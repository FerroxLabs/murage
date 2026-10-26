// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 routine-replay-limit through the real server: the frame re-proof every dispatch makes right before a turn is sent
// (MemoryDispatchReceipt: prepareMemoryDisclosure at its making, assertCurrent before the engine is called; bundle.ts assertMemoryBundle)
// could end in the raw limit error (MEMORY_REPLAY_LIMIT: a record "checking", or the re-proof's allowance spent on a slow or cold machine).
// No dispatch caller rebuilds on it, so on RC3 a routine run ended failed with error=MEMORY_REPLAY_LIMIT and a chat or room turn showed it on
// an error card. Now it is refused as a revoked context is: the turn rebuilds, and the last rebuild carries no memory.
//
// Every place a turn dispatches is covered: a direct chat turn, a routine run (direct dispatch in its own conversation) and a room member's
// turn (runGroupMemberTurn). The limit is forced at the re-proof by a load hook on bundle.ts (<data>/frame-limit: "all" forces every frame
// re-proof, a number forces that many), so the test does not depend on how fast the runner is; <data>/frame-limit.hits counts what it forced,
// so a pass is never vacuous.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path} ${response.status}`).toBe(true);
  return await response.json() as any;
};
const data = (name: string) => join(fixture.info.dataDir, name);
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const sentRows = () => existsSync(data("sent")) ? readFileSync(data("sent"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const hits = () => existsSync(data("frame-limit.hits")) ? readFileSync(data("frame-limit.hits"), "utf8").trim().split("\n").filter(Boolean).length : 0;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const replies = async (threadId: string) => (await messages(threadId)).filter(isReply).length;
const errorLines = (all: any[]) => all.filter(message => String(message.tool?.name ?? "").startsWith("error:")).map(message => String(message.tool.name));
const botIdle = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy !== true;
const markerIdle = async () => {
  const answer = data("revoke-idle.json");
  await expect.poll(() => {
    if (existsSync(answer) && JSON.parse(readFileSync(answer, "utf8")).idle === true) return true;
    if (!existsSync(data("revoke-idle.req"))) { rmSync(answer, { force: true }); writeFileSync(data("revoke-idle.req"), ""); }
    return false;
  }, { timeout: 60000, interval: 100 }).toBe(true);
  rmSync(answer, { force: true });
};
/** A bot on the fixture engine with one owner-pinned memory, so every frame it is sent holds a record to re-prove. */
const pinnedBot = async (name: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "late", model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  mkdirSync(join(fixture.info.dataDir, "workspaces", bot.id, "memory"), { recursive: true });
  writeFileSync(join(fixture.info.dataDir, "workspaces", bot.id, "memory", "notes.md"), `${name} reports are written in charcoal.\n`);
  const preview = await api("POST", "/api/memory/action", { action: "import-preview", selections: [{ kind: "bot", botId: bot.id, topic: "notes.md" }] });
  const committed = await api("POST", "/api/memory/action", { action: "import-commit", previewId: preview.previewId, track: false });
  for (const id of committed.recordIds as string[]) await api("POST", "/api/memory/action", { action: "pin", id, version: 1, pinned: true });
  await markerIdle();
  return bot;
};
const send = async (botId: string, threadId: string, text: string, room?: { id: string }) => {
  const before = await replies(threadId);
  await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${botId}/messages`, { threadId, text });
  await expect.poll(async () => await replies(threadId), { timeout: 60000 }).toBe(before + 1);
  await expect.poll(async () => await botIdle(botId), { timeout: 15000 }).toBe(true);
};
/** Nothing the owner sees names the limit: no error card, no line holding the code. */
const expectNoLimitShown = async (threadId: string) => {
  const all = await messages(threadId);
  expect(errorLines(all)).toEqual([]);
  expect(JSON.stringify(all)).not.toContain("MEMORY_REPLAY_LIMIT");
};
const force = (mode: "all" | number) => writeFileSync(data("frame-limit"), String(mode));

describe.skipIf(process.platform === "win32")("1.0.7 a frame re-proof that cannot finish never fails a turn or a routine run", () => {
  beforeAll(async () => {
    const bundleUrl = pathToFileURL(join(process.cwd(), "server/memory/bundle.ts")).href;
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const dir=process.env.MURAGE_DATA_DIR;
      // the forced limit: <dir>/frame-limit is "all" (every frame re-proof) or a count (that many, then none)
      globalThis.__frameLimit=()=>{
        const file=path.join(dir,'frame-limit'); if(!fs.existsSync(file))return false;
        const mode=fs.readFileSync(file,'utf8').trim();
        if(mode!=='all'){const left=Number(mode);if(!(left>0))return false;fs.writeFileSync(file,String(left-1));}
        fs.appendFileSync(path.join(dir,'frame-limit.hits'),'hit\\n');
        return true;
      };
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, nextLoad) {
        if(url!==${JSON.stringify(bundleUrl)})return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const anchor='  inMemoryAccessPass(() => {\\n    for (const record of trusted.records) {';
        if(source.split(anchor).length!==2)throw new Error('assertMemoryBundle fixture anchor changed');
        return { format:'module-typescript', shortCircuit:true, source: source.replace(anchor,'  if (trusted.records.length && (globalThis as any).__frameLimit()) throw new Error("MEMORY_REPLAY_LIMIT");\\n'+anchor) };
      } });
      // revoke-idle: the pinned import inherits the marks of any revoke in flight and reads "checking" until its last mark
      setInterval(async()=>{
        const req=path.join(dir,'revoke-idle.req'); if(!fs.existsSync(req))return;
        const { database } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/database.ts")).href)});
        const { revocationWorkPending } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory/memory-revocation.ts")).href)});
        const { markerWorkPending } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory/revoke-marker.ts")).href)});
        const db=database(); const idle=!markerWorkPending(db)&&!revocationWorkPending(db);
        fs.rmSync(req,{force:true}); fs.writeFileSync(path.join(dir,'revoke-idle.tmp'),JSON.stringify({idle})); fs.renameSync(path.join(dir,'revoke-idle.tmp'),path.join(dir,'revoke-idle.json'));
      },25).unref();
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      // what each engine call was sent: whether the bot's pinned memory (its frame) is in it
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input); const sendTurn=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{fs.appendFileSync(path.join(dir,'sent'),JSON.stringify({threadId:turn.threadId,frame:JSON.stringify(turn).includes('written in charcoal')})+'\\n');return sendTurn(turn);};
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.late={driver:'fakeLateTerminal',environment:{}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 120000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(() => { if (fixture) { rmSync(data("frame-limit"), { force: true }); rmSync(data("frame-limit.hits"), { force: true }); } });

  it("direct chat, forced once: the turn rebuilds and is sent WITH its memory frame, no card", async () => {
    const bot = await pinnedBot("Once");
    await send(bot.id, bot.threadId, "warm up");
    const before = sentRows().length, notes = count(log(), `context revoked during dispatch on thread ${bot.threadId}`);
    force(1);
    await send(bot.id, bot.threadId, "what colour are my reports?");
    expect(hits()).toBe(1);
    await expectNoLimitShown(bot.threadId);
    expect(count(log(), `context revoked during dispatch on thread ${bot.threadId}`)).toBe(notes + 1);
    expect(log()).toContain("not a revoke");
    // the rebuild carried memory: the one engine call made for this turn (the refused attempt never reached the engine) held the frame
    const sent = sentRows().slice(before).filter(row => row.threadId === bot.threadId);
    expect(sent).toHaveLength(1);
    expect(sent[0].frame).toBe(true);
  }, 180000);

  it("direct chat, every re-proof forced: the turn ends on the last rebuild with no memory and a reply, never the raw limit", async () => {
    const bot = await pinnedBot("Always");
    force("all");
    const before = sentRows().length;
    await send(bot.id, bot.threadId, "what colour are my reports?");
    expect(hits()).toBeGreaterThan(0);
    await expectNoLimitShown(bot.threadId);
    // the one engine call is the last rebuild's: no frame
    expect(sentRows().slice(before).filter(row => row.threadId === bot.threadId)).toEqual([{ threadId: bot.threadId, frame: false }]);
  }, 180000);

  it("routine run, every re-proof forced: the run completes, its error is never MEMORY_REPLAY_LIMIT", async () => {
    const bot = await pinnedBot("Routine");
    const routine = (await api("POST", "/api/routines", { botId: bot.id, name: "Limit check", prompt: "Please answer briefly.", schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine;
    force("all");
    const started = (await api("POST", `/api/routines/${routine.id}/run`, {})).run as { id: string };
    const runOf = async () => ((await api("GET", "/api/routines")).runs as any[]).find(run => run.id === started.id);
    await expect.poll(async () => (await runOf())?.status, { timeout: 120000 }).toMatch(/^(completed|failed|cancelled|missed)$/);
    const run = await runOf();
    expect(String(run.error ?? "")).not.toContain("MEMORY_REPLAY_LIMIT");
    expect(run.status).toBe("completed");
    expect(hits()).toBeGreaterThan(0);
    if (run.threadId) await expectNoLimitShown(run.threadId);
  }, 180000);

  it("room member turn, every re-proof forced: the member replies, no error card", async () => {
    const bot = await pinnedBot("Member");
    const room = (await api("POST", "/api/groups", { name: "Limit room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group as { id: string; threadId: string };
    await markerIdle();
    force("all");
    await send(bot.id, room.threadId, "what colour are the reports?", room);
    expect(hits()).toBeGreaterThan(0);
    await expectNoLimitShown(room.threadId);
  }, 180000);

  it("room member turn, forced once: the member's rebuild is sent WITH its memory frame", async () => {
    const bot = await pinnedBot("Member once");
    const room = (await api("POST", "/api/groups", { name: "Limit room once", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group as { id: string; threadId: string };
    await markerIdle();
    const before = sentRows().length;
    force(1);
    await send(bot.id, room.threadId, "and the colour again?", room);
    expect(hits()).toBe(1);
    await expectNoLimitShown(room.threadId);
    const sent = sentRows().slice(before).filter(row => row.threadId === room.threadId);
    expect(sent).toHaveLength(1);
    expect(sent[0].frame).toBe(true);
  }, 180000);
});
