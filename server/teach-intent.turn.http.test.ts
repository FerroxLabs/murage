// W17 (TEACH-ENTRY 1.0.23 D9.2, D9.3, D9.5): what the bot is told, entered through
// POST /api/bots/:id/messages on a booted server with the fake Claude engine. The engine's
// stdin is logged (FAKE_CLAUDE_INPUT_LOG), so each row reads the exact turn message it got.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TURN_PROMPTS as PROMPTS } from "./bot-shapes.ts";
import { LEARN_PROMPT_MARKER } from "./skill-learn.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// A tree without the teach lines (the pre-fix base) reads as a line no turn carries, so a base run fails at the assertion, not at setup.
const TURN_PROMPTS = { teachText: (PROMPTS as Record<string, string>).teachText ?? "<no teachText on this tree>", teachCard: (PROMPTS as Record<string, string>).teachCard ?? "<no teachCard on this tree>" };
let fixture: VerificationServer;
let model: string;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const inputLog = () => join(fixture.info.dataDir, "engine-input.jsonl");
const inputs = (): string[] => (existsSync(inputLog()) ? readFileSync(inputLog(), "utf8").split("\n").filter(Boolean) : []);

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.verification.environment={...(cfg.instances.verification.environment||{}),FAKE_CLAUDE_INPUT_LOG:path.join(dataDir,'engine-input.jsonl'),FAKE_CLAUDE_HOLD_MARKER:'HOLD-TEACH-TURN',FAKE_CLAUDE_HOLD_GATE:path.join(dataDir,'hold-gate'),FAKE_CLAUDE_HOLD_SEEN:path.join(dataDir,'hold-seen')};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `,
  });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 120_000);
afterAll(async () => { await fixture?.close(); });

/** One owner turn in a fresh bot; resolves with the engine's turn input once it arrives. */
async function turn(text: string, extra: Record<string, unknown> = {}, owner = true): Promise<string> {
  return (await turnIn(await freshBot(), text, extra, owner)).input;
}
async function freshBot(): Promise<{ id: string; threadId: string }> {
  const created = await api("POST", "/api/bots", { name: `Teach ${Math.random().toString(36).slice(2, 8)}`, modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  return created.body.bot as { id: string; threadId: string };
}
async function turnIn(bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}, owner = true): Promise<{ input: string; message: any }> {
  const before = inputs().length;
  // Without the desktop proof the send is not the owner at the keyboard: an unproven, unattended turn (index.ts requestOrigin).
  const proof = headers;
  if (!owner) headers = {};
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: crypto.randomUUID(), ...extra }).finally(() => { headers = proof; });
  expect(sent.status).toBe(202);
  // The turn's own input (a /learn alias arrives expanded, so it is matched by its marker).
  const arrived = (line: string) => line.includes(JSON.stringify(text).slice(1, 30)) || line.includes(LEARN_PROMPT_MARKER);
  await expect.poll(() => inputs().slice(before).some(arrived), { timeout: 30_000 }).toBe(true);
  return { input: inputs().slice(before).join("\n"), message: sent.body.message };
}
const has = (input: string, line: string) => input.includes(JSON.stringify(line).slice(1, -1));

describe("W17 the teach note on a direct owner turn", () => {
  it("a bare offer with the client's card flag gets the teachCard line", async () => {
    const input = await turn("I want to teach you something", { teachCard: true });
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(true);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
  }, 60_000);

  it("the same offer without the flag gets the teachText line", async () => {
    const input = await turn("I want to teach you something");
    expect(has(input, TURN_PROMPTS.teachText)).toBe(true);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 60_000);

  it.each([
    "teach me how to file expenses",
    "Remember how I do the expense report? Do it again for October.",
    "Let me show you how I want the report formatted: Title, Date, Total",
    "Can you remember how to get to my office?",
    "Let me teach you something about Acme",
  ])("%j with a stray card flag gets neither line", async (text) => {
    const input = await turn(text, { teachCard: true });
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
  }, 60_000);

  it("/teach invoices sent as typed is the /learn alias, with no teach note", async () => {
    const input = await turn("/teach invoices");
    expect(input).toContain(LEARN_PROMPT_MARKER);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 60_000);

  it("the same bare offer from a send that is not the owner's (unproven) gets neither line", async () => {
    const input = await turn("I want to teach you something", { teachCard: true }, false);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 60_000);

  it.each(["/learn-notes x", "/teach-notes x"])("%j is ordinary text, not the alias", async (text) => {
    const input = await turn(text);
    expect(input).not.toContain(LEARN_PROMPT_MARKER);
  }, 60_000);
});

describe("W17 rows that are not an owner typing in a direct chat (index.ts ownerDirectTurn)", () => {
  const OFFER = "I want to teach you something";

  it("a routine run whose prompt is a bare offer gets no teach line", async () => {
    const bot = await freshBot();
    const before = inputs().length;
    const created = await api("POST", "/api/routines", { botId: bot.id, name: "Teach routine", prompt: OFFER, schedule: { type: "once", at: Date.now() + 3_600_000 } });
    expect(created.status).toBeLessThan(300);
    const run = await api("POST", `/api/routines/${created.body.routine.id}/run`, {});
    expect(run.status).toBe(201);
    await expect.poll(() => inputs().slice(before).some((line) => line.includes("teach you something")), { timeout: 30_000 }).toBe(true);
    const input = inputs().slice(before).join("\n");
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 60_000);

  it("the edit route gives the teachText line and never the teachCard line, whatever the body says", async () => {
    const bot = await freshBot();
    const first = await turnIn(bot, "hello there");
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id)?.busy === false, { timeout: 30_000 }).toBe(true);
    const before = inputs().length;
    const edited = await api("POST", `/api/bots/${bot.id}/messages/${first.message.id}/edit`, { threadId: bot.threadId, text: OFFER, sendId: crypto.randomUUID(), teachCard: true });
    expect(edited.status).toBeLessThan(300);
    await expect.poll(() => inputs().slice(before).some((line) => line.includes("teach you something")), { timeout: 30_000 }).toBe(true);
    const input = inputs().slice(before).join("\n");
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(true);
  }, 90_000);

  it("a bare offer queued behind a running turn and drained later gets no teach line (queuedDrain)", async () => {
    const bot = await freshBot();
    const gate = join(fixture.info.dataDir, "hold-gate");
    const seen = join(fixture.info.dataDir, "hold-seen");
    const before = inputs().length;
    const held = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "HOLD-TEACH-TURN", sendId: crypto.randomUUID() });
    expect(held.status).toBe(202);
    await expect.poll(() => existsSync(seen), { timeout: 30_000 }).toBe(true);
    // The first turn is still running, so this send queues behind it.
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: OFFER, sendId: crypto.randomUUID(), teachCard: true });
    expect(queued.status).toBe(202);
    expect(inputs().slice(before).some((line) => line.includes("teach you something"))).toBe(false);
    writeFileSync(gate, "go");
    await expect.poll(() => inputs().slice(before).some((line) => line.includes("teach you something")), { timeout: 60_000 }).toBe(true);
    const drained = inputs().slice(before).filter((line) => line.includes("teach you something")).join("\n");
    expect(has(drained, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(drained, TURN_PROMPTS.teachCard)).toBe(false);
  }, 120_000);

  // The engine input log also carries background lines (titles, memory), so the cost is read per turn text: a matching turn's words
  // reach the engine in as many lines as a plain turn's. An extra model call about a match would carry the offer once more.
  const engineInputsFor = async (texts: string[]): Promise<string[]> => {
    const bot = await freshBot();
    const before = inputs().length;
    for (const text of texts) {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: crypto.randomUUID() });
      await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id)?.busy === false, { timeout: 30_000 }).toBe(true);
    }
    return inputs().slice(before);
  };
  it("the detector costs no engine call: 10 turns of which every 5th and the last are matches; the last reaches the engine in one line, as a plain last turn does", async () => {
    // The engine replays earlier turns inside later ones, so only the last turn's words are counted: nothing replays after it.
    const LAST = "I'd like to teach you a skill.";
    const mixed = await engineInputsFor(Array.from({ length: 10 }, (_, i) => (i === 9 ? LAST : i % 5 === 0 ? OFFER : `plain turn ${i}`)));
    const plain = await engineInputsFor(Array.from({ length: 10 }, (_, i) => (i === 9 ? "Please summarise the folder." : `plain turn ${i}`)));
    const carrying = (lines: string[], text: string) => lines.filter((line) => line.includes(JSON.stringify(text).slice(1, -1))).length;
    expect(carrying(plain, "Please summarise the folder.")).toBe(1);
    expect(carrying(mixed, LAST)).toBe(1);
    // The provider-call count: every user message the engine was handed over all 10 turns. A detector that asked the model
    // whether a message is an offer would add a user message per turn (or per match) that a plain run does not have.
    const userMessages = (lines: string[]) => lines.filter((line) => { try { return (JSON.parse(line) as { type?: string }).type === "user"; } catch { return false; } }).length;
    expect(userMessages(mixed)).toBe(10);
    expect(userMessages(plain)).toBe(10);
  }, 360_000);

  // N=100 on the same path (MAIN 2026-11-22: N=1000 is a Medium follow-up; the fake engine takes ~1.5 s a turn).
  it("N=100: the engine is handed exactly one user message per turn, with every 5th turn and the last a match", async () => {
    const LAST = "I'd like to teach you a skill.";
    const userMessages = (lines: string[]) => lines.filter((line) => { try { return (JSON.parse(line) as { type?: string }).type === "user"; } catch { return false; } }).length;
    const mixed = await engineInputsFor(Array.from({ length: 100 }, (_, i) => (i === 99 ? LAST : i % 5 === 0 ? OFFER : `plain turn ${i}`)));
    expect(userMessages(mixed)).toBe(100);
  }, 900_000);
});
