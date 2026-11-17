import "./testing/port-integrity.ts";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>, dump: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const desktopApi = api;
// A failed BEGIN owns a connection but no transaction. Always close either shape.
function closeContentionLock(lock: DatabaseSync): void {
  try { if (lock.isTransaction) lock.exec("ROLLBACK"); } finally { lock.close(); }
}
/** Take the write lock the way a fixture must: wait for the server's own writer while acquiring (busy_timeout 5000), and only then drop the
 * wait to 0 so the measured foreground request sees a held lock. busy_timeout=0 before BEGIN IMMEDIATE fails "database is locked" whenever the
 * server happens to be writing at that instant (a wide parallel run). */
function acquireContentionLock(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("BEGIN IMMEDIATE");
  db.exec("PRAGMA busy_timeout=0");
}
type Row = { threadId: string; turnId?: string; token?: string; stopped?: string };
const rows = (threadId: string): Row[] => existsSync(dump) ? readFileSync(dump, "utf8").split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as Row).filter(row => row.threadId === threadId) : [];
const turnMemoryOutcomes = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn'").all(threadId).map(row => String(row.outcome)); }
  finally { db.close(); }
};
beforeEach(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
    const { makeLedgerDriver } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-ledger-driver.ts")).href)});
    BUILT_IN_DRIVERS.push(makeLedgerDriver());
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json'), cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.instances.ledger = { driver: 'fakeLedger', environment: { FAKE_LEDGER_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'ledger-boundaries'),
      FAKE_LEDGER_EVENTS: path.join(process.env.MURAGE_DATA_DIR, 'ledger-events') } };
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  dump = join(fixture.info.dataDir, "ledger-boundaries");
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
}, 30_000);
function preserveFixtureLog(): void {
  if (!fixture || !process.env.SC_LEDGER_EVIDENCE) return;
  const dir = process.env.SC_LEDGER_EVIDENCE;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fixture.info.logPath.split("/").at(-1)!), readFileSync(fixture.info.logPath));
  if (existsSync(dump)) writeFileSync(join(dir, fixture.info.dataDir.split("/").at(-1)! + ".jsonl"), readFileSync(dump));
}
afterEach(async () => {
  preserveFixtureLog();
  await fixture?.close();
});

