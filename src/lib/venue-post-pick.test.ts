// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 section 6: the composer's Post in… pick, the send body on both client paths, and the room note.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { venuePostBody } from "../state/send-delivery";
import { venuePostNote, VENUE_POST_NOTE_GONE } from "./venue-post-note";
import { parsePostableVenues, postableVenuesPath, postInOffered, postInTooltip, postPickFields } from "./venue-post-pick";

it("greyed while the bot works, with the tooltip naming the bot", () => {
  expect(postInTooltip("Sable", true)).toBe("Available when Sable finishes");
  expect(postInTooltip("Sable", false)).not.toMatch(/Available when/);
  expect(postInOffered({ bot: true, group: false, locked: false })).toBe(true);
  expect(postInOffered({ bot: true, group: true, locked: false })).toBe(false);
  expect(postInOffered({ bot: true, group: false, locked: true })).toBe(false);
});

it("the pick becomes postTo; only a bot reply is quoted; no pick sends nothing extra", () => {
  expect(postPickFields(null, { id: "m1", fromBot: true })).toEqual({});
  expect(postPickFields({ venueId: "g1", name: "Launch" }, null)).toEqual({ postTo: { venueId: "g1" } });
  expect(postPickFields({ venueId: "g1", name: "Launch" }, { id: "m1", fromBot: true })).toEqual({ postTo: { venueId: "g1" }, quoteMessageId: "m1" });
  expect(postPickFields({ venueId: "g1", name: "Launch" }, { id: "u1", fromBot: false })).toEqual({ postTo: { venueId: "g1" } });
  expect(venuePostBody({})).toEqual({});
  expect(venuePostBody({ postTo: { venueId: "g1" }, quoteMessageId: "m1" })).toEqual({ postTo: { venueId: "g1" }, quoteMessageId: "m1" });
});

it("the pick rides BOTH send paths: the outbox delivery post and the direct post", () => {
  const store = readFileSync(join(import.meta.dirname, "../state/store.tsx"), "utf8");
  expect(store).toMatch(/api\(`\/api\/bots\/\$\{entry\.botId\}\/messages`[\s\S]{0,400}\.\.\.venuePostBody\(entry\)/);
  expect(store).toMatch(/\.\.\.venuePostBody\(action\),\n\s+\.\.\.\(action\.outboxDraft/);
  expect(store).toMatch(/JSON\.stringify\(\{ text: action\.text, replyToId: action\.replyToId, threadId, sendId, \.\.\.venuePostBody\(action\) \}\)/);
  const composer = readFileSync(join(import.meta.dirname, "../components/Composer.tsx"), "utf8");
  expect(composer.match(/\.\.\.pickFields,/g)?.length).toBe(2);
  // the list is its own chunk, loaded when the owner opens it
  expect(composer).toMatch(/retryableLazy\(\(\) => import\("\.\/VenuePostMenu"\)/);
  expect(composer).not.toMatch(/^import .*VenuePostMenu/m);
});

it("the picker reads only well-formed rows from its route", () => {
  expect(postableVenuesPath("b 1", "t1")).toBe("/api/bots/b%201/postable-venues?threadId=t1");
  expect(parsePostableVenues({ venues: [{ venueId: "g1", name: "A" }, { venueId: 2 }, null] })).toEqual([{ venueId: "g1", name: "A" }]);
  expect(parsePostableVenues(null)).toEqual([]);
});

it("venuePostNote names the bot, or says the chat is gone", () => {
  expect(venuePostNote({ botId: "b1", threadId: "t" }, [{ id: "b1", name: "Sable" }])).toBe("Sent from your chat with Sable");
  expect(venuePostNote({ botId: "zz", threadId: "t" }, [{ id: "b1", name: "Sable" }])).toBe(VENUE_POST_NOTE_GONE);
});
