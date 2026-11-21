const MAX_ROUTE_ALIASES = new Set([
  "excelnt-code-fast",
  "excelnt-code-balanced",
  "excelnt-code-reasoning",
]);
const MAX_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const MAX_KINDS = new Set(["max.chief-of-staff", "max.deep-analysis"]);

/**
 * Use an egress-issued MAX capability for one tool dispatch.
 *
 * Candidate state comes from Bridge's current routing context. The registrar
 * independently resolves the active control-plane request; prompt fields and
 * tool output are never authorization inputs.
 */
export async function invokeMaxExcelntTool({
  request,
  context,
  registerTask,
  buildArgs,
  invokeHermes,
  timeoutMs,
  log = () => {},
}) {
  if (context?.maxExcelntCandidate !== true || !MAX_KINDS.has(request?.kind)
      || request.origin !== "max") return null;
  if (typeof registerTask !== "function" || typeof buildArgs !== "function"
      || typeof invokeHermes !== "function") {
    throw new TypeError("max_excelnt_dependencies_invalid");
  }

  let grant;
  try {
    grant = await registerTask(request);
  } catch (error) {
    const code = String(error?.code || "max_grant_unavailable").slice(0, 80);
    log("max_excelnt_grant_denied", request?.id, code);
    return null;
  }

  const aliases = Array.isArray(grant?.eligible_route_aliases)
    ? [...new Set(grant.eligible_route_aliases)].filter((alias) => MAX_ROUTE_ALIASES.has(alias))
    : [];
  if (typeof grant?.capability !== "string" || !MAX_CAPABILITY_PATTERN.test(grant.capability)
      || aliases.length === 0) return null;

  const args = buildArgs(request, aliases);
  const output = await invokeHermes(args, {
    timeout: timeoutMs,
    excelntCapability: grant.capability,
    excelntEligibleAliases: aliases,
  });
  return output.trim();
}


const MAX_DIRECT_PRIVACY_CLASSES = new Set(["PUBLIC", "SANITIZED", "REMOTE_FREE_ALLOWED", "PREFER_LOCAL"]);
const MAX_DIRECT_OUTPUT_TOKENS = 256;

/**
 * Deterministic task-bound MAX→EX11 route. A grant must be issued by the
 * authenticated egress authority before any provider request. With no grant,
 * callers continue on their already selected local/FREE route. Once a grant is
 * issued, any execute error is terminal; never fall back or replay after send.
 */
export async function invokeMaxExcelntDirectTask({
  request, context, registerTask, executeTask, log = () => {},
}) {
  if (context?.maxExcelntCandidate !== true || !MAX_KINDS.has(request?.kind)
      || request.origin !== "max" || request.capability !== "read_only"
      || request.sideEffecting !== false
      || (Array.isArray(request.attachments) && request.attachments.length > 0)
      || context.securityDisabled !== false
      || !MAX_DIRECT_PRIVACY_CLASSES.has(context.privacyClass)) return null;
  if (typeof registerTask !== "function" || typeof executeTask !== "function") {
    throw new TypeError("max_excelnt_direct_dependencies_invalid");
  }
  const title = typeof request.title === "string" ? request.title.trim() : "";
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const goal = prompt ? (title ? `${title}\n\n${prompt}` : prompt) : title;
  if (!goal || Buffer.byteLength(goal, "utf8") > 8_192) {
    throw Object.assign(new Error("max_task_packet_invalid"), {
      code: "max_task_packet_invalid", outcome: "REJECTED_PRE_SEND",
    });
  }
  let grant;
  try {
    grant = await registerTask(request);
  } catch (error) {
    if (error?.outcome === "UNKNOWN_AFTER_SEND") throw error;
    const code = String(error?.code || "max_grant_unavailable").slice(0, 80);
    log("max_excelnt_grant_denied", request?.id, code);
    return null;
  }
  const aliases = Array.isArray(grant?.eligible_route_aliases)
    ? [...new Set(grant.eligible_route_aliases)].filter((alias) => MAX_ROUTE_ALIASES.has(alias))
    : [];
  if (typeof grant?.capability !== "string" || !MAX_CAPABILITY_PATTERN.test(grant.capability)
      || grant.max_calls !== 1 || aliases.length === 0) {
    throw Object.assign(new Error("max_grant_response_invalid"), {
      code: "max_grant_response_invalid", outcome: "UNKNOWN_AFTER_SEND",
    });
  }
  const routeAlias = aliases.includes("excelnt-code-fast")
    ? "excelnt-code-fast" : [...aliases].sort()[0];
  const taskPacket = {
    goal,
    constraints: ["No tools, network access, or side effects.",
      "Use only the supplied request; do not add private or external context."],
    expected_output: "A concise technical response.",
  };
  return executeTask({
    capability: grant.capability, routeAlias, taskPacket,
    maxOutputTokens: MAX_DIRECT_OUTPUT_TOKENS,
    escalationReason: "COMPLEXITY_ESCALATION",
  });
}
