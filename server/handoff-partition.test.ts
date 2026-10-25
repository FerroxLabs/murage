// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A partitioned bot reading a project page sees the words of a linked row (copyOf, handoffOf or handoffFrom) only when every source of its whole
// chain is in the bot's partition; a link that does not resolve, or crosses the partition, leaves the row out (no words, no id). The owner's
// own page keeps showing everything. Real Store, real partition resolver, real messages table.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import type { Message } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { OWNER_PAGE, readProjectMessages } from "./project-memory-tools.ts";
import { linkedRowShown, partitionSourcesVerdict } from "./partition-sources.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), sam = make("Sam", "Sales");
  const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  iris.partitionedAt = 1; iris.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }, { id: support, name: "Support" }] };
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const project = store.createGroup("Launch", [iris.id, sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(project.id);
  const desk = store.ensureProjectDesk(iris.id, project.id, "Launch")!;
  const samDesk = store.ensureProjectDesk(sam.id, project.id, "Launch")!;
  reconcileMemoryRoster(store);
  database().exec("UPDATE memory_meta SET mode='active'");
  const say = (threadId: string, text: string, extra: Record<string, unknown> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, ...extra } as Omit<Message, "id" | "at">);
  const asIris = () => readProjectMessages(database(), store, project.id, { limit: 50 }, { botId: iris.id, threadId: desk.threadId });
  const asOwner = () => readProjectMessages(database(), store, project.id, { limit: 50 }, OWNER_PAGE);
  return { store, iris, sam, work, project, desk, samDesk, say, asIris, asOwner };
}
type Page = { messages: Array<{ id: string; text: string }> };
const words = (result: { status: number; body: unknown }) => { expect(result.status).toBe(200); return JSON.stringify(result.body); };
const ids = (result: { body: unknown }) => (result.body as Page).messages.map(line => line.id);

it("a hand-off saved with only handoffFrom, from a conversation in another partition, shows no words and no id on the project page", () => {
  const f = fixture();
  const row = f.say(f.project.threadId, "HANDOFF_FROM_CANARY", { handoffFrom: f.iris.threadId });
  f.say(f.project.threadId, "plain project line");
  const page = f.asIris();
  expect(words(page)).not.toContain("HANDOFF_FROM_CANARY");
  expect(ids(page)).not.toContain(row.id);
  expect(words(page)).toContain("plain project line");
  // another bot's own conversation is outside the partition as well, and so is a conversation nobody knows
  const fromSam = f.say(f.project.threadId, "HANDOFF_FROM_SAM_CANARY", { handoffFrom: f.sam.threadId });
  const fromNowhere = f.say(f.project.threadId, "HANDOFF_FROM_UNKNOWN_CANARY", { handoffFrom: "no-such-thread" });
  expect(words(f.asIris())).not.toMatch(/HANDOFF_FROM_(SAM|UNKNOWN)_CANARY/);
  expect(ids(f.asIris())).not.toContain(fromSam.id); expect(ids(f.asIris())).not.toContain(fromNowhere.id);
});

it("a handoffFrom that is not a conversation id is left out", () => {
  const f = fixture();
  for (const bad of [42, { threadId: f.desk.threadId }, "", null]) f.say(f.project.threadId, "HANDOFF_FROM_MALFORMED_CANARY", { handoffFrom: bad });
  expect(words(f.asIris())).not.toContain("HANDOFF_FROM_MALFORMED_CANARY");
});

it("a hand-off by handoffOf whose source is in another partition, or is not stored, is left out", () => {
  const f = fixture();
  const source = f.say(f.iris.threadId, "HOME_SOURCE");
  const handed = f.say(f.project.threadId, "HANDOFF_OF_CANARY", { handoffOf: { threadId: f.iris.threadId, messageId: source.id } });
  const missing = f.say(f.project.threadId, "HANDOFF_OF_MISSING_CANARY", { handoffOf: { threadId: f.desk.threadId, messageId: "never-stored" } });
  f.say(f.project.threadId, "HANDOFF_OF_MALFORMED_CANARY", { handoffOf: { threadId: f.desk.threadId } });
  const page = f.asIris();
  expect(words(page)).not.toMatch(/HANDOFF_OF_(MISSING_|MALFORMED_)?CANARY|HOME_SOURCE/);
  expect(ids(page)).not.toContain(handed.id); expect(ids(page)).not.toContain(missing.id);
});

