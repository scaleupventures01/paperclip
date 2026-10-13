import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns } from "@paperclipai/db";

export type ProviderUsagePolicy = {
  providerKey: string;
  windowMs: number;
  issueMaxRuns: number;
  issueMaxTokens: number;
  agentMaxRuns: number;
  agentMaxTokens: number;
  companyMaxRuns: number;
  companyMaxTokens: number;
};

export type ProviderUsageObserved = {
  issueRuns: number;
  issueTokens: number;
  agentRuns: number;
  agentTokens: number;
  companyRuns: number;
  companyTokens: number;
};

export type ProviderUsageAdmissionDecision =
  | { allowed: true }
  | { allowed: false; scope: "issue" | "agent" | "company"; metric: "runs" | "tokens"; observed: number; limit: number };

const DEFAULT_GLM_POLICIES: ProviderUsagePolicy[] = [
  {
    providerKey: "glm",
    windowMs: 30 * 60 * 1000,
    issueMaxRuns: 6,
    issueMaxTokens: 25_000_000,
    agentMaxRuns: 20,
    agentMaxTokens: 75_000_000,
    companyMaxRuns: 150,
    companyMaxTokens: 200_000_000,
  },
  {
    providerKey: "glm",
    windowMs: 6 * 60 * 60 * 1000,
    issueMaxRuns: 10,
    issueMaxTokens: 35_000_000,
    agentMaxRuns: 40,
    agentMaxTokens: 100_000_000,
    companyMaxRuns: 200,
    companyMaxTokens: 150_000_000,
  },
];

function normalizedKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return key || null;
}

function containsGlm(value: unknown): boolean {
  return typeof value === "string" && /(^|[\/_-])glm(?:[\/_-]|$)/i.test(value);
}

export function resolveUsageProviderKey(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
}): string {
  const config = input.adapterConfig ?? {};
  const explicit = normalizedKey(config.usageProviderKey);
  if (explicit) return explicit;
  const provider = normalizedKey(config.provider);
  const model = normalizedKey(config.model);
  if (containsGlm(provider) || containsGlm(model)) return "glm";
  if (provider === "codex" || provider === "openai") return "openai";
  if (provider === "claude" || provider === "anthropic") return "anthropic";
  if (provider === "gemini" || provider === "google") return "google";
  if (provider === "grok" || provider === "xai") return "xai";
  if (provider === "acpx") {
    const agent = normalizedKey(config.acpxAgent);
    if (agent === "claude") return "anthropic";
    if (agent === "codex") return "openai";
    if (agent) return agent;
  }
  if (provider && !["opencode", "paperclip_runner"].includes(provider)) return provider;
  const adapter = normalizedKey(input.adapterType) ?? "unknown";
  if (adapter.startsWith("claude")) return "anthropic";
  if (adapter.startsWith("codex")) return "openai";
  if (adapter.startsWith("gemini")) return "google";
  if (adapter.startsWith("grok")) return "xai";
  return provider ?? adapter.replace(/_local$/, "");
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parsePolicy(value: unknown): ProviderUsagePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const providerKey = normalizedKey(row.providerKey);
  const windowMs = positiveInteger(row.windowMs);
  const issueMaxRuns = positiveInteger(row.issueMaxRuns);
  const issueMaxTokens = positiveInteger(row.issueMaxTokens);
  const agentMaxRuns = positiveInteger(row.agentMaxRuns);
  const agentMaxTokens = positiveInteger(row.agentMaxTokens);
  const companyMaxRuns = positiveInteger(row.companyMaxRuns);
  const companyMaxTokens = positiveInteger(row.companyMaxTokens);
  if (!providerKey || !windowMs || !issueMaxRuns || !issueMaxTokens || !agentMaxRuns || !agentMaxTokens || !companyMaxRuns || !companyMaxTokens) return null;
  return { providerKey, windowMs, issueMaxRuns, issueMaxTokens, agentMaxRuns, agentMaxTokens, companyMaxRuns, companyMaxTokens };
}

export function providerUsagePoliciesFromEnv(env: Record<string, string | undefined> = process.env): ProviderUsagePolicy[] {
  const raw = env.PAPERCLIP_PROVIDER_USAGE_LIMITS_JSON?.trim();
  if (!raw) return DEFAULT_GLM_POLICIES.map((policy) => ({ ...policy }));
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_GLM_POLICIES.map((policy) => ({ ...policy }));
    const policies = parsed.map(parsePolicy).filter((row): row is ProviderUsagePolicy => row !== null);
    return policies.length > 0 ? policies : DEFAULT_GLM_POLICIES.map((policy) => ({ ...policy }));
  } catch {
    return DEFAULT_GLM_POLICIES.map((policy) => ({ ...policy }));
  }
}

