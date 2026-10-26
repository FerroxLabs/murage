// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client for the launcher's bot-state modes (CLOUD-ENGINES-DESIGN.md r9 "launcher modes"). Every call
// goes through the `launch` seam: a fake ChildProcess prints the launcher's answer. sudo is never spawned.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_RENEW_WINDOW_MS, assertCloudBotIdNotTombstoned, cloudBotStateRefusalCopy, cloudClaudeRenewalDue, installCloudBotGuards,
  queryCloudBotState, releaseCloudBotState, resetCloudBotStateForTests, type CloudLauncherSpawn,
} from "./bot-state.ts";
import { cloudHomeCopy } from "./copy.ts";
import { TURN_BOT, TURN_MARKER, cloudTurnBot, cloudTurnEnvironment, cloudTurnLaunch } from "./turn-process.ts";

interface FakeAnswer { code: number; stdout?: string | Buffer; stderr?: string | Buffer }
/** A launcher that records each request and answers with `answer` on its pipes, then exits. */
function fakeLauncher(answer: FakeAnswer) {
  const requests: Record<string, unknown>[] = [];
  const launch: CloudLauncherSpawn = (request) => {
    requests.push(JSON.parse(JSON.stringify(request)) as Record<string, unknown>);
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    setImmediate(() => {
      if (answer.stdout !== undefined) stdout.write(answer.stdout);
      if (answer.stderr !== undefined) stderr.write(answer.stderr);
      stdout.end(); stderr.end();
      setImmediate(() => (child as unknown as EventEmitter).emit("close", answer.code));
    });
    return child;
  };
  return { launch, requests };
}
const query = (body: unknown) => fakeLauncher({ code: 0, stdout: JSON.stringify(body) });

beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); resetCloudBotStateForTests(); });
afterEach(() => { vi.unstubAllEnvs(); resetCloudBotStateForTests(); });

describe("queryCloudBotState", () => {
  it("parses names and timestamps; unknown modes read as null and non-object engine entries are left out", async () => {
    const fake = query({ tombstoned: false, engines: {
      codex: { mode: "apikey", signedIn: true, expiresAt: null },
      claudeAgent: { mode: "oauth-token", signedIn: true, expiresAt: 1_900_000_000, source: "bot" },
      grokAgent: { mode: "password", signedIn: "yes", expiresAt: "soon" },
      kimiAgent: "signed-in", opencodeGo: null, qwenAgent: [1, 2],
    } });
    const state = await queryCloudBotState("bot-atlas", fake.launch);
    expect(state).toEqual({ tombstoned: false, engines: {
      codex: { mode: "apikey", signedIn: true, expiresAt: null, source: null },
      claudeAgent: { mode: "oauth-token", signedIn: true, expiresAt: 1_900_000_000, source: "bot" },
      grokAgent: { mode: null, signedIn: false, expiresAt: null, source: null },
    } });
  });
  it("sends only mode and bot, and no bot at all for the engine-wide stores", async () => {
    const withBot = query({ tombstoned: false, engines: {} });
    await queryCloudBotState("bot-atlas", withBot.launch);
    expect(withBot.requests).toEqual([{ mode: "bot-state-query", bot: "bot-atlas" }]);
    const engineWide = query({ tombstoned: false, engines: {} });
    await queryCloudBotState(undefined, engineWide.launch);
    expect(engineWide.requests).toEqual([{ mode: "bot-state-query" }]);
  });
  it("throws on a failed exit or an unreadable answer", async () => {
    await expect(queryCloudBotState("bot-atlas", fakeLauncher({ code: 1, stderr: "Cloud launcher refused\nmore" }).launch)).rejects.toThrow("Cloud launcher refused");
    await expect(queryCloudBotState("bot-atlas", fakeLauncher({ code: 0, stdout: "not json" }).launch)).rejects.toThrow(cloudHomeCopy.cloudBotStateUnreadable);
    await expect(queryCloudBotState("bot-atlas", fakeLauncher({ code: 0, stdout: "null" }).launch)).rejects.toThrow(cloudHomeCopy.cloudBotStateUnreadable);
  });
  it("keeps at most 64 KiB of each stream: an oversized answer is unreadable, never a partial state", async () => {
    const huge = JSON.stringify({ tombstoned: true, engines: {}, pad: "x".repeat(200 * 1024) });
    await expect(queryCloudBotState("bot-atlas", fakeLauncher({ code: 0, stdout: huge }).launch)).rejects.toThrow(cloudHomeCopy.cloudBotStateUnreadable);
    const noisy = fakeLauncher({ code: 1, stderr: "y".repeat(200 * 1024) });
    const error = await queryCloudBotState("bot-atlas", noisy.launch).catch((caught: Error) => caught);
    expect((error as Error).message.length).toBe(64 * 1024);
  });
});

