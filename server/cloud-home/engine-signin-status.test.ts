// F4 (C2): on a Cloud home a signed-in engine must read as signed in to the new-bot ranking, and a bot with
// no sign-in of its own must read as needing one. The sign-ins are root-only per-bot stores; the server's own
// probes run outside any bot, so every driver's check read "not signed in" there and a new bot fell to Fuigo.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickDefaultEngine, type EngineReading } from "../default-engine.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { KimiAgentDriver } from "../drivers/acp/kimi.ts";
import { createOpenCodeDriver } from "../drivers/acp/opencode-go.ts";
import { AntigravityDriver } from "../drivers/antigravity.ts";
import type { CloudLauncherSpawn } from "./bot-state.ts";
import { botEngineSignIn, botEngineSignedIn, cloudEngineSignedInSomewhere, configureCloudSignIns } from "./signin-status.ts";
import { botSignInLines } from "./engine-signins.ts";

// A home runs the server's probes through the launcher with no bot: the launcher stages no sign-in into them, so
// `login status` says "Not logged in" whoever is signed in, and `--version` answers.
const probe = vi.hoisted(() => ({ ownLoggedIn: false }));
vi.mock("../procs.ts", async (original) => ({
  ...(await original<typeof import("../procs.ts")>()),
  execCli: (cli: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr?: string) => void) => {
    if (args[0] === "login" && args[1] === "status" && probe.ownLoggedIn) cb(null, "Logged in using ChatGPT\n", "");
    else if (args[0] === "login" && args[1] === "status") cb(new Error("Cloud CLI probe failed"), "", "Not logged in\n");
    else if (args[0] === "--version") cb(null, cli.endsWith("/agy") ? "1.4.4\n" : `${cli.split("/").pop()} 1.4.4\n`, "");
    else cb(new Error("Cloud CLI probe failed"), "", "");
  },
}));

type Stores = { home?: string[]; bots: Record<string, string[]> };
/** The launcher's bot-state-query as bot_state_query() answers it: the C store wins, then the bot's own store. */
const launcherFor = (stores: Stores): CloudLauncherSpawn => (request) => {
  const bot = request.bot as string | undefined;
  const signedIn = new Set([...(stores.home ?? []), ...(bot ? stores.bots[bot] ?? [] : [])]);
  const engines = Object.fromEntries([...signedIn].map((name) => [name, { mode: "oauth", signedIn: true, expiresAt: null }]));
  return child(0, JSON.stringify({ tombstoned: false, engines }));
};
function child(code: number, stdout: string, stderr = ""): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const out = new PassThrough(), err = new PassThrough();
  Object.assign(proc, { stdout: out, stderr: err, stdin: new PassThrough(), kill: () => true });
  setImmediate(() => { out.end(stdout); err.end(stderr); setImmediate(() => (proc as unknown as EventEmitter).emit("close", code)); });
  return proc;
}
const BOTS = ["bot-a", "bot-b"];
const catalog = { default: "m", options: [{ id: "m", label: "m" }] };

