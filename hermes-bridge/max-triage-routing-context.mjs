const MAX_LITERAL_REQUEST_MARKER = "\n\n[Solicitud literal del usuario]\n";
const MAX_LITERAL_REQUEST_AT_START = "[Solicitud literal del usuario]\n";

/** Extract the user-authored MAX task before routing markers/context are removed. */
export function extractMaxUserTask(request) {
  const prompt = String(request?.prompt || "");
  const marker = prompt.lastIndexOf(MAX_LITERAL_REQUEST_MARKER);
  if (marker >= 0) return prompt.slice(marker + MAX_LITERAL_REQUEST_MARKER.length).trim().slice(0, 2000);
  if (prompt.startsWith(MAX_LITERAL_REQUEST_AT_START)) {
    return prompt.slice(MAX_LITERAL_REQUEST_AT_START.length).trim().slice(0, 2000);
  }
  return String(request?.title || "").replace(/^Max\s*[·:-]\s*/i, "").trim().slice(0, 2000);
}

/** Return only a user task captured for this exact active request. */
export function boundMaxUserTask(context, request) {
  const requestId = String(request?.id || "");
  if (!requestId || String(context?.request?.id || "") !== requestId
      || String(context?.maxUserTaskRequestId || "") !== requestId
      || typeof context?.maxUserTask !== "string" || !context.maxUserTask.trim()) return null;
  return context.maxUserTask;
}

/** Bind a MAX triage prompt and its verified static prefix to one request. */
export async function withMaxTriageRoutingRequest(context, request, invoke, {
  trustedStaticPrefix,
  dynamicPrompt,
} = {}) {
  const current = context?.request;
  if (!context || !current || !request
      || String(current.id || "") !== String(request.id || "")
      || current.kind !== request.kind
      || !["max.chief-of-staff", "max.deep-analysis"].includes(String(request.kind || ""))
      || typeof request.prompt !== "string" || !request.prompt.trim()
      || typeof trustedStaticPrefix !== "string" || !trustedStaticPrefix.trim()
      || typeof dynamicPrompt !== "string" || !dynamicPrompt.trim()
      || request.prompt !== trustedStaticPrefix + dynamicPrompt
      || typeof invoke !== "function") {
    throw new Error("max_triage_request_binding_denied");
  }
  const previous = current;
  const previousTrustedPrefix = context.trustedStaticPromptPrefix;
  context.request = { ...current, prompt: request.prompt };
  context.trustedStaticPromptPrefix = Object.freeze({
    requestId: String(request.id),
    kind: String(request.kind),
    prefix: trustedStaticPrefix,
    dynamicPrompt,
  });
  try {
    return await invoke();
  } finally {
    context.request = previous;
    if (previousTrustedPrefix === undefined) delete context.trustedStaticPromptPrefix;
    else context.trustedStaticPromptPrefix = previousTrustedPrefix;
  }
}
