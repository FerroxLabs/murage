// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), rows on a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA).
// A2 core: a start below START_FLOOR_BYTES (but above the worker's 64 MiB floor, so only the start check can make it read-only) serves reads and refuses
// every write at the request edge with the owner's words, and stays up.
// Runs only where /strict is a real mount; elsewhere it is skipped because there is no small filesystem to fill.
// HEADLESS ONLY: throwaway HOME under /strict and a probed port.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const STRICT = "/strict";
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const MiB = 1024 * 1024;
const OWNER_COPY = "Your disk is almost full. Chats are read-only. Free some space, then restart Murage.";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const onStrictMount = (() => { try { return readFileSync("/proc/mounts", "utf8").split("\n").some(line => line.split(" ")[1] === STRICT); } catch { return false; } })();
const free = () => { const s = statfsSync(STRICT); return s.bavail * s.bsize; };

interface Run { child: ChildProcess; out: () => string; exited: () => number | null | undefined }
function start(home: string, port: number): Run {
  let output = "", code: number | null | undefined;
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", chunk => (output += chunk));
  child.stderr!.on("data", chunk => (output += chunk));
  child.on("exit", c => { code = c; });
  return { child, out: () => output, exited: () => code };
}
async function healthOk(port: number, run: Run): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (run.exited() !== undefined) return false;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await sleep(50);
  }
  return false;
}
function fillTo(file: string, targetFree: number): void {
  const fd = openSync(file, "a"); const buf = Buffer.alloc(MiB, 1);
  try { while (free() - targetFree > 0) writeSync(fd, buf, 0, Math.min(MiB, free() - targetFree)); } finally { closeSync(fd); }
}

