const CONTENT_ACTION = /\b(?:crea(?:r)?|redacta(?:r)?|escribe|escribir|genera(?:r)?|prepara(?:r)?|diseña(?:r)?|propón|proponer|elabora(?:r)?|formula(?:r)?|revisa(?:r)?|corrige|corregir|mejora(?:r)?|resume|resumir|compara(?:r)?)\b/iu;
const CONTENT_OBJECT = /\b(?:borrador(?:es)?|publicaci(?:ó|o)n(?:es)?|posts?|guion(?:es)?|scripts?|captions?|copy|calendarios?|planes?|ideas?|estrategias?|textos?|contenidos?|newsletters?|t[ií]tulos?|descripciones?|hooks?|ganchos?|tweets?|hilos?|res[uú]menes?)\b/iu;
const CONTENT_KEYS = ["content", "draft", "text", "body", "script", "posts", "items", "caption", "copy", "output"];
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const INLINE_CONTENT_LIMIT = 4000;

export function pulseRequestRequiresDeliverable(request = {}) {
  const text = `${String(request.title || "")}\n${String(request.prompt || "")}`;
  return (CONTENT_ACTION.test(text) && CONTENT_OBJECT.test(text))
    || /\b(?:borrador(?:es)?|guion(?:es)?|script(?:s)?|caption(?:s)?|copy)\b/iu.test(text);
}

function fromStructured(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(fromStructured).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  for (const key of CONTENT_KEYS) {
    if (Object.hasOwn(value, key)) {
      const content = fromStructured(value[key]);
      if (content) return content;
    }
  }
  return "";
}

function extractContent(result) {
  const raw = String(result ?? "").trim();
  if (!raw) return "";
  const unfenced = raw.replace(/^```(?:json|text|markdown)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (/^[{[]/.test(unfenced)) {
    try { return fromStructured(JSON.parse(unfenced)); }
    catch { /* Preserve ordinary prose that happens to start with a bracket. */ }
  }
  return unfenced;
}

function isOperationalReportOnly(content) {
  if (/^\s*EVIDENCIA_DEL_AGENTE\s*\(/i.test(content)) return true;
  const labels = content.match(/(?:^|\n)\s*(?:CAUSA_CONFIRMADA|HIPOTESIS|REPARACION_APLICADA|VALIDACION|LIMITACIONES|SIGUIENTE_ACCION)\s*:/gim) || [];
  return labels.length >= 2 || /(?:^|\n)\s*VALIDACION\s*:\s*NO_RESOLUBLE\b/i.test(content);
}

function isAcknowledgementOnly(content) {
  return /^(?:(?:listo|he|se ha|se)\s+)?(?:redactad[oa]|redactó|generad[oa]|generó|cread[oa]|creó|preparad[oa]|preparó|elaborad[oa]|elaboró)(?=\s|$|[.!?])[^\n]{0,240}[.!]?$/iu.test(content)
    || /^(?:draft|borrador)\s+(?:created|ready|generado|listo)[.!]?$/iu.test(content);
}

function requestReference(requestId) {
  return SAFE_REQUEST_ID.test(String(requestId || "")) ? `/api/hermes/requests/${requestId}` : null;
}

function firstParagraph(content) {
  return (content.split(/\n\s*\n/, 1)[0] || content).replace(/\s+/g, " ").trim().slice(0, 300);
}

export function normalizePulseDeliverable(request, result, requestId) {
  if (!pulseRequestRequiresDeliverable(request)) {
    return { required: false, ok: true, content: String(result ?? "").trim() };
  }
  const content = extractContent(result);
  if (content.length < 20 || isOperationalReportOnly(content) || isAcknowledgementOnly(content)) {
    return { required: true, ok: false, reason: "pulse_deliverable_content_missing" };
  }
  const reference = requestReference(requestId);
  const wordCount = (content.match(/[\p{L}\p{N}]+/gu) || []).length;
  const eventSummary = `Pulse entregó un borrador (${wordCount} palabras) en la solicitud ${String(requestId || "desconocida")}.`;
  if (content.length <= INLINE_CONTENT_LIMIT) {
    return { required: true, ok: true, content, persistedResult: content, eventSummary };
  }
  const referenceLine = reference
    ? `Texto íntegro accesible en ${reference}.`
    : `Texto íntegro disponible en el resultado de la solicitud ${String(requestId || "desconocida")}.`;
  return {
    required: true,
    ok: true,
    content,
    persistedResult: `Borrador extenso de Pulse. Solicitud ${String(requestId || "desconocida")}\n${referenceLine}\nResumen: ${firstParagraph(content)}\n\nContenido íntegro:\n${content}`,
    eventSummary: `Pulse entregó un borrador extenso (${wordCount} palabras). ${referenceLine}`,
  };
}
