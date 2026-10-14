import { readFileSync } from "node:fs";

/**
 * AgentOS fleet release gate at wake admission (agentos#596).
 *
 * During a staged fleet release only the current cohort may run. The policy
 * file is the same one the startup route patch reads
 * (infra config/paperclip/fleet-release-gate/apply.py): JSON
 * {"version":1,"enabled":true,"allowedAgentIds":[...]}, located by the
 * AGENTOS_FLEET_RELEASE_GATE environment variable. It is read on every call so
 * cohort promotion needs no restart.
 *
 * - Env unset or empty: no effect.
 * - Unreadable file or invalid JSON: refuse (fail closed).
 * - version 1, enabled false: no effect (the rollout is over).
 * - version 1, enabled true, allowedAgentIds an array: allow only listed ids.
 * - Any other shape: refuse (fail closed).
 */
export const FLEET_RELEASE_GATE_ENV = "AGENTOS_FLEET_RELEASE_GATE";
export const FLEET_RELEASE_GATE_SKIP_REASON = "fleet_release_gate.not_allowed";

export type FleetReleaseGateDecision =
  | { allowed: true }
  | { allowed: false; message: string };

export function evaluateFleetReleaseGate(
  agentId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
  } = {},
): FleetReleaseGateDecision {
  const env = options.env ?? process.env;
  const path = env[FLEET_RELEASE_GATE_ENV] ?? "";
  if (!path) return { allowed: true };

  const readFile = options.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  let gate: unknown;
  try {
    gate = JSON.parse(readFile(path));
  } catch {
    return { allowed: false, message: "Fleet release gate is unavailable; wake refused" };
  }

  const record = gate && typeof gate === "object" && !Array.isArray(gate)
    ? (gate as Record<string, unknown>)
    : null;
  if (record?.version === 1 && record.enabled === false) return { allowed: true };
  const allowedAgentIds =
    record?.version === 1 && record.enabled === true && Array.isArray(record.allowedAgentIds)
      ? record.allowedAgentIds
      : null;
  if (!allowedAgentIds) {
    return { allowed: false, message: "Fleet release gate is invalid; wake refused" };
  }
  if (!allowedAgentIds.includes(agentId)) {
    return { allowed: false, message: "Fleet release gate does not release this agent; wake refused" };
  }
  return { allowed: true };
}
