// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.15 BIRTH-FUIGO-1014 P1 and P2 at the route, on a real server: the first-launch Chief and a POST /api/bots with no selection are
// born by the birth rule (a usable Fuigo, else a desktop copy of the Chief, else empty), marked; an owner pick in the body is kept,
// unmarked, live and on disk. Two servers: one with a Flux key (Fuigo's catalogue usable), one without (keyless Fuigo is not).
import { connect } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { isFluxModel } from "./flux-surface.ts";
import type { ModelCatalog, ModelSelection } from "./contracts.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const GROK = { instanceId: "grok", model: "fake-model" };

type World = { base: string; home: string; child: ChildProcess; headers: Record<string, string>; stderr: string };

async function boot(withKey: boolean, found: "grok" | "claude" | null = "grok", options: { home?: string; env?: Record<string, string>; configure?: (config: any, home: string) => void } = {}): Promise<World> {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  chmodSync(FAKE_CLI, 0o755);
  chmodSync(FAKE_CLAUDE, 0o755);
  const home = options.home ?? mkdtempSync(join(tmpdir(), "murage-birth-route-"));
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, ".fuigo"), { recursive: true });
  const config = {
    engineDiscovery: "explicit",
    ...(withKey ? { flux: { apiKey: "sk-flux-birthroutefixture000000000000000000" } } : {}), // secret-scan: fixture
    instances: {
      fuigo: { driver: "fuigoAgent", config: { cli: FAKE_CLI, fullAuto: false } },
      // r3: `found` is a machine where another engine was already set up (Claude Code in the field)
      ...(found === "grok" ? { grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } } : {}),
      ...(found === "claude" ? { claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE } } } : {}),
    },
  };
  if (!options.home) { options.configure?.(config, home); writeFileSync(join(home, ".murage", "config.json"), JSON.stringify(config)); }
  const world: World = { base, home, headers: {}, stderr: "", child: spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...options.env, TMPDIR: process.env.TMPDIR,
      HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) };
  world.child.stderr!.on("data", (c) => (world.stderr += c));
  world.child.stdout!.resume();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${world.stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await (await fetch(`${base}/api/desktop-secret`)).json() as { secret: string };
  world.headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  return world;
}

