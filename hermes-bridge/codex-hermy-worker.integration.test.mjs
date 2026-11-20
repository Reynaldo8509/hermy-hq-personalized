import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(bridgeDir);
const workerScript = path.join(bridgeDir, "codex-hermy-worker.mjs");

test("worker claims a synthetic task, runs a local stub, and records the result", { timeout: 12_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "hermy-codex-worker-test-"));
  const runtimeDir = path.join(temp, "runtime");
  const stubFile = path.join(temp, "fake-codex.mjs");
  const codexFile = path.join(temp, "fake-codex");
  const task = {
    id: "synthetic-codex-task",
    origin: "max",
    kind: "codex.audit",
    title: "Synthetic worker contract",
    status: "queued",
    sideEffecting: false,
    action: "audit",
    capability: "read_only",
    prompt: '[[CODEX_ASSIGNMENT_V1:{"priority":"critical","target":"Synthetic worker contract","expectedOutcome":"Return structured synthetic evidence","rationale":"This task validates the read-only worker contract safely.","taskClass":"complex_engineering","codexRequiredReason":"The synthetic worker test verifies engineering worker integration."}]]\n[[CODEX_INTENT_V1:read_only]]\nRead-only worker instruction.\n\n[Tarea solicitada]\nRead-only synthetic task. Return the required structured fields.',
  };
  let taskStatus = "queued";
  let structured = null;
  let completion = null;
  let completedResolve;
  const completed = new Promise((resolve) => { completedResolve = resolve; });
  const heartbeats = [];
  const seen = [];
  const secret = "local-test-only";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-internal-secret"] !== secret) {
      send(401, { error: "unauthorized" });
      return;
    }
    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }
    seen.push(req.method + " " + url.pathname);
    if (url.pathname === "/api/agents" && req.method === "POST") {
      heartbeats.push(body.status);
      send(200, { ok: true });
      return;
    }
    if (url.pathname === "/api/hermes/incident-memory" && req.method === "GET") {
      send(200, { incidents: [] });
      return;
    }
    if (url.pathname === "/api/codex/tasks" && req.method === "GET") {
      send(200, { tasks: taskStatus === "queued" ? [task] : [], circuit: { open: false }, emergency: false });
      return;
    }
    if (url.pathname === "/api/codex/tasks/" + task.id && req.method === "GET") {
      send(200, { task: { ...task, status: taskStatus } });
      return;
    }
    if (url.pathname === "/api/codex/tasks/" + task.id && req.method === "PATCH") {
      if (body.action === "worker-start" && taskStatus === "running") {
        seen.push("worker-start:" + body.workerUnit + ":" + body.workerPid);
        send(200, { ok: true });
        return;
      }
      if (body.action === "claim" && taskStatus === "queued") {
        taskStatus = "running";
        send(200, { task });
        return;
      }
      if (body.action === "record-structure") {
        structured = body;
        send(200, { ok: true });
        return;
      }
      if (body.action === "complete") {
        taskStatus = "done";
        completion = body;
        completedResolve();
        send(200, { ok: true });
        return;
      }
      send(409, { error: "unexpected task transition" });
      return;
    }
    send(404, { error: "not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fakeSource = [
    "#!/usr/bin/env node",
    "import { writeFile } from 'node:fs/promises';",
    "const args = process.argv.slice(2);",
    "const index = args.indexOf('--output-last-message');",
    "const target = args[index + 1];",
    "if (!target) process.exit(4);",
    "const report = ['CAUSA_CONFIRMADA: synthetic worker path executed', 'HIPOTESIS: none', 'REPARACION_APLICADA: none', 'VALIDACION: fake cli returned success', 'LIMITACIONES: isolated harness', 'SIGUIENTE_ACCION: none'].join('\\n');",
    "await writeFile(target, report, { mode: 0o600 });",
    "console.log(JSON.stringify({ type: 'thread.started', model: 'codex-test-model' }));",
  ].join("\n");
  await writeFile(stubFile, fakeSource, { mode: 0o700 });
  await writeFile(codexFile, "#!/bin/sh\nexec " + process.execPath + " " + stubFile + " \"$@\"\n", { mode: 0o700 });
  await chmod(codexFile, 0o700);

  const worker = spawn(process.execPath, [
    workerScript,
  ], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH || path.dirname(process.execPath),
      HOME: temp,
      HERMY_HQ_URL: "http://127.0.0.1:" + address.port,
      INTERNAL_API_SECRET: secret,
      CODEX_BIN: codexFile,
      CODEX_CAPACITY_PREFLIGHT_ENABLED: "false",
      CODEX_WORKSPACE: temp,
      CODEX_RUNTIME_DIR: runtimeDir,
      CODEX_POLL_MS: "25",
      CODEX_TASK_TIMEOUT_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
    if (worker.exitCode === null && worker.signalCode === null) await once(worker, "exit").catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  let stderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitPromise = once(worker, "exit");
  const timer = setTimeout(() => completedResolve(), 8_000);
  await completed;
  clearTimeout(timer);
  assert.equal(taskStatus, "done", "worker did not finish the synthetic task");
  assert.ok(completion && String(completion.result).includes("synthetic worker path executed"));
  assert.equal(completion.processor, "codex");
  assert.equal(completion.provider, "openai-codex");
  assert.equal(completion.model, "codex-test-model");
  assert.equal(completion.workerUnit, "codex-hermy-vps.service");
  assert.ok(Number.isInteger(completion.workerPid));
  assert.equal(structured && structured.cause, "synthetic worker path executed");
  assert.ok(seen.some((value) => value.startsWith("worker-start:codex-hermy-vps.service:")));
  assert.ok(seen.includes("GET /api/codex/tasks"));
  assert.ok(seen.includes("PATCH /api/codex/tasks/" + task.id));
  assert.ok(heartbeats.includes("working"));
  worker.kill("SIGTERM");
  await exitPromise;
  assert.equal(stderr.trim(), "");
});


