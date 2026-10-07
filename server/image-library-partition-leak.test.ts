// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Saved prompt blocks and reference packs of a partitioned bot (SPEC-X I4):
// one partition's library never reaches another, in either direction; the
// owner's workspace items ride every partition; an unpartitioned bot keeps
// today's single library.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { imageLibraryKey, markPartitions } from "./execution-audience.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deletePromptBlock, deleteReferencePack, getPromptBlock, imageLibraryBotId, promptBlockById, imageLibraryKeyInUse, listPromptBlocksForBot, listReferencePacksForBot, resolvePromptBlocks, resolveReferencePack, savePromptBlock, saveReferencePack,
} from "./image-library.ts";

const PNG_HOME = { bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), mime: "image/png" as const };
const PNG_SALES = { bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"), mime: "image/png" as const };

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), carl = make("Carl", "Design"), sam = make("Sam", "Sales");
  const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  iris.partitionedAt = 1; iris.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }, { id: support, name: "Support" }] };
  const work = store.createSharedWorkTask(iris.id, sales)!, other = store.createSharedWorkTask(iris.id, support)!;
  const room = store.createGroup("CANARY_GENERAL_ROOM_NAME", [iris.id, carl.id, sam.id], false, "");
  const db = database();
  // What the internal routes do: the calling turn's library, then the actor.
  const actor = (botId: string, threadId: string) => ({ kind: "bot" as const, botId: imageLibraryKey(botId, threadId) });
  return { store, iris, carl, sam, work, other, room, db, actor };
}
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };

it("a home block never reaches the bot's work for another team, and a team's block never comes home", () => {
  const f = fixture(), home = f.actor(f.iris.id, f.iris.threadId), sales = f.actor(f.iris.id, f.work.threadId), support = f.actor(f.iris.id, f.other.threadId);
  savePromptBlock(f.db, { scope: "bot", botId: home.botId, name: "brand-lock", text: "CANARY_HOME_BLOCK", createdBy: `bot:${f.iris.id}` });
  savePromptBlock(f.db, { scope: "bot", botId: sales.botId, name: "sales-lock", text: "CANARY_SALES_BLOCK", createdBy: `bot:${f.iris.id}` });
  // list
  expect(JSON.stringify(listPromptBlocksForBot(f.db, sales.botId))).not.toContain("brand-lock");
  expect(JSON.stringify(listPromptBlocksForBot(f.db, home.botId))).not.toContain("sales-lock");
  expect(JSON.stringify(listPromptBlocksForBot(f.db, support.botId))).not.toMatch(/brand-lock|sales-lock/);
  // get
  expect(refusal(() => getPromptBlock(f.db, sales, "brand-lock"))).toContain("No saved prompt block is named brand-lock");
  expect(refusal(() => getPromptBlock(f.db, home, "sales-lock"))).toContain("No saved prompt block is named sales-lock");
  expect(refusal(() => getPromptBlock(f.db, support, "sales-lock"))).toContain("No saved prompt block is named sales-lock");
  // resolve (what generate_image sends)
  expect(refusal(() => resolvePromptBlocks(f.db, sales, ["brand-lock"]))).not.toContain("CANARY");
  expect(resolvePromptBlocks(f.db, sales, ["sales-lock"]).map(block => block.text)).toEqual(["CANARY_SALES_BLOCK"]);
  expect(getPromptBlock(f.db, home, "brand-lock").text).toBe("CANARY_HOME_BLOCK");
});

it("one name in two partitions is two blocks, versioned and deduplicated apart", () => {
  const f = fixture(), home = f.actor(f.iris.id, f.iris.threadId), sales = f.actor(f.iris.id, f.work.threadId);
  expect(savePromptBlock(f.db, { scope: "bot", botId: home.botId, name: "lock", text: "CANARY_HOME", createdBy: "bot" })).toMatchObject({ version: 1, created: true });
  // The same text in the team's library is its own first version, not a link to home's.
  expect(savePromptBlock(f.db, { scope: "bot", botId: sales.botId, name: "lock", text: "CANARY_HOME", createdBy: "bot" })).toMatchObject({ version: 1, created: true });
  expect(savePromptBlock(f.db, { scope: "bot", botId: sales.botId, name: "lock", text: "CANARY_SALES", createdBy: "bot" })).toMatchObject({ version: 2 });
  expect(getPromptBlock(f.db, home, "lock")).toMatchObject({ version: 1, text: "CANARY_HOME" });
  expect(refusal(() => getPromptBlock(f.db, home, "lock@2"))).toBe("lock has no version 2. Its latest is v1.");
  expect(getPromptBlock(f.db, sales, "lock")).toMatchObject({ version: 2, text: "CANARY_SALES" });
});

