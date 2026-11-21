import { pulseRequestRequiresDeliverable } from './pulse-content-contract.mjs';

const ATTENTION = /(severidad\s+(media|alta|crítica|critica)|error|failed|failure|unavailable|offline|overdue|stale|corrupt|missing|critical|crítico|fall[oó]|no se pudo|bloquead|inaccesible|no disponible|401|403|404|429)/i;

export function shouldNotifySpecialistOutcome({ agentId, request, status }) {
  if (agentId === 'pulse' && status === 'done' && pulseRequestRequiresDeliverable(request)) return false;
  const text = `${String(request?.title || '')}\n${String(request?.prompt || '')}`;
  return status === 'failed' || ATTENTION.test(text);
}

export function isDuplicateSpecialistAlert(previous, fingerprint, now = Date.now(), windowMs = 43200000) {
  return previous?.fingerprint === fingerprint && now - Number(previous.at || 0) < windowMs;
}