describe("engine sign-in status on a Cloud home (F4 C2)", () => {
  beforeEach(() => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); configureCloudSignIns(); });

  const create = async (kind: string) => {
    const base = { instanceId: kind, displayName: kind, environment: {}, enabled: true };
    switch (kind) {
      case "codex": return CodexDriver.create({ ...base, config: { cli: "/opt/murage/bin/codex", fullAuto: false } });
      case "grokAgent": return GrokAgentDriver.create({ ...base, config: GrokAgentDriver.decodeConfig({ cli: "/opt/murage/bin/grok", fullAuto: false }) });
      case "kimiAgent": return KimiAgentDriver.create({ ...base, config: KimiAgentDriver.decodeConfig({ cli: "/opt/murage/bin/kimi", fullAuto: false }) });
      case "opencodeGo": return createOpenCodeDriver(async () => catalog).create({ ...base, config: { cli: "/opt/murage/bin/opencode", fullAuto: false } });
      default: return AntigravityDriver.create({ ...base, config: { cli: "/opt/murage/bin/agy", fullAuto: false } });
    }
  };
  const engines: Array<[string, string]> = [["codex", "codex"], ["grokAgent", "grokAgent"], ["kimiAgent", "kimiAgent"], ["opencodeGo", "opencodeGo"], ["antigravityAgent", "antigravity"]];

  it.each(engines)("%s: signed in on bot-a only reads as signed in for the home, and not for bot-b", async (kind, launcherName) => {
    configureCloudSignIns({ bots: () => BOTS, launch: launcherFor({ bots: { "bot-a": [launcherName] } }) });
    const instance = await create(kind);
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
      expect(await cloudEngineSignedInSomewhere(kind)).toBe(true);
      expect(await botEngineSignedIn(kind, "bot-a")).toBe(true);
      // Per-bot, no shared token: bot-b has nothing of its own, so it needs its own sign-in.
      expect(await botEngineSignedIn(kind, "bot-b")).toBe(false);
    } finally { await instance.dispose(); }
  });

  it.each(engines)("%s: nobody signed in anywhere is not reported as signed in", async (kind) => {
    configureCloudSignIns({ bots: () => BOTS, launch: launcherFor({ bots: {} }) });
    const instance = await create(kind);
    try {
      expect((await instance.snapshot()).authenticated).not.toBe(true);
      expect(await cloudEngineSignedInSomewhere(kind)).toBe(false);
    } finally { await instance.dispose(); }
  });

  it("a launcher that cannot answer changes nothing (the driver's own reading stands)", async () => {
    configureCloudSignIns({ bots: () => BOTS, launch: () => child(1, "", "Cloud bot state unreadable") });
    expect(await cloudEngineSignedInSomewhere("codex")).toBeUndefined();
    const instance = await create("codex");
    try { expect((await instance.snapshot()).authenticated).toBe(false); } finally { await instance.dispose(); }
  });

  it("off a home nothing is asked of the launcher", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const launch = vi.fn(launcherFor({ bots: { "bot-a": ["codex"] } }));
    configureCloudSignIns({ bots: () => BOTS, launch });
    expect(await cloudEngineSignedInSomewhere("codex")).toBeUndefined();
    expect(await botEngineSignedIn("codex", "bot-a")).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  // THE RULE (F4-CLOUD-SIGNIN-BRIEF.md 3.8, C2): "The ranking reads per-bot status. A new bot on a home where any bot
  // is signed in to engine E is offered 'Sign <bot> in to E' before it falls back. It never drops silently to the
  // metered engine." So with bot-a signed in to Codex, bot-b's default is Codex (and bot-b itself reads
  // 'needs sign-in'), NOT Fuigo; with nobody signed in, Fuigo stays the default.
  it("new bot default: Codex signed in on bot-a puts bot-b on Codex (needs sign-in), never silently on metered Fuigo", async () => {
    const pick = async (stores: Stores) => {
      configureCloudSignIns({ bots: () => BOTS, launch: launcherFor(stores) });
      const codex = await create("codex");
      try {
        const described: EngineReading[] = [
          { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux-1" } },
          { instanceId: "codex", driverKind: "codex", snapshot: await codex.snapshot(), models: { default: "gpt-5" } },
        ];
        return pickDefaultEngine(described).instanceId;
      } finally { await codex.dispose(); }
    };
    expect(await pick({ bots: { "bot-a": ["codex"] } })).toBe("codex");
    expect(await botEngineSignedIn("codex", "bot-b")).toBe(false);
    expect(await pick({ bots: {} })).toBe("fuigo");
  });

  it("botEngineSignIn says which store answered for the bot (Claude: its own or the home's), and nothing else", async () => {
    const launch: CloudLauncherSpawn = (request) => child(0, JSON.stringify({ tombstoned: false, engines: {
      claudeAgent: { mode: "oauth-token", signedIn: true, expiresAt: 5, source: request.bot === "bot-a" ? "bot" : "home" },
      codex: { mode: "chatgpt", signedIn: false, expiresAt: null, source: "home" } } }));
    configureCloudSignIns({ bots: () => BOTS, launch });
    expect(await botEngineSignIn("claudeAgent", "bot-a")).toEqual({ signedIn: true, source: "bot" });
    expect(await botEngineSignIn("claudeAgent", "bot-b")).toEqual({ signedIn: true, source: "home" });
    expect(await botEngineSignIn("codex", "bot-a")).toEqual({ signedIn: false, source: null });
    expect(await botEngineSignIn("grokAgent", "bot-a")).toEqual({ signedIn: false, source: null });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(await botEngineSignIn("claudeAgent", "bot-a")).toBeUndefined();
  });
});

