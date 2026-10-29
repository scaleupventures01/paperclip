import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEX_PROCESS_ACTIVITY_POLL_INTERVAL_MS = 15_000;

export interface CodexProcessActivitySnapshot {
  cpuTicks: number;
  ioBytes: number;
  processIds: string;
}

export interface CodexProcessActivityMonitorOptions {
  pid: number;
  processGroupId: number | null;
  onActivity: () => void;
  intervalMs?: number;
  sample?: () => Promise<CodexProcessActivitySnapshot | null>;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CodexProcessActivityMonitorHandle {
  stop(): void;
}

function parseProcStat(stat: string): { processGroupId: number; cpuTicks: number } | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (![processGroupId, userTicks, systemTicks].every(Number.isFinite)) return null;
  return { processGroupId, cpuTicks: userTicks + systemTicks };
}

function parseProcIo(io: string): number {
  let bytes = 0;
  for (const line of io.split("\n")) {
    const match = /^(?:read_bytes|write_bytes):\s+(\d+)$/.exec(line.trim());
    if (match) bytes += Number(match[1]);
  }
  return bytes;
}

function parseCpuTimeToTicks(value: string): number | null {
  const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, hours = "0", minutes, seconds] = match;
  const numericHours = Number(hours);
  const numericMinutes = Number(minutes);
  const numericSeconds = Number(seconds);
  if (![numericHours, numericMinutes, numericSeconds].every(Number.isFinite)) return null;
  return Math.round((numericHours * 3_600 + numericMinutes * 60 + numericSeconds) * 100);
}

export async function sampleCodexProcessActivity(
  pid: number,
  processGroupId: number | null,
): Promise<CodexProcessActivitySnapshot | null> {
  if (process.platform === "darwin") {
    const targetProcessGroupId = processGroupId && processGroupId > 0 ? processGroupId : null;
    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,cputime="], {
        timeout: 5_000,
        maxBuffer: 4 * 1_024 * 1_024,
      });
      const processIds: number[] = [];
      let cpuTicks = 0;
      for (const line of stdout.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 3) continue;
        const processId = Number(fields[0]);
        const parsedProcessGroupId = Number(fields[1]);
        const parsedCpuTicks = parseCpuTimeToTicks(fields.slice(2).join(" "));
        if (![processId, parsedProcessGroupId, parsedCpuTicks].every(Number.isFinite)) continue;
        if (
          targetProcessGroupId !== null
            ? parsedProcessGroupId !== targetProcessGroupId
            : processId !== pid
        ) {
          continue;
        }
        processIds.push(processId);
        cpuTicks += parsedCpuTicks!;
      }
      if (processIds.length === 0) return null;
      processIds.sort((left, right) => left - right);
      return { cpuTicks, ioBytes: 0, processIds: processIds.join(",") };
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  const targetProcessGroupId = processGroupId && processGroupId > 0 ? processGroupId : null;
  const entries = targetProcessGroupId ? await fs.readdir("/proc") : [String(pid)];
  const processIds: number[] = [];
  let cpuTicks = 0;
  let ioBytes = 0;

  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      try {
        const parsed = parseProcStat(await fs.readFile(`/proc/${entry}/stat`, "utf8"));
        if (!parsed) return;
        if (targetProcessGroupId !== null && parsed.processGroupId !== targetProcessGroupId) return;
        if (targetProcessGroupId === null && Number(entry) !== pid) return;
        const io = await fs.readFile(`/proc/${entry}/io`, "utf8").catch(() => "");
        processIds.push(Number(entry));
        cpuTicks += parsed.cpuTicks;
        ioBytes += parseProcIo(io);
      } catch {
        // Processes can exit between listing /proc and reading their stat file.
      }
    }),
  );

  if (processIds.length === 0) return null;
  processIds.sort((left, right) => left - right);
  return { cpuTicks, ioBytes, processIds: processIds.join(",") };
}

export function createCodexProcessActivityMonitor(
  options: CodexProcessActivityMonitorOptions,
): CodexProcessActivityMonitorHandle {
  const intervalMs = options.intervalMs ?? CODEX_PROCESS_ACTIVITY_POLL_INTERVAL_MS;
  const sample = options.sample ?? (() => sampleCodexProcessActivity(options.pid, options.processGroupId));
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const minimumCpuTickDelta = Math.max(1, Math.floor(intervalMs / 1_000));
  let previous: CodexProcessActivitySnapshot | null = null;
  let timer: unknown = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      void poll();
    }, intervalMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  };

  const poll = async () => {
    if (stopped) return;
    const current = await sample().catch(() => null);
    if (stopped) return;
    if (
      current &&
      previous &&
      (current.cpuTicks - previous.cpuTicks >= minimumCpuTickDelta ||
        current.ioBytes > previous.ioBytes ||
        current.processIds !== previous.processIds)
    ) {
      options.onActivity();
    }
    previous = current;
    schedule();
  };

  void poll();

  return {
    stop() {
      stopped = true;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
