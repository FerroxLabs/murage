// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolation-all round 9: an engine whose version is unknown (the probe is retried ONCE) or older than the first one proven to honour
// its own home setting is not started for a bot. The turn is rejected before any spawn with a structured update-required error
// (rendered in the owner's language by the chat), never run in the owner's own engine home.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./acp/core.ts";
import { scopeGrokHome } from "./acp/grok-scope.ts";
import { CodexDriver } from "./codex.ts";
import { resetIsolationCache } from "./isolation-cache.ts";
import { ScopeUnavailableError, resetScopeBookkeeping, scopedCliHomeRoot, setScopeRetryBoundMs } from "./scoped-cli-home.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(here, "..", "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(here, "..", "testing", "fake-codex-app-server.ts");
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
/** The ACP fake writes its dump on every start, `--version` probes included; a real spawn is the one that got as far as `initialize`. */
const spawned = (dump: string): boolean => existsSync(dump) && "initialize" in (JSON.parse(readFileSync(dump, "utf8")) as Record<string, unknown>);
const probes = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); setScopeRetryBoundMs(250); });
afterEach(() => {
  setScopeRetryBoundMs(10_000);
  delete process.env.FAKE_CODEX_DUMP;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ACP engines that scope their home (Grok shown): version gate", () => {
  const support = (): AcpSupport => ({
    driverKind: "scopeVersionTest",
    displayName: "Scope Test",
    models: { default: "m", options: [{ id: "m", label: "M" }] },
    defaultCli: FAKE_ACP,
    nativeSource: "scope-version.acp",
    loginNote: "never reached",
    scopeKind: "grok",
    spawnArgs: () => [],
    spawnNeedsCliVersion: true,
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: () => true,
    applyMountEnv: (env, { cliVersion, botId }) => scopeGrokHome(env, cliVersion, botId),
    scopeRoot: (env) => env.GROK_HOME,
  });
  async function run(environment: Record<string, string>) {
    chmodSync(FAKE_ACP, 0o755);
    const home = tmp("iso9-acp-");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "LOGIN");
    const dump = join(home, "spawn.json");
    const log = join(home, "probes.log");
    const driver = createAcpDriver(support());
    const instance = await driver.create({ instanceId: "scope-v", displayName: "scope-v", enabled: true,
      config: driver.decodeConfig({ cli: FAKE_ACP, fullAuto: true }),
      environment: { HOME: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION_LOG: log, ...environment } });
    const recorder = recordEvents(instance.adapter);
    try {
      const error = await instance.adapter.sendTurn({ threadId: "scope-v-1", text: "hi", cwd: home, warmIdentity: { botId: "bot-v", audience: "owner" } })
        .then(() => null, (e: unknown) => e);
      if (error === null) await recorder.until((event) => event.type === "turn.completed", 15_000);
      return { error: error as ScopeUnavailableError | null, dump, probes: probes(log), home };
    } finally { recorder.stop(); await instance.dispose(); }
  }

  it("a version that cannot be read is probed once more, then the turn is rejected before any spawn", async () => {
    const out = await run({ FAKE_ACP_VERSION_FAIL: "1" });
    expect(out.error).toBeInstanceOf(ScopeUnavailableError);
    expect(out.error).toMatchObject({ code: "update-required", engine: "Scope Test", busy: false });
    expect(spawned(out.dump)).toBe(false);
    expect(out.probes).toBe(2); // the turn's probe and ONE retry
  });

  it("a version older than the first proven one is rejected before any spawn", async () => {
    const out = await run({ FAKE_ACP_VERSION: "grok 1.0.49" });
    expect(out.error).toMatchObject({ code: "update-required", engine: "Scope Test" });
    expect(spawned(out.dump)).toBe(false);
  });

  it("a proven version starts the turn in the bot's scope, never the owner's GROK_HOME", async () => {
    const out = await run({ FAKE_ACP_VERSION: "grok 1.0.50" });
    expect(out.error).toBeNull();
    const env = (JSON.parse(readFileSync(out.dump, "utf8")) as { env: Record<string, string> }).env;
    expect(env.GROK_HOME.startsWith(scopedCliHomeRoot("grok"))).toBe(true);
    expect(env.GROK_HOME).not.toBe(join(out.home, ".grok"));
  });
});

