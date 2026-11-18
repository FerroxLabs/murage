// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 r2-owner-limit-projects (review recovery). A card run has no human words. When memory recovery withholds the stored prompt
// (the last rebuild: message only), the run still has to carry what the server itself authored: the review ask with its card id, result and
// this run's nonce, and the lead's decision wake. Without it the reviewer cannot give a verdict and the lead cannot decide.
// Deterministic: the fixture engine holds every attempt before its write and reports two known unwritten context refusals, then accepts.
// The server owns both rebuilds. The fixture records passing frames and each refusal separately; it never fabricates a verdict or nonce.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let fixture: VerificationServer, proof: string, fixtureRoot: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const withDb = <T>(read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); return read(db); } finally { db.close(); }
};
/** What reached the fixture engine, one row per attempt that passed the fence: its frame is `system \n memory context \n prompt text`. */
const dumpRows = (name: string): Array<{ prompt?: boolean; frame?: string; refused?: boolean; threadId?: string }> => {
  const file = join(fixture.info.dataDir, `${name}-dump`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
};
const frames = (name: string) => dumpRows(name).filter(row => row.prompt).map(row => String(row.frame ?? ""));
const stopDrain = { value: false };
/** Release each held attempt; the fake changes memory mode at the first two writes so the real submission guard must rebuild. */
async function drain(prefix: string) {
  const active = fixture;
  for (let attempt = 1; !stopDrain.value && fixture === active; attempt++) {
    const base = join(fixture.info.dataDir, `${prefix}${attempt}`);
    while (!existsSync(`${base}.waiting`)) { if (stopDrain.value || fixture !== active) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    writeFileSync(base, "");
  }
}

beforeEach(async () => {
  stopDrain.value = false;
  fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "recovery-frame-")));
  vi.stubEnv("TMPDIR", fixtureRoot);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs');const path=await import('node:path');
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
    const {database}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/database.ts")).href)});
    const {insertRoomRequest,completeRequest}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/room-requests.ts")).href)});
    const driver=makeLateTerminalDriver({ fencedDefaults: true });
    // HOLD_EACH: every sendTurn waits, after its prompt was built and before the engine submits it, for <prefix><n>
    const create=driver.create.bind(driver);
    driver.create=async input=>{
      const instance=await create(input);
      if(input.environment.HOLD_EACH!=='1')return instance;
      const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
      instance.adapter.sendTurn=async turn=>{
        const base=path.join(process.env.MURAGE_DATA_DIR,input.environment.HOLD_PREFIX+(++n));
        fs.writeFileSync(base+'.waiting',turn.threadId);
        await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
        // A memory-mode change races the prepared prompt; the real submission guard refuses before releasing any write.
        if(n%3!==0){
          const db=database(),saved=db.prepare('SELECT mode FROM memory_meta WHERE id=1').get();
          db.prepare("UPDATE memory_meta SET mode=? WHERE id=1").run(saved.mode==='off'?'active':'off');
          try { turn.beforeSubmit(); throw new Error('fixture memory-mode guard did not refuse'); }
          catch(error){ fs.appendFileSync(input.environment.FAKE_LATE_DUMP,JSON.stringify({refused:true,attempt:n,error:error.message})+'\\n'); throw error; }
          finally { db.prepare('UPDATE memory_meta SET mode=? WHERE id=1').run(saved.mode); }
        }
        // ASK_TEAMMATE: the engine asks a teammate during its own card run. The fixture records that ask as the card run's child, as the
        // ask tool does, on the attempt that is written, and ends it; the server owns the rest (waiting, the wake, the continuation run).
        if(input.environment.ASK_TEAMMATE==='1'){
          const db=database(),target=path.join(process.env.MURAGE_DATA_DIR,'ask-target');
          const parent=db.prepare("SELECT id,group_id,to_bot_id FROM room_requests WHERE target_thread_id=? AND verb='assign' AND state='running'").get(turn.threadId);
          if(parent&&fs.existsSync(target)){
            const child=insertRoomRequest(db,{groupId:parent.group_id,verb:'ask',fromKind:'bot',fromBotId:parent.to_bot_id,toBotId:fs.readFileSync(target,'utf8'),parentId:parent.id,admissionKey:'fixture-card-ask:'+parent.id,payloadText:'What is the launch price?',now:Date.now()}).request;
            // the teammate's ask ends once the card run is waiting on it (no answer text: the wake carries the server's own no-answer line)
            const poll=setInterval(()=>{
              if(database().prepare('SELECT state FROM room_requests WHERE id=?').get(parent.id)?.state!=='waiting_bot')return;
              clearInterval(poll);completeRequest(database(),child.id,{state:'done',now:Date.now()});
            },20);
          }
        }
        return send(turn);
      };
      return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const dir=process.env.MURAGE_DATA_DIR;
    cfg.instances.heldreviewer={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'rev-hold-',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'reviewer-dump')}};
    cfg.instances.heldlead={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'lead-hold-',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'lead-dump')}};
    cfg.instances.heldasker={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'ask-hold-',ASK_TEAMMATE:'1',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'asker-dump')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
}, 60000);
afterEach(async () => { stopDrain.value = true; await fixture?.close(); if (fixtureRoot) removeTempDirSync(fixtureRoot); vi.unstubAllEnvs(); });

