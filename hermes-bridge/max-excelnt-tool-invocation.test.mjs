import assert from "node:assert/strict";
import test from "node:test";
import { invokeMaxExcelntDirectTask } from "./max-excelnt-tool-invocation.mjs";

const request = {
  id: "max-task-001", kind: "max.deep-analysis", origin: "max", capability: "read_only",
  sideEffecting: false, title: "Analyze a short public technical question",
  prompt: "Explain why an idempotent operation can be safely retried, with one concise example.",
};
const context = {
  maxExcelntCandidate: true, securityDisabled: false,
  privacyClass: "REMOTE_FREE_ALLOWED",
};
const grant = {
  capability: "a".repeat(48), max_calls: 1,
  eligible_route_aliases: ["excelnt-code-reasoning"],
};

test("trusted MAX task invokes Sidecar directly without a Qwen planner", async () => {
  let registerCount = 0;
  let executeCount = 0;
  let execution;
  const result = await invokeMaxExcelntDirectTask({
    request, context,
    registerTask: async (input) => { registerCount += 1; assert.equal(input, request); return grant; },
    executeTask: async (input) => { executeCount += 1; execution = input; return { outcome: "COMPLETE", model: "gpt-6-luna", text: "A retry is safe when repeating the operation has the same effect; for example, setting a value to 5." }; },
  });
  assert.equal(registerCount, 1);
  assert.equal(executeCount, 1);
  assert.equal(execution.routeAlias, "excelnt-code-reasoning");
  assert.equal(execution.maxOutputTokens, 256);
  assert.equal(execution.escalationReason, "COMPLEXITY_ESCALATION");
  assert.match(execution.taskPacket.goal, /idempotent operation/);
  assert.equal(result.model, "gpt-6-luna");
});

test("self-declared MAX, LOCAL_ONLY, and unsafe request shapes cannot reach Sidecar", async () => {
  let calls = 0;
  const invoke = (req, ctx) => invokeMaxExcelntDirectTask({
    request: req, context: ctx,
    registerTask: async () => { calls += 1; return grant; },
    executeTask: async () => { calls += 1; return {}; },
  });
  assert.equal(await invoke(request, { ...context, maxExcelntCandidate: false }), null);
  assert.equal(await invoke(request, { ...context, privacyClass: "LOCAL_ONLY" }), null);
  assert.equal(await invoke({ ...request, attachments: ["secret"] }, context), null);
  assert.equal(await invoke({ ...request, sideEffecting: true }, context), null);
  assert.equal(calls, 0);
});

test("absence of grant preserves the existing selected route without commercial execution", async () => {
  let executed = 0;
  const result = await invokeMaxExcelntDirectTask({
    request, context, registerTask: async () => { throw Object.assign(new Error("billing_source_unverified"), { code: "billing_source_unverified" }); },
    executeTask: async () => { executed += 1; return {}; },
  });
  assert.equal(result, null);
  assert.equal(executed, 0);
});

test("ambiguous post-send grant and execution failures are terminal without retry", async () => {
  let executions = 0;
  await assert.rejects(invokeMaxExcelntDirectTask({ request, context,
    registerTask: async () => { throw Object.assign(new Error("timeout"), { outcome: "UNKNOWN_AFTER_SEND" }); },
    executeTask: async () => { executions += 1; return {}; },
  }), /timeout/);
  await assert.rejects(invokeMaxExcelntDirectTask({ request, context,
    registerTask: async () => grant,
    executeTask: async () => { executions += 1; throw Object.assign(new Error("timeout"), { outcome: "UNKNOWN_AFTER_SEND" }); },
  }), /timeout/);
  assert.equal(executions, 1);
});
