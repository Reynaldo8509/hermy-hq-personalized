export type HomeAssistantStatus = { reachable: boolean; summary: string; checkedAt: string };

export async function readHomeAssistantStatus(): Promise<HomeAssistantStatus> {
  const checkedAt = new Date().toISOString();
  const url = process.env.HOME_ASSISTANT_BASE_URL || "http://127.0.0.1:8123/";
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const reachable = response.ok;
    return {
      reachable,
      summary: reachable ? "Home Assistant responde desde el VPS." : `Home Assistant respondió HTTP ${response.status}.`,
      checkedAt,
    };
  } catch {
    return { reachable: false, summary: "Home Assistant no responde desde el VPS.", checkedAt };
  }
}
