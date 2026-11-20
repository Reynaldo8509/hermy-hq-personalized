import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalOperatorMessage, CODEX_DELL_OPERATOR_ID, operatorFingerprint } from "../../scripts/codex-dell-operator-protocol.mjs";

export { canonicalOperatorMessage, CODEX_DELL_OPERATOR_ID, operatorFingerprint };
export const TRUSTED_OPERATOR_AUTH_SOURCE = "ed25519_trusted_operator";
export const TRUSTED_OPERATOR_APPROVAL_METHOD = "trusted_operator_self_approval";
export const TRUSTED_OPERATOR_KIND = "codex.dell.operator";
export const MAX_OPERATOR_BODY_BYTES = 64 * 1024;
export const MAX_OPERATOR_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CODEX_DELL_OPERATOR_REQUESTS_PATH = "/api/hermes/codex-dell/requests";
export const ALLOWED_OPERATOR_SERVICES = Object.freeze([
  "hermy-hq-vps.service",
  "hermy-hq-bridge-vps.service",
  "hermes-excelnt-egress.service",
]);

export function isCodexDellOperatorPath(method, pathname) {
  const verb = String(method || "").toUpperCase();
  if (pathname === CODEX_DELL_OPERATOR_REQUESTS_PATH && ["GET", "POST"].includes(verb)) return true;
  return verb === "PATCH"
    && /^\/api\/hermes\/codex-dell\/requests\/[A-Za-z0-9_-]{8,80}$/.test(String(pathname || ""));
}

const HEX_256 = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const NONCE = /^[A-Za-z0-9_-]{22,96}$/;
const OPERATIONS = Object.freeze({
  "workspace.inspect": { capability: "read_only", executionMode: "local_operator", effect: "workspaceRead" },
  "workspace.modify": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "workspaceWrite" },
  "workspace.test": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "testExecution" },
  "release.build": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "releaseBuild" },
  "release.publish": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "releasePublish" },
  "release.promote": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "productionDeploy" },
  "service.restart": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "serviceRestart" },
  "release.rollback": { capability: "codex_dell_admin", executionMode: "local_operator", effect: "releaseRollback" },
});
const OPERATION_RESOURCES = Object.freeze({
  "workspace.inspect": "codex-dell-g15:workspace",
  "workspace.modify": "codex-dell-g15:workspace",
  "workspace.test": "codex-dell-g15:workspace",
  "release.build": "codex-dell-g15:operator-releases",
  "release.publish": "codex-dell-g15:operator-releases",
  "release.promote": "codex-dell-g15:operator-releases",
  "release.rollback": "codex-dell-g15:operator-releases",
  "service.restart": "codex-dell-g15:hermy-platform",
});

