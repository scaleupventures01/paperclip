import { describe, expect, it, vi } from "vitest";
import {
  isRetryableSshGitBundleError,
  retrySshGitBundleImport,
} from "./ssh.js";

describe("SSH git bundle import retry", () => {
  it("retries one truncated bundle and returns the clean import", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("git fetch failed"), {
        stderr: "fatal: early EOF\nerror: index-pack died",
      }))
      .mockResolvedValueOnce("imported-head");

    await expect(retrySshGitBundleImport(operation)).resolves.toBe("imported-head");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unrelated git failure", async () => {
    const failure = new Error("fatal: cannot lock ref");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(retrySshGitBundleImport(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(isRetryableSshGitBundleError(failure)).toBe(false);
  });

  it("does not hide a second corrupt bundle", async () => {
    const failure = new Error("fatal: unexpected end of file");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(retrySshGitBundleImport(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
