// W17 (TEACH-ENTRY 1.0.23 D9.5): the rows that are not an owner typing in a direct chat, entered the way the
// product enters them on a booted server with the fake Claude engine: a bot asking a peer
// (POST /api/internal/ask-bot, commsDepth > 0), a handoff (POST /api/internal/delegate-bot, delegationRun) and the
// owner's own DM from a paired messaging app (a Telegram update through the fetch fixture). The engine's stdin is
// logged (FAKE_CLAUDE_INPUT_LOG), so each row reads the exact turn message the engine got.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TURN_PROMPTS as PROMPTS } from "./bot-shapes.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

// A tree without the teach lines (the pre-fix base) reads as a line no turn carries, so a base run fails at the assertion, not at setup.
const TURN_PROMPTS = { teachText: (PROMPTS as Record<string, string>).teachText ?? "<no teachText on this tree>", teachCard: (PROMPTS as Record<string, string>).teachCard ?? "<no teachCard on this tree>" };
let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const OFFER = "I want to teach you something";
const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const get = async (path: string) => (await (await fetch(`${fixture.info.url}${path}`, { headers: desktop })).json()) as any;
const inputLog = () => join(fixture.info.dataDir, "engine-input.jsonl");
const inputs = (): string[] => (existsSync(inputLog()) ? readFileSync(inputLog(), "utf8").split("\n").filter(Boolean) : []);
const has = (input: string, line: string) => input.includes(JSON.stringify(line).slice(1, -1));
const newBot = async (name: string) => (await post("/api/bots", { name })).body.bot as { id: string; threadId: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const turnFor = async (tag: string) => {
  for (const started = Date.now(); Date.now() - started < 30_000; await sleep(100)) {
    try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (text.includes(tag)) return withTurnSecrets(JSON.parse(text)) as { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } }; } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
};
const tokenOf = (turn: Awaited<ReturnType<typeof turnFor>>) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map((server) => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;
/** The peer's turn input: the engine lines that carry the offer's words, once at least one has arrived. */
async function offerInput(before: number): Promise<string> {
  await expect.poll(() => inputs().slice(before).some((line) => line.includes("teach you something")), { timeout: 30_000 }).toBe(true);
  return inputs().slice(before).filter((line) => line.includes("teach you something")).join("\n");
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.FAKE_CLAUDE_INPUT_LOG = join(process.env.MURAGE_DATA_DIR, 'engine-input.jsonl');
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
      process.env.FAKE_CLAUDE_HOLD_MARKER = 'DM_HOLD_TURN';
      process.env.FAKE_CLAUDE_HOLD_GATE = join(process.env.MURAGE_DATA_DIR, 'dm-hold');
      process.env.FAKE_TELEGRAM_DIR = join(process.env.MURAGE_DATA_DIR, 'telegram-fixture');
      mkdirSync(process.env.FAKE_TELEGRAM_DIR);
      await import(${JSON.stringify(new URL("./testing/telegram-fetch-preload.mjs", import.meta.url).href)});
    `,
  });
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
}, 120_000);
afterAll(async () => { await fixture?.close(); });

describe.skipIf(process.platform === "win32")("W17 peer, handoff and channel rows (index.ts ownerDirectTurn, teachTurnNote)", () => {
  // Two independent layers keep a peer or handoff message from getting a teach line: the ownerDirectTurn guard (commsDepth, delegationRun) and the
  // "[Message from @bot ...]" wrapper the message arrives in, which the bare-offer detector never matches. Removing ONE layer alone leaves these
  // rows green by design (the wrapper itself is asserted per row, so removing the wrapper alone is RED there); the receipt mutant removes both (M17-both: ownerDirectTurn forced true and the wrapper stripped) and goes RED at :81 and :95.
  async function holdAsker(tag: string) {
    const asker = await newBot("Asker");
    const peer = await newBot("Peer");
    await post(`/api/bots/${asker.id}/messages`, { text: `Hold on. __fixture_hold_authority__ ${tag}` });
    const held = await turnFor(tag);
    return { asker, peer, held, token: tokenOf(held) };
  }

  it("bot-to-bot: a peer asked with a bare offer (commsDepth > 0) gets no teach line", async () => {
    const { asker, peer, held, token } = await holdAsker("ASKER_HOLD_PEER");
    const before = inputs().length;
    const asked = await post("/api/internal/ask-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: OFFER }, { authorization: `Bearer ${token}` });
    expect(asked.status).toBe(200);
    const input = await offerInput(before);
    // The wrapper layer: the offer reaches the peer inside the sender's header, never as the bare message.
    expect(has(input, `[Message from @Asker, another bot in this Murage workspace. Reply to them.]\n\n${OFFER}`)).toBe(true);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
    writeFileSync(join(fixture.fixtureFinishGateDir, String(held.pid)), "finish");
  }, 120_000);

  it("delegated run: a handoff whose message is a bare offer gets no teach line", async () => {
    const { asker, peer, held, token } = await holdAsker("ASKER_HOLD_DLG");
    const before = inputs().length;
    const asked = await post("/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: OFFER }, { authorization: `Bearer ${token}` });
    expect(asked.status).toBe(200);
    // The handoff starts once the asking turn ends.
    writeFileSync(join(fixture.fixtureFinishGateDir, String(held.pid)), "finish");
    const input = await offerInput(before);
    expect(has(input, `[Delegated by @Asker, another bot in this Murage workspace. Do the work and reply directly.]\n\n${OFFER}`)).toBe(true);
    expect(has(input, TURN_PROMPTS.teachText)).toBe(false);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 120_000);

  it("owner channel DM: the owner's paired Telegram message gets the teachText line, never the teachCard line", async () => {
    const bot = await newBot("Channel bot");
    expect((await post(`/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: "workspace" }, desktop, "PATCH")).status).toBe(200);
    await post("/api/config", { telegram: { botToken: "123:abcdefghijklmnopqrstuvwxyz123456" } }, desktop, "PATCH");
    const pair = await post("/api/telegram/pair", { targetBotId: bot.id });
    expect(pair.status).toBe(200);
    const dir = join(fixture.info.dataDir, "telegram-fixture");
    const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" } } });
    const rows = [update(1, `/pair ${pair.body.code}`)];
    const send = () => { writeFileSync(join(dir, "updates.tmp"), JSON.stringify(rows)); renameSync(join(dir, "updates.tmp"), join(dir, "updates.json")); };
    send();
    await expect.poll(async () => (await get("/api/telegram/status")).paired, { timeout: 20_000 }).toBe(true);
    const binding = (await post("/api/memory/action", { action: "humans" })).body.bindings[0];
    const linked = await post("/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
    expect(linked.status).toBe(200);
    const before = inputs().length;
    rows.push(update(2, OFFER));
    send();
    const input = await offerInput(before);
    expect(has(input, TURN_PROMPTS.teachText), input.slice(0, 1800)).toBe(true);
    expect(has(input, TURN_PROMPTS.teachCard)).toBe(false);
  }, 120_000);
});