const EFFECTS = Object.freeze([
  "workspaceRead", "workspaceWrite", "testExecution", "releaseBuild", "releasePublish",
  "productionDeploy", "serviceRestart", "releaseRollback", "commercialInference",
  "externalIO", "credentialManagement", "securityControlChange", "irreversibleAction",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function header(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

export function verifyOperatorSignature({ headers, method, pathAndQuery, rawBody, identity, nowMs = Date.now() }) {
  if (!identity || identity.operatorId !== CODEX_DELL_OPERATOR_ID || identity.enabled !== true) {
    return { ok: false, reason: "operator_identity_disabled" };
  }
  const operatorId = header(headers, "x-hermy-operator-id");
  const timestamp = header(headers, "x-hermy-operator-timestamp");
  const nonce = header(headers, "x-hermy-operator-nonce");
  const signature = header(headers, "x-hermy-operator-signature");
  if (operatorId !== CODEX_DELL_OPERATOR_ID || !/^[0-9]{13}$/.test(String(timestamp || ""))
      || !NONCE.test(String(nonce || "")) || !/^[A-Za-z0-9_-]{80,100}$/.test(String(signature || ""))) {
    return { ok: false, reason: "operator_signature_headers_invalid" };
  }
  if (Math.abs(nowMs - Number(timestamp)) > MAX_OPERATOR_CLOCK_SKEW_MS) {
    return { ok: false, reason: "operator_signature_stale" };
  }
  try {
    const fingerprint = operatorFingerprint(identity.publicKeyPem);
    if (fingerprint !== identity.fingerprintSha256) return { ok: false, reason: "operator_fingerprint_mismatch" };
    const message = canonicalOperatorMessage({ operatorId, method, pathAndQuery, timestamp, nonce, rawBody });
    const valid = verify(null, message, createPublicKey(identity.publicKeyPem), Buffer.from(signature, "base64url"));
    if (!valid) return { ok: false, reason: "operator_signature_invalid" };
    return { ok: true, operatorId, fingerprint, scopes: identity.scopes };
  } catch {
    return { ok: false, reason: "operator_key_invalid" };
  }
}

export function loadTrustedOperatorIdentity({
  registryFile = process.env.HERMY_TRUSTED_OPERATOR_REGISTRY_FILE,
  operatorId = CODEX_DELL_OPERATOR_ID,
  requireRootOwner = true,
  fsModule = fs,
} = {}) {
  if (typeof registryFile !== "string" || !path.isAbsolute(registryFile)) return null;
  try {
    const absolute = path.resolve(registryFile);
    if (fsModule.realpathSync(absolute) !== absolute) return null;
    const fd = fsModule.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let info;
    let raw;
    try {
      info = fsModule.fstatSync(fd);
      raw = fsModule.readFileSync(fd, "utf8");
    } finally {
      fsModule.closeSync(fd);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 || (info.mode & 0o022) !== 0) return null;
    if (requireRootOwner && info.uid !== 0) return null;
    const registry = JSON.parse(raw);
    if (registry?.schemaVersion !== 1 || !registry.identities || typeof registry.identities !== "object") return null;
    const identity = registry.identities[operatorId];
    if (!identity || identity.operatorId !== operatorId || identity.enabled !== true
        || typeof identity.publicKeyPem !== "string" || typeof identity.fingerprintSha256 !== "string") return null;
    if (operatorFingerprint(identity.publicKeyPem) !== identity.fingerprintSha256) return null;
    const scopes = Array.isArray(identity.scopes) ? identity.scopes.map(String) : [];
    if (scopes.length === 0 || scopes.some((scope) => !Object.hasOwn(OPERATIONS, scope))
        || new Set(scopes).size !== scopes.length) return null;
    return Object.freeze({
      operatorId,
      enabled: true,
      publicKeyPem: identity.publicKeyPem,
      fingerprintSha256: identity.fingerprintSha256,
      enrolledAt: identity.enrolledAt || null,
      scopes,
    });
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validHash(value) {
  return typeof value === "string" && HEX_256.test(value);
}

function validCas(value) {
  return validHash(value) || value === "ABSENT";
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

export function verifyPackageTree(root, tree, manifest, { fsModule = fs, requireRootOwner = true } = {}) {
  if (!isPlainObject(tree) || !Array.isArray(tree.files) || !Array.isArray(tree.symlinks)) return false;
  const files = new Map();
  const links = new Map();
  for (const row of tree.files) {
    if (!isPlainObject(row) || !safeRelativePath(row.path) || !validHash(row.sha256)
        || !Number.isSafeInteger(row.size) || row.size < 0 || !/^0[0-7]{3}$/.test(row.mode)
        || files.has(row.path)) return false;
    files.set(row.path, row);
  }
  for (const row of tree.symlinks) {
    if (!isPlainObject(row) || !safeRelativePath(row.path) || typeof row.target !== "string"
        || !row.target || links.has(row.path) || files.has(row.path)) return false;
    links.set(row.path, row);
  }
  const externalRoot = manifest?.external_dependencies?.external_dependency_root;
  let externalReal = null;
  if (typeof externalRoot === "string") {
    try { externalReal = fsModule.realpathSync(externalRoot); } catch { return false; }
  }
  const seenFiles = new Set();
  const seenLinks = new Set();
  const excluded = (rel) => rel === "activation/package-manifest.json"
    || rel === "activation/package-tree-manifest.json"
    || rel === "runtime/.next/cache" || rel.startsWith("runtime/.next/cache/");
  const walk = (directory) => {
    for (const entry of fsModule.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      if (rel === "runtime/.next/cache") {
        const cache = fsModule.lstatSync(absolute);
        if (!cache.isDirectory() || cache.isSymbolicLink() || cache.uid !== process.getuid?.()
            || (cache.mode & 0o777) !== 0o750) return false;
        continue;
      }
      if (excluded(rel)) continue;
      const info = fsModule.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        const row = links.get(rel);
        if (!row || fsModule.readlinkSync(absolute) !== row.target) return false;
        const resolved = fsModule.realpathSync(absolute);
        const inRelease = resolved === root || resolved.startsWith(root + path.sep);
        const inExternal = externalReal !== null
          && (resolved === externalReal || resolved.startsWith(externalReal + path.sep));
        if (!inRelease && !inExternal) return false;
        seenLinks.add(rel);
        continue;
      }
      if (info.isDirectory()) {
        if ((requireRootOwner && info.uid !== 0) || (info.mode & 0o222) !== 0) return false;
        if (!walk(absolute)) return false;
        continue;
      }
      if (!info.isFile() || (requireRootOwner && info.uid !== 0) || (info.mode & 0o222) !== 0 || info.nlink !== 1) return false;
      const row = files.get(rel);
      const mode = `0${(info.mode & 0o777).toString(8).padStart(3, "0")}`;
      if (!row || row.size !== info.size || row.mode !== mode || row.sha256 !== sha256(fsModule.readFileSync(absolute))) {
        return false;
      }
      seenFiles.add(rel);
    }
    return true;
  };
  try {
    if (!walk(root)) return false;
  } catch {
    return false;
  }
  return seenFiles.size === files.size && seenLinks.size === links.size
    && [...seenFiles].every((rel) => files.has(rel)) && [...seenLinks].every((rel) => links.has(rel));
}

function validateReleaseDescriptor(release, { releasesRoot, checkpointsRoot, fsModule = fs, operationName } = {}) {
  if (!isPlainObject(release) || typeof releasesRoot !== "string" || typeof checkpointsRoot !== "string") {
    return { ok: false, reason: "release_descriptor_invalid" };
  }
  const fields = ["packagePath", "manifestSha256", "treeSha256", "checkpointPath", "checkpointManifestSha256",
    "casPreimage", "casPostimage", "service", "promotionOperator", "rollbackOperator"];
  if (Object.keys(release).sort().join("|") !== fields.sort().join("|")) return { ok: false, reason: "release_descriptor_shape_invalid" };
  if (![release.manifestSha256, release.treeSha256, release.checkpointManifestSha256,
    release.casPreimage, release.casPostimage].every(validCas) || !validHash(release.casPostimage)) {
    return { ok: false, reason: "release_hash_invalid" };
  }
  if (!ALLOWED_OPERATOR_SERVICES.includes(release.service)) return { ok: false, reason: "service_not_allowlisted" };

  try {
    const root = fsModule.realpathSync(path.resolve(releasesRoot));
    const packagePath = path.resolve(String(release.packagePath));
    if (!packagePath.startsWith(root + path.sep) || fsModule.realpathSync(packagePath) !== packagePath) {
      return { ok: false, reason: "release_path_not_allowlisted" };
    }
    const packageInfo = fsModule.lstatSync(packagePath);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink() || packageInfo.uid !== 0
        || (packageInfo.mode & 0o777) !== 0o550) return { ok: false, reason: "release_root_not_immutable" };
    const activation = path.join(packagePath, "activation");
    const manifestPath = path.join(activation, "package-manifest.json");
    const treeManifestPath = path.join(activation, "package-tree-manifest.json");
    for (const file of [manifestPath, treeManifestPath]) {
      const info = fsModule.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1
          || (info.mode & 0o777) !== 0o440) return { ok: false, reason: "release_manifest_not_immutable" };
    }
    const manifestRaw = fsModule.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestRaw.toString("utf8"));
    const treeRaw = fsModule.readFileSync(treeManifestPath);
    const checkpointPath = path.resolve(String(release.checkpointPath));
    const checkpointRoot = fsModule.realpathSync(path.resolve(checkpointsRoot));
    if (!checkpointPath.startsWith(checkpointRoot + path.sep)
        || !safeRelativePath(path.relative(checkpointRoot, checkpointPath).split(path.sep).join("/"))) {
      return { ok: false, reason: "checkpoint_path_not_allowlisted" };
    }
    if (sha256(manifestRaw) !== release.manifestSha256 || manifest.release_id !== path.basename(packagePath)
        || manifest.tree_sha256 !== release.treeSha256 || sha256(treeRaw) !== manifest.tree_manifest_sha256
        || manifest.preimage_sha256 !== release.casPreimage || manifest.postimage_sha256 !== release.casPostimage
        || manifest.checkpoint_path !== checkpointPath
        || !verifyPackageTree(packagePath, JSON.parse(treeRaw.toString("utf8")), manifest, { fsModule })) {
      return { ok: false, reason: "release_checkpoint_binding_mismatch" };
    }
    // The service cannot read root-only checkpoints. This signed request binds
    // their path/hash/CAS; the root operator independently checks checkpoint
    // bytes immediately before it performs a production CAS.
    if (manifest.baseline?.unit !== release.service) return { ok: false, reason: "release_service_mismatch" };
    const target = manifest.target;
    const targetParent = `/etc/systemd/system/${release.service}.d/`;
    if (typeof target !== "string" || !path.posix.isAbsolute(target) || target.includes("..")
        || !target.startsWith(targetParent) || !target.endsWith(".conf")) {
      return { ok: false, reason: "release_selector_target_not_allowlisted" };
    }
    const expectedCurrent = operationName === "release.rollback" ? release.casPostimage : release.casPreimage;
    let currentHash = "ABSENT";
    try {
      const targetInfo = fsModule.lstatSync(target);
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.uid !== 0
          || (targetInfo.mode & 0o222) !== 0) return { ok: false, reason: "release_selector_target_not_immutable" };
      currentHash = sha256(fsModule.readFileSync(target));
    } catch (error) {
      if (error?.code !== "ENOENT") return { ok: false, reason: "release_selector_target_unavailable" };
    }
    if (currentHash !== expectedCurrent) return { ok: false, reason: "release_selector_cas_precondition_mismatch" };
    if (manifest.component === "hq" && manifest.autoapproval_enabled !== false) {
      return { ok: false, reason: "hq_release_must_keep_autoapproval_disabled" };
    }
    const dependencies = manifest.external_dependencies || {};
    if (typeof dependencies.external_dependency_root === "string") {
      const dependencyRoot = fsModule.realpathSync(dependencies.external_dependency_root);
      const dependencyInfo = fsModule.lstatSync(dependencyRoot);
      if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink() || dependencyInfo.uid !== 0
          || (dependencyInfo.mode & 0o222) !== 0) return { ok: false, reason: "external_dependencies_not_immutable" };
      const lockHash = dependencies.expected_package_lock_sha256 || dependencies.package_lock_sha256;
      if (lockHash) {
        const lockPath = path.join(packagePath, "runtime/package-lock.json");
        if (sha256(fsModule.readFileSync(lockPath)) !== lockHash) return { ok: false, reason: "release_lockfile_hash_mismatch" };
      }
      for (const [name, expectedHash] of Object.entries(dependencies.dependency_package_sha256 || {})) {
        if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) || !validHash(expectedHash)) {
          return { ok: false, reason: "release_dependency_manifest_invalid" };
        }
        const packageJson = path.join(dependencyRoot, name, "package.json");
        if (sha256(fsModule.readFileSync(packageJson)) !== expectedHash) {
          return { ok: false, reason: "release_dependency_hash_mismatch" };
        }
      }
    }
    if (manifest.component === "hq") {
      const runtime = path.join(packagePath, "runtime");
      if (fsModule.readFileSync(path.join(runtime, ".next/BUILD_ID"), "utf8").trim() !== manifest.build_id) {
        return { ok: false, reason: "hq_build_id_mismatch" };
      }
    }
    const safeOperator = (name) => {
      if (name !== "activation/sealed_release_operator.py") return false;
      const info = fsModule.lstatSync(path.join(packagePath, name));
      return info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1
        && (info.mode & 0o222) === 0;
    };
    if (!safeOperator(release.promotionOperator) || !safeOperator(release.rollbackOperator)) {
      return { ok: false, reason: "release_operator_missing" };
    }
    return { ok: true, release: Object.freeze({
      packagePath, releaseId: manifest.release_id, manifestSha256: release.manifestSha256,
      treeSha256: release.tree_sha256, checkpointPath, checkpointManifestSha256: release.checkpointManifestSha256,
      casPreimage: release.casPreimage, casPostimage: release.casPostimage, service: release.service,
      promotionOperator: release.promotionOperator, rollbackOperator: release.rollbackOperator,
    }) };
  } catch {
    return { ok: false, reason: "release_files_unavailable_or_invalid" };
  }
}

