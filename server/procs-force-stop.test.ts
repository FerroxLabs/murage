// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CLI_CONFIRM_CAP_MS, CLI_LIFECYCLE_CAP_MS, CLI_TERM_GRACE_MS, awaitCliTreeStopped, cliTreeStopOutcome, forceCliTreeStopped, spawnCli } from "./procs.ts";
import { setPlatformProcessHooks } from "./platform-process-hooks.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === "win32")("forced stop of an owned CLI tree (POSIX)", () => {
  it("an already-closed root with a SIGTERM-resistant child is killed at once, not after the 3 s grace", async () => {
    // The root prints its child's pid and exits; the child ignores SIGTERM.
    const root = spawnCli("sh", ["-c", "(trap '' TERM; exec sleep 30 >/dev/null 2>&1 </dev/null) & echo $!; exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    root.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    await once(root, "close"); // the close listener has begun the ordinary 3 s stop
    const grandchild = Number(out.trim());
    expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
    expect(alive(grandchild)).toBe(true);
    const started = Date.now();
    expect(await forceCliTreeStopped(root)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(alive(grandchild)).toBe(false);
  }, 15_000);

  it("a plain stop keeps its SIGTERM grace (the escalation is only for a forced one)", async () => {
    const root = spawnCli("sh", ["-c", "(trap '' TERM; exec sleep 30 >/dev/null 2>&1 </dev/null) & echo $!; exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    root.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    await once(root, "close");
    const grandchild = Number(out.trim());
    const started = Date.now();
    expect(await awaitCliTreeStopped(root)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
    expect(alive(grandchild)).toBe(false);
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("a confirmation that never resolves is bounded (POSIX)", () => {
  it("a caller reads not stopped at its own deadline, the hung lifecycle is shared, and a retry after its bound confirms", async () => {
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>(() => {}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = spawnCli("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
      await once(root, "close"); // the close listener starts a stop whose platform answer never comes
      const hung = awaitCliTreeStopped(root);
      await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_CONFIRM_CAP_MS + 100);
      expect(await hung).toBe(false);
      setPlatformProcessHooks({});
      await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_LIFECYCLE_CAP_MS + 100);
      expect(await awaitCliTreeStopped(root)).toBe(true);
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);

  it("a slow confirmation that succeeds after a caller's deadline still reaches that caller's lifecycle and later callers", async () => {
    let confirm: (ok: boolean) => void = () => {};
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>((resolve) => { confirm = resolve; }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = spawnCli("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
      await once(root, "close");
      const early = awaitCliTreeStopped(root);
      const lifecycle = cliTreeStopOutcome(root);
      await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_CONFIRM_CAP_MS + 100);
      expect(await early).toBe(false); // its deadline passed
      confirm(true); // the shared confirmation finally succeeds
      expect(await lifecycle).toBe(true);
      expect(await awaitCliTreeStopped(root)).toBe(true);
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);
});
