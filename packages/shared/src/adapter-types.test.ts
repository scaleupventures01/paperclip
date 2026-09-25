import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  AGENT_ROLE_FAMILIES,
  AGENT_ROLE_FAMILY_BY_ROLE,
  AGENT_ROLE_FAMILY_LABELS,
  AGENT_ROLE_LABELS,
  acceptInviteSchema,
  createAgentSchema,
  updateAgentSchema,
} from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts an explicit managed instructions bundle for new agents", () => {
    expect(
      createAgentSchema.parse({
        name: "Bundle Agent",
        adapterType: "codex_local",
        instructionsBundle: {
          files: {
            "AGENTS.md": "Use AGENTS.md.",
          },
        },
      }).instructionsBundle?.files["AGENTS.md"],
    ).toBe("Use AGENTS.md.");
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("accepts the security agent role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
  });

  it.each([
    ["program_manager", "Program Manager"],
    ["engagement_manager", "Engagement Manager"],
    ["spec_writer", "Spec Writer"],
    ["tester", "Tester"],
    ["builder", "Builder"],
    ["architect", "Architect"],
    ["release_manager", "Release Manager"],
    ["pod_devops", "Pod DevOps"],
    ["storage_steward", "Storage Steward"],
    ["maintenance_manager", "Maintenance Manager"],
    ["agent_improver", "Agent Improver"],
    ["agent_doctor", "Agent Doctor"],
    ["root_cause_engineer", "Root Cause Repair Engineer"],
    ["uptime_services", "Uptime and Services"],
    ["reviewer", "Reviewer"],
  ] as const)("accepts the %s agent role and exposes its UI label", (role, label) => {
    expect(
      createAgentSchema.parse({
        name: label,
        role,
        adapterType: "codex_local",
      }).role,
    ).toBe(role);

    expect(AGENT_ROLE_LABELS[role]).toBe(label);
  });

  it("maps every role to exactly one labeled role family", () => {
    expect(Object.keys(AGENT_ROLE_FAMILY_BY_ROLE).sort()).toEqual([...AGENT_ROLES].sort());
    expect(new Set(Object.values(AGENT_ROLE_FAMILY_BY_ROLE))).toEqual(new Set(AGENT_ROLE_FAMILIES));
    for (const role of AGENT_ROLES) {
      expect(AGENT_ROLE_FAMILY_LABELS[AGENT_ROLE_FAMILY_BY_ROLE[role]]).toBeTruthy();
    }
  });

  it("accepts the complete ScaleUp role taxonomy and rejects unknown roles", () => {
    for (const role of AGENT_ROLES) {
      expect(createAgentSchema.parse({ name: role, role, adapterType: "codex_local" }).role).toBe(role);
    }
    expect(() =>
      createAgentSchema.parse({
        name: "Unknown role",
        role: "unknown_role",
        adapterType: "codex_local",
      }),
    ).toThrow();
  });
});