let made = 0;
async function makeBot(name: string, instanceId: string) {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
  expect(instance, instanceId).toBeTruthy();
  const model = instance.models.options[0]?.id || instance.models.default || "fixture-model";
  const result = await api("POST", "/api/bots", { name: `${name}${++made}`, modelSelection: { instanceId, model } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
  return result.body.bot as { id: string; name: string; threadId: string };
}
const cardOf = async (groupId: string, cardId: string) => (await api("GET", `/api/groups/${groupId}/board`)).body.cards.find((entry: any) => entry.id === cardId);

async function startReview() {
    const lead = await makeBot("Nova", "heldlead"), worker = await makeBot("Cole", "verification"), reviewer = await makeBot("Reed", "heldreviewer");
    void drain("lead-hold-");
    const group = (await api("POST", "/api/groups", { name: "Recovery frame", memberIds: [lead.id, worker.id, reviewer.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
    const goalId = `goal-${group.id}`;
    withDb(db => {
      db.prepare("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES(?,?,'Ship the plan','working',1,1,1)").run(goalId, group.id);
      db.prepare("UPDATE project_goals SET criteria=? WHERE id=?").run(JSON.stringify([{ id: "criterion", text: "STORED_GOAL_CRITERION", setBy: "owner", proposed: false, met: false }]), goalId);
      db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(lead.id, group.id);
    });
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "recovery-frame", title: "Pricing section", description: "Give our real pricing.", assigneeBotId: worker.id, writes: false })).body.card;
    withDb(db => db.prepare("UPDATE project_work_items SET goal_id=? WHERE id=?").run(goalId, card.id));
    const fresh = await cardOf(group.id, card.id);
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: fresh.revision, action: "start" })).status).toBe(200);

    return { lead, worker, reviewer, group, card };
}

