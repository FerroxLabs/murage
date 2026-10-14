import { describe, expect, it, vi } from "vitest";
import { NATIVE_ACTION_BUSY, nativeActionMessage, runNativeAction } from "./native-action-error";

const timeout = () => new Error("Error invoking remote method 'desktop:artifact-action': TimeoutError: The operation was aborted due to timeout");

describe("native file action errors", () => {
  it("says Murage is busy for a timeout, with no channel text", () => {
    expect(nativeActionMessage(timeout(), "x")).toBe(NATIVE_ACTION_BUSY);
    expect(NATIVE_ACTION_BUSY).not.toMatch(/Error invoking|desktop:/);
  });
  it("keeps the server's sentence and drops the channel prefix", () => {
    expect(nativeActionMessage(new Error("Error invoking remote method 'desktop:workspace-file-action': Error: This file is unavailable. Refresh the workspace."), "x")).toBe("This file is unavailable. Refresh the workspace.");
  });
  it("retries a timeout once and succeeds", async () => {
    const call = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(undefined);
    await runNativeAction(call, "x", 0);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("retries at most once, then shows the busy sentence", async () => {
    const call = vi.fn().mockRejectedValue(timeout());
    await expect(runNativeAction(call, "x", 0)).rejects.toThrow(NATIVE_ACTION_BUSY);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("does not retry a refusal", async () => {
    const call = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'c': Error: This saved file is unavailable. Refresh Files."));
    await expect(runNativeAction(call, "x", 0)).rejects.toThrow("This saved file is unavailable. Refresh Files.");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