describe("Codex: version gate", () => {
  async function run(version: string) {
    chmodSync(FAKE_CODEX, 0o755);
    const home = tmp("iso9-codex-v-");
    const codex = join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "auth.json"), "LOGIN");
    const dump = join(home, "dump.json");
    const log = join(home, "probes.log");
    process.env.FAKE_CODEX_DUMP = dump;
    const instance = await CodexDriver.create({ instanceId: "codex-v", displayName: "Codex", enabled: true,
      environment: { HOME: home, CODEX_HOME: codex, FAKE_CODEX_VERSION: version, FAKE_CODEX_VERSION_LOG: log }, config: { cli: FAKE_CODEX, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "codex-v-1", text: "go", warmIdentity: { botId: "bot-cv", audience: "owner" } });
      const done = await recorder.until((event) => event.type === "turn.completed", 15_000);
      return { done, events: recorder.events, dump, probes: probes(log), codex };
    } finally { recorder.stop(); await instance.dispose(); }
  }

  // Codex hands the turn id back before it launches, so the refusal is the turn's own failure: a structured runtime.error the chat words
  // from its code (never English text), a failed completion, and no process.
  it("an unreadable version is probed once more and the turn fails with an update-required code before any spawn", async () => {
    const out = await run("fail");
    expect(out.events.find((event) => event.type === "runtime.error")).toMatchObject({ localFailure: "engine-update-required", localFailureEngine: "Codex" });
    expect(out.done).toMatchObject({ type: "turn.completed", ok: false, stopReason: "scope_unavailable" });
    expect(existsSync(out.dump)).toBe(false);
    expect(out.probes).toBe(2);
  });

  it("a version older than 0.2.0 fails the same way before any spawn", async () => {
    const out = await run("codex-cli 0.1.9");
    expect(out.events.find((event) => event.type === "runtime.error")).toMatchObject({ localFailure: "engine-update-required", localFailureEngine: "Codex" });
    expect(out.done).toMatchObject({ ok: false });
    expect(existsSync(out.dump)).toBe(false);
  });

  it("a successful version probe is remembered per binary (path, mtime, size): a second instance and a second turn do not spawn it again", async () => {
    chmodSync(FAKE_CODEX, 0o755);
    const home = tmp("iso10-codex-probe-");
    const codex = join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "auth.json"), "LOGIN");
    const log = join(home, "probes.log");
    process.env.FAKE_CODEX_DUMP = join(home, "dump.json");
    for (const id of ["codex-p1", "codex-p2"]) {
      const instance = await CodexDriver.create({ instanceId: id, displayName: "Codex", enabled: true,
        environment: { HOME: home, CODEX_HOME: codex, FAKE_CODEX_VERSION: "codex-cli 0.150.0", FAKE_CODEX_VERSION_LOG: log }, config: { cli: FAKE_CODEX, fullAuto: false } });
      const recorder = recordEvents(instance.adapter);
      try {
        for (const turn of [1, 2]) {
          await instance.adapter.sendTurn({ threadId: `${id}-${turn}`, text: "go", warmIdentity: { botId: "bot-probe", audience: "owner" } });
          expect(await recorder.until((event) => event.type === "turn.completed" && event.threadId === `${id}-${turn}`, 15_000)).toMatchObject({ ok: true });
        }
      } finally { recorder.stop(); await instance.dispose(); }
    }
    expect(probes(log)).toBe(1);
  });

  it("a proven version runs in the bot's CODEX_HOME scope, never the owner's", async () => {
    const out = await run("codex-cli 0.150.0");
    expect(out.done).toMatchObject({ ok: true });
    const childHome = (JSON.parse(readFileSync(out.dump, "utf8")) as { env: Record<string, string> }).env.CODEX_HOME;
    expect(childHome).not.toBe(out.codex);
    expect(childHome.startsWith(scopedCliHomeRoot("codex"))).toBe(true);
  });
});
