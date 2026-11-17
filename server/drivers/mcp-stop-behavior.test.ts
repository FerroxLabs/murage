// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace: black-box witnesses through the EXISTING entry points (ChatMcpDescendants, assertRelayAvailable). They run unchanged against the base commit and
// fail there by assertion, which is what ties the new proof modules to the behaviour the base gets wrong.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ChatMcpDescendants } from "./chat-mcp-client.ts";
import * as relay from "./cli-mount-relay.ts";
import { setPlatformProcessHooks } from "../platform-process-hooks.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(() => setPlatformProcessHooks({}));

describe("BH: base-red witnesses", () => {
  it("BH1 R5: ChatMcpDescendants.stop() never resolves true because the platform is win32", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    expect(await new ChatMcpDescendants(child, "win32").stop()).toBe(false);
  }, 20_000);

  describe.skipIf(process.platform !== "linux")("Linux", () => {
    it("BH2 the 1020 race: a process-list hook that never answers does not make the stop unprovable (no ps, no hook: the proof reads /proc itself)", async () => {
      setPlatformProcessHooks({ listTree: () => new Promise<number[]>(() => {}) });
      const root = spawn("sleep", ["30"], { stdio: "ignore" });
      try { expect(await new ChatMcpDescendants(root).stop()).toBe(true); } finally { root.kill("SIGKILL"); }
    }, 20_000);

    it("BH3 a listTree [] is never a verdict: a live setsid grandchild is found, ended and confirmed gone although the hook says nothing is left", async () => {
      setPlatformProcessHooks({ listTree: async () => [] });
      const root = spawn("sh", ["-c", "setsid sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
      let pid = 0;
      try {
        pid = await new Promise<number>((resolve) => root.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
        expect(alive(pid)).toBe(true);
        const descendants = new ChatMcpDescendants(root);
        descendants.track();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await descendants.stop()).toBe(true);
        expect(alive(pid), "the grandchild the hook did not list is dead").toBe(false);
      } finally { root.kill("SIGKILL"); if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }, 30_000);
  });

  it("BH5 S2/V2: a durable stop record holds its owner (botId ?? threadId) so the bot is refused before any relay exists; a proof releases it", () => {
    const turn = { warmIdentity: { botId: "bot-hold-1" }, threadId: "thread-hold-1" } as never;
    (relay as Record<string, any>).holdRecordOwner?.("bot-hold-1", "k1");
    expect(() => relay.assertRelayAvailable(turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    (relay as Record<string, any>).releaseRecordOwner?.("bot-hold-1", "k1");
    expect(() => relay.assertRelayAvailable(turn)).not.toThrow();
    // the owner key falls back to the thread when there is no bot
    const threadTurn = { threadId: "thread-hold-2" } as never;
    (relay as Record<string, any>).holdRecordOwner?.("thread-hold-2", "k2");
    expect(() => relay.assertRelayAvailable(threadTurn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    (relay as Record<string, any>).releaseRecordOwner?.("thread-hold-2", "k2");
  });
});