export function operatorTaskFingerprint(payload) {
  return sha256(JSON.stringify(canonical({
    schemaVersion: 1,
    idempotencyKey: payload.idempotencyKey,
    operation: payload.operation,
    title: payload.title,
    prompt: payload.prompt,
    resourceId: payload.resourceId,
    service: payload.service ?? null,
    release: payload.release ?? null,
  })));
}

export function validateOperatorTask(payload, options = {}) {
  if (!isPlainObject(payload)) return { ok: false, status: 400, reason: "request_body_invalid" };
  const allowedKeys = ["idempotencyKey", "operation", "title", "prompt", "resourceId", "service", "release"];
  if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) return { ok: false, status: 400, reason: "request_fields_unknown" };
  if (typeof payload.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(payload.idempotencyKey)) {
    return { ok: false, status: 400, reason: "idempotency_key_required" };
  }
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!title || title.length > 200 || !prompt || prompt.length > 12000) {
    return { ok: false, status: 400, reason: "title_or_prompt_invalid" };
  }
  const operation = OPERATIONS[String(payload.operation || "")];
  if (!operation) return { ok: false, status: 403, reason: "operator_operation_not_allowlisted" };
  if (!Array.isArray(options.operatorScopes) || !options.operatorScopes.includes(String(payload.operation))) {
    return { ok: false, status: 403, reason: "operator_scope_not_granted" };
  }
  const resourceId = typeof payload.resourceId === "string" ? payload.resourceId : "";
  if (resourceId !== OPERATION_RESOURCES[String(payload.operation)]) {
    return { ok: false, status: 403, reason: "operator_resource_scope_mismatch" };
  }

  let release = null;
  if (["release.promote", "release.rollback"].includes(String(payload.operation))) {
    if (typeof payload.service !== "string") return { ok: false, status: 400, reason: "service_required" };
    const checked = validateReleaseDescriptor(payload.release, { ...options, operationName: String(payload.operation) });
    if (!checked.ok) return { ok: false, status: 403, reason: checked.reason };
    if (checked.release.service !== payload.service) return { ok: false, status: 403, reason: "release_service_mismatch" };
    release = checked.release;
  } else if (payload.release !== undefined || (payload.service !== undefined
      && String(payload.operation) !== "service.restart")) {
    return { ok: false, status: 400, reason: "release_metadata_not_applicable" };
  }
  if (String(payload.operation) === "service.restart" && !ALLOWED_OPERATOR_SERVICES.includes(String(payload.service || ""))) {
    return { ok: false, status: 403, reason: "service_not_allowlisted" };
  }
  if (String(payload.operation) !== "service.restart" && !["release.promote", "release.rollback"].includes(String(payload.operation))
      && payload.service !== undefined) return { ok: false, status: 400, reason: "service_metadata_not_applicable" };

  const effects = Object.fromEntries(EFFECTS.map((name) => [name, false]));
  effects[operation.effect] = true;
  if (release) effects.serviceRestart = true;
  const normalized = {
    idempotencyKey: payload.idempotencyKey,
    operation: String(payload.operation),
    title,
    prompt,
    resourceId,
    ...(payload.service === undefined ? {} : { service: String(payload.service) }),
    ...(release ? { release } : {}),
  };
  const scope = Object.freeze({
    id: "codex-dell-g15.operator.v1",
    resourceIds: Object.freeze([resourceId]),
    effects: Object.freeze(effects),
    operation: normalized.operation,
    service: normalized.service ?? null,
    release,
  });
  return { ok: true, operatorId: CODEX_DELL_OPERATOR_ID, normalized, operation,
    capability: operation.capability, executionMode: operation.executionMode, scope,
    fingerprint: operatorTaskFingerprint(normalized) };
}

