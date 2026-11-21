const LOOKUP_ACTION = /\b(?:busca(?:r)?|investiga(?:r)?|consulta(?:r)?|verifica(?:r)?|compara(?:r)?|encuentra|localiza|monitorea)\b/i;
const SOURCE_TARGET = /\b(?:youtube|canal(?:es)?|tendencias?|m[eé]tricas?|estad[ií]sticas?|publicaciones?|fuentes?|redes sociales|videos?\s+(?:de|en)\s+youtube)\b/i;
const EXPLICIT_NO_LOOKUP = /\b(?:no|sin)\s+(?:(?:me|lo|las|los)\s+)?(?:busques?|buscar|investigues?|investigar|consultes?|consultar|verifiques?|verificar|uses?|utilizar)\b.{0,80}\b(?:youtube|canal|videos?|fuentes?|internet|web|redes sociales)\b/i;
const SUPPLIED_CONTENT_REVIEW = /\b(?:revisa|revisar|corrige|corregir|edita|editar|mejora|mejorar|resume|resumir|compara|comparar)\b.{0,120}\b(?:borradores?|guiones?|scripts?|textos?|documentos?|reportes?)\b/i;
const EXPLICIT_EXTERNAL_SCOPE = /\b(?:actual(?:es|mente)?|reciente(?:s)?|tendencias?|m[eé]tricas?|estad[ií]sticas?|fuentes?\s+(?:oficiales|p[uú]blicas)|canales?\s+p[uú]blicos|competidores?|competencia)\b/i;

export function pulseNeedsExternalLookup(request = {}) {
  const text = `${String(request.title || '')}\n${String(request.prompt || '')}`;
  if (EXPLICIT_NO_LOOKUP.test(text)) return false;
  if (!LOOKUP_ACTION.test(text) || !SOURCE_TARGET.test(text)) return false;
  if (SUPPLIED_CONTENT_REVIEW.test(text) && !EXPLICIT_EXTERNAL_SCOPE.test(text)) return false;
  return true;
}

export async function dispatchPulseSocial(request, handlers = {}) {
  const handler = pulseNeedsExternalLookup(request) ? handlers.externalLookup : handlers.inference;
  if (typeof handler !== 'function') {
    throw new TypeError('Pulse route handler is required');
  }
  return handler(request);
}
