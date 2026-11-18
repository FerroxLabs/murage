import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// The late-refusal ticket: a turn the server accepted and the memory fence then refused at a post-handback write owns exactly one ticket.
// Its terminal event redeems it once (a bounded rebuild while unwritten, a card otherwise, nothing for a Stop), releases the run, and never
// reaches another thread's turn. Each case drives the real server with the late-handback fixture engine; a revoke lands while the engine
// holds its write, so the fence refuses with MEMORY_CONTEXT_REVOKED.
let fixture: VerificationServer, headers: Record<string, string>, dir: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const rowsOf = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId).busy as boolean;
const blocked = (message: any) => String(message.tool?.name ?? "").startsWith("error:") || message.memoryNote === "resend";
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const newBot = async (name: string, instanceId: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } });
  expect(created.status).toBe(201);
  expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot;
};
/** Hold each attempt at its late write, land a revoke, release it: the fence refuses that attempt. Returns once `attempts` were refused. */
const refuseAttempts = async (botId: string, gate: string, attempts: number, seen = new Set<string>()) => {
  // The waiting file names the attempt that holds the gate: wait for an attempt not yet refused, never the one just released (its file is
  // removed a poll later, and a revoke counted against it would leave the next attempt unrefused). A caller refusing in steps passes one set.
  const waiting = () => { try { return readFileSync(gate + ".waiting", "utf8"); } catch { return ""; } };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await expect.poll(() => { const id = waiting(); return id && !seen.has(id) ? id : ""; }, { timeout: 30000 }).not.toBe("");
    seen.add(waiting());
    expect((await api("PATCH", `/api/bots/${botId}`, { section: `Revoke ${seen.size} ${gate.split("/").pop()}`.slice(0, 60) })).status).toBe(200);
    writeFileSync(gate, "");
  }
};