it("a copy whose original is in another partition is left out (unchanged)", () => {
  const f = fixture();
  const source = f.say(f.iris.threadId, "COPY_HOME_SOURCE");
  f.say(f.project.threadId, "COPY_OF_CANARY", { copyOf: { threadId: f.iris.threadId, messageIds: [source.id] } });
  expect(words(f.asIris())).not.toContain("COPY_OF_CANARY");
});

it("mixed chains: a copy of a handoffFrom-only row, a copy of a handoffOf row, and a handoffOf onto a copy are left out", () => {
  const f = fixture();
  const fromOnly = f.say(f.desk.threadId, "MIX_FROM_ONLY", { handoffFrom: f.iris.threadId });
  f.say(f.project.threadId, "MIX_COPY_OF_FROM_CANARY", { copyOf: { threadId: f.desk.threadId, messageIds: [fromOnly.id] } });
  const home = f.say(f.iris.threadId, "MIX_HOME");
  const handed = f.say(f.samDesk.threadId, "MIX_HANDED", { handoffOf: { threadId: f.iris.threadId, messageId: home.id } });
  f.say(f.project.threadId, "MIX_COPY_OF_HANDOFF_CANARY", { copyOf: { threadId: f.samDesk.threadId, messageIds: [handed.id] } });
  const copy = f.say(f.samDesk.threadId, "MIX_COPY", { copyOf: { threadId: f.iris.threadId, messageIds: [home.id] } });
  f.say(f.project.threadId, "MIX_HANDOFF_OF_COPY_CANARY", { handoffOf: { threadId: f.samDesk.threadId, messageId: copy.id } });
  // a hand-off whose handoffOf resolves in the partition but whose handoffFrom does not: every link must resolve
  const inside = f.say(f.samDesk.threadId, "MIX_INSIDE");
  f.say(f.project.threadId, "MIX_BOTH_LINKS_CANARY", { handoffOf: { threadId: f.samDesk.threadId, messageId: inside.id }, handoffFrom: f.iris.threadId });
  const text = words(f.asIris());
  expect(text).not.toMatch(/MIX_[A-Z_]*CANARY/);
  expect(partitionSourcesVerdict(database(), f.iris.id, f.desk.threadId, [fromOnly.id])).toBe("withheld");
});

it("a hand-off whose whole chain stays in the partition still shows its words", () => {
  const f = fixture();
  const ask = f.say(f.samDesk.threadId, "INSIDE_ASK");
  f.say(f.project.threadId, "INSIDE_HANDOFF_WORDS", { handoffFrom: f.samDesk.threadId, handoffOf: { threadId: f.samDesk.threadId, messageId: ask.id } });
  f.say(f.project.threadId, "INSIDE_FROM_ONLY_WORDS", { handoffFrom: f.desk.threadId });
  const text = words(f.asIris());
  expect(text).toContain("INSIDE_HANDOFF_WORDS");
  expect(text).toContain("INSIDE_FROM_ONLY_WORDS");
});

it("the owner's own page still shows every line, linked or not", () => {
  const f = fixture();
  const home = f.say(f.iris.threadId, "OWNER_HOME");
  f.say(f.project.threadId, "OWNER_FROM_ONLY", { handoffFrom: f.iris.threadId });
  f.say(f.project.threadId, "OWNER_HANDOFF_OF", { handoffOf: { threadId: f.iris.threadId, messageId: home.id } });
  f.say(f.project.threadId, "OWNER_PLAIN");
  const text = words(f.asOwner());
  for (const canary of ["OWNER_FROM_ONLY", "OWNER_HANDOFF_OF", "OWNER_PLAIN"]) expect(text).toContain(canary);
});

