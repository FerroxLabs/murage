// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WARM-SCALE guard (extreme-scale rule, 1.0.18; a GUARD, not red-before: no shipped tree fails it, and it goes red when the warmer's
// retired early return, lineage-warm.ts:235, is skipped). On a real server with the fake engine:
//   - the file is retired (readTimeRetired) after its first completed turn, so the read-time warmer has no per-turn work;
//   - a send to a thread of 200,000 messages reads the same statements bound to the thread as a send to one of 1,000 (+ a small slack),
//     and its prompt reaches the engine within the same budget;
//   - the first send after a restart shows its reply within budget, whatever the warmer's idle flag says (that flag is internal:
//     its only reader is guaranteeLineageWarmSlice, lineage-warm.ts:96).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { countControlSource, refillThread, sendCountCommand } from "./testing/bounded-reads.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LW = fileURLToPath(new URL("./memory/lineage-warm.ts", import.meta.url));
const RT = fileURLToPath(new URL("./memory/read-time-retired.ts", import.meta.url));
const DB = fileURLToPath(new URL("./database.ts", import.meta.url));
// Measured at b18 4df086541 on hz (--cpus 4, load ~15, 4 runs): 202 in 0.02-0.07 s, prompt 0.22-0.76 s, reply 0.23-0.95 s; statements
// large minus small -57..-16 after the seed restart and 0..+41 on a restart's first send. With the retired early return at
// lineage-warm.ts:235 skipped (the warmer walks the 200,000 messages) the same differences are +241 and +291, so the slack sits between.
const ACCEPT_BUDGET_S = 1, PROMPT_BUDGET_S = 4, REPLY_BUDGET_S = 5, STATEMENT_SLACK = 128;
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  // one deadline covers the response and its body
  const r = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const file = (n: string) => join(fixture.info.dataDir, n);
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const sqlite=await import('node:sqlite');const {pathToFileURL}=await import('node:url');
  process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  const LWM=await import(pathToFileURL(${JSON.stringify(LW)}).href);
  const dir=process.env.MURAGE_DATA_DIR;let watched=null;let frozen=false;let statements=0;
  const proto=sqlite.StatementSync.prototype;
  for(const name of ['all','get','iterate','run']){const original=proto[name];proto[name]=function(...args){const result=original.apply(this,args);
    if(watched!==null&&!frozen&&args.some(arg=>arg===watched||(arg&&typeof arg==='object'&&Object.values(arg).includes(watched))))statements++;return result;};}
  ${countControlSource(`(command)=>{
    if(command.idle){fs.writeFileSync(path.join(dir,'idle.json'),JSON.stringify({idle:LWM.lineageWarmIdle()}));return;}
    if(command.start){watched=command.start;frozen=false;statements=0;fs.writeFileSync(path.join(dir,'window-open'),'1');return;}
    if(command.counts){frozen=true;fs.writeFileSync(path.join(dir,'counts.json'),JSON.stringify({statements}));return;}
    if(command.state){Promise.all([import(pathToFileURL(${JSON.stringify(DB)}).href),import(pathToFileURL(${JSON.stringify(RT)}).href)]).then(([m,r])=>
      fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({retired:r.readTimeRetired(m.database())})));}}`)}
