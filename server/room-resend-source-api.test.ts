import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { RESEND_OFFER_LINE } from "../shared/resend-offer.ts";

// 1.0.19 H1: a room member's refusal row names the owner message THAT turn answered (A, which waited), never the newest user line (B, sent to
// another member meanwhile); and a teammate's @mention turn (hop 1) is not the owner's message, so it gets no Send again at all.
let fixture: VerificationServer, headers: Record<string, string>, dir: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const mkBot = async (name: string, instanceId: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const mkRoom = async (name: string, members: any[]) => (await api("POST", "/api/groups", { name, memberIds: members.map(m => m.id), setup: { bulletin: "", defaultResponder: { kind: "member", botId: members[0].id } } })).body.group;
const thread = async (room: any) => (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
describe.skipIf(process.platform === "win32")("a room member's Send again row names the right owner message (H1)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver(); const create=driver.create;
      driver.create=async input=>{const instance=await create(input); const mention=input.environment.FAKE_MENTION;
        if(mention){const subscribe=instance.adapter.onEvent.bind(instance.adapter);instance.adapter.onEvent=listener=>subscribe(event=>listener(event.type==='item.completed'&&event.itemType==='assistant_text'?{...event,text:mention}:event));}
        return instance;};
      BUILT_IN_DRIVERS.push(driver);
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const base={FAKE_LATE_HANDBACK:'1'};
      cfg.instances.gated={driver:'fakeLateTerminal',environment:{...base,FAKE_LATE_REFUSE_AFTER_FENCE:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'gate')}};
      cfg.instances.plain={driver:'fakeLateTerminal',environment:{...base}};
      cfg.instances.refuser={driver:'fakeLateTerminal',environment:{...base,FAKE_LATE_REFUSE_AFTER_FENCE:'1'}};
      cfg.instances.chatty={driver:'fakeLateTerminal',environment:{...base,FAKE_MENTION:'@Beta please take a look'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    dir = fixture.info.dataDir;
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  it("A waits behind member one's running turn, B goes to member two, then member one's turns are refused: each row is for the message it answered, never B", async () => {
    const m1 = await mkBot("Alpha", "gated"), m2 = await mkBot("Gamma", "plain");
    const room = await mkRoom("H1 room", [m1, m2]);
    const gate = join(dir, "gate");
    rmSync(gate, { force: true }); rmSync(gate + ".waiting", { force: true });
    const send = (text: string, to: any) => api("POST", `/api/groups/${room.id}/messages`, { text, sendId: crypto.randomUUID(), mode: "chat", responderId: to.id });
    expect((await send("message T0", m1)).status).toBe(202);
    await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 15000 }).toBe(true);
    expect((await send("message A", m1)).status).toBe(202);
    expect((await send("message B", m2)).status).toBe(202);
    writeFileSync(gate, "go");
    const mine = async () => (await thread(room)).filter(m => m.memoryNote === "resend" && m.from?.botId === m1.id);
    await expect.poll(async () => (await mine()).length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await thread(room)).filter(m => m.role === "user").length, { timeout: 30000 }).toBe(3);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await thread(room);
    const text = (id: string) => all.find(m => m.id === id)?.text;
    const rows = await mine();
    expect(rows.every(r => r.tool.name === RESEND_OFFER_LINE)).toBe(true);
    // every row of member one's refusals names T0 or A, and A's turn (which ran after B was sent) names A
    expect(rows.map(r => text(r.resendOf?.messageId)).sort()).toEqual(["message A", "message T0"]);
    for (const r of rows) expect(r.resendOf).toMatchObject({ threadId: room.threadId, botId: m1.id });
  }, 90000);
  it("an @mention hop, a wake or a routine turn gets no Send again source (the guard on roomResendSource)", () => {
    // The fake engine cannot produce a bot-to-bot @mention chain on this server shape, so the guard is pinned where it is written.
    const source = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
    const line = source.split("\n").find(l => l.trimStart().startsWith("const roomResendSource ="));
    expect(line).toBeDefined();
    for (const guard of ["hop === 0", "!continuationPrompt", "!orchestration", "!heldContinuation", 'roomLineageRow.verb === "room_turn"', 'roomLineageRow.fromKind === "owner"']) expect(line).toContain(guard);
    expect(source).toContain("...(roomResendSource ? { resendOf: { messageId: roomResendSource.id");
    expect(source).not.toMatch(/resendOf: \{ messageId: latestUser\.id/);
  });
  it("C3R3-1: a drained batch of two lines that is refused gets a line but no Send again source", async () => {
    const bot = await mkBot("Batcher", "gated");
    const gate = join(dir, "gate");
    rmSync(gate, { force: true }); rmSync(gate + ".waiting", { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "first", sendId: crypto.randomUUID() })).status).toBeLessThan(300);
    await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 15000 }).toBe(true);
    for (const n of [2, 3]) expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `line ${n}`, sendId: crypto.randomUUID() })).status).toBeLessThan(300);
    writeFileSync(gate, "go");
    const msgs = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    await expect.poll(async () => (await msgs()).filter(m => m.memoryNote === "resend").length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await msgs();
    const rows = all.filter(m => m.memoryNote === "resend");
    const users = all.filter(m => m.role === "user");
    expect(users).toHaveLength(3);
    // the single-line turn keeps its button source; every batch turn (it carries more than one line) has none
    expect(rows.filter(m => m.resendOf).map(m => m.resendOf.messageId)).toEqual([users[0].id]);
    expect(rows.filter(m => !m.resendOf).length).toBeGreaterThanOrEqual(1);
  }, 60000);
});
