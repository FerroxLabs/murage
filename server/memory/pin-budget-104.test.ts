// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 pin allowance. On 1.0.3 the owner's Pin action took any size, and a
// set of realistic pins past the 2,048-byte share stopped every turn of the
// bot with MEMORY_PIN_OVERFLOW (lane 104-pinrate, measured on 3a4610373). Now:
// every writer that sets or keeps a pin measures the scope's pins as the
// bundle renders them and refuses with 409 MEMORY_PIN_BUDGET when they would
// not fit (FIX A); an install already over the share, or a small local model,
// keeps answering and leaves the trailing pins out (FIX B, droppedPins).
// Bundles are built with the availableContextTokens server/index.ts computes
// (model contextWindow, else 20480).
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { assertOwnerPinsFit, buildMemoryBundle, MEMORY_FRAME_TOKENS, ownerPinUse, PIN_SHARE_DEFAULT } from "./bundle.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { writeBotIdentity } from "./identity.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
const ticket = ownerMemoryTicket(), bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("moss", "private");
  const token = registry.mint({ botId: "moss", threadId: "private", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function scopeId() { return String((database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key='moss'").get() as any).id); }
/** An active owner-statement fact in the bot's scope, as capture or an approved candidate leaves it. `pinned` writes the pin straight
 * into the store, the way an install upgraded from 1.0.3 already holds it. */
function activeFact(text: string, pinned = false) {
  const id = randomUUID();
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',?,?,NULL,NULL,?)").run(id, scopeId(), text, pinned ? 1 : 0, Date.now(), Date.now());
  return id;
}
const pin = (id: string, pinned = true, version = 1) => memoryOwnerRoute("/api/memory/action", { action: "pin", id, version, pinned }, ticket, roster);
const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, ticket, roster);
const bundle = (availableContextTokens: number) => buildMemoryBundle("What should I do next?", access(), bridge, { allowance: LineageAllowance.tool(), availableContextTokens });
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const pinnedFlag = (id: string, version = 1) => (database().prepare("SELECT owner_pinned FROM memory_records WHERE id=? AND version=?").get(id, version) as any)?.owner_pinned;

// One instruction of the size an owner really writes in the Memory page (about 360 bytes).
const ONE = `When you draft anything for a client, use British spelling, keep it under 150 words, open with the client's first name, never promise a delivery date or a price, and sign off as "Sean, Ferrox Labs". If a request touches billing or a refund, do not answer it yourself: tell me and wait. Prefer plain words over jargon and never use em dashes in anything you write.`;
// A realistic standing set: the kind of lines an owner pins so every turn has them (220 to 380 bytes each).
const SET = [
  ONE,
  `My working hours are 08:00 to 17:00 Austin time, Monday to Friday. Do not schedule, send or promise anything outside those hours unless I say so in the same message. Meetings default to 25 minutes, never back to back, and always with a video link.`,
  `Our company is Ferrox Labs, a Florida LLC with its address in Austin, Texas. Never say Bangkok. Never mention The Forge, it is an old product. Privacy questions go to privacy@murage.ai and security reports to security@ferroxlabs.com; do not answer those yourself.`,
  `When I ask for a summary, give one paragraph first, then a single table of what is done, in progress and pending, then an Important notes section. Lead every question you ask me with a verified recommendation and the reason for it; never give me a bare list of options.`,
  `Pricing: never sell on price, never quote a discount, never compare us with a competitor by name. If someone asks what Murage costs, point them to the pricing page and offer a call. The Agency plan and Cloud are coming; say coming, never give a date.`,
  `Tone for everything public: confident, plain, no exclamation marks, no emojis, no em dashes, frame every fix as a strength (what it can now do), and keep claims true. Sign-off on blog posts is "The Murage team"; on email it is my name only.`,
  `Travel: I am often on the road in Asia, so quote every time in UTC and in my local time, check the date first, and never book anything that lands between 23:00 and 07:00 where I am. Hotels go on the company card, flights on my personal one.`,
  `Code and releases: never push to main, never commit on my behalf, always branch first, and never put a Co-Authored-By line on anything for Ferrox Labs. Releases are weekly; only a Critical holds one, everything else goes to the next version.`,
  `People: Ray handles Agency Builders, Maria handles support tickets, and Tom is the accountant. Questions about invoices go to Tom, questions about the cohort go to Ray, and support goes to Maria. Never give out their personal numbers.`,
  `Reports: a summary paragraph first, then one table of everything done, in progress and pending with the three status marks, then Important notes. Keep agent reports under twenty lines and never ask me a question without a recommendation.`,
  `Diet and health reminders: I do not drink coffee after 14:00, I skip gluten, and I train Monday, Wednesday and Friday at 06:30. If I ask you to book a dinner, pick places with gluten-free options and never before 19:00.`,
  `Kids: Lily is nine and Max is six. School pickup is 15:15 on days I am home; never schedule a call across it. Birthday reminders two weeks ahead, and gift ideas should be books or outdoor things, never screens.`,
];

it("the owner Pin action takes a realistic 360-byte line and default Claude carries it", async () => {
  const id = activeFact(ONE);
  await expect(pin(id)).resolves.toBeTruthy();
  expect(pinnedFlag(id)).toBe(1);
  const built = await bundle(1_000_000);
  expect(built.pinned).toHaveLength(1);
  expect(built.droppedPins).toBeUndefined();
  console.log(`[pin-budget] ONE text bytes=${bytes(ONE)} frame=${MEMORY_FRAME_TOKENS} pinned above frame=${built.tokenCount - MEMORY_FRAME_TOKENS}`);
});

it("the Pin-time measure is the bundle's own rendering: equal to the bytes the bundle spends on the same pins", async () => {
  for (const text of SET.slice(0, 4)) activeFact(text, true);
  const built = await bundle(1_000_000);
  expect(built.pinned).toHaveLength(4);
  expect(ownerPinUse(database(), scopeId())).toEqual({ used: built.tokenCount - MEMORY_FRAME_TOKENS, allowed: PIN_SHARE_DEFAULT });
});

it("FIX A: a pin that would push the set over the allowance is refused with 409 MEMORY_PIN_BUDGET, nothing changes, the bundle still builds", async () => {
  const ids = SET.map(text => activeFact(text));
  let refused: any, at = -1;
  for (const [index, id] of ids.entries()) {
    const outcome = await pin(id).then(() => undefined, (error: Error) => error);
    if (outcome) { refused = outcome; at = index; break; }
  }
  expect(refused?.message).toMatch(/^MEMORY_PIN_BUDGET: \d+\/2048$/);
  expect(refused).toMatchObject({ status: 409, allowed: 2048 });
  expect(refused.used).toBeGreaterThan(2048);
  expect(pinnedFlag(ids[at])).toBe(0);
  const built = await bundle(1_000_000);
  expect(built.pinned).toHaveLength(at);
  expect(built.droppedPins).toBeUndefined();
  console.log(`[pin-budget] FIX A: pin #${at + 1} refused (${refused.used}/${refused.allowed})`);
});

it("FIX B: an install already over the allowance degrades: the turn runs, over-budget pins are left out and named", async () => {
  const ids = SET.map(text => activeFact(text, true));
  for (const ctx of [1_000_000, 20480]) { // Claude; Codex and Fuigo (no contextWindow -> 20480, the same 2048 share)
    const built = await bundle(ctx);
    expect(built.pinned.length).toBeGreaterThan(0);
    expect(built.pinned.length).toBeLessThan(ids.length);
    expect((built.droppedPins ?? []).length).toBe(ids.length - built.pinned.length);
    expect(built.tokenCount - MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(2048);
    // The ones left out are the trailing ones, in the bundle's own pin order.
    const order = [...ids].sort();
    expect([...built.pinned.map(record => record.id), ...built.droppedPins!.map(pin => pin.id)]).toEqual(order);
  }
});

it("a 4K local model (share 409) keeps answering: the one pin it has no room for is left out", async () => {
  await pin(activeFact(ONE));
  const built = await bundle(4096);
  expect(built.pinned).toEqual([]);
  expect(built.droppedPins).toHaveLength(1);
});

it("way out: unpin is never refused, even over the allowance, and the next bundle carries every pin", async () => {
  const ids = SET.map(text => activeFact(text, true));
  expect(() => assertOwnerPinsFit(database(), scopeId())).toThrow("MEMORY_PIN_BUDGET");
  for (const id of ids.slice(0, 6)) await expect(pin(id, false)).resolves.toBeTruthy();
  const built = await bundle(1_000_000);
  expect(built.pinned).toHaveLength(ids.length - 6);
  expect(built.droppedPins).toBeUndefined();
});

it("correct: new words that keep the pin are measured, and an edit that does not fit is refused with nothing changed", async () => {
  activeFact("y".repeat(1700), true);
  const id = activeFact("Short pinned note.");
  await pin(id);
  await expect(act({ action: "correct", id, version: 1, text: "z".repeat(600) })).rejects.toMatchObject({ message: expect.stringMatching(/^MEMORY_PIN_BUDGET/), status: 409 });
  expect(database().prepare("SELECT version,state,text FROM memory_records WHERE id=? ORDER BY version").all(id).map(row => ({ ...row }))).toEqual([{ version: 1, state: "active", text: "Short pinned note." }]);
  // An edit that fits is kept, the pin with it.
  await expect(act({ action: "correct", id, version: 1, text: "Short pinned note, a little longer." })).resolves.toBeTruthy();
  expect(pinnedFlag(id, 2)).toBe(1);
});

it("correct: an install already over the allowance can still shorten a pin (only growth is refused)", async () => {
  const ids = SET.map(text => activeFact(text, true));
  await expect(act({ action: "correct", id: ids[0], version: 1, text: `${SET[0]} And one more thing.` })).rejects.toThrow("MEMORY_PIN_BUDGET");
  await expect(act({ action: "correct", id: ids[0], version: 1, text: "British spelling, under 150 words." })).resolves.toBeTruthy();
  expect(pinnedFlag(ids[0], 2)).toBe(1);
});

it("writeBotIdentity: growing a pinned character-canon past the allowance is refused and the pinned version stays", async () => {
  const canon = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lighthouse", expectedVersion: 0, text: "Moss once tended a fictional lighthouse.", basis: "fiction", audience: "owner-private" }, roster);
  await pin(canon.id);
  await expect(bundle(1_000_000)).resolves.toMatchObject({ pinned: [expect.objectContaining({ id: canon.id })] });
  const grow = () => writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lighthouse", expectedVersion: 1, expectedId: canon.id, text: "Moss once tended a fictional lighthouse. ".repeat(55), basis: "fiction", audience: "owner-private" }, roster);
  expect(grow).toThrow("MEMORY_PIN_BUDGET");
  expect(database().prepare("SELECT version,state,owner_pinned FROM memory_records WHERE id=? ORDER BY version").all(canon.id).map(row => ({ ...row }))).toEqual([{ version: 1, state: "active", owner_pinned: 1 }]);
  const built = await bundle(1_000_000);
  expect(built.pinned.map(record => [record.id, record.version])).toEqual([[canon.id, 1]]);
  expect(built.droppedPins).toBeUndefined();
});

it("writeBotIdentity: the measure counts the identity attribution the bundle renders, not the raw text", async () => {
  // Raw text alone fits the share; the rendered line (handle, fictional-canon attribution, kind, pin mark, JSON quoting) does not.
  const canon = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "harbour", expectedVersion: 0, text: "Moss sailed a fictional harbour.", basis: "fiction", audience: "owner-private" }, roster);
  await pin(canon.id);
  const text = "q".repeat(2048 - 40);
  expect(bytes(text)).toBeLessThan(2048);
  expect(() => writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "harbour", expectedVersion: 1, expectedId: canon.id, text, basis: "fiction", audience: "owner-private" }, roster)).toThrow("MEMORY_PIN_BUDGET");
});
