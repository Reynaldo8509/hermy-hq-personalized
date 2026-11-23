import { lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const fail = (condition, label) => {
  if (!condition) throw new Error(`mcp_restart_runtime_test_failed:${label}`);
};

if (process.env.MCP_RESTART_TEST_MODE !== "1") {
  throw new Error("mcp_restart_runtime_test_mode_required");
}

const baseUrl = new URL(process.env.MCP_RESTART_TEST_URL || "");
const databaseUrl = new URL(process.env.DATABASE_URL || "");
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || "";
const credentialPrefix = path.join(tmpdir(), "hq-mcp-restart-test-");
const databaseName = databaseUrl.pathname.slice(1);

fail(baseUrl.protocol === "http:" && baseUrl.hostname === "localhost" && baseUrl.port === "3216",
  "server_must_be_test_loopback");
fail(databaseUrl.protocol.startsWith("postgres") && databaseUrl.hostname === "localhost" &&
  databaseUrl.port === "55439" && databaseName.startsWith("hermyhq_contract_mcp_"),
"database_must_be_isolated_local_contract_database");
fail(path.resolve(credentialDirectory).startsWith(credentialPrefix), "credential_directory_must_be_temporary");

const directoryStat = lstatSync(credentialDirectory);
const tokenPath = path.join(credentialDirectory, "mcp-restart-request-token");
const tokenStat = lstatSync(tokenPath);
fail(directoryStat.isDirectory() && directoryStat.uid === process.getuid() && (directoryStat.mode & 0o077) === 0,
  "credential_directory_permissions");
fail(tokenStat.isFile() && tokenStat.uid === process.getuid() && tokenStat.nlink === 1 &&
  (tokenStat.mode & 0o077) === 0, "credential_file_permissions");
const token = readFileSync(tokenPath, "ascii");
fail(/^[A-Za-z0-9_-]{43,128}$/.test(token), "synthetic_test_credential_format");

const prisma = new PrismaClient();
const base = `${baseUrl.protocol}//${baseUrl.host}`;
const collection = "/api/mcp/restart-requests";

async function call(method, route, { auth = "valid", body } = {}) {
  const headers = { accept: "application/json" };
  if (auth === "valid") headers["x-mcp-restart-token"] = token;
  if (auth === "wrong") headers["x-mcp-restart-token"] = "other-service-test-token-012345678901234567890123456789";
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(route, base), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`mcp_restart_runtime_test_failed:non_json_response_${response.status}`); }
  return { status: response.status, payload };
}

try {
  const body = { operation: "restart", unit: "rey-infrastructure-mcp-admin.service" };
  const first = await call("POST", collection, { body });
  fail(first.status === 201 && first.payload.status === "PENDING" && first.payload.duplicate === false,
    "post_creates_pending");
  const requestId = first.payload.requestId;
  fail(typeof requestId === "string" && /^[a-f0-9]{40}$/.test(requestId), "request_id_format");
  fail(typeof first.payload.nonce === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(first.payload.nonce),
    "post_nonce_contract");
  fail(first.payload.unit === body.unit && first.payload.operation === body.operation, "post_scope_contract");

  const duplicate = await call("POST", collection, { body });
  fail(duplicate.status === 200 && duplicate.payload.duplicate === true &&
    duplicate.payload.requestId === requestId && duplicate.payload.nonce === first.payload.nonce,
  "post_retry_deduplicated");
  const count = await prisma.$queryRaw`SELECT count(*)::int AS count FROM "ActionApproval" WHERE id=${requestId}`;
  fail(count[0]?.count === 1, "single_approval_row");

  const pending = await call("GET", `${collection}/${requestId}`);
  fail(pending.status === 200 && pending.payload.status === "PENDING" &&
    pending.payload.requestId === requestId && !Object.hasOwn(pending.payload, "nonce"), "get_own_pending_without_nonce");
  fail((await call("GET", `${collection}/${requestId}`, { auth: "missing" })).status === 401,
    "missing_identity_rejected");
  fail((await call("GET", `${collection}/${requestId}`, { auth: "wrong" })).status === 403,
    "other_identity_rejected");
  fail((await call("GET", `${collection}/${"f".repeat(40)}`)).status === 404, "unknown_id_not_found");
  fail((await call("PATCH", `${collection}/${requestId}`, { body: { status: "approved" } })).status === 405,
    "mcp_cannot_approve");
  fail((await call("POST", `${collection}/${requestId}`, { body })).status === 405,
    "post_id_route_rejected");
  fail((await call("POST", "/api/hermes/dispatch", { body: {} })).status === 403,
    "dispatch_not_authorized");
  const stillPending = await prisma.$queryRaw`SELECT status FROM "ActionApproval" WHERE id=${requestId}`;
  fail(stillPending[0]?.status === "pending", "negative_attempts_do_not_mutate_approval");

  const foreignId = "e".repeat(40);
  await prisma.$executeRaw`
    INSERT INTO "ActionApproval"
      (id,request_id,action,status,requested_by,approved_by,rejected_by,resolved_by,decision,
       reason,created_at,resolved_at,expires_at,parameters_snapshot)
    SELECT ${foreignId},${foreignId},action,'pending','another-test-principal',NULL,NULL,NULL,NULL,
      'isolated ownership test',now(),NULL,now() + interval '10 minutes',
      parameters_snapshot || jsonb_build_object('requestId',${foreignId},'requester','another-test-principal')
    FROM "ActionApproval" WHERE id=${requestId}`;
  const foreign = await call("GET", `${collection}/${foreignId}`);
  fail(foreign.status === 404, "existing_foreign_principal_request_hidden");

  await prisma.$executeRaw`
    UPDATE "ActionApproval"
    SET created_at=now() - interval '31 minutes', expires_at=now() - interval '1 minute'
    WHERE id=${requestId} AND status='pending'`;
  const expired = await call("GET", `${collection}/${requestId}`);
  fail(expired.status === 200 && expired.payload.status === "EXPIRED", "expired_request_read_only");
  const persistedExpired = await prisma.$queryRaw`SELECT status FROM "ActionApproval" WHERE id=${requestId}`;
  fail(persistedExpired[0]?.status === "pending", "get_does_not_reactivate_or_mutate_expired_row");

  await prisma.$executeRaw`
    UPDATE "ActionApproval"
    SET status='approved', approved_by='mcp-runtime-test-human',
      created_at=now() - interval '1 minute', expires_at=now() + interval '10 minutes'
    WHERE id=${requestId}`;
  const approved = await call("GET", `${collection}/${requestId}`);
  fail(approved.status === 200 && approved.payload.status === "APPROVED", "human_approved_status");
  await prisma.$executeRaw`UPDATE "ActionApproval" SET status='rejected', approved_by=NULL WHERE id=${requestId}`;
  const rejected = await call("GET", `${collection}/${requestId}`);
  fail(rejected.status === 200 && rejected.payload.status === "REJECTED", "rejected_status");
  await prisma.$executeRaw`UPDATE "ActionApproval" SET status='cancelled', approved_by=NULL WHERE id=${requestId}`;
  const cancelled = await call("GET", `${collection}/${requestId}`);
  fail(cancelled.status === 200 && cancelled.payload.status === "CANCELLED", "cancelled_status");

  console.log("mcp_restart_runtime_http=PASS post_pending=PASS get_own=PASS foreign_hidden=PASS unknown=PASS expiry=PASS auth=PASS no_self_approval=PASS dedup=PASS states=PASS");
} finally {
  await prisma.$disconnect();
}
