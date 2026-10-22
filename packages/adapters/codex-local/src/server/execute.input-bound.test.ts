import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeCodexAcp,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  executeCodexAcp: vi.fn(async () => {
    throw new Error("ACP must not be used for an explicit CLI run");
  }),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  tempCodexHome: "/tmp/paperclip-codex-input-bound-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => executeCodexAcp,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    adapterExecutionTargetIsRemote: () => false,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
      target: { kind: "local" },
      restoreWorkspace: async () => undefined,
    })),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async (command: string) => command),
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-home.js")>();
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    resolveSharedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", () => ({
  prepareCodexRuntimeConfig,
}));

import { execute } from "./execute.js";

const CODEX_MAX_INPUT_CHARS = 1_048_576;

describe("codex_local oversized Paperclip context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends one turn/start input at the documented limit and preserves retry context", async () => {
    const oversizedDescription = `x`.repeat(1_010_472);
    const metaRecords: unknown[] = [];
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codex-input-bound-"));
    cleanupDirs.push(fixtureRoot);
    const instructionsPath = path.join(fixtureRoot, "AGENTS.md");
    await writeFile(instructionsPath, "AGENT_INSTRUCTIONS_MARKER\n".padEnd(60_000, "i"));
    const result = await execute({
      runId: "run-oversized-context",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        cwd: "/tmp/oversized-context-workspace",
        env: { OPENAI_API_KEY: "test-key" },
        instructionsFilePath: instructionsPath,
        promptTemplate: "PROMPT_END_MARKER",
      },
      context: {
        paperclipIssue: {
          id: "issue-1",
          description: oversizedDescription,
        },
        paperclipTaskMarkdown: [
          "# Current task",
          "",
          "ISSUE_DESCRIPTION_MARKER",
          "",
          oversizedDescription,
        ].join("\n"),
        paperclipWake: {
          version: 1,
          reason: "issue_assigned",
          issue: {
            id: "issue-1",
            description: oversizedDescription,
          },
          executionContinuation: {
            version: 1,
            interruptedRunId: "interrupted-run-1",
            coverage: { kind: "full_task_history" },
            completedWork: "RETRY_CONTEXT_MARKER",
          },
        },
      },
      onLog: vi.fn(async () => {}),
      onMeta: vi.fn(async (meta: unknown) => {
        metaRecords.push(meta);
      }),
    } as never);

    expect(result.exitCode).toBe(0);
    expect(executeCodexAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    const transportOptions = (
      runAdapterExecutionTargetProcess.mock.calls as unknown as Array<
        [unknown, unknown, unknown, unknown, { stdin?: string }]
      >
    )[0]?.[4];
    const prompt = transportOptions.stdin ?? "";
    const metrics = (metaRecords[0] as { promptMetrics?: Record<string, unknown> }).promptMetrics ?? {};

    expect(prompt).toContain("RETRY_CONTEXT_MARKER");
    expect(prompt).toContain("PROMPT_END_MARKER");
    expect(prompt).not.toContain("ISSUE_DESCRIPTION_MARKER");
    expect(prompt.length).toBeLessThanOrEqual(CODEX_MAX_INPUT_CHARS);
    expect(prompt.match(/PROMPT_END_MARKER/g)).toHaveLength(1);
    expect(metrics.promptChars).toBe(prompt.length);
  });

  it("keeps the complete normal-size task brief", async () => {
    const description = "Normal-sized task description.";
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codex-input-normal-"));
    cleanupDirs.push(fixtureRoot);
    const instructionsPath = path.join(fixtureRoot, "AGENTS.md");
    await writeFile(instructionsPath, "AGENT_INSTRUCTIONS_MARKER\n".padEnd(27_850, "i"));

    await execute({
      runId: "run-normal-context",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: "codex",
        cwd: "/tmp/normal-context-workspace",
        env: { OPENAI_API_KEY: "test-key" },
        instructionsFilePath: instructionsPath,
        promptTemplate: "PROMPT_END_MARKER",
      },
      context: {
        paperclipIssue: { id: "issue-1", description },
        paperclipTaskMarkdown: `# Current task\n\nISSUE_DESCRIPTION_MARKER\n\n${description}`,
        paperclipWake: {
          version: 1,
          reason: "issue_assigned",
          issue: { id: "issue-1", description },
        },
      },
      onLog: vi.fn(async () => {}),
    } as never);

    const prompt = (
      runAdapterExecutionTargetProcess.mock.calls as unknown as Array<
        [unknown, unknown, unknown, unknown, { stdin?: string }]
      >
    )[0]?.[4].stdin ?? "";
    expect(prompt.length).toBeLessThanOrEqual(CODEX_MAX_INPUT_CHARS);
    expect(prompt).toContain("ISSUE_DESCRIPTION_MARKER");
    expect(prompt).toContain(description);
    expect(prompt).toContain("PROMPT_END_MARKER");
    expect(prompt).not.toContain("[PAPERCLIP_CONTEXT_BOUND:");
  });
});
