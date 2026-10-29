import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  createCodexProcessActivityMonitor,
  sampleCodexProcessActivity,
  type CodexProcessActivitySnapshot,
} from "./process-activity-monitor.js";

class PollHarness {
  private callback: (() => void) | null = null;

  setTimer = (callback: () => void) => {
    this.callback = callback;
    return callback;
  };

  clearTimer = () => {
    this.callback = null;
  };

  async poll(): Promise<void> {
    await vi.waitFor(() => expect(this.callback).not.toBeNull());
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function snapshot(cpuTicks: number, ioBytes: number, processIds = "100"): CodexProcessActivitySnapshot {
  return { cpuTicks, ioBytes, processIds };
}

describe("createCodexProcessActivityMonitor", () => {
  it.skipIf(process.platform === "win32")(
    "samples POSIX process-group churn on every supported host",
    async () => {
      const shell = spawn("sh", ["-c", "sleep 30 & sleep 31 & wait"], {
        detached: true,
        stdio: "ignore",
      });
      const processGroupId = shell.pid!;

      try {
        const baseline = await vi.waitFor(
          async () => {
            const snapshot = await sampleCodexProcessActivity(processGroupId, processGroupId);
            expect(snapshot).not.toBeNull();
            expect(snapshot!.processIds.split(",").length).toBeGreaterThan(1);
            return snapshot!;
          },
          { interval: 100, timeout: 3_000 },
        );
        const processIds = baseline.processIds.split(",").map(Number);
        const childToExit = processIds.find((processId) => processId !== processGroupId);
        expect(childToExit).toBeGreaterThan(0);

        process.kill(childToExit!, "SIGKILL");
        await vi.waitFor(
          async () => {
            const current = await sampleCodexProcessActivity(processGroupId, processGroupId);
            expect(current).not.toBeNull();
            expect(current!.processIds).not.toBe(baseline.processIds);
          },
          { interval: 100, timeout: 3_000 },
        );
      } finally {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          // The process group may already be gone.
        }
        shell.kill("SIGKILL");
      }
    },
    10_000,
  );

  it("requires a baseline and ignores sub-threshold CPU changes", async () => {
    const samples = [snapshot(100, 1_000), snapshot(114, 1_000)];
    const harness = new PollHarness();
    const onActivity = vi.fn();
    const monitor = createCodexProcessActivityMonitor({
      pid: 100,
      processGroupId: 100,
      intervalMs: 15_000,
      sample: async () => samples.shift() ?? null,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      onActivity,
    });

    await harness.poll();
    await vi.waitFor(() => expect(onActivity).not.toHaveBeenCalled());
    monitor.stop();
  });

  it.each([
    ["CPU growth", snapshot(115, 1_000)],
    ["I/O growth", snapshot(100, 1_001)],
    ["process-group churn", snapshot(100, 1_000, "100,101")],
  ])("reports %s as process activity", async (_label, activeSnapshot) => {
    const samples = [snapshot(100, 1_000), activeSnapshot];
    const harness = new PollHarness();
    const onActivity = vi.fn();
    const monitor = createCodexProcessActivityMonitor({
      pid: 100,
      processGroupId: 100,
      intervalMs: 15_000,
      sample: async () => samples.shift() ?? null,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      onActivity,
    });

    await harness.poll();
    await vi.waitFor(() => expect(onActivity).toHaveBeenCalledTimes(1));
    monitor.stop();
  });

  it("resets its comparison baseline after an unavailable sample", async () => {
    const samples = [snapshot(100, 1_000), null, snapshot(200, 2_000), snapshot(215, 2_000)];
    const harness = new PollHarness();
    const onActivity = vi.fn();
    const monitor = createCodexProcessActivityMonitor({
      pid: 100,
      processGroupId: 100,
      intervalMs: 15_000,
      sample: async () => samples.shift() ?? null,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      onActivity,
    });

    await harness.poll();
    await harness.poll();
    await vi.waitFor(() => expect(onActivity).not.toHaveBeenCalled());
    await harness.poll();
    await vi.waitFor(() => expect(onActivity).toHaveBeenCalledTimes(1));
    monitor.stop();
  });
});
