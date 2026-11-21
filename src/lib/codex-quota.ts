import type { Prisma } from "@prisma/client";
import { CODEX_POLICY_LIMITS } from "./codex-policy.mjs";
type QuotaReader = Pick<Prisma.TransactionClient, "inferenceAttempt">;
export type CodexQuotaUsage = { runsLastFiveHours: number; maxRunsPerFiveHours: number; runsLastSevenDays: number; maxRunsPerSevenDays: number; blocked: boolean; nextAllowedAt: string | null };
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export async function getCodexQuotaUsage(db: QuotaReader, now = new Date()): Promise<CodexQuotaUsage> {
  const [runsLastFiveHours, runsLastSevenDays] = await Promise.all([
    db.inferenceAttempt.count({ where: { provider: "openai", model: "codex", created_at: { gte: new Date(now.getTime() - FIVE_HOURS_MS) } } }),
    db.inferenceAttempt.count({ where: { provider: "openai", model: "codex", created_at: { gte: new Date(now.getTime() - SEVEN_DAYS_MS) } } }),
  ]);
  return { runsLastFiveHours, maxRunsPerFiveHours: CODEX_POLICY_LIMITS.maxRunsPerFiveHours, runsLastSevenDays, maxRunsPerSevenDays: CODEX_POLICY_LIMITS.maxRunsPerSevenDays, blocked: false, nextAllowedAt: null };
}
