// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Warm presence P-SIG 1b/1c across a rebuild takeover (designs/WARM-W1-1022-presence.md; OPUS 08c6017e2c H3, ASTRA 831b2c39bc/d0f7e5e5d3):
// an owner turn refused at its send over memory keeps its thread and is rebuilt; the rebuilt turn takes the held run over at its
// admission (index.ts startTurn, directRuns.admit takeOver), and the takeover drops the refused run's release watches. The refused
// turn's presence token would then never be ended by its own watch: startTurn ends the thread's earlier token at the new admission.
// Without that the owner reads present for as long as the token lasts (hours), so nothing warm is ever retired for being away.
// Real server, real HTTP send route (POST /api/bots/:id/messages), the fixture engine server/testing/fake-late-terminal-driver.ts held
// before each submit (as server/direct-rebuild-hold-api.test.ts), a real section revoke that makes the fence refuse the send, and the
// desktop's own presence report without a state (POST /api/presence: the re-check an unlock or resume runs) as the observable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const W = 2_500; // the activity window (MURAGE_WARM_ACTIVITY_WINDOW_MS)
const INSTANCE = "prrebuild";
let fixture: VerificationServer, headers: Record<string, string>;
const raw = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await raw(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
};
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const replies = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[])
  .filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length;
const taskBusy = async (botId: string, threadId: string) => (await api("GET", `/api/bots/${botId}/tasks/${threadId}`)).task?.busy === true;
const holdFile = (n: number) => join(fixture.info.dataDir, `${INSTANCE}-hold-${n}`);
const dispatches = (threadId: string) => {
  const dump = join(fixture.info.dataDir, `${INSTANCE}-dump`);
  return existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.threadId === threadId).length : 0;
};
let held = 0;
/** Lets the next send of the instance through its hold point (after its prompt was built, before the engine submits it). */
const pass = async (threadId: string, before?: () => Promise<unknown>) => {
  held++;
  await expect.poll(() => existsSync(`${holdFile(held)}.waiting`), { timeout: 60_000 }).toBe(true);
  expect(readFileSync(`${holdFile(held)}.waiting`, "utf8")).toBe(threadId);
  if (before) await before();
  writeFileSync(holdFile(held), "");
};
const waiting = () => existsSync(`${holdFile(held + 1)}.waiting`);
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
let seq = 0;
/** The desktop shell's report with no state: unlock or resume, a re-check only (index.ts ownerPresence.resumed). Never owner input. */
const deskRecheck = () => raw("POST", "/api/presence", { clientId: "desk-fixture-02", seq: ++seq, visible: true });

describe.skipIf(process.platform === "win32")("warm presence: a rebuilt owner turn leaves no presence token behind", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS='${W}';
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver();
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        if(!input.environment.HOLD_PREFIX)return instance;
        const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
        instance.adapter.sendTurn=async turn=>{
          const base=path.join(process.env.MURAGE_DATA_DIR,input.environment.HOLD_PREFIX+(++n));
          fs.writeFileSync(base+'.waiting',turn.threadId);
          await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.${INSTANCE}={driver:'fakeLateTerminal',environment:{HOLD_PREFIX:'${INSTANCE}-hold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_DUMP:path.join(dir,'${INSTANCE}-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    await login();
    // what 1.0.2 left for receipt flips (as direct-rebuild-hold-api.test.ts): audience-only revoke jobs no walk can finish, so the
    // section revoke below is still being checked when the held send is submitted and the fence refuses it
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
    const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
    const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
    const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
    const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
    db.exec("BEGIN");
    for (let n = 0; n < 122; n++) { const id = 710001 + n; job.run(id, root); audience.run(id); pending.run(id); frontier.run(id); }
    db.exec("COMMIT");
    db.close();
    await fixture.restart();
    await login();
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  it("W-PR1g: an owner turn refused at its send and rebuilt (run taken over) ends both presence tokens: past the window the re-check finds him away", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Presence rebuild", modelSelection: { instanceId: INSTANCE, model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const threadId = bot.threadId;
    // an answered first owner turn
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "an earlier question" });
    for (let attempt = 0; attempt < 3 && await replies(threadId) < 1; attempt++) {
      await pass(threadId);
      await expect.poll(async () => await replies(threadId) >= 1 || waiting(), { timeout: 60_000 }).toBe(true);
    }
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15_000 }).toBe(false);
    const sentBefore = dispatches(threadId);
    // the owner turn the fence refuses at its send (a section revoke lands while it is held), then its rebuild(s) until the reply
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "the question refused at its send" });
    await pass(threadId, () => api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke before the presence rebuild submission" }));
    for (let attempt = 0; attempt < 4 && await replies(threadId) < 2; attempt++) {
      await expect.poll(async () => await replies(threadId) >= 2 || waiting(), { timeout: 60_000 }).toBe(true);
      if (await replies(threadId) < 2) await pass(threadId);
    }
    await expect.poll(async () => await replies(threadId), { timeout: 60_000 }).toBe(2);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15_000 }).toBe(false);
    // setup (the same with and without the release): one POST, yet the engine was handed that turn at least twice (the refused
    // send, then its rebuild on the held run), and it answered
    const sends = dispatches(threadId) - sentBefore;
    expect({ rebuilt: sends >= 2, replies: await replies(threadId) }, `sends=${sends} passes=${held}`).toEqual({ rebuilt: true, replies: 2 });
    // no owner input for longer than the window (reads and the presence report are not input), then the desktop's re-check
    const mark = log().length;
    await sleep(W + 1_500);
    const reported = await deskRecheck();
    for (let waited = 0; waited < 3_000 && !log().slice(mark).includes("presence warm state=away"); waited += 100) await sleep(100);
    const after = log().slice(mark);
    // W-PR1g:rebuild-token-ended — every owner turn settled and the window passed: he is away. With the refused run's token left
    // behind by the takeover (no release at the rebuild's admission) he still reads present here: no away line.
    expect({ status: reported.status, away: count(after, "presence warm state=away cause=idle"), present: count(after, "presence warm state=present") }).toEqual({ status: 204, away: 1, present: 0 });
  }, 240_000);
});
