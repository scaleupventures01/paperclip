import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  evaluateFleetReleaseGate,
  FLEET_RELEASE_GATE_ENV,
} from "../services/fleet-release-gate.js";

// agentos#596 follow-up D: wake admission honors the fleet release allowlist.
const dir = mkdtempSync(path.join(tmpdir(), "fleet-release-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function gateFile(name: string, body: string) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

const allowedId = "11111111-1111-4111-8111-111111111111";
const excludedId = "22222222-2222-4222-8222-222222222222";

describe("evaluateFleetReleaseGate", () => {
  it("refuses an agent missing from an enabled allowlist", () => {
    const file = gateFile("enabled.json", JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [allowedId] }));
    expect(evaluateFleetReleaseGate(excludedId, { env: { [FLEET_RELEASE_GATE_ENV]: file } }))
      .toMatchObject({ allowed: false });
  });

  it("refuses every agent when the enabled allowlist is empty (live 18:36Z config)", () => {
    const file = gateFile("empty.json", JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [] }));
    expect(evaluateFleetReleaseGate(allowedId, { env: { [FLEET_RELEASE_GATE_ENV]: file } }))
      .toMatchObject({ allowed: false });
  });

  it("allows an agent listed in an enabled allowlist", () => {
    const file = gateFile("enabled-in.json", JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [allowedId] }));
    expect(evaluateFleetReleaseGate(allowedId, { env: { [FLEET_RELEASE_GATE_ENV]: file } }))
      .toEqual({ allowed: true });
  });

  it("allows every agent when the gate is disabled", () => {
    const file = gateFile("disabled.json", JSON.stringify({ version: 1, enabled: false, allowedAgentIds: [] }));
    expect(evaluateFleetReleaseGate(excludedId, { env: { [FLEET_RELEASE_GATE_ENV]: file } }))
      .toEqual({ allowed: true });
  });

  it("has no effect when the environment variable is unset", () => {
    expect(evaluateFleetReleaseGate(excludedId, { env: {} })).toEqual({ allowed: true });
  });

  it("fails closed when the configured file cannot be read", () => {
    expect(evaluateFleetReleaseGate(allowedId, {
      env: { [FLEET_RELEASE_GATE_ENV]: path.join(dir, "missing.json") },
    })).toMatchObject({ allowed: false });
  });

  it("fails closed on malformed JSON or an unknown shape", () => {
    const broken = gateFile("broken.json", "{not json");
    const wrongVersion = gateFile("v2.json", JSON.stringify({ version: 2, enabled: true, allowedAgentIds: [allowedId] }));
    const noList = gateFile("nolist.json", JSON.stringify({ version: 1, enabled: true }));
    for (const file of [broken, wrongVersion, noList]) {
      expect(evaluateFleetReleaseGate(allowedId, { env: { [FLEET_RELEASE_GATE_ENV]: file } }))
        .toMatchObject({ allowed: false });
    }
  });

  it("reads the file on every call so cohort promotion needs no restart", () => {
    const file = gateFile("promote.json", JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [] }));
    const env = { [FLEET_RELEASE_GATE_ENV]: file };
    expect(evaluateFleetReleaseGate(allowedId, { env })).toMatchObject({ allowed: false });
    writeFileSync(file, JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [allowedId] }));
    expect(evaluateFleetReleaseGate(allowedId, { env })).toEqual({ allowed: true });
  });
});