describe("releaseCloudBotState", () => {
  it("exit 0 releases; the request carries only mode and bot", async () => {
    const fake = fakeLauncher({ code: 0 });
    await expect(releaseCloudBotState("bot-atlas", fake.launch)).resolves.toBeUndefined();
    expect(fake.requests).toEqual([{ mode: "bot-state-release", bot: "bot-atlas" }]);
  });
  it("exit 1 throws the launcher's line, and the owner reads it in plain words", async () => {
    const inUse = await releaseCloudBotState("bot-atlas", fakeLauncher({ code: 1, stderr: "Cloud bot state is in use\n" }).launch).catch((error: Error) => error);
    expect((inUse as Error).message).toBe("Cloud bot state is in use");
    expect(cloudBotStateRefusalCopy(inUse)).toBe(cloudHomeCopy.cloudBotStateInUse);
    const releasing = await releaseCloudBotState("bot-atlas", fakeLauncher({ code: 1, stderr: "Cloud bot state is being released" }).launch).catch((error: Error) => error);
    expect(cloudBotStateRefusalCopy(releasing)).toBe(cloudHomeCopy.cloudBotStateBeingReleased);
    const silent = await releaseCloudBotState("bot-atlas", fakeLauncher({ code: 1 }).launch).catch((error: Error) => error);
    expect(cloudBotStateRefusalCopy(silent)).toBe(cloudHomeCopy.cloudBotStateReleaseFailed);
    expect(cloudBotStateRefusalCopy(new Error("EACCES /usr/bin/sudo"))).toBe(cloudHomeCopy.cloudBotStateReleaseFailed);
  });
  it("refuses a bad bot id before anything is spawned", async () => {
    for (const bad of ["", "../etc", "a b", "x".repeat(65), "bot;rm"]) {
      const fake = fakeLauncher({ code: 0 });
      await expect(releaseCloudBotState(bad, fake.launch)).rejects.toThrow();
      await expect(queryCloudBotState(bad, fake.launch)).rejects.toThrow();
      await expect(assertCloudBotIdNotTombstoned(bad, fake.launch)).rejects.toThrow();
      expect(fake.requests).toEqual([]);
    }
  });
});

describe("tombstones and the Store hooks", () => {
  it("assertCloudBotIdNotTombstoned refuses a tombstoned id and passes a fresh one", async () => {
    await expect(assertCloudBotIdNotTombstoned("bot-gone", query({ tombstoned: true, engines: {} }).launch)).rejects.toThrow(cloudHomeCopy.cloudBotIdTombstoned);
    await expect(assertCloudBotIdNotTombstoned("bot-new", query({ tombstoned: false, engines: {} }).launch)).resolves.toBeUndefined();
  });
  it("the Store hooks refuse what the launcher tombstoned or never released", async () => {
    const store: { botIdGuard?: (id: string) => void; releaseBotState?: (id: string) => void } = {};
    installCloudBotGuards(store);
    expect(() => store.releaseBotState!("bot-atlas")).toThrow(cloudHomeCopy.cloudBotStateNotReleased);
    await releaseCloudBotState("bot-atlas", fakeLauncher({ code: 0 }).launch);
    expect(() => store.releaseBotState!("bot-atlas")).not.toThrow();
    expect(() => store.botIdGuard!("bot-atlas")).toThrow(cloudHomeCopy.cloudBotIdTombstoned);
    await queryCloudBotState("bot-old", query({ tombstoned: true, engines: {} }).launch);
    expect(() => store.botIdGuard!("bot-old")).toThrow(cloudHomeCopy.cloudBotIdTombstoned);
    expect(() => store.botIdGuard!("bot-fresh")).not.toThrow();
  });
});