test("worker refuses a write request mislabeled as read-only before starting Codex", { timeout: 12_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "hermy-codex-worker-policy-test-"));
  const runtimeDir = path.join(temp, "runtime");
  const sentinel = path.join(temp, "codex-was-started");
  const codexFile = path.join(temp, "fake-codex");
  const assignment = { priority: "important", target: "Synthetic worker contract", expectedOutcome: "Return structured synthetic evidence", rationale: "This task validates the read-only worker contract safely." };
  const task = {
    id: "synthetic-mislabelled-codex-task", origin: "max", kind: "codex.audit", title: "Synthetic unsafe intent",
    status: "queued", sideEffecting: false, action: "audit", capability: "read_only",
    prompt: `[[CODEX_ASSIGNMENT_V1:${JSON.stringify(assignment)}]]\n[[CODEX_INTENT_V1:read_only]]\nRead-only worker instruction.\n\n[Tarea solicitada]\nWrite a file in the repository and report its path.`,
  };
  let taskStatus = "queued";
  let rejectedResolve;
  const rejected = new Promise((resolve) => { rejectedResolve = resolve; });
  const secret = "local-test-only";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-internal-secret"] !== secret) return send(401, { error: "unauthorized" });
    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }
    if (url.pathname === "/api/agents" && req.method === "POST") return send(200, { ok: true });
    if (url.pathname === "/api/codex/tasks" && req.method === "GET") return send(200, { tasks: taskStatus === "queued" ? [task] : [], circuit: { open: false }, emergency: false });
    if (url.pathname === "/api/codex/tasks/" + task.id && req.method === "PATCH" && body.action === "reject-policy") {
      taskStatus = "failed"; rejectedResolve(body); return send(200, { ok: true, status: taskStatus });
    }
    if (url.pathname === "/api/codex/tasks/" + task.id && req.method === "PATCH" && body.action === "claim") return send(409, { error: "unsafe task must never be claimed" });
    return send(404, { error: "not found" });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(codexFile, "#!/bin/sh\nprintf started > " + sentinel + "\n", { mode: 0o700 });
  await chmod(codexFile, 0o700);
  const worker = spawn(process.execPath, [workerScript], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH || path.dirname(process.execPath), HOME: temp,
      HERMY_HQ_URL: "http://127.0.0.1:" + address.port, INTERNAL_API_SECRET: secret,
      CODEX_BIN: codexFile,
      CODEX_CAPACITY_PREFLIGHT_ENABLED: "false", CODEX_WORKSPACE: temp, CODEX_RUNTIME_DIR: runtimeDir,
      CODEX_POLL_MS: "25", CODEX_TASK_TIMEOUT_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
    if (worker.exitCode === null && worker.signalCode === null) await once(worker, "exit").catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const outcome = await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error("worker did not reject the unsafe task")), 8_000))]);
  assert.equal(taskStatus, "failed");
  assert.equal(outcome.reason, "read_only_intent_conflicts_with_payload");
  assert.equal(await import("node:fs/promises").then(({ access }) => access(sentinel).then(() => true, () => false)), false);
  worker.kill("SIGTERM");
  await once(worker, "exit");
});