describe("the launcher read behind the status (cache, failures, limits)", () => {
  beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); configureCloudSignIns(); });
  const reply = (engines: Record<string, boolean>): ChildProcess => child(0, JSON.stringify({ tombstoned: false, engines: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, { mode: "oauth", signedIn: v, expiresAt: null, source: "home" }])) }));

  it("overlapping questions share one read, and the TTL runs from when it finished", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launch = vi.fn((_request: Record<string, unknown>) => reply({ codex: true }));
    configureCloudSignIns({ bots: () => ["bot-a"], launch });
    await Promise.all([cloudEngineSignedInSomewhere("codex"), cloudEngineSignedInSomewhere("codex"), cloudEngineSignedInSomewhere("grokAgent")]);
    expect(launch).toHaveBeenCalledTimes(2); // home-wide once + bot-a once, not once per question
    vi.setSystemTime(Date.now() + 4_000);
    await cloudEngineSignedInSomewhere("codex");
    expect(launch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 2_000);
    await cloudEngineSignedInSomewhere("codex");
    expect(launch).toHaveBeenCalledTimes(4);
  });
  it("a bot the launcher cannot read makes 'not signed in anywhere' unknown, never false; a signed-in answer still holds", async () => {
    const launch = (request: Record<string, unknown>) => request.bot === "bot-b" ? child(1, "", "boom") : reply({ codex: request.bot === "bot-a" });
    configureCloudSignIns({ bots: () => ["bot-a", "bot-b"], launch });
    expect(await cloudEngineSignedInSomewhere("codex")).toBe(true);
    expect(await cloudEngineSignedInSomewhere("grokAgent")).toBeUndefined();
  });
  it("reads at most 200 bots; a home with more reads unknown, not false", async () => {
    const launch = vi.fn((_request: Record<string, unknown>) => reply({ codex: false }));
    configureCloudSignIns({ bots: () => Array.from({ length: 205 }, (_, i) => `bot-${i}`), launch });
    expect(await cloudEngineSignedInSomewhere("codex")).toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(201);
  });
  it("a driver's own probe that says signed in stays true when the launcher says none", async () => {
    configureCloudSignIns({ bots: () => ["bot-a"], launch: () => reply({}) });
    probe.ownLoggedIn = true;
    const instance = await CodexDriver.create({ instanceId: "codex", displayName: "codex", environment: {}, enabled: true, config: { cli: "/opt/murage/bin/codex", fullAuto: false } });
    try {
      expect(await cloudEngineSignedInSomewhere("codex")).toBe(false);
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally { probe.ownLoggedIn = false; await instance.dispose(); }
  });
  it("10 bots polled 3 times inside the cache window ask the launcher at most 10 times, and a failed read is asked again", async () => {
    let calls = 0, open = 0, peak = 0;
    const launch = vi.fn((request: Record<string, unknown>) => { if (request.bot) { calls++; open++; peak = Math.max(peak, open); setImmediate(() => { open--; }); } return reply({ codex: request.bot === "bot-3" }); });
    const ids = Array.from({ length: 10 }, (_, i) => `bot-${i}`);
    configureCloudSignIns({ bots: () => ids, launch });
    const refs = ids.map((id) => ({ id, name: id, driverKind: "codex" }));
    for (let poll = 0; poll < 3; poll++) {
      const lines = await botSignInLines(refs);
      expect(lines).toHaveLength(10);
      expect(lines!.filter((line) => line.signedIn).map((line) => line.id)).toEqual(["bot-3"]);
    }
    expect(calls).toBeLessThanOrEqual(10);
    // The turn guard's own question is never served from the poll cache.
    await botEngineSignIn("codex", "bot-3");
    expect(calls).toBe(11);
    // A failed read is not kept.
    let fail = true;
    configureCloudSignIns({ bots: () => ["bot-x"], launch: (request) => (request.bot && fail ? child(1, "", "boom") : reply({ codex: true })) });
    expect(await botSignInLines([{ id: "bot-x", name: "X", driverKind: "codex" }])).toBeUndefined();
    fail = false;
    expect((await botSignInLines([{ id: "bot-x", name: "X", driverKind: "codex" }]))![0]!.signedIn).toBe(true);
  });
  it("reads the bots a few at a time, not one after another", async () => {
    let open = 0, peak = 0;
    const source = { signIn: async () => { open++; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 5)); open--; return { signedIn: true, source: null }; } };
    const refs = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, driverKind: "codex" }));
    const lines = await botSignInLines(refs, source);
    expect(lines!.map((line) => line.id)).toEqual(refs.map((ref) => ref.id));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