`;
const ask = async (cmd: object, name: string, ms = 30_000) => { rmSync(file(name), { force: true }); sendCountCommand(fixture.info.dataDir, cmd); await until(() => existsSync(file(name)), Math.min(ms, 30_000)); return JSON.parse(readFileSync(file(name), "utf8")); };
const auth = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };
const createBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };
function seed(threadId: string, count: number) {
  const db = new DatabaseSync(file("messages.db"));
  try {
    const leaf = (db.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(threadId) as { id: string | null } | undefined)?.id ?? null;
    db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT ?, 'seed-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
        json_object('id','seed-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,
          'parentId',CASE WHEN v=1 THEN ? ELSE 'seed-'||(v-1) END)
      FROM n`).run(count, threadId, leaf);
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `seed-${count}`);
    refillThread(db, threadId);
  } finally { db.close(); }
}
const replyStored = (threadId: string, t0: number) => {
  const db = new DatabaseSync(file("messages.db"), { readOnly: true });
  try { return Boolean(db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND at>=? LIMIT 1").get(threadId, t0)); } finally { db.close(); }
};
/** One send: seconds to the 202, to the engine's prompt and to the stored reply, and the statements bound to the thread from the send
 * until the warmer is observed idle: a warmer that judges the history in the background shows up here, not in the reply. The idle flag
 * can trail the reply by ~15 s on a retired file (it clears on the memory worker's next idle call), so the deadline is generous, and a
 * warmer still busy at it fails the guard (a partial count is never accepted). */
const WARM_WAIT_MS = 90_000;
async function send(bot: { id: string; threadId: string }, text: string) {
  rmSync(fixture.fixtureDumpPath, { force: true });
  await ask({ start: bot.threadId }, "window-open");
  const t0 = Date.now();
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  const acceptedS = (Date.now() - t0) / 1000;
  await until(() => existsSync(fixture.fixtureDumpPath), 60_000);
  const promptS = (Date.now() - t0) / 1000;
  await until(() => replyStored(bot.threadId, t0), 60_000);
  const replyS = (Date.now() - t0) / 1000;
  // one shared deadline: each idle request gets only the time left, and an idle answer that lands after the deadline does not count
  const deadline = t0 + WARM_WAIT_MS;
  let idle = false;
  for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
    const seen = (await ask({ idle: true }, "idle.json", left)).idle === true;
    if (seen && Date.now() <= deadline) { idle = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(idle, "the warmer was still busy at the deadline").toBe(true);
  const { statements } = await ask({ counts: true }, "counts.json");
  console.log("WARM-SCALE guard", bot.threadId, { acceptedS, promptS, replyS, statements });
  return { acceptedS, promptS, replyS, statements };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  await auth();
  model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it("is retired after its first completed turn, and a 200,000-message thread costs a send what a 1,000-message one does, after a restart too", async () => {
  expect((await ask({ state: true }, "state.json")).retired).toBe(false);
  const first = await createBot("First");
  await send(first, "Kestrel quorum ledger zxv");
  expect((await ask({ state: true }, "state.json")).retired).toBe(true);
  const small = await createBot("Small"), large = await createBot("Large");
  await fixture.stop();
  seed(small.threadId, 1_000);
  seed(large.threadId, 200_000);
  await fixture.restart(); await auth();
  // the first send after the restart: its reply is shown within budget (the warmer's idle flag is not waited on)
  const a = await send(small, "Kestrel quorum ledger zxv");
  const b = await send(large, "Kestrel quorum ledger zxv");
  expect((await ask({ state: true }, "state.json")).retired).toBe(true);
  // and the first send straight after a restart, the small thread then (another restart) the large one: the restart's own work is the
  // same for both, so the large one is held to the small one
  await fixture.restart(); await auth();
  const d = await send(small, "Kestrel quorum ledger zxv");
  await fixture.restart(); await auth();
  const c = await send(large, "Kestrel quorum ledger zxv");
  for (const r of [a, b, c, d]) {
    expect(r.acceptedS).toBeLessThan(ACCEPT_BUDGET_S);
    expect(r.promptS).toBeLessThan(PROMPT_BUDGET_S);
    expect(r.replyS).toBeLessThan(REPLY_BUDGET_S);
  }
  expect(b.statements).toBeLessThanOrEqual(a.statements + STATEMENT_SLACK);
  expect(c.statements).toBeLessThanOrEqual(d.statements + STATEMENT_SLACK);
  // a dead counter must not pass: every send binds its own thread id at least once
  for (const r of [a, b, c, d]) expect(r.statements).toBeGreaterThan(0);
}, 600_000);
