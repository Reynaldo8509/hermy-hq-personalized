import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { agentForKind } from "@/lib/phase2-domain.mjs";
import { normalizeLegacyQwenMetrics, resolveFreshRemoteStatus, resolveTailnetReachability, tailnetObservationMaxAgeMs } from "@/lib/infrastructure-domain.mjs";
import { createAsyncTtlCache } from "@/lib/async-ttl-cache.mjs";
import { sumKnownUsage } from "@/lib/inference-observability.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PERIODS: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };
const KNOWN_KIND_PREFIXES = ["max.", "codex.", "atlas.", "aegis.", "ledger.", "milo.", "pulse.", "domus."];
const inferenceQueryCache = createAsyncTtlCache<Array<Record<string, unknown>>>(5 * 60 * 1000, 3);

function numberValue(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function attributedAgent(kind: string | null, origin: string | null) {
  if (kind && (KNOWN_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix)) || kind === "video.youtube.analyze")) {
    return agentForKind(kind, origin || "");
  }
  return "unattributed";
}

function matchesFilter(actual: string, selected: string | null) {
  return !selected || selected === "all" || actual === selected;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const period = params.get("period") || "7d";
    const hours = PERIODS[period] || PERIODS["7d"];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const [store, operationalStore, grouped, remoteNodeRows, trackedModelRows, qwenInvokerRows] = await Promise.all([
      prisma.dataStore.findUnique({ where: { key: "hermyhq-infrastructure-v1" } }),
      prisma.dataStore.findUnique({ where: { key: "hermyhq-operational-status-v1" } }),
      inferenceQueryCache(period, () => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        WITH classified_attempts AS (
          SELECT i.*,
            COALESCE(NULLIF(i.actual_provider, ''), NULLIF(i.provider, ''), 'unknown') AS effective_provider,
            COALESCE(NULLIF(i.actual_model, ''), NULLIF(i.model, ''), 'unknown') AS effective_model,
            COALESCE(NULLIF(i.requested_provider, ''), NULLIF(i.provider, ''), 'unknown') AS selected_provider,
            COALESCE(NULLIF(i.requested_model, ''), NULLIF(i.model, ''), 'unknown') AS selected_model,
            CASE
              WHEN lower(COALESCE(i.provider, ''))='default' AND lower(COALESCE(i.model, ''))='default'
                THEN 'legacy_unclassified'
              WHEN lower(COALESCE(i.actual_provider, ''))='not_invoked' OR lower(COALESCE(i.actual_model, ''))='not_invoked'
                THEN 'route_not_invoked'
              ELSE 'model_inference'
            END AS telemetry_class,
            CASE
              WHEN lower(COALESCE(i.actual_model, i.model, ''))='qwen3-8b-local'
                AND lower(COALESCE(i.actual_provider, i.provider, '')) IN ('qwen-local-tailscale','qwen local','qwen-local')
                AND (i.remote_attempted IS FALSE OR COALESCE(i.route_tier, '') LIKE 'local%') THEN 'local'
              WHEN i.free_route IS TRUE AND i.route_cost_policy='catalog_verified_free' THEN 'verified_free'
              WHEN i.cost_status='paid' OR (i.cost_status='actual' AND COALESCE(i.reported_cost, 0)>0) THEN 'commercial_verified'
              ELSE 'remote_cost_unverified'
            END AS route_category,
            CASE WHEN
              ((i.usage_source IS NOT NULL AND i.usage_source <> 'unknown') AND
                (i.prompt_tokens IS NOT NULL OR i.completion_tokens IS NOT NULL OR i.total_tokens IS NOT NULL
                  OR i.reasoning_tokens IS NOT NULL OR i.cache_read_tokens IS NOT NULL OR i.cache_write_tokens IS NOT NULL
                  OR i.auxiliary_total_tokens IS NOT NULL OR i.total_including_auxiliary_tokens IS NOT NULL))
              OR COALESCE(i.prompt_tokens, 0)>0 OR COALESCE(i.completion_tokens, 0)>0 OR COALESCE(i.total_tokens, 0)>0
              OR COALESCE(i.reasoning_tokens, 0)>0 OR COALESCE(i.cache_read_tokens, 0)>0 OR COALESCE(i.cache_write_tokens, 0)>0
              OR COALESCE(i.auxiliary_total_tokens, 0)>0 OR COALESCE(i.total_including_auxiliary_tokens, 0)>0
              THEN true ELSE false END AS usage_known
          FROM "InferenceAttempt" i
          WHERE i.created_at >= $1
        )
        SELECT i.effective_provider AS provider,
          i.effective_model AS model,
          i.selected_provider AS requested_provider,
          i.selected_model AS requested_model,
          r.kind AS task_type,
          r.origin,
          r.status AS request_status,
          i.telemetry_class,
          i.route_category,
          count(*)::int AS calls,
          count(*) FILTER (WHERE i.status='success')::int AS successes,
          count(*) FILTER (WHERE i.status='failed')::int AS failures,
          count(*) FILTER (WHERE i.duration_ms IS NOT NULL)::int AS latency_samples,
          round(avg(i.duration_ms) FILTER (WHERE i.duration_ms IS NOT NULL))::bigint AS avg_latency_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY i.duration_ms)
            FILTER (WHERE i.duration_ms IS NOT NULL) AS p95_latency_ms,
          count(*) FILTER (WHERE COALESCE(i.attempt_no, i.attempt_number, 1) > 1)::int AS fallback_attempts,
          count(*) FILTER (WHERE i.status='failed' AND i.reason ~* '\\m429\\M|rate.?limit|too many requests')::int AS errors_429,
          count(*) FILTER (WHERE i.status='failed' AND i.reason ~* '\\m401\\M|unauthori[sz]ed|invalid.{0,20}key')::int AS errors_401,
          count(*) FILTER (WHERE i.status='failed' AND i.reason ~* 'timeout|timed out|ETIMEDOUT|ECONNABORTED')::int AS timeout_errors,
          count(DISTINCT i.request_id)::int AS linked_requests,
          count(*) FILTER (WHERE r.id IS NULL OR r.kind IS NULL)::int AS unattributed_calls,
          count(*) FILTER (WHERE i.usage_known)::int AS known_usage_calls,
          count(*) FILTER (WHERE NOT i.usage_known)::int AS unknown_usage_calls,
          sum(i.prompt_tokens) FILTER (WHERE i.usage_known) AS input_tokens,
          sum(i.completion_tokens) FILTER (WHERE i.usage_known) AS output_tokens,
          sum(i.total_tokens) FILTER (WHERE i.usage_known) AS total_tokens,
          sum(i.auxiliary_total_tokens) FILTER (WHERE i.usage_known) AS auxiliary_total_tokens,
          sum(i.total_including_auxiliary_tokens) FILTER (WHERE i.usage_known) AS total_including_auxiliary_tokens
        FROM classified_attempts i
        LEFT JOIN "AgentRequest" r ON r.id=i.request_id
        GROUP BY 1, 2, 3, 4, r.kind, r.origin, r.status, i.telemetry_class, i.route_category
        ORDER BY calls DESC
        LIMIT 1000
      `, cutoff)),
      prisma.dataStore.findMany({ where: { key: { startsWith: "hermyhq-node-telemetry-v1:" } } }),
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        "SELECT COALESCE(NULLIF(i.actual_provider, ''), NULLIF(i.provider, ''), 'unknown') AS provider, COALESCE(NULLIF(i.actual_model, ''), NULLIF(i.model, ''), 'unknown') AS model, count(*)::int AS calls, count(*) FILTER (WHERE i.status='success')::int AS successes, count(*) FILTER (WHERE i.status='failed')::int AS failures, count(*) FILTER (WHERE i.duration_ms IS NOT NULL)::int AS latency_samples, round(avg(i.duration_ms) FILTER (WHERE i.duration_ms IS NOT NULL))::bigint AS avg_latency_ms, percentile_cont(0.95) WITHIN GROUP (ORDER BY i.duration_ms) FILTER (WHERE i.duration_ms IS NOT NULL) AS p95_latency_ms, count(*) FILTER (WHERE COALESCE(i.attempt_no, i.attempt_number, 1) > 1)::int AS fallback_attempts FROM \"InferenceAttempt\" i WHERE i.created_at >= $1 AND NOT (lower(COALESCE(i.provider, ''))='default' AND lower(COALESCE(i.model, ''))='default') AND lower(COALESCE(i.actual_provider, '')) <> 'not_invoked' AND lower(COALESCE(i.actual_model, '')) <> 'not_invoked' AND ((lower(COALESCE(NULLIF(i.actual_provider, ''), i.provider)) IN ('qwen-local-tailscale','qwen local','qwen-local') AND lower(COALESCE(NULLIF(i.actual_model, ''), i.model))='qwen3-8b-local') OR (COALESCE(NULLIF(i.actual_provider, ''), i.provider)='openai' AND COALESCE(NULLIF(i.actual_model, ''), i.model)='codex')) GROUP BY 1, 2",
        cutoff,
      ),
      inferenceQueryCache("qwen-invokers:" + period, () => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        "SELECT COALESCE(r.origin, 'sin-origen') AS origin, r.kind, count(DISTINCT i.request_id) FILTER (WHERE r.id IS NOT NULL)::int AS executions, count(*)::int AS attempts, count(*) FILTER (WHERE i.status='success')::int AS successes, count(*) FILTER (WHERE i.status='failed')::int AS failures FROM \"InferenceAttempt\" i LEFT JOIN \"AgentRequest\" r ON r.id=i.request_id WHERE i.created_at >= $1 AND NOT (lower(COALESCE(i.provider, ''))='default' AND lower(COALESCE(i.model, ''))='default') AND lower(COALESCE(i.actual_provider, '')) <> 'not_invoked' AND lower(COALESCE(i.actual_model, '')) <> 'not_invoked' AND lower(COALESCE(NULLIF(i.actual_provider, ''), i.provider)) IN ('qwen-local-tailscale','qwen local','qwen-local') AND lower(COALESCE(NULLIF(i.actual_model, ''), i.model))='qwen3-8b-local' GROUP BY r.origin, r.kind ORDER BY executions DESC, attempts DESC LIMIT 100",
        cutoff,
      )),

    ]);

    const allRows = grouped.map((row) => {
      const kind = row.task_type == null ? null : String(row.task_type);
      const origin = row.origin == null ? null : String(row.origin);
      return {
        provider: String(row.provider || "unknown"),
        model: String(row.model || "unknown"),
        requestedProvider: String(row.requested_provider || "unknown"),
        requestedModel: String(row.requested_model || "unknown"),
        telemetryClass: String(row.telemetry_class || "model_inference"),
        routeCategory: String(row.route_category || "remote_cost_unverified"),
        requestStatus: row.request_status == null ? "unlinked" : String(row.request_status),
        taskType: kind || "unattributed",
        origin: origin || null,
        agentId: attributedAgent(kind, origin),
        calls: numberValue(row.calls),
        successes: numberValue(row.successes),
        failures: numberValue(row.failures),
        latencySamples: numberValue(row.latency_samples),
        avgLatencyMs: row.avg_latency_ms == null ? null : numberValue(row.avg_latency_ms),
        p95LatencyMs: row.p95_latency_ms == null ? null : Math.round(numberValue(row.p95_latency_ms)),
        fallbackAttempts: numberValue(row.fallback_attempts),
        errors429: numberValue(row.errors_429),
        errors401: numberValue(row.errors_401),
        timeoutErrors: numberValue(row.timeout_errors),
        linkedRequests: numberValue(row.linked_requests),
        unattributedCalls: numberValue(row.unattributed_calls),
        knownUsageCalls: numberValue(row.known_usage_calls),
        unknownUsageCalls: numberValue(row.unknown_usage_calls),
        inputTokens: row.input_tokens == null ? null : numberValue(row.input_tokens),
        outputTokens: row.output_tokens == null ? null : numberValue(row.output_tokens),
        totalTokens: row.total_tokens == null ? null : numberValue(row.total_tokens),
        auxiliaryTokens: row.auxiliary_total_tokens == null ? null : numberValue(row.auxiliary_total_tokens),
        totalIncludingAuxiliaryTokens: row.total_including_auxiliary_tokens == null ? null : numberValue(row.total_including_auxiliary_tokens),
      };
    });

    const trackedModels = trackedModelRows.map((row) => ({
      provider: String(row.provider || "unknown"),
      model: String(row.model || "unknown"),
      calls: numberValue(row.calls),
      successes: numberValue(row.successes),
      failures: numberValue(row.failures),
      latencySamples: numberValue(row.latency_samples),
      avgLatencyMs: row.avg_latency_ms == null ? null : numberValue(row.avg_latency_ms),
      p95LatencyMs: row.p95_latency_ms == null ? null : numberValue(row.p95_latency_ms),
      fallbackAttempts: numberValue(row.fallback_attempts),
    })).filter((row) => row.calls > 0);

    const qwenInvokers = qwenInvokerRows.map((row) => {
      const kind = row.kind == null ? null : String(row.kind);
      const origin = row.origin == null ? "sin-origen" : String(row.origin);
      return {
        origin,
        taskType: kind || "sin tipo enlazado",
        agentId: attributedAgent(kind, origin === "sin-origen" ? null : origin),
        executions: numberValue(row.executions),
        attempts: numberValue(row.attempts),
        successes: numberValue(row.successes),
        failures: numberValue(row.failures),
      };
    });

    const provider = params.get("provider");
    const model = params.get("model");
    const agent = params.get("agent");
    const taskType = params.get("taskType");
    const inferenceRows = allRows.filter((row) => row.telemetryClass === "model_inference");
    const rows = inferenceRows.filter((row) =>
      matchesFilter(row.provider, provider) &&
      matchesFilter(row.model, model) &&
      matchesFilter(row.agentId, agent) &&
      matchesFilter(row.taskType, taskType)
    );
    const totals = rows.reduce((sum, row) => {
      sum.calls += row.calls;
      sum.successes += row.successes;
      sum.failures += row.failures;
      sum.latencySamples += row.latencySamples;
      sum.fallbackAttempts += row.fallbackAttempts;
      sum.errors429 += row.errors429;
      sum.errors401 += row.errors401;
      sum.timeoutErrors += row.timeoutErrors;
      sum.unattributedCalls += row.unattributedCalls;
      sum.knownUsageCalls += row.knownUsageCalls;
      sum.unknownUsageCalls += row.unknownUsageCalls;
      sum.weightedLatency += numberValue(row.avgLatencyMs) * row.latencySamples;
      return sum;
    }, {
      calls: 0, successes: 0, failures: 0, latencySamples: 0, fallbackAttempts: 0,
      errors429: 0, errors401: 0, timeoutErrors: 0, unattributedCalls: 0, weightedLatency: 0,
      knownUsageCalls: 0, unknownUsageCalls: 0,
    });
    const data = store?.data && typeof store.data === "object" ? store.data as Record<string, any> : {};
    const operationalData = operationalStore?.data && typeof operationalStore.data === "object"
      ? operationalStore.data as Record<string, any>
      : null;
    const samples = Array.isArray(data.samples) ? data.samples : [];
    const nodes = { ...normalizeLegacyQwenMetrics(data.nodes || {}) };
    const tailnetPeers = Array.isArray(data.knownTailnetPeers) ? data.knownTailnetPeers : [];
    const tailnetObservedAt = typeof data.tailnetPeersObservedAt === "string" ? data.tailnetPeersObservedAt : null;
    const tailnetFreshnessMs = tailnetObservationMaxAgeMs(numberValue(data.sampleIntervalSeconds));
    const allowedRemoteNodes = new Set(["dell-g15", "raspberrypi4", "toshiba-p50"]);
    const remotePrefix = "hermyhq-node-telemetry-v1:";
    for (const row of remoteNodeRows) {
      const nodeId = row.key.slice(remotePrefix.length);
      if (!allowedRemoteNodes.has(nodeId) || !row.data || typeof row.data !== "object") continue;
      const displayNodeId = nodeId === "raspberrypi4" ? "raspberry-pi4" : nodeId;
      const snapshot = row.data as Record<string, any>;
      const base = nodes[displayNodeId] || {};
      const metricsReadAt = typeof snapshot.metricsReadAt === "string" ? snapshot.metricsReadAt : null;
      const readTime = metricsReadAt ? Date.parse(metricsReadAt) : NaN;
      const metricsFresh = Number.isFinite(readTime) && Date.now() - readTime <= 15 * 60 * 1000;
      nodes[displayNodeId] = {
        ...base,
        ...snapshot,
        id: displayNodeId,
        status: resolveFreshRemoteStatus(snapshot.status, metricsFresh),
        powerState: metricsFresh ? snapshot.powerState : "unknown",
        observedAt: metricsFresh ? snapshot.observedAt : (base.observedAt || snapshot.observedAt),
        lastSeenAt: metricsFresh ? snapshot.lastSeenAt : (base.lastSeenAt || snapshot.lastSeenAt),
        networkInterfaces: metricsFresh ? (snapshot.networkInterfaces || []) : (base.networkInterfaces || []),
        batteryState: metricsFresh ? snapshot.batteryState : (base.batteryState || "unknown"),
        batteryPercent: metricsFresh ? snapshot.batteryPercent : (base.batteryPercent ?? null),
        metricsFreshness: metricsFresh ? "fresh" : "stale",
        qwen: metricsFresh ? (base.qwen || null) : base.qwen ? {
          ...base.qwen,
          status: "no-data",
          errorClass: null,
          httpStatus: null,
          latencyMs: null,
          metricsStatus: "not-queried",
        } : null,
        services: base.services || [],
        tailscale: metricsFresh ? snapshot.tailscale : {
          ...(snapshot.tailscale || base.tailscale || {}),
          status: "no-data",
        },
      };
    }
    for (const [nodeId, node] of Object.entries(nodes)) {
      const reachability = resolveTailnetReachability({
        nodeId,
        hostnames: [node.hostname, node.tailscale?.hostname],
        peers: tailnetPeers,
        observedAt: tailnetObservedAt,
        now: Date.now(),
        maxAgeMs: tailnetFreshnessMs,
      });
      if (!reachability) continue;
      const qwenUnavailable = nodeId === "dell-g15" && reachability.identityMatched === true
        && reachability.status === "offline" && node.qwen;
      nodes[nodeId] = {
        ...node,
        status: reachability.status,
        observedAt: reachability.checkedAt,
        lastSeenAt: reachability.lastSeenAt || node.lastSeenAt,
        tailscale: {
          ...(node.tailscale || {}),
          status: reachability.status,
          lastSeenAt: reachability.lastSeenAt || node.tailscale?.lastSeenAt || null,
        },
        qwen: qwenUnavailable ? {
          ...node.qwen,
          status: "offline",
          errorClass: null,
          httpStatus: null,
          latencyMs: null,
          metricsStatus: "offline",
        } : node.qwen,
        reachability,
      };
    }
    // Verified Oracle KVM guest has no GPU device or thermal sensor exposed to Linux.
    if (nodes.vps?.metrics) {
      const vpsMetrics = nodes.vps.metrics as Record<string, any>;
      nodes.vps = {
        ...nodes.vps,
        metrics: {
          ...vpsMetrics,
          temperatures: { state: "not-applicable", maximumCelsius: null, sensorCount: 0 },
          gpu: { state: "not-applicable", name: null, utilizationPercent: null, vramUsedMiB: null, vramTotalMiB: null, temperatureCelsius: null, detail: "VM Oracle Cloud en KVM: no expone GPU ni sensores termicos al sistema invitado." },
        },
      };
    }
    const history = samples.filter((sample: any) => {
      const time = Date.parse(String(sample?.collectedAt || ""));
      return Number.isFinite(time) && time >= Date.now() - hours * 60 * 60 * 1000;
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      period,
      filters: {
        provider: provider || "all", model: model || "all", agent: agent || "all", taskType: taskType || "all",
        providers: [...new Set(inferenceRows.map((row) => row.provider))].sort(),
        models: [...new Set(inferenceRows.map((row) => row.model))].sort(),
        agents: [...new Set(inferenceRows.map((row) => row.agentId))].sort(),
        taskTypes: [...new Set(inferenceRows.map((row) => row.taskType))].sort(),
      },
      operations: operationalData,
      infrastructure: {
        collectedAt: data.collectedAt || null,
        intervalSeconds: data.sampleIntervalSeconds || null,
        retentionHours: data.retentionHours || 0,
        history,
        nodes,
        tailnetAvailable: history.at(-1)?.tailnetAvailable ?? null,
      },
      modelPerformance: {
        rows,
        trackedModels,
        qwenInvokers,
        codexRuntime: {
          model: process.env.HERMYHQ_CODEX_RUNTIME_MODEL || null,
          reasoningEffort: process.env.HERMYHQ_CODEX_REASONING_EFFORT || null,
          backupModel: process.env.HERMYHQ_CODEX_BACKUP_MODEL || null,
        },
        qwenRuntime: {
          model: process.env.HERMYHQ_QWEN_RUNTIME_MODEL || null,
          quantization: process.env.HERMYHQ_QWEN_RUNTIME_QUANTIZATION || null,
          reasoning: process.env.HERMYHQ_QWEN_RUNTIME_REASONING || null,
          contextTokens: process.env.HERMYHQ_QWEN_RUNTIME_CONTEXT ? numberValue(process.env.HERMYHQ_QWEN_RUNTIME_CONTEXT) : null,
          maxOutputTokens: process.env.HERMYHQ_QWEN_MAX_OUTPUT_TOKENS ? numberValue(process.env.HERMYHQ_QWEN_MAX_OUTPUT_TOKENS) : null,
        },
        totals: {
          ...totals,
          avgLatencyMs: totals.latencySamples ? Math.round(totals.weightedLatency / totals.latencySamples) : null,
          successRate: totals.calls ? totals.successes / totals.calls : null,
          fallbackAttemptRate: totals.calls ? totals.fallbackAttempts / totals.calls : null,
          inputTokens: sumKnownUsage(rows, "inputTokens"),
          outputTokens: sumKnownUsage(rows, "outputTokens"),
          totalTokens: sumKnownUsage(rows, "totalTokens"),
          auxiliaryTokens: sumKnownUsage(rows, "auxiliaryTokens"),
          totalIncludingAuxiliaryTokens: sumKnownUsage(rows, "totalIncludingAuxiliaryTokens"),
          legacyUnclassifiedAttempts: allRows.filter((row) => row.telemetryClass === "legacy_unclassified").reduce((total, row) => total + row.calls, 0),
          routeNotInvokedAttempts: allRows.filter((row) => row.telemetryClass === "route_not_invoked").reduce((total, row) => total + row.calls, 0),
          weightedLatency: undefined,
          estimatedCost: null,
          contextCompression: null,
        },
        dataQuality: {
          tokenUsage: "reported-when-available-otherwise-unknown",
          knownUsageCalls: totals.knownUsageCalls,
          unknownUsageCalls: totals.unknownUsageCalls,
          legacyUnclassifiedAttempts: allRows.filter((row) => row.telemetryClass === "legacy_unclassified").reduce((total, row) => total + row.calls, 0),
          routeNotInvokedAttempts: allRows.filter((row) => row.telemetryClass === "route_not_invoked").reduce((total, row) => total + row.calls, 0),
          modelInferenceAttempts: inferenceRows.reduce((total, row) => total + row.calls, 0),
          cost: "no-reliable-per-request-pricing",
          contextCompression: "not-linked-to-inference-attempts",
          agentAttribution: totals.calls ? "request-kind-and-origin" : "no-data",
          unattributedCalls: totals.unattributedCalls,
          measuredLatencyCalls: totals.latencySamples,
          sampledCalls: totals.calls,
        },
      },
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Infrastructure API error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "No se pudo leer la telemetría de infraestructura" }, { status: 503 });
  }
}