it("terminal ledger refusal completes the waiting product client", async () => {
  const { ProductClient } = await import(new URL("../scripts/no-limits-live/run.mjs", import.meta.url).href);
  const bot = (await desktopApi("POST", "/api/bots", { name: "Terminal fixture", modelSelection: { instanceId: "ledger", model: "ledger-1" } })).body.bot;
  const client = new ProductClient(fixture.info.url, headers, fixture.info.dataDir, 3000);
  await client.connect();
  let lock: DatabaseSync | undefined;
  try {
    const result = await client.observe(bot, async () => {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Terminal fixture", threadId: bot.threadId })).status).toBe(202);
      await expect.poll(() => rows(bot.threadId).filter(row => row.turnId).length, { timeout: 10000 }).toBe(1);
      const admitted = rows(bot.threadId).find(row => row.turnId)!;
      const ready = await fetch(`${fixture.info.url}/api/internal/agents?self=${bot.id}`, { headers: { authorization: `Bearer ${admitted.token}` } });
      expect(ready.status).toBe(200); await ready.text();
      const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
      try {
        db.exec("PRAGMA busy_timeout=5000");
        expect(Number(db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE thread_id=?").run(bot.threadId).changes)).toBeGreaterThan(0);
        acquireContentionLock(db);
        lock = db;
      } finally { if (lock !== db) db.close(); }
      const refused = await fetch(`${fixture.info.url}/api/internal/agents?self=${bot.id}`, { headers: { authorization: `Bearer ${admitted.token}` } });
      expect(refused.status).toBe(409);
      await refused.text();
    });
    expect(result.complete).toBe(true);
    expect(result.ended).toBe(false);
    expect(result.events.filter((event: { type: string }) => event.type === "turn.completed")).toHaveLength(1);
    expect(result.turn.ok).toBe(false);
    // Completion is observable while the refusal's SQLite writes are blocked.
    expect(lock?.isTransaction).toBe(true);
    closeContentionLock(lock!); lock = undefined;
    await expect.poll(async () => (await desktopApi("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages
      .filter((message: { text?: string }) => message.text === "I stopped this turn because some of its context is no longer available.").length).toBe(1);
    expect(readFileSync(fixture.info.logPath, "utf8")).toContain("ledger refusal cause=checking:");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("refusal persistence failed");
    const noticeRows = () => {
      const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT id FROM messages WHERE thread_id=? AND text=?").all(bot.threadId,
        "I stopped this turn because some of its context is no longer available."); }
      finally { db.close(); }
    };
    const durable = noticeRows();
    expect(durable).toHaveLength(1);
    const notice = (await desktopApi("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages
      .find((message: { id: string }) => message.id === durable[0]!.id);
    expect(notice.actorKind).toBe("murage");
    expect(notice.speechGenerationId).toBeUndefined();
    await client.disconnect();
    preserveFixtureLog();
    // Restore only the deliberately malformed fixture JSON before boot's
    // schema validator runs. The durable notice and refused turn stay intact.
    // The server owns the write lock while it runs (refusal persistence retries on its own handle); this handle has no busy wait, so repair
    // only with the server stopped: the overlap was the "database is locked" failure of a wide run.
    const serverPid = fixture.info.pid;
    await fixture.stop();
    expect(() => process.kill(serverPid, 0)).toThrow();
    const repair = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    // The server is still running and keeps writing memory rows for a moment after the notice: wait for its writer instead of failing "database is locked".
    try { repair.exec("PRAGMA busy_timeout=5000"); repair.prepare("UPDATE memory_disclosures SET source_versions='[]' WHERE thread_id=?").run(bot.threadId); }
    finally { repair.close(); }
    await fixture.restart();
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    expect(noticeRows()).toEqual(durable);
    const restored = (await desktopApi("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages;
    expect(restored.filter((message: { text?: string }) => message.text ===
      "I stopped this turn because some of its context is no longer available.")).toHaveLength(1);
  } finally { if (lock) closeContentionLock(lock); await client.disconnect(); await api("DELETE", `/api/bots/${bot.id}`); }
});

// red-at-4df086541: a benign internal reply did not recheck the live receipt;
// the provider kept running and its eventual completion could settle normally.
// All mutations below target the verification server's private database.
it.each(["direct", "room"].flatMap(route => ["turn.completed", "session.exited", "runtime.error", "content.delta"]
  .map(event => ({ route, event }))))("T-LEDGER-STOP server $route finalizer survives $event and replacement", async ({ route, event }) => {
  const eventFile = join(fixture.info.dataDir, "ledger-events");
  writeFileSync(eventFile, event);
  const bot = (await desktopApi("POST", "/api/bots", { name: "Ledger fixture", modelSelection: { instanceId: "ledger", model: "ledger-1" } })).body.bot;
  const room = route === "room" ? (await api("POST", "/api/groups", {
    name: "Retained finalizer fixture", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
  })).body.group : undefined;
  const threadId = room?.threadId ?? bot.threadId;
  const start = async () => {
    const before = rows(threadId).filter(row => row.turnId).length;
    expect((await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${bot.id}/messages`,
      { text: "Ledger fixture", ...(room ? {} : { threadId }) })).status).toBe(202);
    await expect.poll(() => rows(threadId).filter(row => row.turnId).length, { timeout: 20_000 }).toBe(before + 1);
    const row = rows(threadId).filter(row => row.turnId).at(-1)!;
    expect(row.token).toMatch(/^[a-f0-9]{48}$/);
    return { row, headers: { authorization: `Bearer ${row.token}` } };
  };
  try {
    const first = await start();
    const url = `${fixture.info.url}/api/internal/agents?self=${bot.id}`;
    expect((await fetch(url, { headers: first.headers })).status).toBe(200);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=5000"); // contention with the server's own writes, not a held lock (7C-TRIAGE-RULING.md reader-lifecycle shape)
    let bundleId: string;
    try {
      const row = db.prepare("SELECT bundle_id FROM memory_disclosures WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId);
      expect(row, "ordinary dispatch must have joined an actual receipt").toBeDefined();
      bundleId = String(row!.bundle_id);
      db.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE bundle_id=?").run(bundleId);
    } finally { db.close(); }
    const refused = await fetch(url, { headers: first.headers });
    expect(refused.status, "benign response must refuse malformed retained receipt before result bytes").toBe(409);
    expect(await refused.text()).toBe("I stopped this turn because some of its context is no longer available.");
    await expect.poll(() => turnMemoryOutcomes(threadId).filter(value => value === "memory-refused").length,
      { timeout: 5_000 }).toBe(1);
    await expect.poll(() => rows(threadId).filter(row => row.stopped === first.row.turnId).length, { timeout: 5_000 }).toBe(1);
    // The actual server consumes duplicate terminal provider events.
    expect(turnMemoryOutcomes(threadId).filter(value => value === "memory-refused")).toHaveLength(1);
    const notices = async () => (await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages
      .filter((message: { text?: string }) => message.text === "I stopped this turn because some of its context is no longer available.");
    expect(await notices()).toHaveLength(1);
    const repair = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    repair.exec("PRAGMA busy_timeout=5000");
    try { repair.prepare("UPDATE memory_disclosures SET source_versions='[]' WHERE bundle_id=?").run(bundleId!); }
    finally { repair.close(); }
    const next = await start();
    expect(next.row.turnId).not.toBe(first.row.turnId);
    expect((await fetch(url, { headers: first.headers })).status).toBe(401);
    expect((await fetch(url, { headers: next.headers })).status).toBe(200);
    expect(turnMemoryOutcomes(threadId).filter(value => value === "memory-refused")).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
    expect(rows(threadId).filter(row => row.stopped === next.row.turnId)).toHaveLength(0);
    const messages = (await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;
    expect(JSON.stringify(messages)).not.toContain("fixture late provider content");
    expect(JSON.stringify(messages)).not.toContain("fixture late provider failure");
  } finally {
    rmSync(eventFile, { force: true });
    if (room) {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
    } else await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  }
});

// red-at-4df086541: a busy exception bypassed the original consuming writer.
// The live row is the 503/Retry-After control. This is a real second SQLite
// connection holding a write lock, not a closed handle or injected busy error.
it.each(["live", "revoked"])("T-BUSY-RELEASE server outer contention/%s", async state => {
  const bot = (await api("POST", "/api/bots", { name: "Busy fixture", modelSelection: { instanceId: "ledger", model: "ledger-1" } })).body.bot;
  let lock: DatabaseSync | undefined;
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Busy fixture", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => rows(bot.threadId).filter(row => row.turnId).length, { timeout: 20_000 }).toBe(1);
    const admitted = rows(bot.threadId).find(row => row.turnId)!;
    expect(admitted.token).toMatch(/^[a-f0-9]{48}$/);
    // sendTurn records its token before acceptance bookkeeping finishes.
    // Match the sibling's real retained-reply rendezvous before competing
    // with the server writer; the response deadline below is unchanged.
    const ready = await fetch(`${fixture.info.url}/api/internal/agents?self=${bot.id}`, {
      headers: { authorization: `Bearer ${admitted.token}` },
    });
    expect(ready.status).toBe(200); await ready.text();
    lock = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    // Fixture-only acquisition, before measurement, just like the sibling.
    lock.exec("PRAGMA busy_timeout=5000");
    if (state === "revoked") {
      const changed = lock.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE thread_id=?").run(bot.threadId);
      expect(Number(changed.changes)).toBeGreaterThan(0);
    }
    expect(() => acquireContentionLock(lock!)).not.toThrow();
    const started = performance.now();
    const reply = await fetch(`${fixture.info.url}/api/internal/request-credential`, {
      method: "POST", headers: { authorization: `Bearer ${admitted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "openaiImageApiKey" }),
    });
    const text = await reply.text();
    expect(performance.now() - started).toBeLessThan(4_000);
    lock.exec("ROLLBACK"); lock.close(); lock = undefined;
    if (state === "live") {
      expect(reply.status).toBe(503); expect(reply.headers.get("retry-after")).toBe("1");
      expect(JSON.parse(text)).toMatchObject({ code: "DATABASE_BUSY" });
      expect(rows(bot.threadId).filter(row => row.stopped)).toHaveLength(0);
    } else {
      expect(reply.status).toBe(409); expect(reply.headers.has("retry-after")).toBe(false);
      expect(text).toBe("I stopped this turn because some of its context is no longer available.");
      await expect.poll(() => rows(bot.threadId).filter(row => row.stopped === admitted.turnId).length, { timeout: 5_000 }).toBe(1);
    }
    const check = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(check.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND kind='secret'").get(bot.threadId)!.n).toBe(0);
    } finally { check.close(); }
  } finally {
    if (lock) closeContentionLock(lock);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await api("DELETE", `/api/bots/${bot.id}`);
  }
});

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it.each(["live", "revoked"])("SC-SAFETY added coverage: T-BUSY-RELEASE server outer contention/%s", async state => {
  const bot = (await api("POST", "/api/bots", { name: "Busy fixture", modelSelection: { instanceId: "ledger", model: "ledger-1" } })).body.bot;
  let lock: DatabaseSync | undefined;
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Busy fixture", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => rows(bot.threadId).filter(row => row.turnId).length, { timeout: 20_000 }).toBe(1);
    const admitted = rows(bot.threadId).find(row => row.turnId)!;
    expect(admitted.token).toMatch(/^[a-f0-9]{48}$/);
    // The provider records its token inside sendTurn, before the server's
    // acceptance continuations finish. Complete an ordinary retained reply
    // while the binding is still live before corrupting or locking its DB.
    // This rendezvous prevents the lock from stranding dispatch bookkeeping.
    const ready = await fetch(`${fixture.info.url}/api/internal/agents?self=${bot.id}`, {
      headers: { authorization: `Bearer ${admitted.token}` },
    });
    expect(ready.status).toBe(200);
    await ready.text();
    lock = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    // Lock acquisition is the fixture handshake with the separate server
    // writer. Wait only here, before measuring its foreground response.
    lock.exec("PRAGMA busy_timeout=5000");
    if (state === "revoked") {
      const changed = lock.prepare("UPDATE memory_disclosures SET source_versions='{}' WHERE thread_id=?").run(bot.threadId);
      expect(Number(changed.changes)).toBeGreaterThan(0);
    }
    acquireContentionLock(lock);
    const started = performance.now();
    const reply = await fetch(`${fixture.info.url}/api/internal/request-credential`, {
      method: "POST", headers: { authorization: `Bearer ${admitted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "openaiImageApiKey" }),
    });
    const text = await reply.text();
    expect(performance.now() - started).toBeLessThan(4_000);
    closeContentionLock(lock); lock = undefined;
    if (state === "live") {
      expect(reply.status).toBe(503); expect(reply.headers.get("retry-after")).toBe("1");
      expect(JSON.parse(text)).toMatchObject({ code: "DATABASE_BUSY" });
      expect(rows(bot.threadId).filter(row => row.stopped)).toHaveLength(0);
    } else {
      expect(reply.status).toBe(409); expect(reply.headers.has("retry-after")).toBe(false);
      expect(text).toBe("I stopped this turn because some of its context is no longer available.");
      await expect.poll(() => rows(bot.threadId).filter(row => row.stopped === admitted.turnId).length, { timeout: 5_000 }).toBe(1);
    }
    const check = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(check.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND kind='secret'").get(bot.threadId)!.n).toBe(0);
    } finally { check.close(); }
  } finally {
    if (lock) { closeContentionLock(lock); lock = undefined; }
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await api("DELETE", `/api/bots/${bot.id}`);
  }
});

// "database is locked" in a wide run: the fixture took its lock with busy_timeout=0 while the server was mid-write. Forced overlap: another process
// (the server's writer) holds the write lock and releases it after a delay; acquisition, a synchronous call, must wait for it, then hold the lock.
it("T-BUSY-ACQUIRE the fixture lock waits for a concurrent writer instead of failing database is locked", async () => {
  const file = join(fixture.info.dataDir, "acquire-overlap.db");
  const setup = new DatabaseSync(file); setup.exec("CREATE TABLE t (n INTEGER)"); setup.close();
  const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`, file], { stdio: ["ignore", "pipe", "inherit"] });
  const lock = new DatabaseSync(file);
  try {
    await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.stdout!.once("data", () => resolve()); });
    const started = performance.now();
    acquireContentionLock(lock);
    expect(performance.now() - started).toBeGreaterThan(100);
    expect(lock.isTransaction).toBe(true);
  } finally { closeContentionLock(lock); holder.kill(); }
});
