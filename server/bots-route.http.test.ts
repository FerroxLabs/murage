// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.15 BIRTH-FUIGO-1014 P1 and P2 at the route, on a real server: the first-launch Chief and a POST /api/bots with no selection are
// born by the birth rule (a usable Fuigo, else a desktop copy of the Chief, else empty), marked; an owner pick in the body is kept,
// unmarked, live and on disk. Two servers: one with a Flux key (Fuigo's catalogue usable), one without (keyless Fuigo is not).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const GROK = { instanceId: "grok", model: "fake-model" };

type World = { base: string; home: string; child: ChildProcess; headers: Record<string, string>; stderr: string };

async function boot(withKey: boolean, found: "grok" | "claude" | null = "grok"): Promise<World> {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  chmodSync(FAKE_CLI, 0o755);
  chmodSync(FAKE_CLAUDE, 0o755);
  const home = mkdtempSync(join(tmpdir(), "murage-birth-route-"));
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, ".fuigo"), { recursive: true });
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
    ...(withKey ? { flux: { apiKey: "sk-flux-birthroutefixture000000000000000000" } } : {}), // secret-scan: fixture
    instances: {
      fuigo: { driver: "fuigoAgent", config: { cli: FAKE_CLI, fullAuto: false } },
      // r3: `found` is a machine where another engine was already set up (Claude Code in the field)
      ...(found === "grok" ? { grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } } : {}),
      ...(found === "claude" ? { claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE } } } : {}),
    },
  }));
  const world: World = { base, home, headers: {}, stderr: "", child: spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
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
