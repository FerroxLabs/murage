import { appendFixtureMessage } from './testing/approval-card.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E round 2 (ui-review-r2/REPORT.md, P1): the page a client gets depends
// on what it says it can fold. A 1.0.2 renderer takes open request cards beside
// its page; a 1.0.1 renderer, the phone and the companion never read that field
// and are sent every open card inside their page, as they always were.

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
  expect(sanitizeBotDisplayMessage(huge, { authorship: "bot" })).toMatchObject({ id: "row", text: "«redacted»" });
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
  const row = { id: "host-question", at: 1, role: "bot", kind: "options", card: { title: "x".repeat(300_000), subtitle: "SIBLINGSECRET", requestId: "private-provider-id", answered: "", expired: true, questions: [{ id: "private-question-id", question: "SIBLINGSECRET", options: [{ label: "private label" }], allowOther: true, secret: true }] } };
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
