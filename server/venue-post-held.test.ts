// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 step 4, gate tier: T35 (the held card's one transaction and boot recovery), the card copy, Stop, the engine rows (T36
// Cursor env) and the room's context line. Fails on base (no venue-post-held.ts, no venue_post row in OWN_HANDLER_CARDED).
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { OWN_HANDLER_CARDED, isOwnHandlerCarded } from "../shared/own-servers.ts";
import { cursorOwnReadAllow } from "./drivers/acp/cursor.ts";
import { GATE_UNASKED } from "./drivers/pi-permission-gate.ts";
import { answerHeldVenuePost, type HeldAnswerHost } from "./venue-post.ts";
import {
  heldVenuePost, holdVenuePost, initializeVenuePosts, isVenuePostRequestId, moveVenuePost, recoverVenuePosts, stopHeldVenuePosts,
  venuePostCardTitle, venuePostDoneLine, venuePostPreview, venuePostRequestId, VENUE_POST_CARD_POST, VENUE_POST_CARD_SKIP, VENUE_POST_NOT_POSTED,
} from "./venue-post-held.ts";

const seed = (db: DatabaseSync, id = "vpost-a") => holdVenuePost(db, {
  id, botId: "b1", threadId: "t-1to1", origin: "desktop", requestMessageId: "m1", requestHash: "h", venueId: "g1",
  targetThreadId: "t-room", text: "Hello room", stableId: id, lineage: "[]",
});
const tx = (db: DatabaseSync) => <T,>(operation: (inner: DatabaseSync) => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try { const out = operation(db); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
};
const host = (db: DatabaseSync, over: Partial<HeldAnswerHost> = {}): HeldAnswerHost => ({
  transaction: tx(db), roster: () => ({ bots: [], groups: [] }), message: () => null, lineExists: () => false,
  append: () => { throw new Error("no append in this test"); }, ...over,
});

it("T35: a held row is written once; a repeat call returns the same row", () => {
  const db = new DatabaseSync(":memory:");
  expect(seed(db).created).toBe(true);
  expect(seed(db).created).toBe(false);
  expect(heldVenuePost(db, "vpost-a")?.state).toBe("held");
});

it("T35: a throw inside Post it rolls the claim back to held, and no line is written", () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  let appended = 0;
  expect(() => answerHeldVenuePost(host(db, { roster: () => { throw new Error("cut"); }, append: () => { appended++; throw new Error("x"); } }), "vpost-a", "post")).toThrow("cut");
  expect(heldVenuePost(db, "vpost-a")?.state).toBe("held");
  expect(appended).toBe(0);
});

it("T35: a failed re-check (bot gone) ends unavailable, never posts; a second answer returns the final state", () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  expect(answerHeldVenuePost(host(db), "vpost-a", "post")?.state).toBe("unavailable");
  expect(answerHeldVenuePost(host(db), "vpost-a", "skip")?.state).toBe("unavailable");
});

it("T35: Don't post ends declined", () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  expect(answerHeldVenuePost(host(db), "vpost-a", "skip")?.state).toBe("declined");
  expect(heldVenuePost(db, "vpost-a")?.state).toBe("declined");
});

it("T35 boot: posting with its line on the target -> posted; without -> held; no duplicate line", () => {
  const db = new DatabaseSync(":memory:");
  seed(db, "vpost-a"); seed(db, "vpost-b");
  moveVenuePost(db, "vpost-a", "held", "posting"); moveVenuePost(db, "vpost-b", "held", "posting");
  const moved = recoverVenuePosts(db, (target, stableId) => target === "t-room" && stableId === "vpost-a");
  expect(moved.map(row => [row.id, row.state])).toEqual([["vpost-a", "posted"], ["vpost-b", "held"]]);
  expect(recoverVenuePosts(db, () => true)).toEqual([]);
});

it("Stop ends the conversation's held posts only", () => {
  const db = new DatabaseSync(":memory:");
  seed(db, "vpost-a"); seed(db, "vpost-b"); moveVenuePost(db, "vpost-b", "held", "declined");
  expect(stopHeldVenuePosts(db, "t-1to1").map(row => row.id)).toEqual(["vpost-a"]);
  expect(heldVenuePost(db, "vpost-a")?.state).toBe("stopped");
  initializeVenuePosts(db);
});

it("card copy (MurageMain 11-04): title, 280-char preview, buttons, settled lines; request ids", () => {
  expect(venuePostCardTitle("Sable", "Launch")).toBe("Sable wants to post in Launch");
  expect(venuePostPreview("x".repeat(300))).toBe(`${"x".repeat(280)}…`);
  expect(venuePostPreview("short")).toBe("short");
  expect([VENUE_POST_CARD_POST, VENUE_POST_CARD_SKIP]).toEqual(["Post it", "Don't post"]);
  expect(venuePostDoneLine("Launch")).toBe("Posted in Launch");
  expect(VENUE_POST_NOT_POSTED).toBe("Not posted");
  expect(isVenuePostRequestId(venuePostRequestId("vpost-a"))).toBe(true);
  expect(isVenuePostRequestId("email-x")).toBe(false);
});

it("T36: venue_post is handler-carded and unasked on every engine, and Cursor allows it only on a turn that mounts it", () => {
  expect(OWN_HANDLER_CARDED.find(row => row.tool === "venue_post")?.mountEnv).toBe("MURAGE_VENUE_POST");
  expect(isOwnHandlerCarded("own:agents", "venue_post")).toBe(true);
  expect(GATE_UNASKED.find(([mount]) => mount === "own:agents")?.[1]).toContain("venue_post");
  const allow = (env: Record<string, string>) => cursorOwnReadAllow({ integrations: { agents: { serverName: "murage-agents", env } } } as never);
  expect(allow({ MURAGE_VENUE_POST: "1" })).toContain("Mcp(murage-agents:venue_post)");
  expect(allow({})).not.toContain("Mcp(murage-agents:venue_post)");
  expect(allow({ MURAGE_EMAIL_TOOLS: "send" }).some(entry => entry.endsWith(":venue_post)"))).toBe(false);
});