it("a pack saved at home cannot be used for another team, and the reverse", () => {
  const f = fixture(), home = f.actor(f.iris.id, f.iris.threadId), sales = f.actor(f.iris.id, f.work.threadId);
  saveReferencePack(f.db, DATA_DIR, { scope: "bot", botId: home.botId, name: "home-pack", references: [PNG_HOME], createdBy: "bot" });
  saveReferencePack(f.db, DATA_DIR, { scope: "bot", botId: sales.botId, name: "sales-pack", references: [PNG_SALES], createdBy: "bot" });
  expect(listReferencePacksForBot(f.db, sales.botId).map(pack => pack.name)).toEqual(["sales-pack"]);
  expect(listReferencePacksForBot(f.db, home.botId).map(pack => pack.name)).toEqual(["home-pack"]);
  expect(refusal(() => resolveReferencePack(f.db, DATA_DIR, sales, "home-pack"))).toContain("No saved reference pack is named home-pack");
  expect(refusal(() => resolveReferencePack(f.db, DATA_DIR, home, "sales-pack"))).toContain("No saved reference pack is named sales-pack");
  expect(resolveReferencePack(f.db, DATA_DIR, sales, "sales-pack").references[0]!.bytes.equals(PNG_SALES.bytes)).toBe(true);
});

it("a marked room is its own partition too, before and after its marker is written", () => {
  const f = fixture(), roomThread = f.room.threadId, room = f.actor(f.iris.id, roomThread), home = f.actor(f.iris.id, f.iris.threadId);
  markPartitions(f.store);
  expect(f.room.partitionedFor?.[f.iris.id]).toBeDefined();
  expect(f.actor(f.iris.id, roomThread).botId).toBe(room.botId);
  expect(room.botId).not.toBe(home.botId);
  savePromptBlock(f.db, { scope: "bot", botId: room.botId, name: "room-lock", text: "CANARY_ROOM", createdBy: "bot" });
  expect(refusal(() => getPromptBlock(f.db, home, "room-lock"))).toContain("No saved prompt block is named room-lock");
});

it("the owner's workspace items ride every partition", () => {
  const f = fixture();
  savePromptBlock(f.db, { scope: "workspace", name: "house-style", text: "OWNER_STYLE", createdBy: "owner" });
  saveReferencePack(f.db, DATA_DIR, { scope: "workspace", name: "owner-pack", references: [PNG_HOME], createdBy: "owner" });
  for (const threadId of [f.iris.threadId, f.work.threadId, f.other.threadId, f.room.threadId]) {
    const actor = f.actor(f.iris.id, threadId);
    expect(getPromptBlock(f.db, actor, "house-style").text).toBe("OWNER_STYLE");
    expect(resolveReferencePack(f.db, DATA_DIR, actor, "owner-pack").references).toHaveLength(1);
  }
});

it("an unpartitioned bot keeps one library, as before, in every conversation", () => {
  const f = fixture(), room = f.store.createGroup("Design room", [f.carl.id], false, "Design");
  expect(f.actor(f.carl.id, room.threadId).botId).toBe(f.carl.id);
  expect(f.actor(f.carl.id, f.carl.threadId).botId).toBe(f.carl.id);
  expect(f.actor(f.iris.id, f.iris.threadId).botId).toBe(f.iris.id);
  // Unpartitioned Carl in a room that mixes teams keeps his one library (DX6).
  expect(f.actor(f.carl.id, f.room.threadId).botId).toBe(f.carl.id);
});