export function decideProviderUsageAdmission(input: {
  policy: ProviderUsagePolicy;
  observed: ProviderUsageObserved;
}): ProviderUsageAdmissionDecision {
  const checks = [
    ["issue", "runs", input.observed.issueRuns, input.policy.issueMaxRuns],
    ["issue", "tokens", input.observed.issueTokens, input.policy.issueMaxTokens],
    ["agent", "runs", input.observed.agentRuns, input.policy.agentMaxRuns],
    ["agent", "tokens", input.observed.agentTokens, input.policy.agentMaxTokens],
    ["company", "runs", input.observed.companyRuns, input.policy.companyMaxRuns],
    ["company", "tokens", input.observed.companyTokens, input.policy.companyMaxTokens],
  ] as const;
  for (const [scope, metric, observed, limit] of checks) {
    if (observed >= limit) return { allowed: false, scope, metric, observed, limit };
  }
  return { allowed: true };
}

function countValue(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function admitProviderUsage(input: {
  db: Db;
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  providerKey: string;
  now?: Date;
  policies?: ProviderUsagePolicy[];
}): Promise<{ providerKey: string; policy: ProviderUsagePolicy | null; decision: ProviderUsageAdmissionDecision }> {
  const providerKey = input.providerKey.trim().toLowerCase();
  const policies = (input.policies ?? providerUsagePoliciesFromEnv()).filter((candidate) => candidate.providerKey === providerKey);
  if (policies.length === 0) return { providerKey, policy: null, decision: { allowed: true } };
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`provider-usage:${input.companyId}:${providerKey}`}))`);
    const currentRun = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!currentRun) throw new Error("provider_usage_admission_run_missing");
    let selectedPolicy = policies[0]!;
    let selectedStart = new Date(now.getTime() - selectedPolicy.windowMs);
    let selectedObserved: ProviderUsageObserved | null = null;
    let decision: ProviderUsageAdmissionDecision = { allowed: true };
    for (const policy of policies) {
      const start = new Date(now.getTime() - policy.windowMs);
      const runPredicate = and(
        eq(heartbeatRuns.companyId, input.companyId),
        gte(heartbeatRuns.createdAt, start),
        sql`${heartbeatRuns.contextSnapshot} -> 'providerUsageAdmission' ->> 'status' = 'admitted'`,
        sql`${heartbeatRuns.contextSnapshot} -> 'providerUsageAdmission' ->> 'providerKey' = ${providerKey}`,
      );
      const [runCounts, tokenCounts] = await Promise.all([
        tx.select({
          companyRuns: sql<number>`count(*)::int`,
          agentRuns: sql<number>`count(*) filter (where ${heartbeatRuns.agentId} = ${input.agentId})::int`,
          issueRuns: input.issueId
            ? sql<number>`count(*) filter (where ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId})::int`
            : sql<number>`0::int`,
        }).from(heartbeatRuns).where(runPredicate).then((rows) => rows[0]),
        tx.select({
          companyTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}), 0)::bigint`,
          agentTokens: sql<number>`coalesce(sum(case when ${costEvents.agentId} = ${input.agentId} then ${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens} else 0 end), 0)::bigint`,
          issueTokens: input.issueId
            ? sql<number>`coalesce(sum(case when ${costEvents.issueId} = ${input.issueId} then ${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens} else 0 end), 0)::bigint`
            : sql<number>`0::bigint`,
        }).from(costEvents).innerJoin(
          heartbeatRuns,
          eq(heartbeatRuns.id, costEvents.heartbeatRunId),
        ).where(and(
          eq(costEvents.companyId, input.companyId),
          sql`${heartbeatRuns.contextSnapshot} -> 'providerUsageAdmission' ->> 'status' = 'admitted'`,
          sql`${heartbeatRuns.contextSnapshot} -> 'providerUsageAdmission' ->> 'providerKey' = ${providerKey}`,
          gte(costEvents.occurredAt, start),
        )).then((rows) => rows[0]),
      ]);
      const observed: ProviderUsageObserved = {
        issueRuns: countValue(runCounts?.issueRuns),
        agentRuns: countValue(runCounts?.agentRuns),
        companyRuns: countValue(runCounts?.companyRuns),
        issueTokens: countValue(tokenCounts?.issueTokens),
        agentTokens: countValue(tokenCounts?.agentTokens),
        companyTokens: countValue(tokenCounts?.companyTokens),
      };
      const candidateDecision = decideProviderUsageAdmission({ policy, observed });
      selectedPolicy = policy;
      selectedStart = start;
      selectedObserved = observed;
      if (!candidateDecision.allowed) {
        decision = candidateDecision;
        break;
      }
    }
    await tx.update(heartbeatRuns).set({
      contextSnapshot: {
        ...(currentRun.contextSnapshot ?? {}),
        providerUsageAdmission: {
          status: decision.allowed ? "admitted" : "blocked",
          providerKey,
          admittedAt: now.toISOString(),
          windowMs: selectedPolicy.windowMs,
          windowStartedAt: selectedStart.toISOString(),
          observed: selectedObserved,
          ...(decision.allowed ? {} : { block: decision }),
        },
      },
      updatedAt: now,
    }).where(eq(heartbeatRuns.id, input.runId));
    return { providerKey, policy: selectedPolicy, decision };
  });
}