describe.skipIf(process.platform === "win32")("a late-refused turn owns one ticket, redeemed once", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver({ fencedDefaults: true }), create=driver.create;
      // Stop-window fixture: the instance with FAKE_LATE_TEARDOWN_HOLD keeps a refused turn's teardown open until its gate file exists.
      driver.create=async input=>{
        const instance=await create(input), hold=input.environment.FAKE_LATE_TEARDOWN_HOLD, teardown=instance.adapter.awaitTurnTeardown?.bind(instance.adapter);
        if(hold&&teardown)instance.adapter.awaitTurnTeardown=async(...args)=>{
          const result=await teardown(...args);
          if(!fs.existsSync(hold)){fs.writeFileSync(hold+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(hold)){clearInterval(poll);resolve();}},5);});}
          return result;
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      // M2 witness (late view): while 'lateview-hold' is armed, the next rebuild access (options.rebuild) reads an unpublished view for
      // LATE_VIEW_READS reads, more than any probe schedule has (0/50/300/2000 ms: 4), and each failed read is followed by one publication
      // event of this database generation. The view is published (the read passes through) only on the read after that. No timer: a rebuild
      // advances only on publications, so it reaches its own view and its receipt; a rebuild taking the probe schedule runs out of reads first.
      const {RecallReadiness}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory/recall-readiness.ts")).href)});
      const {RecallPreparationPending}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory/recall-recovery.ts")).href)});
      const {databaseGeneration}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/database.ts")).href)});
      const access=RecallReadiness.prototype.access, lateHold=path.join(process.env.MURAGE_DATA_DIR,'lateview-hold'), LATE_VIEW_READS=5;
      RecallReadiness.prototype.access=function(read,signal,wait,options){
        if(!options?.rebuild||!fs.existsSync(lateHold))return access.call(this,read,signal,wait,options);
        fs.rmSync(lateHold);
        let unpublished=0, listener;
        const publications=next=>{listener=next;const off=(options.publications??(()=>()=>{}))(next);return()=>{listener=undefined;off();};};
        const late=()=>{
          if(unpublished<LATE_VIEW_READS){unpublished++;fs.writeFileSync(lateHold+'.reads',String(unpublished));setImmediate(()=>listener?.({contextKey:'late-view',databaseGeneration:databaseGeneration()}));throw new RecallPreparationPending('recall view not published yet');}
          fs.writeFileSync(lateHold+'.published','');
          return read();
        };
        // '.settled' names how that rebuild access ended: 'view' (its own published view) or the error it threw
        const settled=outcome=>fs.writeFileSync(lateHold+'.settled',outcome);
        return access.call(this,late,signal,wait,{...options,publications}).then(value=>{settled('view');return value;},error=>{settled(error?.constructor?.name??'error');throw error;});
      };
      const dir=process.env.MURAGE_DATA_DIR, file=path.join(dir,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const each=(name,extra={})=>({driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,name+'-gate'),FAKE_LATE_DUMP:path.join(dir,name+'-dump'),...extra}});
      cfg.instances.direct=each('direct');
      cfg.instances.lateview=each('lateview');
      cfg.instances.room=each('room');
      cfg.instances.iso=each('iso');
      // the one engine here that does not declare fenced writes (it also acts before the id is handed back)
      cfg.instances.unfenced=each('unfenced',{FAKE_LATE_UNKNOWN_ACTION:'1'});
      cfg.instances.stop=each('stop',{FAKE_LATE_TEARDOWN:'1',FAKE_LATE_TEARDOWN_HOLD:path.join(dir,'stop-teardown')});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    dir = fixture.info.dataDir;
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("W1 direct, unwritten: every refusal rebuilds once, the last rebuild runs, never a fourth dispatch", async () => {
    const bot = await newBot("Ticket direct", "direct");
    const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Rebuild while unwritten" })).status).toBe(202);
    await refuseAttempts(bot.id, join(dir, "direct-gate"), 3);
    await expect.poll(async () => (await messages(bot.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const mine = rowsOf(join(dir, "direct-dump")).filter(row => row.threadId === bot.threadId);
    const all = await messages(bot.threadId);
    // 1 + MEMORY_REDISPATCH_ATTEMPTS dispatches (the third, the last resort, runs with no remembered context), one prompt written
    expect(mine.filter(row => !row.prompt)).toHaveLength(3);
    expect(mine.filter(row => row.prompt)).toHaveLength(1);
    expect(existsSync(join(dir, "direct-gate.waiting"))).toBe(false);
    expect(all.filter(message => message.role === "user")).toHaveLength(1);
    expect(all.filter(blocked)).toEqual([]);
    // MA-REBUILD I2 (Astra): the first rebuild dispatched with memory holds its own receipt, so the SECOND revoke refuses that rebuilt receipt
    // (count 1, not the receipt-less held path's 0) and the second rebuild follows; only the last resort, which holds no memory, is not refused.
    const served = readFileSync(fixture.info.logPath, "utf8").slice(logFrom);
    const revoked = [...served.matchAll(/memory receipts revoked scope=\S+ cause=roster count=(\d+)/g)].map(match => Number(match[1]));
    expect(revoked.slice(0, 2)).toEqual([1, 1]);
    expect(served).toContain(`thread ${bot.threadId}; re-preparing (2 of 2)`);
  }, 120000);

  // M2 (Astra arev-marebuild3 Medium 2): a REAL receipt-bearing rebuild whose own recall view is published late. The first rebuild's view stays
  // unpublished for more reads than the probe schedule has (gate above); the rebuild waits for the publication, dispatches with memory and holds
  // its own receipt, so the second revoke refuses that rebuilt receipt (count 1). Held on a rebuild would dispatch it without memory (count 0).
  it("W6 direct, the rebuild's view is published late: the rebuild waits for it and dispatches holding its own receipt", async () => {
    const bot = await newBot("Ticket late view", "lateview"), hold = join(dir, "lateview-hold");
    const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Rebuild after a late view" })).status).toBe(202);
    writeFileSync(hold, "");
    const refused = new Set<string>();
    await refuseAttempts(bot.id, join(dir, "lateview-gate"), 1, refused);
    // the first rebuild read through the whole late window (more reads than any probe schedule) and then reached its published view
    await expect.poll(() => existsSync(`${hold}.settled`), { timeout: 30000 }).toBe(true);
    expect({ settled: readFileSync(`${hold}.settled`, "utf8"), reads: readFileSync(`${hold}.reads`, "utf8"), published: existsSync(`${hold}.published`) }).toEqual({ settled: "view", reads: "5", published: true });
    expect(existsSync(hold)).toBe(false);
    // two more held attempts, each released after a revoke: the late-view rebuild (holding its own receipt) and the last resort
    await refuseAttempts(bot.id, join(dir, "lateview-gate"), 2, refused);
    await expect.poll(async () => (await messages(bot.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    const mine = rowsOf(join(dir, "lateview-dump")).filter(row => row.threadId === bot.threadId);
    const dispatches = mine.filter(row => !row.prompt), all = await messages(bot.threadId);
    expect(dispatches).toHaveLength(3);
    expect(mine.filter(row => row.prompt)).toHaveLength(1);
    // only the last resort notes that remembered context was left out; the late-view rebuild had its memory
    expect(all.filter(message => message.memoryNote === "without-memory").map(message => message.turnId)).toEqual([dispatches[2].turnId]);
    expect(all.filter(blocked)).toEqual([]);
    const served = readFileSync(fixture.info.logPath, "utf8").slice(logFrom);
    const revoked = [...served.matchAll(/memory receipts revoked scope=\S+ cause=roster count=(\d+)/g)].map(match => Number(match[1]));
    // the second revoke refused the late-view rebuild's own receipt (count 1); a held rebuild holds none (count 0)
    expect(revoked.slice(0, 2)).toEqual([1, 1]);
    expect(served).toContain(`thread ${bot.threadId}; re-preparing (1 of 2)`);
    expect(served).toContain(`thread ${bot.threadId}; re-preparing (2 of 2)`);
    expect(served).not.toContain(`not ready after`);
  }, 120000);

  it("W3 isolation: a refusal on one thread neither rebuilds nor holds another thread's turn", async () => {
    const refused = await newBot("Ticket refused", "iso"), other = await newBot("Ticket bystander", "direct");
    expect((await api("POST", `/api/bots/${refused.id}/messages`, { threadId: refused.threadId, text: "Refuse this one" })).status).toBe(202);
    await expect.poll(() => existsSync(join(dir, "iso-gate.waiting")), { timeout: 30000 }).toBe(true);
    // the bystander's turn runs to its reply while the refused turn is still held
    expect((await api("POST", `/api/bots/${other.id}/messages`, { threadId: other.threadId, text: "Unrelated chat" })).status).toBe(202);
    await expect.poll(() => existsSync(join(dir, "direct-gate.waiting")), { timeout: 30000 }).toBe(true);
    writeFileSync(join(dir, "direct-gate"), "");
    await expect.poll(async () => (await messages(other.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(1);
    expect((await api("PATCH", `/api/bots/${refused.id}`, { section: "Revoke the refused thread only" })).status).toBe(200);
    const firstAttempt = readFileSync(join(dir, "iso-gate.waiting"), "utf8");
    writeFileSync(join(dir, "iso-gate"), "");
    // the rebuilt attempt holds the gate under its own id (the released attempt's file is removed a poll later)
    await expect.poll(() => { try { return readFileSync(join(dir, "iso-gate.waiting"), "utf8"); } catch { return firstAttempt; } }, { timeout: 30000 }).not.toBe(firstAttempt);
    await expect.poll(() => busy(other.id), { timeout: 10000 }).toBe(false);
    const otherRows = rowsOf(join(dir, "direct-dump")).filter(row => row.threadId === other.threadId);
    expect(otherRows.filter(row => !row.prompt)).toHaveLength(1);
    expect(otherRows.filter(row => row.prompt)).toHaveLength(1);
    expect((await messages(other.threadId)).filter(blocked)).toEqual([]);
    // the refused thread alone rebuilt; its second attempt is waiting, and the bystander has not been touched again
    expect(rowsOf(join(dir, "iso-dump")).filter(row => row.threadId === refused.threadId && !row.prompt)).toHaveLength(2);
    writeFileSync(join(dir, "iso-gate"), "");
    await expect.poll(async () => (await messages(refused.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(1);
    expect(rowsOf(join(dir, "direct-dump")).filter(row => row.threadId === other.threadId && !row.prompt)).toHaveLength(1);
  }, 120000);

  it("W2 Stop between refusal and terminal: no row, no rebuild, the bot is released", async () => {
    const bot = await newBot("Ticket stop", "stop");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this refused turn" })).status).toBe(202);
    await refuseAttempts(bot.id, join(dir, "stop-gate"), 1);
    // the refused turn's terminal event has fired and its teardown is held open: the Stop lands in that window
    await expect.poll(() => existsSync(join(dir, "stop-teardown.waiting")), { timeout: 30000 }).toBe(true);
    const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
    await new Promise(resolve => setTimeout(resolve, 200));
    writeFileSync(join(dir, "stop-teardown"), "");
    expect((await stopping).status).toBe(200);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await messages(bot.threadId);
    expect(all.filter(blocked)).toEqual([]);
    expect(rowsOf(join(dir, "stop-dump")).filter(row => row.threadId === bot.threadId && !row.prompt)).toHaveLength(1);
    expect(existsSync(join(dir, "stop-gate.waiting"))).toBe(false);
  }, 120000);

  // The ticket's own canRetry is the only layer that stops this rebuild: the engine cannot prove its refused write sent nothing, so the turn is
  // released with one card and never dispatched again (mutant q3b, canRetry always true: a second dispatch).
  it("W5 an engine that does not fence its writes is never rebuilt: one dispatch, one card", async () => {
    const bot = await newBot("Ticket unfenced", "unfenced");
    const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Never rebuilt" })).status).toBe(202);
    await refuseAttempts(bot.id, join(dir, "unfenced-gate"), 1);
    await expect.poll(async () => (await messages(bot.threadId)).filter(blocked).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await messages(bot.threadId);
    expect(rowsOf(join(dir, "unfenced-dump")).filter(row => row.threadId === bot.threadId && !row.prompt)).toHaveLength(1);
    expect(existsSync(join(dir, "unfenced-gate.waiting"))).toBe(false);
    expect(all.filter(blocked)).toHaveLength(1);
    expect(all.filter(isReply)).toEqual([]);
    // q3b: the ticket exists (redispatch) while its boundary cannot retry (an unfenced invocation), and only the ticket's canRetry keeps the
    // terminal fold from holding the run and re-entering the turn; without it the rebuild starts and the send ledger refuses it (stale_action).
    expect(readFileSync(fixture.info.logPath, "utf8").slice(logFrom)).not.toContain("a started turn failed after admission");
  }, 120000);

  it("W4 room member, unwritten: rebuilds are bounded and the member is released", async () => {
    const bot = await newBot("Ticket room", "room");
    const created = await api("POST", "/api/groups", { name: "Ticket room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(created.status).toBe(201);
    const room = created.body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Room rebuild while unwritten" })).status).toBe(202);
    await refuseAttempts(bot.id, join(dir, "room-gate"), 3);
    await expect.poll(async () => (await messages(room.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const mine = rowsOf(join(dir, "room-dump")).filter(row => row.threadId === room.threadId);
    expect(mine.filter(row => !row.prompt)).toHaveLength(3);
    expect(mine.filter(row => row.prompt)).toHaveLength(1);
    expect(existsSync(join(dir, "room-gate.waiting"))).toBe(false);
    expect((await messages(room.threadId)).filter(blocked)).toEqual([]);
  }, 120000);
});