it("the owner can add a version only to a partition library that exists", () => {
  const f = fixture(), sales = f.actor(f.iris.id, f.work.threadId);
  expect(imageLibraryKeyInUse(f.db, sales.botId)).toBe(false);
  savePromptBlock(f.db, { scope: "bot", botId: sales.botId, name: "lock", text: "x", createdBy: "bot" });
  expect(imageLibraryKeyInUse(f.db, sales.botId)).toBe(true);
});

it("every harness route that reads the library asks for the calling turn's key", () => {
  // Wiring check in the 0.1.61 style: the routes build their library actor
  // from the turn's own thread, never from the bot id alone.
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  expect(source).toContain("const actor = { kind: \"bot\" as const, botId: imageLibraryKey(internalClaim.botId, internalClaim.threadId) };");
  expect(source).toContain("const library = { kind: \"bot\" as const, botId: imageLibraryKey(actor.botId, actor.threadId) };");
  expect(source).toContain("resolvePromptBlocks(database(), library, body.promptBlocks ?? [])");
  expect(source).toContain("resolveReferencePack(database(), DATA_DIR, library, body.referencePack)");
  for (const call of source.matchAll(/(?:resolvePromptBlocks|resolveReferencePack|getPromptBlock|listPromptBlocksForBot|listReferencePacksForBot)\(database\(\), ([^,)]+)/g))
    expect(["actor.botId", "actor", "library", "DATA_DIR"]).toContain(call[1]);
});

it("a partition's library still belongs to its bot for the owner", () => {
  const f = fixture(), sales = f.actor(f.iris.id, f.work.threadId);
  expect(sales.botId).not.toBe(f.iris.id);
  expect(imageLibraryBotId(sales.botId)).toBe(f.iris.id);
  expect(imageLibraryBotId(f.iris.id)).toBe(f.iris.id);
});

it("a by-id read, delete or pack delete that names another partition finds nothing, like a missing id", () => {
  const f = fixture(), home = f.actor(f.iris.id, f.iris.threadId), sales = f.actor(f.iris.id, f.work.threadId);
  const salesBlock = savePromptBlock(f.db, { scope: "bot", botId: sales.botId, name: "sales-lock", text: "CANARY_SALES_BLOCK", createdBy: "bot" });
  const homeBlock = savePromptBlock(f.db, { scope: "bot", botId: home.botId, name: "home-lock", text: "CANARY_HOME_BLOCK", createdBy: "bot" });
  const house = savePromptBlock(f.db, { scope: "workspace", name: "house", text: "OWNER_STYLE", createdBy: "owner" });
  const pack = saveReferencePack(f.db, DATA_DIR, { scope: "bot", botId: sales.botId, name: "sales-pack", references: [PNG_SALES], createdBy: "bot" });
  const missing = refusal(() => promptBlockById(f.db, "00000000-0000-0000-0000-000000000000", home.botId));
  // read
  expect(promptBlockById(f.db, salesBlock.id, sales.botId).text).toBe("CANARY_SALES_BLOCK");
  expect(refusal(() => promptBlockById(f.db, salesBlock.id, home.botId))).toBe(missing);
  expect(refusal(() => promptBlockById(f.db, homeBlock.id, sales.botId))).toBe(missing);
  expect(promptBlockById(f.db, house.id, sales.botId).text).toBe("OWNER_STYLE");
  // the owner's unscoped view still reads every id
  expect(promptBlockById(f.db, salesBlock.id).text).toBe("CANARY_SALES_BLOCK");
  // delete
  expect(refusal(() => deletePromptBlock(f.db, salesBlock.id, { scopeKey: home.botId }))).toBe(missing);
  expect(promptBlockById(f.db, salesBlock.id, sales.botId).text).toBe("CANARY_SALES_BLOCK");
  expect(refusal(() => deleteReferencePack(f.db, pack.id, { scopeKey: home.botId }))).toContain("not saved any more");
  expect(deleteReferencePack(f.db, pack.id, { scopeKey: sales.botId }).versions).toBe(1);
  expect(deletePromptBlock(f.db, salesBlock.id, { scopeKey: sales.botId }).versions).toBe(1);
});
