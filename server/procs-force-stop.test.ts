// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CLI_CALLER_DEADLINE_MS, CLI_LIFECYCLE_CAP_MS, CLI_TERM_GRACE_MS, awaitCliTreeStopped, cliTreeConfirmedStopped, cliTreeStoppedSignal, forceCliTreeStopped, spawnCli } from "./procs.ts";
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
  const closedRoot = async () => {
    const root = spawnCli("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
    await once(root, "close"); // the close listener starts a stop whose platform answer is controlled by the test
    return root;
  };

  it("a caller with an explicit deadline reads not stopped at it, and a retry after the cache bound makes a fresh attempt that confirms", async () => {
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>(() => {}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = await closedRoot();
      const hung = awaitCliTreeStopped(root, undefined, CLI_CALLER_DEADLINE_MS);
      await vi.advanceTimersByTimeAsync(CLI_CALLER_DEADLINE_MS + 100);
      expect(await hung).toBe(false);
      setPlatformProcessHooks({});
      await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_LIFECYCLE_CAP_MS + 100);
      expect(await awaitCliTreeStopped(root, undefined, CLI_CALLER_DEADLINE_MS)).toBe(true);
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);

  it("a success that arrives after the cache bound still notifies the durable signal (late raw=true)", async () => {
    let confirm: (ok: boolean) => void = () => {};
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>((resolve) => { confirm = resolve; }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = await closedRoot();
      const early = awaitCliTreeStopped(root, undefined, CLI_CALLER_DEADLINE_MS);
      const signal = cliTreeStoppedSignal(root);
      let notified = false;
      void signal.then(() => { notified = true; });
      await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_LIFECYCLE_CAP_MS + 100);
      expect(await early).toBe(false);
      expect(notified).toBe(false);
      expect(cliTreeConfirmedStopped(root)).toBe(false);
      confirm(true); // the capped attempt finally succeeds
      expect(await signal).toBe(true);
      expect(notified).toBe(true);
      expect(cliTreeConfirmedStopped(root)).toBe(true);
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);

  it("a default caller waits exactly as 1.0.1 did: a confirmation at 5.501 s still returns true", async () => {
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), 5_501); }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = await closedRoot();
      const pending = awaitCliTreeStopped(root);
      await vi.advanceTimersByTimeAsync(5_700);
      expect(await pending).toBe(true);
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);

  it("once the group is seen gone it is never signalled again: a forced join or a retry cannot hit a replacement group with the same number", async () => {
    setPlatformProcessHooks({ confirmStopped: () => new Promise<boolean>(() => {}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = await closedRoot();
      await vi.advanceTimersByTimeAsync(200); // the stop saw the closed root's group gone and latched it
      const real = process.kill.bind(process);
      const calls: Array<[number, unknown]> = [];
      // from here on a replacement group holds the saved number: any signal to it would succeed
      const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => { calls.push([pid, sig]); return true; }) as typeof process.kill);
      try {
        const forced = forceCliTreeStopped(root); // joins the pending stop
        await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_LIFECYCLE_CAP_MS + 100);
        await forced;
        setPlatformProcessHooks({});
        expect(await awaitCliTreeStopped(root)).toBe(true); // the retry only re-runs the confirmation
        expect(calls.filter(([pid]) => pid < 0)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
      void real;
    } finally {
      setPlatformProcessHooks({});
      vi.useRealTimers();
    }
  }, 15_000);
});