interface Fixture { home: string; data: string; port: number; bots: string[] }
const api = (port: number, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
async function desktopHeaders(port: number): Promise<Record<string, string>> {
  const secret = (await (await api(port, "/api/desktop-secret")).json()) as { secret: string };
  return { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
}
/** The snapshot of ACCEPTANCE.md: every table's rows hashed in key order, the data dir inventory (no -wal/-shm) and the hash of every file's bytes (MAIN
 * 2026-11-17 Q2: no exclusion list; only SQLite's own -wal/-shm are left out, their content compared through every table's rows). */
function snapshot(data: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || /-(wal|shm)$/.test(entry.name)) continue;
      parts.push(`${full.slice(data.length)}:${statSync(full).size}`);
      parts.push(`sha:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(data);
  for (const entry of readdirSync(data).filter(name => /\.(db|sqlite)$/.test(name)).sort()) {
    const db = new DatabaseSync(join(data, entry), { readOnly: true });
    try {
      for (const { name } of db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>) {
        const keys = (db.prepare(`pragma table_info("${name}")`).all() as Array<{ name: string; pk: number }>).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => `"${c.name}"`);
        const hash = createHash("sha256");
        const rows = db.prepare(`select * from "${name}" order by ${keys.length ? keys.join(",") : "rowid"}`); rows.setReadBigInts(true);
        for (const row of rows.iterate()) hash.update(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
        parts.push(`${entry}:${name}:${hash.digest("hex")}`);
      }
    } finally { db.close(); }
  }
  return parts.join("\n");
}

/** A browser owner record saved under the old desktop owner id (the constructor would migrate and rewrite it) and a failed-close record (recovery would rewrite it). */
const legacyOwner = createHash("sha256").update("original-installation:desktop").digest("hex").slice(0, 32);
const browserFixture = JSON.stringify([["fixture-migrated", { generation: 1, held: false, owner: legacyOwner }], ["fixture-failed-close", { generation: 2, held: true, owner: null, closeFailed: true }]]);

describe.skipIf(!onStrictMount)("boot tolerance on a real small filesystem", () => {
  const runs: Run[] = [];
  // each case starts from an empty small filesystem: a finished case's server and ballast would otherwise eat the next case's space
  const clean = async () => {
    for (const run of runs.splice(0)) if (run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" });
    for (const leg of ["a2", "d1", "d3", "d4"]) rmSync(join(STRICT, leg), { recursive: true, force: true });
  };
  afterEach(clean);
  afterAll(clean);

  it("A2 core: a read-only start serves reads and refuses every write with the owner's words", { timeout: 600_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_911, 200);
    rmSync(join(STRICT, "a2"), { recursive: true, force: true });
    const home = join(STRICT, "a2", "home"); const data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    chmodSync(FAKE_CLAUDE, 0o755);
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } } } }));
    const get = async (path: string) => { const res = await api(port, path, { headers: await desktopHeaders(port) }); expect(res.status, path).toBe(200); return (await res.json()) as any; };
    type Bot = { id: string; name: string; threadId: string };
    // `tasksEpoch` and `threadVersion` are cache tokens a process mints for itself at its start; every other field of the list is compared
    const stable = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === "tasksEpoch" || key === "threadVersion" ? undefined : v)));
    const threadList = async () => stable((await get("/api/bots?messages=0")).bots) as Bot[];
    const body = async (threadId: string) => (await get(`/api/threads/${threadId}/messages?limit=100`)).messages as Array<{ id: string; role: string; kind: string; text?: string }>;
    const runsOf = async (routineId: string) => ((await get("/api/routines")).runs ?? []).filter((run: { routineId: string }) => run.routineId === routineId);

    // Fixture, first start: five conversations, each with a real turn (a 2 KiB owner message and the engine's answer).
    const first = start(home, port); runs.push(first);
    expect(await healthOk(port, first), first.out().slice(-4000)).toBe(true);
    let headers = await desktopHeaders(port);
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const bots: Bot[] = [];
    for (const name of ["Fixture One", "Fixture Two", "Fixture Three", "Fixture Four", "Fixture Five"]) {
      const created = await api(port, "/api/bots", { method: "POST", headers, body: JSON.stringify({ name, modelSelection, requireAvailableModel: true }) });
      expect(created.status, await created.clone().text()).toBe(201);
      const bot = ((await created.json()) as { bot: Bot }).bot; bots.push(bot);
      expect((await api(port, `/api/bots/${bot.id}`, { method: "PATCH", headers, body: JSON.stringify({ modelSelection, computer: "off" }) })).status).toBe(200);
      const sent = await api(port, `/api/bots/${bot.id}/messages`, { method: "POST", headers, body: JSON.stringify({ threadId: bot.threadId, text: `${name} asks. ${"x".repeat(2048)}` }) });
      expect(sent.status, await sent.clone().text()).toBe(202);
    }
    for (const bot of bots) {
      let seen = "";
      await until(async () => {
        const task = (((await get(`/api/bots/${bot.id}`)).bot?.tasks ?? []) as Array<{ threadId: string; busy?: boolean }>).find(t => t.threadId === bot.threadId);
        const messages = await body(bot.threadId);
        seen = `busy=${String(task?.busy)} messages=${JSON.stringify(messages).slice(0, 1500)} server=${first.out().slice(-1500)}`;
        return (task?.busy ?? false) === false && messages.findIndex(message => message.role === "user") >= 0 && messages.slice(messages.findIndex(message => message.role === "user") + 1).some(message => message.role === "bot" && message.kind === "text");
      }, () => `${bot.name}: the turn finished (${seen})`, 60_000);
    }
    await waitForExit(first.child, { signal: "SIGTERM" });

    // Between starts: the history's bulk (400 conversations, a 2 KiB message each).
    const seed = new DatabaseSync(join(data, "messages.db"));
    seed.exec(`INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<400)
      SELECT printf('thread-bulk-%04d', i), printf('msg-bulk-%04d', i), i, 'user', 'text', printf('%.*c', 2048, 'y'), json_object('turnId', printf('turn-bulk-%04d', i)) FROM n`);
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seed.close();

    // Second normal start: a routine that falls due while the server is down, then the capture every later read is compared with.
    const second = start(home, port); runs.push(second);
    expect(await healthOk(port, second), second.out().slice(-4000)).toBe(true);
    headers = await desktopHeaders(port);
    const dueAt = Date.now() + 15_000;
    const routine = await api(port, "/api/routines", { method: "POST", headers, body: JSON.stringify({ name: "Fixture routine", botId: bots[0]!.id, prompt: "Write the fixture brief.", enabled: true, schedule: { type: "once", at: dueAt } }) });
    expect(routine.status, await routine.clone().text()).toBe(201);
    const routineId = ((await routine.json()) as { routine: { id: string } }).routine.id;
    const listBefore = await threadList();
    const bodiesBefore = await Promise.all(bots.map(bot => body(bot.threadId)));
    expect(listBefore.map(bot => bot.name)).toEqual(expect.arrayContaining(bots.map(bot => bot.name)));
    for (const messages of bodiesBefore) {
      expect(messages.map(message => message.role)).toEqual(expect.arrayContaining(["user", "bot"]));
      expect(JSON.stringify(messages).length).toBeGreaterThan(2048);
    }
    expect(await runsOf(routineId), "the routine has not run before the stop").toEqual([]);
    await waitForExit(second.child, { signal: "SIGTERM" });
    expect(Date.now(), "the fixture server stopped before the routine fell due").toBeLessThan(dueAt);
    // after the last normal start (which would rewrite them): the two browser records that a start's recovery rewrites
    writeFileSync(join(data, "browser-control.json"), browserFixture);
    const snapBefore = snapshot(data);
    while (Date.now() < dueAt + 1_000) await sleep(250);

    // 100 MiB free: below START_FLOOR_BYTES (128 MiB), above the worker's 64 MiB floor
    fillTo(join(STRICT, "a2", "ballast"), 100 * MiB);
    const run = start(home, port); runs.push(run);
    expect(await healthOk(port, run), run.out().slice(-6000)).toBe(true);
    headers = await desktopHeaders(port);
    expect((await (await api(port, "/api/health")).json() as { diskLow?: { mode?: string } }).diskLow?.mode).toBe("read-only");
    // nothing was written between the end of the open and listen; the recoveries that would have written are named as held back
    // (soft: a start that still writes fails here and the rest of the case still reports what else holds)
    expect.soft(run.out().split("\n").filter(line => line.startsWith("[startup] writes since open="))).toEqual(["[startup] writes since open=0"]);
    await until(async () => /\[startup\] read-only start: held back=.*\n/.test(run.out()), "the held-back line is printed after the first health answer");
    const skipped = /\[startup\] read-only start: held back=(.*)\n/.exec(run.out())?.[1]?.split(",") ?? [];
    expect(skipped).toEqual(expect.arrayContaining(["browser.recoverClosedEntries", "routines.start"]));
    // reads: the thread list and the five thread bodies are the pre-stop capture
    expect(await threadList()).toEqual(listBefore);
    for (const [index, bot] of bots.entries()) expect(await body(bot.threadId), `${bot.name}: thread body`).toEqual(bodiesBefore[index]);

    const writes: Array<[string, string, unknown]> = [
      ["POST", "/api/bots", { name: "Refused" }],
      ["POST", `/api/bots/${bots[0]!.id}/messages`, { threadId: bots[0]!.threadId, text: "refused" }],
      ["PATCH", `/api/bots/${bots[0]!.id}`, { name: "Renamed" }],
      ["DELETE", `/api/bots/${bots[0]!.id}`, undefined],
    ];
    for (const [method, path, payload] of writes) {
      const res = await api(port, path, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      expect({ method, path, status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() })
        .toEqual({ method, path, status: 503, retryAfter: null, body: { error: OWNER_COPY, code: "DATABASE_BUSY", reason: "read-only-start", retryable: false } });
    }
    await sleep(35_000);
    expect(run.exited(), run.out().slice(-6000)).toBeUndefined();
    expect(run.out()).not.toMatch(/unhandledRejection/);
    expect((await api(port, "/api/health")).status).toBe(200);
    // the routine was due at the start and for the whole 35 s: no run, no turn
    expect(await runsOf(routineId), "the due routine did not run").toEqual([]);
    expect(await threadList()).toEqual(listBefore);
    for (const [index, bot] of bots.entries()) expect(await body(bot.threadId), `${bot.name}: thread body after 35 s`).toEqual(bodiesBefore[index]);
    // A2 and A2b: after the 35 s and every refused write, the database rows, the data dir inventory and every json file (the two browser records included) are as they were
    await waitForExit(run.child, { signal: "SIGTERM" });
    const snapAfter = snapshot(data);
    expect(snapAfter).toBe(snapBefore);
    expect(readFileSync(join(data, "browser-control.json"), "utf8")).toBe(browserFixture);
  });

  /** Fixture F: a normal start with ample space, two bots through the API, a clean stop. */
  async function fixtureF(leg: string): Promise<Fixture> {
    const port = await freePortBlock([0, 1], 19_911, 200);
    rmSync(join(STRICT, leg), { recursive: true, force: true });
    const home = join(STRICT, leg, "home"); const data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    const first = start(home, port); runs.push(first);
    expect(await healthOk(port, first), first.out().slice(-4000)).toBe(true);
    const headers = await desktopHeaders(port);
    const bots: string[] = [];
    for (const name of ["Fixture One", "Fixture Two"]) {
      const res = await api(port, "/api/bots", { method: "POST", headers, body: JSON.stringify({ name }) });
      expect(res.status, `${name}: ${await res.clone().text()}`).toBe(201);
      bots.push(((await res.json()) as { bot: { id: string } }).bot.id);
    }
    await waitForExit(first.child, { signal: "SIGTERM" });
    return { home, data, port, bots };
  }
  const health = async (port: number) => (await (await api(port, "/api/health")).json()) as { diskLow?: { mode: string } };
  const inbox = async (f: Fixture) => (await (await api(f.port, "/api/inbox?view=decisions", { headers: await desktopHeaders(f.port) })).json()) as { diskLow?: { mode: string } };
  async function until(check: () => Promise<boolean>, what: string | (() => string), ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check()) return; await sleep(250); }
    throw new Error(`timed out: ${typeof what === "string" ? what : what()}`);
  }
  type Notice = { kind: string; notification: { kind: string; id: string; body: string } };
  /** Reads one owner event stream for `ms` and returns its disk-low notify frames. */
  async function diskNotices(f: Fixture, ms: number): Promise<Notice[]> {
    const controller = new AbortController();
    const res = await api(f.port, "/api/events", { headers: await desktopHeaders(f.port), signal: controller.signal });
    const reader = res.body!.getReader(); const decoder = new TextDecoder(); let text = "";
    const timer = setTimeout(() => controller.abort(), ms);
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); } } catch { /* aborted at the deadline */ } finally { clearTimeout(timer); }
    return text.split("\n").filter(line => line.startsWith("data: ")).map(line => { try { return JSON.parse(line.slice(6)) as Notice; } catch { return null; } })
      .filter((frame): frame is Notice => frame?.kind === "notify" && frame.notification?.id === "disk.read-only-start");
  }

  it("D1: the read-only state stays visible after space returns", { timeout: 300_000 }, async () => {
    const f = await fixtureF("d1");
    fillTo(join(STRICT, "d1", "ballast"), 100 * MiB);
    const run = start(f.home, f.port); runs.push(run);
    expect(await healthOk(f.port, run), run.out().slice(-6000)).toBe(true);
    expect((await health(f.port)).diskLow?.mode).toBe("read-only");
    expect((await inbox(f)).diskLow?.mode).toBe("read-only");
    rmSync(join(STRICT, "d1", "ballast"), { force: true });
    expect(free()).toBeGreaterThan(256 * MiB);
    await sleep(3000); // longer than a worker sample: a live floor would have cleared by now
    expect((await health(f.port)).diskLow?.mode).toBe("read-only");
    expect((await inbox(f)).diskLow?.mode).toBe("read-only");
    expect(run.exited()).toBeUndefined();
  });

  it("D3: one owner notice per process, nothing written", { timeout: 300_000 }, async () => {
    const f = await fixtureF("d3");
    const before = snapshot(f.data);
    fillTo(join(STRICT, "d3", "ballast"), 100 * MiB);
    const run = start(f.home, f.port); runs.push(run);
    expect(await healthOk(f.port, run), run.out().slice(-6000)).toBe(true);
    const first = await diskNotices(f, 2500);
    const second = await diskNotices(f, 2500);
    expect(first.map(frame => [frame.notification.kind, frame.notification.id, frame.notification.body])).toEqual([["disk-low", "disk.read-only-start", OWNER_COPY]]);
    expect(second).toEqual([]);
    await waitForExit(run.child, { signal: "SIGTERM" });
    expect(snapshot(f.data)).toBe(before);
  });

  it("D4: a runtime floor is shown and clears", { timeout: 300_000 }, async () => {
    const f = await fixtureF("d4");
    const run = start(f.home, f.port); runs.push(run);
    expect(await healthOk(f.port, run), run.out().slice(-6000)).toBe(true);
    const headers = await desktopHeaders(f.port);
    expect((await health(f.port)).diskLow).toBeUndefined();
    expect((await api(f.port, "/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "Before Floor" }) })).status).toBe(201);
    fillTo(join(STRICT, "d4", "ballast"), 40 * MiB);
    await until(async () => (await health(f.port)).diskLow?.mode === "refusing", "health reports refusing");
    expect((await inbox(f)).diskLow?.mode).toBe("refusing");
    const refused = await api(f.port, "/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "Refused By Floor" }) });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { reason?: string }).reason).toBe("disk-floor");
    rmSync(join(STRICT, "d4", "ballast"), { force: true });
    await until(async () => (await health(f.port)).diskLow === undefined, "health clears");
    expect((await inbox(f)).diskLow).toBeUndefined();
    expect((await api(f.port, "/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "After Floor" }) })).status).toBe(201);
    expect(run.exited()).toBeUndefined();
  });
});