describe("off a Cloud home", () => {
  it("every call is a no-op and nothing is spawned", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const fake = fakeLauncher({ code: 1, stderr: "Cloud bot state is in use" });
    await expect(queryCloudBotState("bot-atlas", fake.launch)).resolves.toEqual({ tombstoned: false, engines: {} });
    await expect(releaseCloudBotState("bot-atlas", fake.launch)).resolves.toBeUndefined();
    await expect(assertCloudBotIdNotTombstoned("bot-atlas", fake.launch)).resolves.toBeUndefined();
    await expect(cloudClaudeRenewalDue(false, { launch: fake.launch })).resolves.toBe(false);
    const store: { botIdGuard?: (id: string) => void; releaseBotState?: (id: string) => void } = {};
    installCloudBotGuards(store);
    expect(store).toEqual({});
    expect(fake.requests).toEqual([]);
  });
});

describe("Claude sign-in renewal", () => {
  const now = Date.UTC(2026, 9, 16);
  const claude = (expiresAt: number | null, mode = "oauth-token") => query({ tombstoned: false, engines: { claudeAgent: { mode, signedIn: true, expiresAt } } }).launch;
  it("is due within 30 days of expiry (seconds or milliseconds) and on the authentication-error path", async () => {
    expect(await cloudClaudeRenewalDue(true, { now, launch: claude(now + CLAUDE_RENEW_WINDOW_MS - 1000) })).toBe(true);
    expect(await cloudClaudeRenewalDue(true, { now, launch: claude(Math.floor((now + 10 * 86_400_000) / 1000)) })).toBe(true);
    expect(await cloudClaudeRenewalDue(true, { now, launch: claude(now + 200 * 86_400_000) })).toBe(false);
    expect(await cloudClaudeRenewalDue(false, { now, launch: claude(now + 200 * 86_400_000) })).toBe(true);
  });
  it("never flags a home with no enrolled token, and a launcher failure is not fatal", async () => {
    expect(await cloudClaudeRenewalDue(false, { now, launch: query({ tombstoned: false, engines: {} }).launch })).toBe(false);
    expect(await cloudClaudeRenewalDue(true, { now, launch: claude(null) })).toBe(false);
    expect(await cloudClaudeRenewalDue(false, { now, launch: fakeLauncher({ code: 1, stderr: "Cloud launcher refused" }).launch })).toBe(false);
    expect(await cloudClaudeRenewalDue(false, { now, launch: () => { throw new Error("spawn failed"); } })).toBe(false);
  });
});

describe("every Cloud spawn site names its bot", () => {
  it("the turn request carries the bot, never the child's environment", () => {
    const env = cloudTurnEnvironment("codex", {});
    cloudTurnBot(env, "bot-atlas");
    expect(env[TURN_BOT]).toBe("bot-atlas");
    const request = JSON.parse(cloudTurnLaunch("/opt/murage/bin/codex", ["app-server"], env)!.request) as { bot?: string; env: Record<string, string> };
    expect(request.bot).toBe("bot-atlas");
    expect(Object.keys(request.env)).not.toContain(TURN_BOT);
    cloudTurnBot(env, undefined);
    expect(env[TURN_BOT]).toBeUndefined();
    expect(JSON.parse(cloudTurnLaunch("/opt/murage/bin/codex", ["--version"], env)!.request)).not.toHaveProperty("bot");
    expect(env[TURN_MARKER]).toBe("codex");
  });
  it("each driver's turn spawn stamps the bot; the CLI test probe runs --version and carries none", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    for (const path of ["../drivers/claude.ts", "../drivers/codex.ts", "../drivers/acp/core.ts", "../drivers/pi.ts", "../drivers/antigravity.ts"]) {
      expect(source(path), path).toContain("cloudTurnBot(");
      expect(source(path), path).toMatch(/cloudTurnBot\(\w+, turn\.warmIdentity\?\.botId\)/);
    }
    const index = source("../index.ts");
    const probe = index.slice(index.indexOf("async function testCliBinary("), index.indexOf("async function testCliBinary(") + 2000);
    expect(probe).toContain('["--version"]');
    expect(probe).not.toContain("cloudTurnBot");
  });
});