describe.skipIf(process.platform === "win32")("a card run keeps its server-authored instruction through the last memory rebuild", () => {
  it("the review ask and the lead's decision wake reach the engine with card id, result, nonce and the instruction, and no stored line", async () => {
    const { group, card } = await startReview();
    void drain("rev-hold-");

    // the reviewer's review ask and, once it gave no verdict, the lead's decision wake each pass only on the last rebuild
    const diagnostics = () => JSON.stringify({ holds: readdirSync(fixture.info.dataDir).filter(name => /hold-\d+/.test(name)),
      rows: withDb(db => db.prepare("SELECT verb, state, to_bot_id, outcome_note, refusal FROM room_requests WHERE group_id=?").all(group.id)),
      reviewer: dumpRows("reviewer"), lead: dumpRows("lead").length, log: readFileSync(fixture.info.logPath, "utf8").split("\n").slice(-25) });
    await expect.poll(() => frames("reviewer").length, { timeout: 90000, interval: 250 }).toBeGreaterThan(0).catch(error => { throw new Error(`${error.message} ${diagnostics()}`); });
    await expect.poll(() => frames("lead").some(frame => frame.includes("you decide now")), { timeout: 90000, interval: 250 }).toBe(true).catch(error => { throw new Error(`${error.message} ${diagnostics()}`); });
    stopDrain.value = true;
    for (const name of ["reviewer", "lead"]) expect(dumpRows(name).filter(row => row.refused).length).toBeGreaterThanOrEqual(2);
    const review = frames("reviewer").find(frame => frame.includes("<murage-review"))!;
    expect(review, JSON.stringify(frames("reviewer"))).toBeTruthy();
    const cardNow = await cardOf(group.id, card.id);
    expect(review).toMatch(/<murage-review nonce="[a-f0-9]{32}">/);
    expect(review).toContain(`Review card ${cardNow.number}: ${cardNow.title}`);
    expect(review).toContain("<result-to-review>");
    expect(review).toContain(`card_id "${card.id}"`);
    const decision = frames("lead").find(frame => frame.includes("you decide now"))!;
    expect(decision).toContain(`ended without a verdict, so you decide now (card_id "${card.id}")`);
    // recovery withholds memory and the system layers: the frame is `system \n memory context \n text`, empty and null in front of the text
    for (const frame of [review, decision]) {
      expect(frame.startsWith("\nnull\n")).toBe(true);
      expect(frame).not.toContain("STORED_GOAL_CRITERION");
    }
    // the nonce the reviewer was asked to answer under is the one the server reads the verdict by: never invented, one per run
    expect(new Set(frames("reviewer").map(frame => frame.match(/nonce="([a-f0-9]{32})"/)?.[1]).filter(Boolean)).size).toBe(1);
    // the review settled exactly once, with a verdict row or "No verdict given"
    const rows = withDb(db => db.prepare("SELECT state, outcome_note FROM room_requests WHERE verb='review' AND work_item_id=?").all(card.id) as Array<{ state: string; outcome_note: string | null }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("done");
  }, 240000);
  it("a lead continuing its own card after a teammate's answer gets the results on the last rebuild, and no other card of the goal", async () => {
    // review H1 (n11): the card continuation rendered the normal wake, whose open-card list names cards the recovery frame does not track
    const lead = await makeBot("Nova", "heldasker"), worker = await makeBot("Cole", "verification");
    const group = (await api("POST", "/api/groups", { name: "Recovery continuation", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
    const goalId = `goal-${group.id}`;
    withDb(db => {
      db.prepare("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES(?,?,'Ship the plan','working',0,1,1)").run(goalId, group.id);
      db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(lead.id, group.id);
    });
    const other = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "recovery-other", title: "OTHER_OPEN_CARD_TITLE", description: "Not this run's card.", assigneeBotId: worker.id, writes: false })).body.card;
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "recovery-own", title: "Pricing section", description: "Give our real pricing.", assigneeBotId: lead.id, writes: false })).body.card;
    withDb(db => db.prepare("UPDATE project_work_items SET goal_id=? WHERE id IN (?,?)").run(goalId, card.id, other.id));
    writeFileSync(join(fixture.info.dataDir, "ask-target"), worker.id);
    const fresh = await cardOf(group.id, card.id);
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: fresh.revision, action: "start" })).status).toBe(200);
    void drain("ask-hold-");
    const diagnostics = () => JSON.stringify({ holds: readdirSync(fixture.info.dataDir).filter(name => /hold-\d+/.test(name)),
      rows: withDb(db => db.prepare("SELECT verb, state, to_bot_id, work_item_id, project_goal_id, outcome_note, refusal FROM room_requests WHERE group_id=?").all(group.id)),
      asker: dumpRows("asker"), log: readFileSync(fixture.info.logPath, "utf8").split("\n").slice(-25) });
    // the card's own continuation: the wake that carries the card and runs in the lead's desk (the lead's later room wake carries no card)
    const cardWakes = () => withDb(db => db.prepare("SELECT work_item_id, project_goal_id, to_bot_id, target_thread_id FROM room_requests WHERE group_id=? AND verb='wake' AND work_item_id IS NOT NULL").all(group.id) as Array<{ work_item_id: string; project_goal_id: string; to_bot_id: string; target_thread_id: string }>);
    const continued = () => dumpRows("asker").find(row => row.prompt && row.threadId === cardWakes()[0]?.target_thread_id && String(row.frame).includes("Results came back for work you handed over"))?.frame;
    await expect.poll(() => Boolean(continued()), { timeout: 120000, interval: 250 }).toBe(true).catch(error => { throw new Error(`${error.message} ${diagnostics()}`); });
    stopDrain.value = true;
    // the continuation ran as this card's own run, and only after the real submission guard refused its first two prompts
    expect(cardWakes()).toEqual([{ work_item_id: card.id, project_goal_id: goalId, to_bot_id: lead.id, target_thread_id: expect.any(String) }]);
    expect(cardWakes()[0]!.target_thread_id).not.toBe(lead.threadId);
    expect(dumpRows("asker").filter(row => row.refused).length).toBeGreaterThanOrEqual(4);
    const frame = continued()!;
    expect(frame.startsWith("\nnull\n")).toBe(true);
    // the other card is still open on the board, and the lead's last rebuild names no card but its own
    expect(await cardOf(group.id, other.id)).toMatchObject({ title: "OTHER_OPEN_CARD_TITLE" });
    expect((await cardOf(group.id, other.id)).state).not.toBe("done");
    expect(frame).not.toContain("OTHER_OPEN_CARD_TITLE");
    expect(frame).not.toContain("Hand over only work that none of them covers");
  }, 240000);
  it.each(["generation", "audience"])("a %s changed after recovery was rendered refuses the stale instruction before provider ingress", async change => {
    const { card, group } = await startReview();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const gate = join(fixture.info.dataDir, `rev-hold-${attempt}`);
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 90000, interval: 250 }).toBe(true);
      writeFileSync(gate, "");
    }
    const gate = join(fixture.info.dataDir, "rev-hold-3");
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 90000, interval: 250 }).toBe(true);
    withDb(db => {
      if (change === "generation") db.prepare("UPDATE project_work_items SET generation=generation+1, revision=revision+1 WHERE id=?").run(card.id);
      else db.prepare("UPDATE room_requests SET not_owner_audience=1 WHERE verb='review' AND work_item_id=?").run(card.id);
    });
    writeFileSync(gate, "");
    const rows = () => withDb(db => db.prepare("SELECT state, outcome_note FROM room_requests WHERE verb='review' AND work_item_id=?").all(card.id) as Array<{ state: string; outcome_note: string | null }>);
    await expect.poll(() => rows()[0]?.state, { timeout: 90000, interval: 250 }).not.toBe("running");
    expect(frames("reviewer")).toEqual([]);
    const outcomeNote = change === "generation" ? "superseded" : "Could not start this card. Try again shortly.";
    expect(rows()).toEqual([{ state: "failed", outcome_note: outcomeNote }]);
    const visible = (await api("GET", `/api/groups/${group.id}/requests`)).body.requests.filter((row: any) => row.verb === "review" && row.workItemId === card.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ state: "failed", outcomeNote });
    expect(await cardOf(group.id, card.id)).toMatchObject({ state: "review", generation: change === "generation" ? 2 : 1 });
  }, 240000);

});
