import { prisma } from "@/lib/prisma";

export const EMERGENCY_GATE_KEY = "agent-emergency-gate";
export const EMERGENCY_GATE_LOCK = 73194201;

export async function isEmergencyStopActive(): Promise<boolean> {
  const row = await prisma.dataStore.findUnique({ where: { key: EMERGENCY_GATE_KEY } });
  const data = row?.data as { active?: boolean; expiresAt?: number } | undefined;
  return data?.active === true && Number(data.expiresAt || 0) > Date.now();
}

export function emergencyStopResponse() {
  return Response.json(
    { error: "Emergency reset is clearing agent queues; retry after it completes." },
    { status: 503, headers: { "Retry-After": "3" } },
  );
}