it("an unpartitioned bot is not judged by partition (unchanged)", () => {
  const f = fixture();
  expect(partitionSourcesVerdict(database(), f.sam.id, f.samDesk.threadId, [f.say(f.project.threadId, "x", { handoffFrom: f.iris.threadId }).id])).toBe("shown");
});

it("a member's room prompt judges linked rows the same way (Grok handoff-partition r1 High)", () => {
  const f = fixture();
  const fromOnly = f.say(f.project.threadId, "ROOM_FROM_ONLY", { handoffFrom: f.iris.threadId });
  const plain = f.say(f.project.threadId, "ROOM_PLAIN");
  const ask = f.say(f.samDesk.threadId, "ROOM_ASK");
  const inside = f.say(f.project.threadId, "ROOM_INSIDE", { handoffFrom: f.samDesk.threadId, handoffOf: { threadId: f.samDesk.threadId, messageId: ask.id } });
  expect(linkedRowShown(database(), f.iris.id, f.project.threadId, fromOnly)).toBe(false);
  expect(linkedRowShown(database(), f.iris.id, f.project.threadId, plain)).toBe(true);
  expect(linkedRowShown(database(), f.iris.id, f.project.threadId, inside)).toBe(true);
  // a row not stored does not resolve
  expect(linkedRowShown(database(), f.iris.id, f.project.threadId, { id: "never-stored", handoffFrom: f.desk.threadId })).toBe(false);
  // the room prompt applies it to every window row and pin, and to a quoted older line, for a bot reader
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const room = index.slice(index.indexOf("function renderRoomContext("), index.indexOf("const window = roomContextMessages(messages", index.indexOf("function renderRoomContext(")));
  expect(room).toMatch(/\.\.\.judged\.window\]\s*\.filter\(row => linkedRowShown\(database\(\), botId, threadId, row\)\)/);
  expect(room).toMatch(/quoted && linkedRowShown\(database\(\), botId, threadId, quoted\)/);
});

it("result egress judges the carrier row, so a hand-off link beside an in-partition copy is judged (Grok handoff-partition r1 Medium)", () => {
  const f = fixture();
  const inside = f.say(f.desk.threadId, "EGRESS_INSIDE");
  const carrier = f.say(f.desk.threadId, "EGRESS_CARRIER", { copyOf: { threadId: f.desk.threadId, messageIds: [inside.id] }, handoffFrom: f.iris.threadId });
  expect(partitionSourcesVerdict(database(), f.iris.id, f.desk.threadId, [inside.id])).toBe("shown");
  expect(partitionSourcesVerdict(database(), f.iris.id, f.desk.threadId, [carrier.id])).toBe("withheld");
  const egress = readFileSync(join(import.meta.dirname, "result-egress.ts"), "utf8");
  expect(egress).toContain("deps.partitionAllowed(worker, threadId, [message.id])");
  expect(egress).not.toContain("message.copyOf?.messageIds ?? [message.id]");
});

it("a shown line never names a withheld hand-off by its id in re (Grok handoff-partition r2 Low)", () => {
  const f = fixture();
  const hidden = f.say(f.project.threadId, "RE_HIDDEN", { handoffFrom: f.iris.threadId });
  const shown = f.say(f.project.threadId, "RE_REPLY", { replyToId: hidden.id });
  const page = f.asIris();
  expect(words(page)).toContain("RE_REPLY");
  expect(words(page)).not.toContain(hidden.id);
  const ask = f.say(f.project.threadId, "RE_PLAIN_ASK");
  f.say(f.project.threadId, "RE_PLAIN_REPLY", { replyToId: ask.id });
  expect((f.asIris().body as { messages: Array<{ text: string; re?: string }> }).messages.find(line => line.text === "RE_PLAIN_REPLY")?.re).toBe(ask.id);
  expect(JSON.stringify(f.asOwner().body)).toContain(hidden.id);
  expect(shown.id).toBeTruthy();
});
