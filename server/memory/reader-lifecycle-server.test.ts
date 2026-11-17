import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { prepareFixtureRecall } from "../testing/recall-ready-fixture.ts";

let fixture: VerificationServer, headers: Record<string, string>, dump: string;
const doorToken = "e".repeat(64);
const remote = { "x-murage-companion": "1", "x-murage-door-token": doorToken };
const api = async (method: string, path: string, body?: unknown, authority = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...authority, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
type Row = { threadId: string; bound: boolean; same: boolean; frozen: boolean; audience: null | { owner: boolean; scopeIds: string[] };
  receiptScopes: string[]; receiptCount: number };
const rows = (threadId: string): Row[] => existsSync(dump) ? readFileSync(dump, "utf8").split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as Row).filter(row => row.threadId === threadId) : [];
const resetLines = (threadId: string): string[] => readFileSync(fixture.info.logPath, "utf8").split("\n")
  .filter(line => line.includes(`memory continuation reset thread=${threadId} `));

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: doorToken }, instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const { StatementSync } = await import('node:sqlite');
    const run = StatementSync.prototype.run;
    // Reused statements still execute every receipt attempt; a prepare hook misses the cached ones.
    StatementSync.prototype.run = function(...args) {
      const rebuild = path.join(process.env.MURAGE_DATA_DIR, 'receipt-fault');
      if (this.sourceSQL.startsWith('INSERT INTO memory_disclosures(') && fs.existsSync(rebuild)) {
        const remaining = Number(fs.readFileSync(rebuild, 'utf8'));
        if (remaining > 0) {
          if (remaining === 1) fs.unlinkSync(rebuild); else fs.writeFileSync(rebuild, String(remaining - 1));
          fs.appendFileSync(rebuild + '.hits', '1\\n');
          throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { code: 'MEMORY_CONTEXT_REVOKED' });
        }
      }
      return run.apply(this, args);
    };
    // Early reader fault. deny-read keeps one cached prepared statement per handle, so a hook on prepare only fires on the first lookup in the
    // process and never after an earlier row warmed the cache. Hook the execution (all/get) instead, keyed on sourceSQL. It is inert without the
    // flag file, fires once, and restores both prototype methods when it fires.
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
// the last-resort route (receiptCount 0). 513 unrelated rows must not change a direct-owner turn. Runs first: it does not rely on buildup.
it("T-DENY-PENDING-BOUND server: 513 unrelated pending rows leave a direct-owner turn with its memory receipts", async () => {
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
  const bot = (await api("POST", "/api/bots", { name: "Bound fixture", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
  const threadId = bot.threadId;
  await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const insert = db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,1,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 513; i++) insert.run(`seed-deny-bound-${i}`, 880_000 + i);
    db.exec("COMMIT");
    const result = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Bound fixture", threadId });
    expect(result.status).toBe(202);
    await expect.poll(() => rows(threadId).length, { timeout: 20_000 }).toBe(1);
    expect(rows(threadId)[0]!.audience).toBeNull();
    expect(rows(threadId)[0]!.receiptCount).toBeGreaterThan(0);
  } finally {
    try { db.exec("DELETE FROM memory_deny_pending WHERE thread_id LIKE 'seed-deny-bound-%'"); } finally { db.close(); }
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await api("DELETE", `/api/bots/${bot.id}`);
  }
});

// red-at-4df086541: real dispatch had no immutable concrete reader shared
// from preparation through the final adapter write; active scopes joined late.
it.each(["direct-owner", "direct-unproven", "owner-room", "non-owner-room"].flatMap(route =>
  ["active", "off", "capture", "paused"].map(mode => ({ route, mode }))))("T-READER-LIFECYCLE server $route/$mode", async ({ route, mode }) => {
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: mode === "paused" ? "active" : mode })).status).toBe(200);
  if (mode === "paused") {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try { db.exec("UPDATE memory_meta SET mode='paused' WHERE id=1"); } finally { db.close(); }
  }
  const bot = (await api("POST", "/api/bots", { name: "Reader fixture", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
  const room = route.endsWith("room") ? (await api("POST", "/api/groups", { name: "Reader room", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group : undefined;
  const threadId = room?.threadId ?? bot.threadId;
  // MAIN RULING INT-CONFLICT-DEFAULT / S3B-Q5 second branch: a member created just now has its recall view built in the background; this
  // file tests the reader's lifecycle, not readiness, so wait for that real view before the send.
  await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId);
  try {
    const authority = route === "direct-unproven" || route === "non-owner-room" ? remote : headers;
    const result = await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${bot.id}/messages`,
      { text: "Reader fixture", ...(room ? {} : { threadId }) }, authority);
    expect(result.status).toBe(202);
    await expect.poll(() => rows(threadId).length, { timeout: 20_000 }).toBe(1);
    const row = rows(threadId)[0]!;
    expect(row).toMatchObject({ bound: true, same: true, frozen: true });
    if (route === "direct-owner") expect(row.audience).toBeNull();
    else {
      expect(row.audience?.owner).toBe(route === "owner-room");
      expect(row.audience?.scopeIds).toEqual(expect.arrayContaining(row.receiptScopes));
      if (mode !== "active") expect(row.audience?.scopeIds).toEqual([]);
    }
    if (mode === "active") expect(row.receiptCount).toBeGreaterThan(0);
    else expect(row.receiptCount).toBe(0);
    // MAIN RULING 1117 (r12-rulings4 item 2): a fresh member with no engine session has nothing to reset.
    if (room && mode === "active") expect(resetLines(threadId)).toEqual([]);
  } finally {
    if (room) { await api("POST", `/api/groups/${room.id}/interrupt`, { threadId }); await api("DELETE", `/api/groups/${room.id}`); }
    else await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await api("DELETE", `/api/bots/${bot.id}`);
  }
});

// red-at-4df086541: reset completion reused a preparation snapshot after
// mode/access changed while the provider reset was awaited. The unchanged
// branch is the identity-preserving delivery control.
it.each(["direct", "room", "direct-unproven", "non-owner-room"].flatMap(route =>
  ["unchanged", "mode", "capture", "paused", "access", "policy", "deletion"].map(change => ({ route, change }))))(
  "T-READER-LIFECYCLE server reset $route/$change", async ({ route, change }) => {
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Reset fixture", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
    const room = route.endsWith("room") ? (await api("POST", "/api/groups", { name: "Reset room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group : undefined;
    const threadId = room?.threadId ?? bot.threadId, arm = join(fixture.info.dataDir, "reset.arm");
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId);
    try {
      rmSync(`${arm}.go`, { force: true });
      // MAIN RULING 1117 (r12-rulings4 item 2): the member's engine restored a session from disk that the harness never saw reported, so
      // production must reset it (session-unreported) before the room turn; the reset hold below lands there.
      if (room) writeFileSync(join(fixture.info.dataDir, "restored", threadId), "");
      writeFileSync(arm, "1");
      expect((await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${bot.id}/messages`,
        { text: "Reset fixture", ...(room ? {} : { threadId }) },
        route === "direct-unproven" || route === "non-owner-room" ? remote : headers)).status).toBe(202);
      await expect.poll(() => existsSync(`${arm}.waiting`), { timeout: 20_000 }).toBe(true);
      expect(rows(threadId)).toHaveLength(0);
      if (room) expect(resetLines(threadId).map(line => line.slice(line.indexOf("memory continuation reset")))).toEqual([
        expect.stringMatching(new RegExp(`^memory continuation reset thread=${threadId} engine=keep reason=room-memory-active session-unreported$`))]);
      if (change === "mode") expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
      if (change === "capture") expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
      if (["paused", "policy", "deletion"].includes(change)) {
        const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
        // 7C-TRIAGE-RULING.md (reader-lifecycle): this handle waits for the server's own writes (busy_timeout), and the guard proves the server
        // holds no write transaction across the park at `.waiting`: a write lock is obtained within 5 s. If it is not, that is a product bug.
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("BEGIN IMMEDIATE; ROLLBACK");
        try {
          if (change === "paused") db.exec("UPDATE memory_meta SET mode='paused' WHERE id=1");
          if (change === "policy") db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
          if (change === "deletion") db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
        } finally { db.close(); }
      }
      if (change === "access") expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Reset access change" })).status).toBe(200);
      writeFileSync(`${arm}.go`, "1");
      await expect.poll(() => rows(threadId).length, { timeout: 20_000 }).toBe(1);
      expect(rows(threadId)[0]).toMatchObject({ bound: true, same: true, frozen: true });
      if (["mode", "capture", "paused"].includes(change)) expect(rows(threadId)[0]!.receiptCount).toBe(0);
      else expect(rows(threadId)[0]!.receiptCount).toBeGreaterThan(0);
    } finally {
      rmSync(arm, { force: true });
      if (existsSync(`${arm}.waiting`)) {
        writeFileSync(`${arm}.go`, "1");
        await expect.poll(() => existsSync(`${arm}.waiting`), { timeout: 5_000 }).toBe(false);
      }
      rmSync(`${arm}.go`, { force: true });
      if (room) { await api("POST", `/api/groups/${room.id}/interrupt`, { threadId }); await api("DELETE", `/api/groups/${room.id}`); }
      else await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

// red-at-4df086541: fresh attempts did not own a final frozen reader before
// receipt construction. One rejected setup rebuilds with a receipt; the third
// takes the existing bounded last-resort route, with no receipt or extra write.
it.each(["direct", "room"].flatMap(route => [1, 3].map(failures => ({ route, failures }))))(
  "T-LEDGER-STOP setup rebuild $route/$failures", async ({ route, failures }) => {
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Rebuild fixture", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
    const room = route === "room" ? (await api("POST", "/api/groups", { name: "Rebuild room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group : undefined;
    const threadId = room?.threadId ?? bot.threadId;
    const flag = join(fixture.info.dataDir, "receipt-fault"), hits = `${flag}.hits`;
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId);
    try {
      writeFileSync(hits, ""); writeFileSync(flag, String(failures));
      expect((await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${bot.id}/messages`,
        { text: "Bounded rebuild fixture", ...(room ? {} : { threadId }) })).status).toBe(202);
      await expect.poll(() => rows(threadId).length, { timeout: 20_000 }).toBe(1);
      expect(readFileSync(hits, "utf8").trim().split("\n")).toHaveLength(failures);
      const row = rows(threadId)[0]!;
      expect(row).toMatchObject({ bound: true, same: true, frozen: true });
      if (failures === 3) expect(row.receiptCount).toBe(0); else expect(row.receiptCount).toBeGreaterThan(0);
      const messages = (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;
      expect(messages.filter((message: { text?: string }) => message.text === "Bounded rebuild fixture")).toHaveLength(1);
    } finally {
      // A failed assertion must not inject a fault into another fixture row.
      const { rmSync } = await import("node:fs"); rmSync(flag, { force: true });
      if (room) { await api("POST", `/api/groups/${room.id}/interrupt`, { threadId }); await api("DELETE", `/api/groups/${room.id}`); }
      else await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

// red-at-4df086541: room reader setup was outside its cleanup scope. The
// injected read failure happens before any adapter invocation, not at a mock
// finalizer; the next real room send proves admission was handed back.
it("T-LEDGER-STOP early room reader failure releases its uninvoked claim", async () => {
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
  const bot = (await api("POST", "/api/bots", { name: "Early reader", modelSelection: { instanceId: "keep", model: "keep-1" } })).body.bot;
  const room = (await api("POST", "/api/groups", { name: "Early reader room", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  try {
    const flag = join(fixture.info.dataDir, "early-reader-fault");
    writeFileSync(flag, "1");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "First attempt" })).status).toBe(202);
    await expect.poll(() => existsSync(`${flag}.hit`), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find((entry: { id: string }) => entry.id === room.id);
      return Boolean(group.working || group.busyBotId);
    }, { timeout: 20_000 }).toBe(false);
    expect(rows(room.threadId)).toHaveLength(0);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Second attempt" })).status).toBe(202);
    await expect.poll(() => rows(room.threadId).length, { timeout: 20_000 }).toBe(1);
    expect(rows(room.threadId)[0]).toMatchObject({ bound: true, same: true, frozen: true });
  } finally {
    rmSync(join(fixture.info.dataDir, "early-reader-fault"), { force: true });
    await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
    await api("DELETE", `/api/groups/${room.id}`); await api("DELETE", `/api/bots/${bot.id}`);
  }
});
