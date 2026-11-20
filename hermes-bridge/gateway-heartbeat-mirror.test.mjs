import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, symlinkSync, statSync, utimesSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./gateway-heartbeat-mirror.py", import.meta.url).pathname;
const unit = new URL("../deployment/hermy-gateway-heartbeat-export.service", import.meta.url);
const driverSource = [
  "import importlib.util, sys",
  `spec = importlib.util.spec_from_file_location('mirror', ${JSON.stringify(script)})`,
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "try:",
  "    module.publish(sys.argv[1], sys.argv[2], expected_uid=int(sys.argv[3]), expected_gid=int(sys.argv[4]), expected_destination_uid=int(sys.argv[5]), expected_destination_gid=int(sys.argv[6]))",
  "except module.HeartbeatPublishError as exc:",
  "    print(str(exc), file=sys.stderr); raise SystemExit(1)",
  "except OSError:",
  "    print('heartbeat_publish_io_error', file=sys.stderr); raise SystemExit(1)",
].join("\n") + "\n";

function publish(driver, source, destination, sourceUid, sourceGid, destUid, destGid) {
  return spawnSync("/usr/bin/python3", [driver, source, destination, String(sourceUid), String(sourceGid), String(destUid), String(destGid)], { encoding: "utf8", timeout: 3000 });
}

function identities(destination) {
  const info = statSync(path.dirname(destination));
  return [info.uid, info.gid];
}

test("heartbeat mirror exports only the source mtime and keeps a stale source stale", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hermy-heartbeat-mirror-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = path.join(root, "driver.py");
  writeFileSync(driver, driverSource, { mode: 0o600 });
  const source = path.join(root, "source");
  const destination = path.join(root, "out", "heartbeat");
  mkdirSync(path.dirname(destination));
  chmodSync(path.dirname(destination), 0o755);
  writeFileSync(source, "private synthetic heartbeat payload", { mode: 0o600 });
  const sourceMtime = Date.now() - 180_000;
  const date = new Date(sourceMtime);
  utimesSync(source, date, date);
  const sourceInfo = statSync(source);
  const [destUid, destGid] = identities(destination);
  const result = publish(driver, source, destination, sourceInfo.uid, sourceInfo.gid, destUid, destGid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(destination).mtimeMs, sourceInfo.mtimeMs);
  assert.equal(statSync(destination).mode & 0o777, 0o644);
  assert.equal(statSync(destination).size, 0, "the heartbeat contents are never copied");
});

test("heartbeat mirror rejects symlinks and a wrong source identity", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hermy-heartbeat-deny-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = path.join(root, "driver.py");
  writeFileSync(driver, driverSource, { mode: 0o600 });
  const source = path.join(root, "source");
  const destination = path.join(root, "out", "heartbeat");
  mkdirSync(path.dirname(destination));
  chmodSync(path.dirname(destination), 0o755);
  writeFileSync(source, "synthetic", { mode: 0o600 });
  const stat = statSync(source);
  const [destUid, destGid] = identities(destination);
  let result = publish(driver, source, destination, stat.uid + 1, stat.gid, destUid, destGid);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "source_identity_rejected");

  const link = path.join(root, "source-link");
  symlinkSync(source, link);
  result = publish(driver, link, destination, stat.uid, stat.gid, destUid, destGid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source_open_failed|source_identity_rejected/);
});

test("heartbeat mirror refuses destination symlinks", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hermy-heartbeat-dest-deny-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = path.join(root, "driver.py");
  writeFileSync(driver, driverSource, { mode: 0o600 });
  const source = path.join(root, "source");
  const destination = path.join(root, "out", "heartbeat");
  mkdirSync(path.dirname(destination));
  chmodSync(path.dirname(destination), 0o755);
  writeFileSync(source, "synthetic", { mode: 0o600 });
  const target = path.join(root, "target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, destination);
  const stat = statSync(source);
  const [destUid, destGid] = identities(destination);
  const result = publish(driver, source, destination, stat.uid, stat.gid, destUid, destGid);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "destination_identity_rejected");
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("heartbeat mirror replaces a valid 250-byte filename atomically with a short private temp name", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hermy-heartbeat-name-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = path.join(root, "driver.py");
  writeFileSync(driver, driverSource, { mode: 0o600 });
  const source = path.join(root, "source");
  const destination = path.join(root, "out", "x".repeat(250));
  mkdirSync(path.dirname(destination));
  chmodSync(path.dirname(destination), 0o755);
  writeFileSync(source, "synthetic", { mode: 0o600 });
  writeFileSync(destination, "old");
  const sourceInfo = statSync(source);
  const [destUid, destGid] = identities(destination);
  const result = publish(driver, source, destination, sourceInfo.uid, sourceInfo.gid, destUid, destGid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(destination).size, 0);
  assert.deepEqual(readdirSync(path.dirname(destination)).sort(), ["x".repeat(250)]);
});

test("heartbeat publisher runs as Gateway UID with no capabilities", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(unit, "utf8");
  assert.match(text, /^User=hermy-gateway$/m);
  assert.match(text, /^Group=hermy-gateway$/m);
  assert.match(text, /^CapabilityBoundingSet=$/m);
  assert.match(text, /^AmbientCapabilities=$/m);
  assert.doesNotMatch(text, /^User=root$|^CapabilityBoundingSet=CAP_/m);
});