export function reconstructOperatorPayload(request) {
  const scope = request?.scope;
  if (!isPlainObject(scope) || scope.id !== "codex-dell-g15.operator.v1") return null;
  return {
    idempotencyKey: request.idempotencyKey,
    operation: scope.operation,
    title: request.title,
    prompt: request.prompt,
    resourceId: Array.isArray(scope.resourceIds) ? scope.resourceIds[0] : "",
    ...(scope.service ? { service: scope.service } : {}),
    ...(scope.release ? { release: scope.release } : {}),
  };
}

export function operatorTaskStatusTransition(currentStatus, action) {
  const transitions = {
    claim: { from: "approved", to: "running" },
    complete: { from: "running", to: "done" },
    fail: { from: "running", to: "failed" },
    cancel: { from: "approved", to: "cancelled" },
  };
  const transition = transitions[action];
  if (!transition) return { ok: false, reason: "operator_action_not_allowlisted" };
  if (currentStatus !== transition.from) return { ok: false, reason: "operator_task_transition_replay_or_conflict" };
  return { ok: true, status: transition.to };
}

export async function readBoundedRequestBody(request, maxBytes = MAX_OPERATOR_BODY_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, reason: "request_body_too_large" };
  }
  if (!request.body) return { ok: true, rawBody: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "request_body_too_large" };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return { ok: true, rawBody: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: "request_body_invalid_utf8" };
  }
}
