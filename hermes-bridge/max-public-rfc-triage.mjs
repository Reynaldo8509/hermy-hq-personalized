import { extractOnePublicHttpsUrl } from "./atlas-max-hq-dispatch.mjs";

const MAX_RESEARCH = "max.chief-of-staff";
const REMOTE_FREE_ALLOWED = "REMOTE_FREE_ALLOWED";
const RFC_REFERENCE = /\bRFC\s*(\d{1,5})\b/i;
const PUBLIC_SCOPE = /\b(?:public|p[uú]blic[oa]s?)\b/i;
const SOURCE_INTENT = /\b(?:consulta(?:r)?|lee?r|investiga(?:r)?|extrae?r|resume(?:n|r)?|revisa(?:r)?|analiza(?:r)?|estudia(?:r)?|read|review|research|retrieve|summarize|extract|analy[sz]e)\b/i;
const RFC_EDITOR_HOSTS = new Set(["www.rfc-editor.org", "rfc-editor.org"]);

/**
 * Route only an explicitly public, read-only RFC source request into MAX's
 * existing triage/delegation path. Privacy authorization remains external to
 * this helper and is required by shouldRunMaxTriageOrInference below.
 */
export function isExplicitPublicRfcSourceTask({ request = {}, dynamicTask = "" } = {}) {
  if (request.kind !== MAX_RESEARCH
      || request.capability !== "read_only"
      || request.executionMode !== "read_only"
      || request.sideEffecting !== false
      || (Array.isArray(request.attachments) && request.attachments.length > 0)
      || ["workflow", "error-supervisor", "system"].includes(String(request.origin || "").toLowerCase())) {
    return false;
  }

  const task = String(dynamicTask || "").trim();
  const declaredRequest = `${String(request.title || "")}\n${task}`;
  if (!task || task.length > 2000 || !PUBLIC_SCOPE.test(declaredRequest) || !SOURCE_INTENT.test(task)) return false;
  const rfcNumbers = new Set([...declaredRequest.matchAll(new RegExp(RFC_REFERENCE.source, "gi"))]
    .map((match) => match[1]));
  if (rfcNumbers.size !== 1) return false;
  const [rfc] = rfcNumbers;

  let source;
  try { source = new URL(extractOnePublicHttpsUrl(task)); }
  catch { return false; }
  if (!RFC_EDITOR_HOSTS.has(source.hostname.toLowerCase()) || source.search) return false;
  return new RegExp(`^/rfc/rfc${rfc}(?:\\.html)?$`, "i").test(source.pathname);
}

/** Preserve the existing COMPLEX route; add only the confirmed public-RFC case. */
export function shouldRunMaxTriageOrInference({
  request = {}, privacyClass, complexityClass, dynamicTask = "",
} = {}) {
  if (privacyClass !== REMOTE_FREE_ALLOWED) return false;
  if (complexityClass === "COMPLEX") return true;
  return isExplicitPublicRfcSourceTask({ request, dynamicTask });
}
