const EXPLICIT_CANCELLATION_STATES = new Set(["cancelled", "canceled", "rejected"]);

export function isExplicitRequestCancellation(status) {
  return EXPLICIT_CANCELLATION_STATES.has(String(status || "").trim().toLowerCase());
}

export function signalTrackedChildren(children, signal, signalProcessGroup = (pid, value) => process.kill(-pid, value)) {
  let signalled = 0;
  for (const child of children || []) {
    const pid = Number(child?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try { signalProcessGroup(pid, signal); } catch {}
    try { child.kill(signal); signalled += 1; } catch {}
  }
  return signalled;
}
