import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { prepareFixtureRecall } from "../testing/recall-ready-fixture.ts";

let fixture: VerificationServer, headers: Record<string, string>, dump: string;
const doorToken = "e".repeat(64);
const api = async (method: string, path: string, body?: unknown, authority = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...authority, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
type Row = { threadId: string; bound: boolean; same: boolean; frozen: boolean; audience: null | { owner: boolean; scopeIds: string[] };
  receiptScopes: string[]; receiptCount: number };
const rows = (threadId: string): Row[] => existsSync(dump) ? readFileSync(dump, "utf8").split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as Row).filter(row => row.threadId === threadId) : [];

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: doorToken }, instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const rebuild = path.join(process.env.MURAGE_DATA_DIR, 'receipt-fault');
      if (String(sql).startsWith('INSERT INTO memory_disclosures(') && fs.existsSync(rebuild)) {
        const remaining = Number(fs.readFileSync(rebuild, 'utf8'));
        if (remaining > 0) {
          if (remaining === 1) fs.unlinkSync(rebuild); else fs.writeFileSync(rebuild, String(remaining - 1));
          fs.appendFileSync(rebuild + '.hits', '1\\n');
          throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { code: 'MEMORY_CONTEXT_REVOKED' });
        }
      }
      return prepare.call(this, sql, ...args);
    };
    // Early reader fault. deny-read keeps one cached prepared statement per handle, so a hook on prepare only fires on the first lookup in the
    // process and never after an earlier row warmed the cache. Hook the execution (all/get) instead, keyed on sourceSQL. It is inert without the
    // flag file, fires once, and restores both prototype methods when it fires.
    const { StatementSync } = await import('node:sqlite');
    const origAll = StatementSync.prototype.all, origGet = StatementSync.prototype.get, origIterate = StatementSync.prototype.iterate;
    const earlyFault = original => function(...args) {
      const flag = path.join(process.env.MURAGE_DATA_DIR, 'early-reader-fault');
      if (this.sourceSQL.includes('FROM memory_deny_pending p') && fs.existsSync(flag)) {
        fs.renameSync(flag, flag + '.hit');
        StatementSync.prototype.all = origAll; StatementSync.prototype.get = origGet; StatementSync.prototype.iterate = origIterate;
        throw new Error('fixture early reader lookup');
      }
      return original.apply(this, args);
    };
    StatementSync.prototype.all = earlyFault(origAll); StatementSync.prototype.get = earlyFault(origGet); StatementSync.prototype.iterate = earlyFault(origIterate);
    // Cleanup gate: while the flag exists, no pending deletion window is removed, so a deleted bot's cleanup stays unfinished.
    const origRun = StatementSync.prototype.run;
    StatementSync.prototype.run = function(...args) {
      if (/^\s*DELETE FROM memory_deny_pending\b/.test(this.sourceSQL) && fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'cleanup-hold'))) return { changes: 0, lastInsertRowid: 0 };
      return origRun.apply(this, args);
    };
    await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/recall-ready-preload.mjs")).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
    const { makeKeepingDriver } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-keeping-driver.ts")).href)});
    const driver = makeKeepingDriver(), create = driver.create;
    driver.create = async function(input) {
      const runtime = await create.call(driver, input), send = runtime.adapter.sendTurn;
      const reset = runtime.adapter.resetSession;
      runtime.adapter.resetSession = async function(...args) {
        await reset?.apply(runtime.adapter, args);
        const arm = path.join(process.env.MURAGE_DATA_DIR, 'reset.arm');
        if (fs.existsSync(arm)) {
          fs.renameSync(arm, arm + '.waiting');
          await new Promise(resolve => {
            const timer = setInterval(() => {
              if (!fs.existsSync(arm + '.go')) return;
              clearInterval(timer); fs.unlinkSync(arm + '.go'); fs.unlinkSync(arm + '.waiting'); resolve();
            }, 20);
          });
        }
      };
      runtime.adapter.sendTurn = async function(turn) {
        const reader = turn.releaseBinding?.turn.reader, check = turn.beforeSubmit;
        return send.call(runtime.adapter, { ...turn, beforeSubmit() {
          check?.();
          const live = turn.releaseBinding?.turn;
          const receipts = live?.parents.filter(ref => ref.kind === 'receipt') ?? [];
          fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR, 'reader-boundaries'), JSON.stringify({
            threadId: turn.threadId, bound: Boolean(turn.releaseBinding), same: reader === live?.reader,
            frozen: Boolean(reader && Object.isFrozen(reader) && (reader.audience === null ||
              Object.isFrozen(reader.audience) && Object.isFrozen(reader.audience.scopeIds))),
            audience: reader?.audience, receiptCount: receipts.length,
            receiptScopes: [...new Set(receipts.flatMap(ref => ref.scopeIds ?? []))]
          }) + '\\n');
        } });
      };
      return runtime;
    };
    BUILT_IN_DRIVERS.push(driver);
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json'), cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const restored = path.join(process.env.MURAGE_DATA_DIR, 'restored'); fs.mkdirSync(restored, { recursive: true });
    cfg.instances.keep = { driver: 'fakeKeeping', environment: { FAKE_KEEP_RESTORED: restored } };
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  dump = join(fixture.info.dataDir, "reader-boundaries");
}, 30_000);
afterAll(async () => { await fixture?.close(); });

// 7C deny-pending ruling: preparedWindowIdentity threw above 512 pending rows anywhere in the file, so a fresh send in an unrelated chat took
// MC63 ruling 1117T09:54Z: a turn never waits on cleanup for bots that are not part of it. Deleting a bot leaves an all-conversations
// pending window until its cleanup finishes; a room read without memory named none of its lines, so its prefix was judged against that
// window and the turn sat silent until the cleanup ended (up to 65 s). The window is seeded as an unfinished cleanup's and held for the test.
it("MC63 unrelated cleanup held: a room turn without memory and a direct turn still reach the engine", async () => {
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
  const hold = join(fixture.info.dataDir, "cleanup-hold");
  const bot = (await api("POST", "/api/bots", { name: "Held fixture", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
  const room = (await api("POST", "/api/groups", { name: "Held room", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  await prepareFixtureRecall(fixture.info.dataDir, bot.id, room.threadId);
  await prepareFixtureRecall(fixture.info.dataDir, bot.id, bot.threadId);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    writeFileSync(hold, "1");
    db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)").run(990_001);
    const windows = () => Number((db.prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'").get() as { n: number }).n);
    expect(windows()).toBeGreaterThan(0);
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Held room fixture" })).status).toBe(202);
    await expect.poll(() => rows(room.threadId).length, { timeout: 10_000 }).toBe(1);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Held direct fixture", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => rows(bot.threadId).length, { timeout: 10_000 }).toBe(1);
    // The window was still there for both turns.
    expect(windows()).toBeGreaterThan(0);
  } finally {
    rmSync(hold, { force: true });
    try { db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=?").run(990_001); } finally { db.close(); }
    await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await api("DELETE", `/api/groups/${room.id}`); await api("DELETE", `/api/bots/${bot.id}`);
  }
});
