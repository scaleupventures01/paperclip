import { describe, expect, it } from "vitest";
import {
  decideProviderUsageAdmission,
  providerUsagePoliciesFromEnv,
  resolveUsageProviderKey,
} from "./provider-usage-breaker.js";

describe("provider usage breaker", () => {
  it.each([
    [{ usageProviderKey: "GLM" }, "opencode_local", "glm"],
    [{ provider: "opencode", model: "zai/glm-5.3-flash" }, "paperclip_runner", "glm"],
    [{ provider: "acpx", acpxAgent: "claude", model: "claude-opus-5" }, "paperclip_runner", "anthropic"],
    [{ provider: "codex", model: "gpt-5.6-sol" }, "paperclip_runner", "openai"],
  ])("resolves billing provider identity from config %j", (config, adapterType, expected) => {
    expect(resolveUsageProviderKey({ adapterType, adapterConfig: config })).toBe(expected);
  });

  it("blocks exactly at the issue run cap and records the limiting scope", () => {
    const decision = decideProviderUsageAdmission({
      policy: { providerKey: "glm", windowMs: 1_800_000, issueMaxRuns: 6, issueMaxTokens: 25_000_000,
        agentMaxRuns: 20, agentMaxTokens: 75_000_000, companyMaxRuns: 150, companyMaxTokens: 200_000_000 },
      observed: { issueRuns: 6, issueTokens: 1, agentRuns: 6, agentTokens: 1, companyRuns: 6, companyTokens: 1 },
    });
    expect(decision).toMatchObject({ allowed: false, scope: "issue", metric: "runs", observed: 6, limit: 6 });
  });

  it("does not let changed comment or wake identifiers reset issue usage", () => {
    const policy = { providerKey: "glm", windowMs: 1_800_000, issueMaxRuns: 6, issueMaxTokens: 25_000_000,
      agentMaxRuns: 20, agentMaxTokens: 75_000_000, companyMaxRuns: 150, companyMaxTokens: 200_000_000 };
    const observed = { issueRuns: 5, issueTokens: 25_000_000, agentRuns: 5, agentTokens: 25_000_000,
      companyRuns: 5, companyTokens: 25_000_000 };
    expect(decideProviderUsageAdmission({ policy, observed })).toMatchObject({
      allowed: false, scope: "issue", metric: "tokens",
    });
  });

  it("allows a different provider partition and a value just below every cap", () => {
    const policy = { providerKey: "glm", windowMs: 1_800_000, issueMaxRuns: 6, issueMaxTokens: 25_000_000,
      agentMaxRuns: 20, agentMaxTokens: 75_000_000, companyMaxRuns: 150, companyMaxTokens: 200_000_000 };
    expect(decideProviderUsageAdmission({
      policy,
      observed: { issueRuns: 5, issueTokens: 24_999_999, agentRuns: 19, agentTokens: 74_999_999,
        companyRuns: 149, companyTokens: 199_999_999 },
    })).toEqual({ allowed: true });
  });

  it("fails closed to the safe GLM policy when override JSON is invalid", () => {
    expect(providerUsagePoliciesFromEnv({ PAPERCLIP_PROVIDER_USAGE_LIMITS_JSON: "{" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerKey: "glm", issueMaxRuns: 6 })]),
    );
  });
});
