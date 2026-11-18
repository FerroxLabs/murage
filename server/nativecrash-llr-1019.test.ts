// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NATIVECRASH G0 LLR (STAGE2 G0, LLR): the room member .catch consumes a submission refusal, and re-dispatches only on canRetry. No storm
// suite: the preload makes one submission's beforeSubmit release the prompt (a passed check, so the write may have
// happened) and then refuse with MEMORY_CONTEXT_REVOKED, the same refusal the proven-unwritten control throws before any release. Unwritten:
// the turn is re-dispatched (two submissions). Released: one submission, one owner row, no re-dispatch (mutant LLR-ROOM-NOCANRETRY drops
// canRetry: a second submission).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { insertRoomRequest } from "./room-requests.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const at = (name: string) => join(fixture.info.dataDir, name);
const href = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const ok = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as any;
  if (response.status < 200 || response.status > 299) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const lines = (name: string) => existsSync(at(name)) ? readFileSync(at(name), "utf8").split("\n").filter(Boolean) : [];
/** Provider submissions on a thread: one dump line per sendTurn. */
const submissions = (threadId: string) => lines("dump").map(line => JSON.parse(line)).filter(row => row.threadId === threadId && !row.prompt).length;
const botIdle = async (botId: string) => (await ok("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy !== true;
const botRows = async (threadId: string) => ((await ok("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[])
  .filter(message => message.role === "bot").map(message => message.kind === "text" ? `text:${message.text}` : `${message.kind}:${message.tool?.name ?? ""}:${message.memoryNote ?? ""}`);
const withDb = <T>(run: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=10000"); return run(db); } finally { db.close(); }
};
const newBot = async (name: string, instanceId = "late") => {
  const bot = (await ok("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
  await ok("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const newRoom = async (name: string, botId: string) => (await ok("POST", "/api/groups", { name, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).group as { id: string; threadId: string };
/** A queued member turn under a waiting owner root, woken the way the owner does (cancelling a spare root pumps the dispatcher). */
const roomTurn = async (room: { id: string; threadId: string }, botId: string) => {
  const lineage = { rootThreadId: room.threadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
  const root = (tag: string) => withDb(db => {
    const request = insertRoomRequest(db, { groupId: room.id, verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:${room.id}:${tag}`, lineage,
      targetThreadId: room.threadId, payloadText: "please look at this", now: Date.now() }).request;
    db.prepare("UPDATE room_requests SET state='waiting_bot' WHERE id=?").run(request.id);
    return request.id;
  });
  const parentId = root(`llr-${Math.random()}`);
  withDb(db => insertRoomRequest(db, { groupId: room.id, verb: "room_turn", fromKind: "owner", toBotId: botId, targetThreadId: room.threadId, parentId,
    admissionKey: `room_turn:${parentId}:${botId}`, payloadText: "please look at this", priority: "coordinator", state: "queued", now: Date.now() }));
  await ok("POST", `/api/groups/${room.id}/requests/${root(`spare-${Math.random()}`)}/cancel`);
};
/** Everything the refused turn could still do has had its chance: the member is idle and a moment more has passed. */
const settled = async (botId: string) => {
  await expect.poll(async () => await botIdle(botId), { timeout: 30000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1500));
};

describe.skipIf(process.platform === "win32")("NATIVECRASH LLR: a released submission refusal is consumed with no rebuild", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${href("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${href("server/testing/fake-late-terminal-driver.ts")});
      const {TurnSubmissionBoundary}=await import(${href("server/turn-dispatch-guard.ts")});
      const dir=process.env.MURAGE_DATA_DIR; const at=name=>path.join(dir,name);
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      // refuse-arm "unwritten": the next submission refuses with MEMORY_CONTEXT_REVOKED before anything is released (canRetry);
      // "released": its check passes first (the prompt is released to the write, which may have happened), then the refusal lands (no canRetry)
      const before=TurnSubmissionBoundary.prototype.beforeSubmit;
      TurnSubmissionBoundary.prototype.beforeSubmit=function(validate){
        if(!fs.existsSync(at('refuse-arm')))return before.call(this,validate);
        const mode=fs.readFileSync(at('refuse-arm'),'utf8'); fs.rmSync(at('refuse-arm'),{force:true});
        if(mode==='released')before.call(this,()=>{});
        try { return before.call(this,()=>{throw new Error('MEMORY_CONTEXT_REVOKED');}); }
        catch(error) { fs.writeFileSync(at('refused-'+mode),String(this.canRetry)); throw error; }
      };
      const file=at('config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.late={driver:'fakeLateTerminal',environment:{FAKE_LATE_DUMP:at('dump')}};
      cfg.instances.fenced={driver:'fakeLateTerminal',environment:{FAKE_LATE_DUMP:at('dump'),FAKE_LATE_FENCED_WRITES:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it.each(["unwritten", "released"])("LLR room member %s", async mode => {
    const bot = await newBot(`LLR room ${mode}`);
    const room = await newRoom(`LLR room ${mode}`, bot.id);
    writeFileSync(at("refuse-arm"), mode);
    await roomTurn(room, bot.id);
    await expect.poll(() => existsSync(at(`refused-${mode}`)), { timeout: 30000 }).toBe(true);
    await settled(bot.id);
    const rows = await botRows(room.threadId);
    console.log("LLR-ROOM", mode, readFileSync(at(`refused-${mode}`), "utf8"), submissions(room.threadId), JSON.stringify(rows));
    if (mode === "unwritten") {
      expect(submissions(room.threadId)).toBe(2);
      expect(rows.filter(row => row === "text:Hello from late")).toHaveLength(1);
    } else {
      expect(submissions(room.threadId)).toBe(1);
      expect(rows.filter(row => row === "text:Hello from late")).toHaveLength(0);
      expect(rows.filter(row => row.startsWith("activity:") && !row.includes("engine limit:"))).toHaveLength(1);
    }
  }, 120000);

  // LLR direct (model r4 LLR): the direct setup consumer rebuilds only on canRetry. A refusal before anything was released on an adapter whose
  // writes are fenced is proven unwritten: rebuilt (two submissions, one reply). Released, or on an adapter that may write outside the fence
  // (an unfenced invocation): one submission and one honest owner row, never a rebuild (mutant LLR-DIRECT-NOCAN drops canRetry at the setup catch: the
  // refused turn is re-started and ends on a stale_action row in place of the honest one).
  it.each([["fenced", "unwritten"], ["fenced", "released"], ["late", "unwritten"]])("LLR direct %s %s", async (instanceId, mode) => {
    const bot = await newBot(`LLR direct ${instanceId} ${mode}`, instanceId);
    await settled(bot.id);
    const before = submissions(bot.threadId), rowsBefore = (await botRows(bot.threadId)).length;
    rmSync(at(`refused-${mode}`), { force: true });
    writeFileSync(at("refuse-arm"), mode);
    await ok("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "please look at this" });
    await expect.poll(() => existsSync(at(`refused-${mode}`)), { timeout: 30000 }).toBe(true);
    await settled(bot.id);
    const rows = (await botRows(bot.threadId)).slice(rowsBefore), sent = submissions(bot.threadId) - before;
    const retryable = instanceId === "fenced" && mode === "unwritten";
    expect(readFileSync(at(`refused-${mode}`), "utf8")).toBe(String(retryable));
    const trace = readFileSync(fixture.info.logPath, "utf8").split("\n")
      .filter(line => line.includes(bot.threadId) && (line.includes("context revoked during dispatch") || line.includes("dispatch preparation failed")));
    console.log("LLR-DIRECT", instanceId, mode, { retryable, sent, rows, trace });
    if (instanceId === "fenced" && mode === "unwritten") {
      expect(sent).toBe(2);
      expect(rows.filter(row => row === "text:Hello from late")).toHaveLength(1);
      expect(rows.filter(row => row.includes("previous attempt may have started"))).toHaveLength(0);
    } else {
      expect(sent).toBe(1);
      expect(rows.filter(row => row === "text:Hello from late")).toHaveLength(0);
      // the one honest row: released offers the resend; an unfenced invocation says the attempt may have started (never a rebuild's stale_action)
      expect(rows.filter(row => row.startsWith("activity:") && !row.includes("engine limit:") && !row.includes("without-memory")))
        .toEqual([mode === "released" ? expect.stringMatching(/:resend$/) : expect.stringContaining("error: Context changed; previous attempt may have started")]);
    }
  }, 120000);
});