const call = async (w: World, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${w.base}${path}`, { method, headers: { ...w.headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any };
};
const onDisk = (w: World, id: string) => (JSON.parse(readFileSync(join(w.home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; modelSelection: { instanceId: string; model: string }; engineAutoPicked?: true }>).find(bot => bot.id === id)!;
const chiefOf = async (w: World) => (await call(w, "GET", "/api/bots")).body.bots.at(-1) as { id: string };

posixOnly("birth at the route, Flux key held", () => {
  let w: World;
  beforeAll(async () => { w = await boot(true); }, 60_000);
  afterAll(async () => { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); });

  it("first launch with a Flux key seeds the Chief on Fuigo, marked", async () => {
    const chief = await chiefOf(w);
    expect(onDisk(w, chief.id).modelSelection.instanceId).toBe("fuigo");
    expect(onDisk(w, chief.id).modelSelection.model).not.toBe("");
    expect(onDisk(w, chief.id).engineAutoPicked).toBe(true);
  });

  it("POST /api/bots with no selection while the Chief is on another engine and Fuigo has a model births on Fuigo", async () => {
    const chief = await chiefOf(w);
    expect((await call(w, "PATCH", `/api/bots/${chief.id}`, { modelSelection: GROK })).status).toBe(200);
    const created = await call(w, "POST", "/api/bots", { name: "Born" });
    expect(created.status).toBe(201);
    expect(onDisk(w, created.body.bot.id).modelSelection.instanceId).toBe("fuigo");
    expect(onDisk(w, created.body.bot.id).engineAutoPicked).toBe(true);
  });

  it("an explicit modelSelection in the body is kept, unmarked, live and on disk", async () => {
    const created = await call(w, "POST", "/api/bots", { name: "Picked", modelSelection: GROK });
    expect(created.status).toBe(201);
    expect(created.body.bot.modelSelection).toMatchObject(GROK);
    expect(onDisk(w, created.body.bot.id).modelSelection).toMatchObject(GROK);
    expect(onDisk(w, created.body.bot.id).engineAutoPicked).toBeUndefined();
  });
}, 120_000);

posixOnly("birth at the route, no Flux key, Claude found", () => {
  let w: World;
  beforeAll(async () => { w = await boot(false, "claude"); }, 60_000);
  afterAll(async () => { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); });

  it("r3: first launch seeds the Chief on the engine the first-launch check found, marked, never a keyless Fuigo", async () => {
    const chief = await chiefOf(w);
    expect(onDisk(w, chief.id).modelSelection.instanceId).toBe("claude");
    expect(onDisk(w, chief.id).modelSelection.model).not.toBe("");
    expect(onDisk(w, chief.id).engineAutoPicked).toBe(true);
  });

  it("r3: the owner taps Not now on the key and the Chief replies", async () => {
    const chief = (await call(w, "GET", "/api/bots")).body.bots.at(-1) as { id: string; threadId: string };
    expect((await call(w, "POST", "/api/setup/skip", { step: "flux" })).status).toBeLessThan(300);
    // The fake engine's own answer, never Murage's setup or status text (Astra r3 Medium).
    const answered = (bot: { messages?: Array<{ role: string; kind: string; text?: string }> }) =>
      (bot.messages ?? []).some(m => m.role === "bot" && m.kind === "text" && (m.text ?? "").includes("hello from fake claude"));
    const chiefNow = async () => (await call(w, "GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === chief.id);
    expect(answered(await chiefNow())).toBe(false);
    expect((await call(w, "POST", `/api/bots/${chief.id}/messages`, { threadId: chief.threadId, text: "hello" })).status).toBeLessThan(300);
    const deadline = Date.now() + 90_000;
    let last: { modelSelection?: unknown; busy?: unknown; messages?: Array<{ role: string; kind: string; text?: string }> } = {};
    while (Date.now() < deadline && !answered(last = await chiefNow())) await new Promise((r) => setTimeout(r, 300));
    expect(answered(last), `no reply. engine ${JSON.stringify(last.modelSelection)} busy ${String(last.busy)} last rows: ${JSON.stringify((last.messages ?? []).slice(-3)).slice(0, 2500)}\nstderr tail: ${w.stderr.slice(-2000)}`).toBe(true);
  }, 120_000);

  it("POST /api/bots with no selection copies the Chief, never a keyless Fuigo", async () => {
    const chief = await chiefOf(w);
    const { instanceId, model } = onDisk(w, chief.id).modelSelection;
    const created = await call(w, "POST", "/api/bots", { name: "Copy" });
    expect(created.status).toBe(201);
    expect(onDisk(w, created.body.bot.id).modelSelection).toMatchObject({ instanceId, model });
    expect(instanceId).toBe("claude");
    expect(onDisk(w, created.body.bot.id).engineAutoPicked).toBe(true);
  });
}, 120_000);

posixOnly("birth at the route, blank machine with no Flux key", () => {
  let w: World;
  beforeAll(async () => { w = await boot(false, null); }, 60_000);
  afterAll(async () => { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); });

  it("first launch with no key and nothing found seeds an empty marked Chief, never another engine", async () => {
    const chief = await chiefOf(w);
    expect(onDisk(w, chief.id).modelSelection).toMatchObject({ instanceId: "", model: "" });
    expect(onDisk(w, chief.id).engineAutoPicked).toBe(true);
  });
}, 120_000);

const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await pause(); }
}
async function paidScan(w: World) {
  await until(async () => (await call(w, "GET", "/api/instances")).body.instances.some((row: any) => row.driverKind === "claudeAgent" && row.enabled && row.snapshot.state === "available" && row.snapshot.authenticated === true && row.snapshot.billing === "subscription"), "paid mapped scan");
}
function assertNativeSelection(selection: ModelSelection, rows: Array<{ instanceId: string; driverKind: string; models: ModelCatalog }>) {
  const row = rows.find(row => row.instanceId === selection.instanceId);
  expect(row, `catalogue for ${selection.instanceId}`).toBeDefined();
  expect(["claudeAgent", "codex"]).toContain(row!.driverKind);
  expect(selection.model).not.toBe("");
  const option = row!.models.options.find(option => option.id === selection.model);
  expect(option, `native catalogue option ${selection.instanceId}/${selection.model}`).toBeDefined();
  // Match the production native-row predicate, including an explicitly empty provider.
  expect(isFluxModel(option!.id)).toBe(false);
  expect(option!.custom).not.toBe(true);
  expect(option!.provider).toBeUndefined();
}

it.each([
  ["empty", "", { id: "native", label: "Native" }],
  ["missing", "nonexistent", { id: "native", label: "Native" }],
  ["Flux", "flux-auto", { id: "flux-auto", label: "Flux" }],
  ["custom", "custom", { id: "custom", label: "Custom", custom: true }],
  ["provider", "provider", { id: "provider", label: "Provider", provider: "other" }],
  ["empty provider", "provider", { id: "provider", label: "Provider", provider: "" }],
] as const)("native birth assertion rejects %s for named accounts", (_label, model, option) => {
  const rows = [{ instanceId: "claude-named", driverKind: "claudeAgent", models: { default: option.id, options: [option] } }];
  expect(() => assertNativeSelection({ instanceId: "claude-named", model }, rows)).toThrow();
  assertNativeSelection({ instanceId: "claude-named", model: "native" }, [{ ...rows[0], models: { default: "native", options: [{ id: "native", label: "Native" }] } }]);
});

async function birth(w: World, expected: string) {
  const result = await call(w, "POST", "/api/bots", { name: "Automatic" });
  expect(result.status).toBe(201);
  expect(result.body.bot.modelSelection.instanceId).toBe(expected);
  expect(result.body.bot.engineAutoPicked).toBe(true);
  expect(onDisk(w, result.body.bot.id)).toMatchObject({ modelSelection: result.body.bot.modelSelection, engineAutoPicked: true });
  if (expected === "claude") expect(result.body.bot.modelSelection.model).not.toMatch(/^flux-/);
  if (expected && expected !== "fuigo") {
    assertNativeSelection(result.body.bot.modelSelection, (await call(w, "GET", "/api/instances")).body.instances);
  }
  return result.body.bot;
}
async function chiefOnClaude(w: World) {
  const chief = (await call(w, "GET", "/api/bots")).body.bots.at(-1);
  const row = (await call(w, "GET", "/api/instances")).body.instances.find((r: any) => r.instanceId === "claude");
  const model = row.models.options.find((m: any) => !m.id.startsWith("flux-") && !m.custom && !m.provider).id;
  expect((await call(w, "PATCH", `/api/bots/${chief.id}`, { modelSelection: { instanceId: "claude", model } })).status).toBe(200);
  return (await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === chief.id);
}
async function idleTurn(w: World, bot: any) {
  expect((await call(w, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hello" })).status).toBeLessThan(300);
  await until(async () => {
    const current = (await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id);
    return !current.busy && current.messages?.some((m: any) => m.role === "bot" && m.text?.includes("hello from fake claude"));
  }, "completed resident Claude turn", 30000);
}

posixOnly("ENGINE-DEFAULT paid births and retirement", () => {
  let w: World;
  afterAll(async () => { if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); } });
  it.each(["F1", "F2", "F4a", "F8"])("%s: paid native birth with usable Fuigo", async scenario => {
    if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
    w = await boot(true, "claude");
    const chief = (await call(w, "GET", "/api/bots")).body.bots.at(-1);
    if (scenario === "F1") {
      expect(onDisk(w, chief.id)).toMatchObject({ modelSelection: { instanceId: "claude" }, engineAutoPicked: true });
      assertNativeSelection(chief.modelSelection, (await call(w, "GET", "/api/instances")).body.instances);
      await idleTurn(w, chief);
    } else {
      if (scenario === "F8") {
        await waitForExit(w.child, { signal: "SIGTERM" });
        w = await boot(true, "claude", { home: w.home });
      }
      await paidScan(w); await birth(w, "claude");
    }
  }, 90000);
  it("F9: named account births and removal use the mapped scan", async () => {
    if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
    w = await boot(true, "claude");
    expect((await call(w, "PATCH", "/api/instances/claude", { enabled: false })).status).toBe(200);
    const added = await call(w, "POST", "/api/claude-accounts", { displayName: "Paid account", configDir: join(w.home, "named") });
    expect(added.status).toBe(201);
    const id = added.body.account.instanceId;
    await paidScan(w);
    const bot = await birth(w, id);
    expect((await call(w, "DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    expect((await call(w, "DELETE", `/api/claude-accounts/${id}`)).status).toBe(200);
    await birth(w, "fuigo");
  }, 60000);
});

posixOnly("ENGINE-DEFAULT metered fallback", () => {
  let w: World;
  afterAll(async () => { if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); } });
  it.each([["F3 metered", "in", "api_key"], ["F2 signed-out", "out", "claude.ai"]])("%s: unqualified Claude stays behind usable Fuigo", async (_label, auth, method) => {
    if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
    w = await boot(true, "claude", { env: { FAKE_CLAUDE_AUTH_METHOD: method, FAKE_CLAUDE_AUTH: auth } });
    await call(w, "GET", "/api/instances");
    await birth(w, "fuigo");
  }, 60000);
});

/** The launcher observes disposal without adding a production route or bypassing admission. */
function residentConfig(config: any, home: string, splitDelays = false) {
  const launcher = join(home, "observed-claude.mjs");
  const events = join(home, "process-events.jsonl");
  mkdirSync(join(home, "exit-gates"), { recursive: true });
  writeFileSync(launcher, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const env = { ...process.env };
if (${JSON.stringify(splitDelays)} && process.argv.includes('--input-format')) {
  const counter = ${JSON.stringify(join(home, 'resident-counter'))};
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(count + 1));
  env.FAKE_CLAUDE_SIGTERM_DELAY_MS = count === 0 ? '800' : '2200';
}
const child = spawn(process.execPath, [${JSON.stringify(FAKE_CLAUDE)}, ...process.argv.slice(2)], { env, stdio: ['pipe', 'inherit', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
const log = event => appendFileSync(${JSON.stringify(events)}, JSON.stringify({event, pid: child.pid, account: process.env.CLAUDE_CONFIG_DIR || 'default', at: Date.now()}) + '\\n');
if (process.argv.includes('--input-format')) log('resident');
process.on('SIGTERM', () => { log('term'); child.kill('SIGTERM'); });
child.on('close', code => { log('close'); process.exit(code ?? 0); });
`);
  chmodSync(launcher, 0o755);
  config.instances.claude.config.cli = launcher;
  config.instances.claude.environment = { FAKE_CLAUDE_SIGTERM_DELAY_MS: "1800", FAKE_CLAUDE_EXIT_GATE_DIR: join(home, "exit-gates") };
}
const eventsOf = (w: World) => existsSync(join(w.home, "process-events.jsonl")) ? readFileSync(join(w.home, "process-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const residentOptions = { env: { MURAGE_PROVIDER_CLOSE_MS: "8000" }, configure: residentConfig };

posixOnly("ENGINE-DEFAULT held disposal", () => {
  let w: World;
  afterAll(async () => { if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); } });
  it.each(["account", "settings"])("F10/F11: %s fleet change refuses births until mapped publication", async kind => {
    if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
    w = await boot(true, "claude", residentOptions);
    const chief = await chiefOnClaude(w);
    await idleTurn(w, chief); await paidScan(w);
    const start = eventsOf(w).length;
    let settled = false;
    const change = (kind === "account" ? call(w, "POST", "/api/claude-accounts", { displayName: "Another", configDir: join(w.home, "another") }) : call(w, "PATCH", "/api/config", { xai: { key: "fixture-key" } })).then(result => { settled = true; return result; });
      void change.catch(() => {});
    await until(() => eventsOf(w).slice(start).some(e => e.event === "term"), "disposal observed");
    expect(settled).toBe(false);
    await birth(w, "");
    expect(settled).toBe(false);
    expect((await change).status).toBe(kind === "account" ? 201 : 200);
    await paidScan(w); await birth(w, "claude");
  }, 90000);
  it.each([false, true])("F5/F6: direct retirement with Stop=%s", async stop => {
    if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
    w = await boot(true, "claude", { ...residentOptions, env: { ...residentOptions.env, FAKE_CLAUDE_HOLD_MARKER: "HOLD-BIRTH" }, configure: (config, home) => {
      residentConfig(config, home, stop);
      Object.assign(config.instances.claude.environment, { FAKE_CLAUDE_HOLD_MARKER: "HOLD-BIRTH", FAKE_CLAUDE_HOLD_GATE: join(home, "hold-gate"), FAKE_CLAUDE_HOLD_SEEN: join(home, "hold-seen") });
    } });
    await paidScan(w);
    await chiefOnClaude(w);
    const bot = (await call(w, "POST", "/api/bots", { name: "Held", modelSelection: onDisk(w, (await chiefOf(w)).id).modelSelection })).body.bot;
    expect((await call(w, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "HOLD-BIRTH" })).status).toBeLessThan(300);
    await until(() => existsSync(join(w.home, "hold-seen")), "held direct turn");
    bot.threadId = (await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).threadId;
    let siblingPid: number | undefined;
    if (stop) {
      const siblingStart = eventsOf(w).length;
      const other = (await call(w, "POST", "/api/bots", { name: "Resident sibling", modelSelection: bot.modelSelection })).body.bot;
      await idleTurn(w, other);
      siblingPid = eventsOf(w).slice(siblingStart).find(e => e.event === "resident")?.pid;
      expect(siblingPid).toBeTypeOf("number");
    }
    let settled = false;
    const change = call(w, "PATCH", "/api/instances/claude", { enabled: false }).then(result => { settled = true; return result; });
      void change.catch(() => {});
    await until(() => JSON.parse(readFileSync(join(w.home, ".murage", "config.json"), "utf8")).instances.claude.enabled === false, "disabled file");
    expect(settled).toBe(false);
    if (!stop) await birth(w, "fuigo");
    if (stop) {
      expect((await call(w, "POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      await until(async () => (await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy === false, "Stop completed before birth");
      await until(() => eventsOf(w).some(e => e.event === "term" && e.pid === siblingPid), "sibling disposal started after Stop");
      expect(eventsOf(w).some(e => e.event === "close" && e.pid === siblingPid)).toBe(false);
    }
    writeFileSync(join(w.home, "hold-gate"), "release");
    expect(settled).toBe(false); await birth(w, "fuigo");
    if (stop) {
      expect(settled, "PATCH must stay pending through the birth response").toBe(false);
      expect(eventsOf(w).some(e => e.event === "close" && e.pid === siblingPid)).toBe(false);
    }
    expect((await change).status).toBe(200);
    if (stop) expect(eventsOf(w).some(e => e.event === "close" && e.pid === siblingPid)).toBe(true);
    await birth(w, "fuigo");
    const messages = (await call(w, "GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages;
    if (!stop) expect(JSON.stringify(messages)).toContain("the engine it was using was turned off or changed in Settings");
    expect((await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy).toBe(false);
  }, 60000);
});

posixOnly("ENGINE-DEFAULT shadow refusal", () => {
  let w: World;
  afterAll(async () => { if (w) { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); } });
  it("F5c: a disabled Chief and stale probe never supply a birth, including restart", async () => {
    w = await boot(false, "claude", residentOptions);
    const chief = await chiefOnClaude(w);
    await idleTurn(w, chief);
    let settled = false;
    const start = eventsOf(w).length;
    const change = call(w, "PATCH", "/api/instances/claude", { enabled: false }).then(result => { settled = true; return result; });
      void change.catch(() => {});
    await until(() => eventsOf(w).slice(start).some(e => e.event === "term"), "shadow disposal");
    expect(settled).toBe(false); await birth(w, "");
    expect((await change).status).toBe(200); await birth(w, "");
    await waitForExit(w.child, { signal: "SIGTERM" });
    w = await boot(false, "claude", { home: w.home });
    expect(onDisk(w, chief.id)).toMatchObject({ modelSelection: chief.modelSelection });
    expect((await call(w, "GET", "/api/bots")).body.bots.some((bot: any) => bot.id === chief.id)).toBe(true);
    expect((await call(w, "GET", "/api/instances")).body.instances.find((row: any) => row.instanceId === "claude").enabled).toBe(false);
    await birth(w, "");
  }, 60000);
});

async function parked(w: World, method: string, path: string, body: unknown) {
  const text = JSON.stringify(body), url = new URL(w.base);
  const socket = connect(Number(url.port), url.hostname);
  let data = "";
  socket.on("data", chunk => { data += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => { socket.on("end", resolve); socket.on("error", reject); });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nExpect: 100-continue\r\nConnection: close\r\n${Object.entries(w.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
  await until(() => data.includes("100 Continue"), "accepted request headers");
  return { socket, send: async () => {
    socket.write(text);
    await closed;
    const response = data.slice(data.indexOf("\r\n\r\n") + 4);
    const status = Number(/^HTTP\/1.1 (\d+)/.exec(response)?.[1]);
    let payload = response.slice(response.indexOf("\r\n\r\n") + 4);
    if (/transfer-encoding: chunked/i.test(response)) payload = payload.slice(payload.indexOf("\r\n") + 2, payload.lastIndexOf("\r\n0\r\n"));
    return { status, body: JSON.parse(payload) };
  } };
}
posixOnly("ENGINE-DEFAULT shutdown", () => {
  it.each(["a", "b", "c"])("F12(%s): accepted births stay empty through terminal shutdown", async variant => {
    const w = await boot(true, "claude", { ...residentOptions, configure: (config, home) => {
      residentConfig(config, home);
      if (variant === "c") {
        config.instances["claude-y"] = { ...config.instances.claude, config: { ...config.instances.claude.config, configDir: join(home, "y") }, environment: { ...config.instances.claude.environment, FAKE_CLAUDE_SIGTERM_DELAY_MS: "800", FAKE_CLAUDE_SIGTERM_GATE: join(home, "y-term-gate") } };
        config.instances["claude-z"] = { ...config.instances.claude, config: { ...config.instances.claude.config, configDir: join(home, "z") }, environment: { ...config.instances.claude.environment, FAKE_CLAUDE_SIGTERM_DELAY_MS: "2200" } };
      }
    } });
    const sockets: Array<{ destroy(): void }> = [];
    try {
      const chief = await chiefOnClaude(w);
      if (variant !== "c") await idleTurn(w, chief);
      else for (const id of ["claude-y", "claude-z"]) {
        const bot = (await call(w, "POST", "/api/bots", { name: id, modelSelection: { ...chief.modelSelection, instanceId: id } })).body.bot;
        await idleTurn(w, bot);
      }
      const post = await parked(w, "POST", "/api/bots", {}); sockets.push(post.socket);
      const patch = variant === "b" ? await parked(w, "PATCH", "/api/config", { language: "fr" }) : null;
      if (patch) sockets.push(patch.socket);
      let reloaded = false;
      const start = eventsOf(w).length;
      const reload = variant === "c" ? call(w, "PATCH", "/api/instances/claude-y", { enabled: true }).then(result => { reloaded = true; appendFileSync(join(w.home, "process-events.jsonl"), JSON.stringify({ event: "patch-complete", account: join(w.home, "y") }) + "\n"); return result; }) : null;
      void reload?.catch(() => {});
      if (reload) {
        await until(() => eventsOf(w).slice(start).some(e => e.event === "term" && e.account === join(w.home, "y")), "Y reload disposal");
        expect(reloaded).toBe(false);
      }
      const shutdownStart = eventsOf(w).length;
      w.child.kill("SIGTERM");
      const account = variant === "c" ? join(w.home, "z") : "default";
      await until(() => eventsOf(w).slice(shutdownStart).some(e => e.event === "term" && e.account === account), "fresh shutdown disposal");
      const term = eventsOf(w).slice(shutdownStart).find(e => e.event === "term" && e.account === account);
      if (reload) {
        expect(reloaded, "Y PATCH must still be pending after Z shutdown disposal starts").toBe(false);
        const yTerm = eventsOf(w).slice(start).find(e => e.event === "term" && e.account === join(w.home, "y"));
        expect(eventsOf(w).some(e => e.event === "close" && e.pid === yTerm.pid)).toBe(false);
        writeFileSync(join(w.home, "y-term-gate"), "release");
        const result = await reload;
        const ordered = eventsOf(w).slice(start);
        expect(ordered.findIndex(e => e.event === "patch-complete")).toBeGreaterThan(ordered.findIndex(e => e.event === "term" && e.pid === term.pid));
        expect(result.status).toBe(200);
        expect(result.body.instances.find((row: any) => row.instanceId === "claude-y")).toMatchObject({ enabled: true, snapshot: { state: "available" } });
      }
      if (patch) expect((await patch.send()).status).toBe(200);
      expect(eventsOf(w).some(e => e.event === "close" && e.pid === term.pid)).toBe(false);
      const result = await post.send();
      expect(result.status).toBe(201);
      expect(result.body.bot).toMatchObject({ modelSelection: { instanceId: "", model: "" }, engineAutoPicked: true });
      expect(onDisk(w, result.body.bot.id)).toMatchObject({ modelSelection: { instanceId: "" }, engineAutoPicked: true });
      expect(eventsOf(w).some(e => e.event === "close" && e.pid === term.pid)).toBe(false);
      await waitForExit(w.child);
      const restarted = await boot(true, "claude", { home: w.home });
      try { expect(["", "fuigo"]).toContain(onDisk(restarted, result.body.bot.id).modelSelection.instanceId); }
      finally { await waitForExit(restarted.child, { signal: "SIGTERM" }); }
    } finally {
      for (const socket of sockets) socket.destroy();
      await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home);
    }
  }, 60000);
});

posixOnly("ENGINE-DEFAULT restart publication", () => {
  it("F13: remembered choice listens immediately while the auth gate holds publication", async () => {
    let w = await boot(true, "claude");
    try {
      const remembered = JSON.parse(readFileSync(join(w.home, ".murage", "default-engine.json"), "utf8"));
      const rows = (await call(w, "GET", "/api/instances")).body.instances;
      expect(rows.find((row: any) => row.instanceId === remembered.instanceId)?.enabled).toBe(true);
      expect(rows.find((row: any) => row.instanceId === remembered.instanceId)?.models.options.some((row: any) => row.id === remembered.model)).toBe(true);
      expect((await call(w, "GET", "/api/bots")).body.bots.length).toBeGreaterThan(0);
      await waitForExit(w.child, { signal: "SIGTERM" });
      const gate = join(w.home, "auth-gate"), log = join(w.home, "auth-probes");
      const started = Date.now();
      w = await boot(true, "claude", { home: w.home, env: { FAKE_CLAUDE_AUTH_GATE: gate, FAKE_CLAUDE_PROBE_LOG: log } });
      await until(() => existsSync(log) && readFileSync(log, "utf8").includes('"probe":"auth"'), "fresh held auth probe", 1500);
      expect(existsSync(gate)).toBe(false);
      await birth(w, "fuigo");
      writeFileSync(gate, "release");
      expect(Date.now() - started).toBeLessThan(6500);
      await paidScan(w); await birth(w, "claude");
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
  it("F13 boot: restart publishes its own completed scan without a scan endpoint", async () => {
    let w = await boot(true, "claude");
    try {
      await waitForExit(w.child, { signal: "SIGTERM" });
      const file = join(w.home, ".murage", "default-engine.json");
      const remembered = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...remembered, fixturePendingRefresh: true }));
      const gate = join(w.home, "boot-auth-gate"), log = join(w.home, "boot-auth-probes");
      w = await boot(true, "claude", { home: w.home, env: { FAKE_CLAUDE_AUTH_GATE: gate, FAKE_CLAUDE_PROBE_LOG: log } });
      await until(() => existsSync(log) && readFileSync(log, "utf8").includes('"probe":"auth"'), "boot auth entered", 1500);
      expect(JSON.parse(readFileSync(file, "utf8")).fixturePendingRefresh).toBe(true);
      writeFileSync(gate, "release");
      // rememberEngine rewrites this file only after the boot probe has completed.
      await until(() => JSON.parse(readFileSync(file, "utf8")).fixturePendingRefresh === undefined, "boot scan completed", 5000);
      await birth(w, "claude");
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
  it("BF-12: invalid named account mapping removes paid evidence before the next birth", async () => {
    const w = await boot(true, "claude");
    try {
      expect((await call(w, "PATCH", "/api/instances/claude", { enabled: false })).status).toBe(200);
      const added = await call(w, "POST", "/api/claude-accounts", { displayName: "Mapped", configDir: join(w.home, "mapped") });
      expect(added.status).toBe(201);
      const id = added.body.account.instanceId;
      await paidScan(w); await birth(w, id);
      const path = join(w.home, ".murage", "config.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.instances[id].config.configDir = "relative-invalid";
      writeFileSync(path, JSON.stringify(config));
      expect((await call(w, "PATCH", "/api/config", { language: "fr" })).status).toBe(200);
      const rows = (await call(w, "GET", "/api/instances")).body.instances;
      expect(rows.find((row: any) => row.instanceId === id).snapshot.state).toBe("unavailable");
      await birth(w, "fuigo");
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
});

posixOnly("ENGINE-DEFAULT room and crash transitions", () => {
  it("F14: room turn escalates to a whole-fleet reload", async () => {
    const w = await boot(true, "claude", { ...residentOptions, configure: (config, home) => {
      residentConfig(config, home);
      Object.assign(config.instances.claude.environment, { FAKE_CLAUDE_HOLD_MARKER: "ROOM-HOLD", FAKE_CLAUDE_HOLD_GATE: join(home, "room-gate"), FAKE_CLAUDE_HOLD_SEEN: join(home, "room-seen") });
    } });
    try {
      const chief = await chiefOnClaude(w);
      const made = await call(w, "POST", "/api/groups", { name: "Held room", memberIds: [chief.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } } });
      expect(made.status).toBe(201);
      const room = made.body.group;
      expect((await call(w, "POST", `/api/groups/${room.id}/messages`, { text: "ROOM-HOLD" })).status).toBeLessThan(300);
      await until(() => existsSync(join(w.home, "room-seen")), "held room turn");
      let settled = false;
      const change = call(w, "PATCH", "/api/instances/claude", { enabled: false }).then(result => { settled = true; return result; });
      void change.catch(() => {});
      await until(() => JSON.parse(readFileSync(join(w.home, ".murage", "config.json"), "utf8")).instances.claude.enabled === false, "room change saved");
      expect(settled).toBe(false); await birth(w, "");
      writeFileSync(join(w.home, "room-gate"), "release");
      const changed = await change;
      expect(changed.status).toBe(200);
      const messages = (await call(w, "GET", `/api/threads/${chief.threadId}/messages?limit=200`)).body.messages;
      expect(JSON.stringify(messages)).toContain("engine settings changed while it was running, so Murage restarted its engines");
      const paidClaude = changed.body.instances.find((row: any) => row.driverKind === "claudeAgent" && row.enabled !== false && row.snapshot.state === "available" && row.snapshot.authenticated === true && row.snapshot.billing === "subscription");
      await birth(w, paidClaude?.instanceId ?? "fuigo");
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
  it.each(["SIGKILL", "SIGTERM"] as const)("F7: %s during retirement restarts with the saved disabled fleet", async signal => {
    let w = await boot(true, "claude", residentOptions);
    try {
      const chief = await chiefOnClaude(w);
      const explicit = (await call(w, "POST", "/api/bots", { name: "Explicit", modelSelection: chief.modelSelection })).body.bot;
      await idleTurn(w, explicit);
      const start = eventsOf(w).length;
      const change = call(w, "PATCH", "/api/instances/claude", { enabled: false }).catch(() => null);
      await until(() => eventsOf(w).slice(start).some(e => e.event === "term"), "crash disposal");
      await birth(w, "fuigo");
      await waitForExit(w.child, { signal }); await change;
      w = await boot(true, "claude", { home: w.home });
      expect((await call(w, "GET", "/api/instances")).body.instances.find((r: any) => r.instanceId === "claude").enabled).toBe(false);
      await birth(w, "fuigo");
      const bots = JSON.parse(readFileSync(join(w.home, ".murage", "bots.json"), "utf8"));
      expect(bots.filter((b: any) => b.modelSelection.instanceId === "claude").map((b: any) => b.id).sort()).toEqual([chief.id, explicit.id].sort());
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
});

posixOnly("ENGINE-DEFAULT stale first bot", () => {
  it("F5d: an empty roster refuses a disabled remembered engine", async () => {
    const w = await boot(false, "claude");
    try {
      for (const bot of (await call(w, "GET", "/api/bots")).body.bots) expect((await call(w, "DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      expect((await call(w, "PATCH", "/api/instances/claude", { enabled: false })).status).toBe(200);
      const empty = await birth(w, "");
      expect((await call(w, "DELETE", `/api/bots/${empty.id}`)).status).toBe(200);
      await birth(w, "");
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
});

posixOnly("ENGINE-DEFAULT Fuigo retirement", () => {
  it.each(["in", "out"])("F5b: retiring Fuigo is refused with Claude auth %s", async auth => {
    const w = await boot(true, "claude", { env: { FAKE_CLAUDE_AUTH: auth, MURAGE_PROVIDER_CLOSE_MS: "8000" }, configure: (config, home) => {
      config.instances.fuigo.environment = { FAKE_ACP_MODE: "cancel-ack", FAKE_ACP_MCP_READY: "1", FAKE_ACP_RPC_DUMP: join(home, "fuigo-rpc"), FAKE_ACP_GATE_FILE: join(home, "fuigo-gate"), FAKE_ACP_TERM: "linger", FAKE_ACP_TERM_MS: "1800", FAKE_ACP_TERM_MARK: join(home, "fuigo-term") };
    } });
    try {
      await chiefOnClaude(w);
      const rows = (await call(w, "GET", "/api/instances")).body.instances;
      const fuigo = rows.find((r: any) => r.instanceId === "fuigo");
      const bot = (await call(w, "POST", "/api/bots", { name: "Fuigo held", modelSelection: { instanceId: "fuigo", model: fuigo.models.default } })).body.bot;
      expect((await call(w, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold" })).status).toBeLessThan(300);
      await until(async () => (await call(w, "GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy, "Fuigo busy");
      // The session must have accepted the prompt before disposal starts.
      await until(() => existsSync(join(w.home, "fuigo-rpc")) && readFileSync(join(w.home, "fuigo-rpc"), "utf8").includes("session/prompt"), "Fuigo accepted prompt").catch(async error => { throw Error(`${error}; rpc=${existsSync(join(w.home, "fuigo-rpc")) ? readFileSync(join(w.home, "fuigo-rpc"), "utf8") : "absent"}; bots=${JSON.stringify((await call(w, "GET", "/api/bots")).body).slice(-6000)}; stderr=${w.stderr.slice(-3000)}`); });
      let settled = false;
      const change = call(w, "PATCH", "/api/instances/fuigo", { enabled: false }).then(result => { settled = true; return result; });
      void change.catch(() => {});
      await until(() => existsSync(join(w.home, "fuigo-term")), "Fuigo disposal signal").catch(error => { throw Error(`${error}; settled=${settled}; stderr=${w.stderr.slice(-4000)}`); });
      expect(settled).toBe(false); await birth(w, "claude");
      expect((await change).status).toBe(200);
    } finally { await waitForExit(w.child, { signal: "SIGTERM" }); await removeTempDir(w.home); }
  }, 60000);
});
