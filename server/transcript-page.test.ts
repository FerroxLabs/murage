import { appendFixtureMessage } from './testing/approval-card.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E round 2 (ui-review-r2/REPORT.md, P1): the page a client gets depends
// on what it says it can fold. A 1.0.2 renderer takes open request cards beside
// its page; a 1.0.1 renderer, the phone and the companion never read that field
// and are sent every open card inside their page, as they always were.

import { REPLY_WITHHELD } from "./owner-display.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { SseReplay } from "./sse-buffer.ts";
import { Store } from "./store.ts";
import { database } from "./database.ts";
import { sanitizeBotDisplayMessage, storedRowDisplayMetadata, wireThread, takesCardsBeside, transcriptPage, wirePage } from "./transcript-page.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("the page each client is sent", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  function longThreadWithOldCard() {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = appendFixtureMessage(store, bot.threadId, { role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId: "req-old", tool: "Bash" } } as never);
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` });
    return { store: new Store(selection), threadId: bot.threadId, card };
  }

  it("a client that did not negotiate gets the old card inside its page and none of the new fields", () => {
    const { store, threadId, card } = longThreadWithOldCard();
    const wire = wirePage(store, threadId, transcriptPage(store, threadId, 100, false), false, true) as Record<string, unknown>;
    expect((wire.messages as Array<{ id: string }>).some((m) => m.id === card.id)).toBe(true);
    expect(wire.openCards).toBeUndefined();
    expect(wire.openCardsLeaf).toBeUndefined();
    expect(wire.olderFrom).toBeUndefined();
  });

  it("a client that did negotiate gets a bounded page, the card beside it, and the head the card was worked out for", () => {
    const { store, threadId, card } = longThreadWithOldCard();
    const page = transcriptPage(store, threadId, 100, true);
    const wire = wirePage(store, threadId, page, true, true) as { messages: unknown[]; openCards?: Array<{ id: string }>; openCardsLeaf?: string; hasMore: boolean };
    expect(wire.messages).toHaveLength(100);
    expect(wire.openCards?.map((m) => m.id)).toEqual([card.id]);
    expect(wire.openCardsLeaf).toBe(store.activeLeafOf(threadId));
    expect(wire.hasMore).toBe(true);
  });

  it("negotiation is read from the header or the stream query", () => {
    expect(takesCardsBeside({}, new URLSearchParams())).toBe(false);
    expect(takesCardsBeside({ "x-murage-cards": "beside" }, new URLSearchParams())).toBe(true);
    expect(takesCardsBeside({}, new URLSearchParams("cards=beside"))).toBe(true);
    expect(takesCardsBeside({ "x-murage-cards": "nope" }, new URLSearchParams("cards=nope"))).toBe(false);
  });
});

describe("a page frame kept in the cards-beside shape only", () => {
  it("is found after a cursor, so a stream that cannot fold it hydrates instead of resuming", () => {
    const replay = new SseReplay();
    const subject = { scope: "global" } as never;
    replay.append({ seq: 1, kind: "bot", subject }, "id: 1\n\n");
    replay.append({ seq: 2, kind: "bot", subject, besideOnly: true }, "id: 2\n\n");
    replay.append({ seq: 3, kind: "bot", subject }, "id: 3\n\n");
    expect(replay.hasBesideOnlySince(0)).toBe(true);
    expect(replay.hasBesideOnlySince(1)).toBe(true);
    expect(replay.hasBesideOnlySince(2)).toBe(false);
    expect(replay.hasBesideOnlySince(null)).toBe(false);
  });
});


describe("historical display boundary", () => {
  beforeAll(() => removeTempDirSync(DATA_DIR));
  // Bypass append/patch scrubbing, exactly like a pre-upgrade persisted row.
  function oldRow(text = ("api_key=OLDSECR" + "ET123456")) {
    const store = new Store(selection), bot = store.createBot();
    const message = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "before upgrade" });
    const old = { ...message, text, removedText: "SIBLINGSECRET", tool: { name: "read", summary: "SIBLINGSECRET", spoken: "SIBLINGSECRET", imageRecord: { summary: "SIBLINGSECRET", prompt: text } } };
    database().prepare("UPDATE messages SET text=?, json=? WHERE id=?").run(text, JSON.stringify(old), message.id);
    const reader = new Store(selection);
    return { store: reader, threadId: bot.threadId, row: reader.messagesFor(bot.threadId).find(row => row.id === message.id)! };
  }
  for (const slot of ["message", "messages", "openCards"] as const) {
    for (const mode of ["wireThread"]) {
      for (const numbered of [false, true]) for (const slim of [false, true]) for (const legacy of [false, true]) {
        it(`historical.${slot}.${mode}.${numbered ? "numbered" : "pending"}.${slim ? "slim" : "full"}.${legacy ? "legacy" : "current"}`, () => {
          const f = oldRow(), before = JSON.stringify(f.row);
          const seq = { threadNumbered: () => numbered, newestSeq: () => 19, messageSeq: () => 7 };
          const body: { message?: unknown; messages?: readonly unknown[]; openCards?: readonly unknown[] } & Record<string, unknown> = { [slot]: slot === "message" ? f.row : [f.row], activeLeafId: f.row.id, hasMore: true, olderFrom: "cursor", newestSeq: 999 };
          const wire = wireThread(seq, f.threadId, body, { slim, legacy });
          expect(JSON.stringify(wire)).not.toMatch(/OLDSECRET123456|SIBLINGSECRET/);
          expect(wire).toMatchObject({ activeLeafId: f.row.id, hasMore: true, olderFrom: "cursor" });
          expect(wire.newestSeq).toBe(numbered && !legacy ? 19 : undefined);
          const row = (slot === "message" ? wire[slot] : (wire[slot] as unknown[])[0]) as Record<string, unknown>;
          expect(row.id).toBe(f.row.id);
          expect(row.parentId).toBe(f.row.parentId);
          expect(row.seq).toBe(numbered && !legacy ? f.row.seq ?? 7 : undefined);
          expect(JSON.stringify(f.row)).toBe(before);
          expect(database().prepare("SELECT text FROM messages WHERE id=?").get(f.row.id)?.text).toBe(f.row.text);
        });
      }
    }
  }
  it("historical.owner-and-storage-unchanged", () => {
    const f = oldRow(), row = { ...f.row, role: "user", origin: "desktop", actorKind: "owner", tool: undefined };
    const before = JSON.stringify(row);
    const result = wireThread(f.store, f.threadId, { message: row }, { slim: false });
    expect(result.message).toEqual(row);
    expect(JSON.stringify(row)).toBe(before);
  });
  it("historical.unknown-authorship-and-accessor", () => {
    let reads = 0;
    const row = { id: "unknown", kind: "text", at: 1, text: "SIBLINGSECRET", get surprise() { reads++; throw new Error("SIBLINGSECRET"); } };
    const result = wireThread({ threadNumbered: () => false, newestSeq: () => 0, messageSeq: () => null }, "thread", { message: row });
    expect(JSON.stringify(result)).not.toContain("SIBLINGSECRET");
    expect(reads).toBe(0);
  });
  it("historical.markdown-whole-unit", () => {
    const f = oldRow("**password**: hunter2\nTAILSECRET");
    const wire = wireThread(f.store, f.threadId, { message: f.row });
    expect(JSON.stringify(wire)).not.toMatch(/hunter2|TAILSECRET|SIBLINGSECRET/);
  });
});


it("historical.bounded-known-fields-and-unknown-subtrees", () => {
  let getters = 0;
  const unknown = { get text() { getters++; throw new Error("SIBLINGSECRET"); } };
  const root = { id: "row", at: 1, role: "bot", kind: "text", text: "ordinary", surprise: unknown };
  expect(sanitizeBotDisplayMessage(root, { authorship: "bot" })).toEqual({ id: "row", at: 1, role: "bot", kind: "text", text: "ordinary" });
  expect(getters).toBe(0);
  const huge = { ...root, text: "SIBLINGSECRET".repeat(30_000) };
  // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z ("size cuts on shown text: remove them"; design X5): 390 KiB of clean stored text was
  // returned as the marker for its size. It is now redacted per character and read back whole (the word is a fixture, not a secret).
  expect(sanitizeBotDisplayMessage(huge, { authorship: "bot" })).toMatchObject({ id: "row", text: huge.text });
  const cycle: Record<string, unknown> = {}; cycle.preview = cycle;
  const serialized = JSON.stringify(sanitizeBotDisplayMessage({ ...root, tool: cycle }, { authorship: "bot" }));
  expect(serialized).toContain("«redacted»");
  expect(getters).toBe(0);
});
it("historical.approval-control-and-original-record", () => {
  const row = { id: "host-row", at: 1, role: "bot", kind: "options", card: { requestId: "provider-request", title: ("api_key=OLDSECR" + "ET123456"), subtitle: "SIBLINGSECRET", options: ["Allow once", "Deny"], exactAllowKey: "PRIVATE-EXECUTION-KEY" } };
  const original = JSON.stringify(row);
  const safe = sanitizeBotDisplayMessage(row, { authorship: "bot" });
  expect(safe.card).toMatchObject({ requestHandle: "p.host-row", options: ["Allow once", "Deny"] });
  expect(JSON.stringify(safe)).not.toMatch(/OLDSECRET123456|SIBLINGSECRET|provider-request|PRIVATE-EXECUTION-KEY/);
  expect(JSON.stringify(row)).toBe(original);
});


it("historical.exhaustion-keeps-authoritative-controls", () => {
  // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design X5): a 300,000 character title no longer exhausts the row (the size cut is
  // gone). The walk still gives up on a subtree deeper than its depth guard, which is the exhaustion this row now uses.
  let deep: unknown = "x"; for (let i = 0; i < 45; i++) deep = { preview: deep };
  const row = { id: "host-question", at: 1, role: "bot", kind: "options", card: { title: "x", preview: deep, subtitle: "SIBLINGSECRET", requestId: "private-provider-id", answered: "", expired: true, questions: [{ id: "private-question-id", question: "SIBLINGSECRET", options: [{ label: "private label" }], allowOther: true, secret: true }] } };
  const safe = sanitizeBotDisplayMessage(row, { authorship: "bot" });
  expect(safe).toMatchObject({ id: row.id, kind: "options", card: { requestHandle: "q.host-question", answered: "", expired: true, questions: [{ handle: "q.0", allowOther: true, secret: true, options: [{ handle: "o.0.0", label: "Option 1" }] }] } });
  expect(JSON.stringify(safe)).not.toMatch(/SIBLINGSECRET|private-provider|private-question|private label/);
});

it("historical.provider-control-names-are-not-host-provenance", () => {
  const row = { id: "stored-row", at: 1, role: "bot", kind: "activity", turnId: ("api_key=OLDSECR" + "ET123456"), tool: { name: ("api_key=OLDSECR" + "ET123456"), id: "SIBLINGSECRET", handle: "SIBLINGSECRET" }, card: { title: "safe", requestId: "raw-provider-request", questions: [{ id: "provider-id", question: "Choose", options: [{ label: "original" }] }] } };
  const safe = sanitizeBotDisplayMessage(row, { authorship: "bot" });
  expect(JSON.stringify(safe)).not.toMatch(/OLDSECRET123456|SIBLINGSECRET|raw-provider-request|provider-id/);
  expect(safe.id).toBe("stored-row");
  expect((safe.card as any).requestHandle).toBe("q.stored-row");
});

it("keeps the host resend source and its used state in a historical refusal", () => {
  const row = { id: "refusal-row", role: "bot", kind: "activity", text: "Try this message again.",
    resendOf: { messageId: "owner-message", threadId: "room-thread", botId: "room-member", unknown: "omitted" }, resendUsed: true, to: ["room-member"] };
  expect(sanitizeBotDisplayMessage(row, { authorship: "bot" })).toMatchObject({
    resendOf: { messageId: "owner-message", threadId: "room-thread", botId: "room-member" }, resendUsed: true, to: ["room-member"],
  });
  expect((sanitizeBotDisplayMessage(row, { authorship: "bot" }).resendOf as object)).not.toHaveProperty("unknown");
});

it("scans resend metadata with its refusal's display unit", () => {
  const row = { id: "refusal-row", role: "bot", kind: "activity", text: "A sibling explanation",
    resendOf: { messageId: ("api_key=OLDSECR" + "ET123456"), threadId: "room-thread", botId: "room-member" } };
  const safe = sanitizeBotDisplayMessage(row, { authorship: "bot" });
  expect(safe.text).toBe("«redacted»");
  expect(JSON.stringify(safe)).not.toContain("OLDSECR" + "ET123456");
});

it("historical.user-role-without-owner-proof-is-not-owner", () => {
  const row = { id: "unknown-owner", at: 1, role: "user", kind: "text", text: ("api_key=OLDSECR" + "ET123456") };
  const safe = wireThread({ threadNumbered: () => false, newestSeq: () => 0, messageSeq: () => null }, "thread", { message: row });
  expect(JSON.stringify(safe)).not.toContain(("OLDSECR" + "ET123456"));
  expect(row.text).toBe(("api_key=OLDSECR" + "ET123456"));
});

it("historical.repeated-projection-preserves-permission-handle", () => {
  const original = { id: "host-permission", at: 1, role: "bot", kind: "options", card: { requestId: "raw-provider-id", title: ("api_key=OLDSECR" + "ET123456"), subtitle: "SIBLINGSECRET", options: ["Allow once", "Deny"] } };
  const first = sanitizeBotDisplayMessage(original, { authorship: "bot" });
  const replay = sanitizeBotDisplayMessage(first, { authorship: "bot" });
  expect(replay.card).toMatchObject({ requestHandle: "p.host-permission", options: ["Allow once", "Deny"] });
  expect(JSON.stringify(replay)).not.toMatch(/OLDSECRET123456|SIBLINGSECRET|raw-provider-id/);
  expect(original.card.requestId).toBe("raw-provider-id");
});

// Phone metadata producer and display consumer owner: p1-conn.
it.each(["share", "ask-intent"])("stored phone %s text stays visible without owner exemption", via => {
  const row = { id: "phone-row", at: 1, role: "user", kind: "text", origin: "unproven", via, text: "shared ordinary text" };
  const metadata = storedRowDisplayMetadata(row);
  expect(metadata.authorship).toBe("bot");
  expect(sanitizeBotDisplayMessage(row, metadata)).toMatchObject(row);
  const secret = { ...row, text: "api_key=" + "FIXTURESECRET123456" };
  // MAIN RULING INT-CONFLICT-DEFAULT 61804c29767 a62419d6d5: retain the current display redactor's exact masked-value spelling.
  expect(sanitizeBotDisplayMessage(secret, metadata).text).toBe("api_key=«redacted 19 chars»");
  expect(secret.text).toBe("api_key=" + "FIXTURESECRET123456");
  expect(storedRowDisplayMetadata({ ...row, via: "unknown" }).authorship).toBe("unknown");
  expect(storedRowDisplayMetadata({ ...row, origin: undefined }).authorship).toBe("unknown");
});

// Widget producer and display consumer owner: r5-fixtures-a.
it("historical.widget-answers-keep-declared-fields-and-share-the-display-scan", () => {
  const row = { id: "widget-row", at: 1, role: "bot", kind: "widget", text: "", widget: {
    id: "booking", root: { type: "Card", children: [{ type: "DatePicker", name: "date" }, { type: "Select", name: "length" }] },
    settled: { ref: "confirm", label: "Book it", sendId: "widget-booking", values: { date: "2026-10-21", length: "60", undeclared: "hidden field" } },
  } };
  const safe = sanitizeBotDisplayMessage(row, { authorship: "bot" });
  expect((safe.widget as any).settled).toEqual({ ref: "confirm", label: "Book it", sendId: "widget-booking", values: { date: "2026-10-21", length: "60" } }); // MAIN RULING 1115-R5RUL-1 (GrokBuild)
  row.widget.settled.values.date = "api_key=OLDSECR" + "ET123456";
  expect(sanitizeBotDisplayMessage(row, { authorship: "bot" })).not.toHaveProperty("widget"); // MAIN RULING 1115-R5RUL-1 (GrokBuild)
  expect(row.widget.settled.values.undeclared).toBe("hidden field"); // MAIN RULING 1115-R5RUL-1 (GrokBuild)
});


it("historical status retains finite zero counts and excludes undeclared data", () => {
  const project = (data: object) => sanitizeBotDisplayMessage({ role: "bot", kind: "activity", murage: { status: { key: "criteria_claim_corrected", data } } }, { authorship: "bot" });
  expect(project({ met: 0, total: 1, undeclared: "private" })).toEqual({ role: "bot", kind: "activity", murage: { status: { key: "criteria_claim_corrected", data: { met: 0, total: 1 } } } });
  expect(JSON.stringify(project({ met: Number.NaN, total: Infinity, undeclared: "private" }))).not.toMatch(/met|total|private/);
  let reads = 0;
  expect(JSON.stringify(project({ get met() { reads++; return 1; }, total: 1 }))).not.toContain('criteria_claim_corrected');
  expect(reads).toBe(0);
});

it("an old marker keeps its field without blanking its owner-only row siblings", () => {
  const store = new Store(selection), bot = store.createBot();
  const old = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Before upgrade." });
  const marker = "«redacted»";
  const legacy = { ...old, text: marker, removedText: "Earlier stored detail." };
  database().prepare("UPDATE messages SET text=?, json=? WHERE id=?").run(marker, JSON.stringify(legacy), old.id);
  const reader = new Store(selection);
  const page = { messages: reader.messagesFor(bot.threadId) };
  const owner = wireThread(reader, bot.threadId, page, { ownerOnly: true });
  // redact2-1020 (Sean report, routine thread): an assistant text row that is ONLY the marker reads as Murage's plain line for the owner,
  // never a bare «redacted» bubble; its sibling fields still keep their own words (the point of this test).
  expect(owner.messages.find(row => row.id === old.id)).toMatchObject({ text: REPLY_WITHHELD, removedText: legacy.removedText });
  const shared = wireThread(reader, bot.threadId, page);
  // MAIN-RULING 2026-11-23T00:58:16Z redact-marker ("a marker-only reply renders as the fixed held-back sentence for EVERY reader"): the
  // shared read's text was the marker; its sibling field keeps the shared mask
  expect(shared.messages.find(row => row.id === old.id)).toMatchObject({ text: REPLY_WITHHELD, removedText: marker });
  const credential = "fixture" + "PrivateValue123";
  const unsafe = { ...legacy, removedText: `password: ${credential}`, tool: { name: "A readable label." } };
  const guarded = wireThread(reader, bot.threadId, { message: unsafe }, { ownerOnly: true });
  expect(guarded.message.tool?.name).toBe(marker);
  expect(guarded.message.removedText).not.toContain(credential);
});

// q1023-skillflake: the secret scan read some random host-minted ids (about 1 in 5,000 UUIDs, 1 in 50,000 digests) as secrets, and a hit masks every
// sibling of the card. These values were drawn from random UUIDs and digests the scan flags, so the witness is deterministic.
describe("a skill switch card keeps its words when a host-minted id looks like a secret", () => {
  const flaggedIds = ["67530864-9570-4616-863d-e96b1ee904ff", "fae48247-5717-49fe-8385-c1ee65db5d13", "ba07099c-ffd3-4946-8976-2c9c090ad47f", "ade1659f-f31f-4ac2-8d9e-63d6cb51b7e4", "d8d2540b-3697-4f0b-be71-407d6ebe9bfd"];
  const flaggedDigests = ["ae21fc492ae7350d7581d0a388469385ebfd217e0a53e37741b021c413f9da67", "ead7691fd992a0ad0c137b3fa5b5b794c722dc0f27029c65ccae0309cf7bf552"];
  const cardRow = (id: string, digest: string, patch: Record<string, unknown> = {}) => ({ id: "row", at: 1, role: "bot", kind: "options", card: {
    title: 'Turn off skill "sample-skill"?', subtitle: "Your other bots keep it.", options: ["Turn off", "Deny"], tool: "switch_skill", requestId: id,
    skillRequest: { version: 1, id, requestId: id, botId: id, threadId: id, stagedId: "", action: "turn_off", name: "sample-skill", sha256: digest, verdictHash: digest, createdAt: 1, ...patch } } });
  it.each(flaggedIds.flatMap(id => flaggedDigests.map(digest => [id, digest])))("%s with digest %s", (id, digest) => {
    const shown = sanitizeBotDisplayMessage(cardRow(id, digest), { authorship: "bot" }) as any;
    expect(shown.card).toMatchObject({ title: 'Turn off skill "sample-skill"?', skillRequest: { action: "turn_off", name: "sample-skill", botId: id, threadId: id, sha256: digest, verdictHash: digest } });
  });
  it("an id field that is not exactly an id is still scanned and still masks the card", () => {
    const credential = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
    const shown = sanitizeBotDisplayMessage(cardRow(flaggedIds[0], flaggedDigests[0], { botId: credential }), { authorship: "bot" }) as any;
    expect(JSON.stringify(shown)).not.toContain(credential);
    expect(shown.card.skillRequest.name).toBe("«redacted»");
  });
});
