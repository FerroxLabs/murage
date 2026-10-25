// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All chats, slice 1, end to end against the real harness: GET /api/chats pages the owner's chats from the records, and
// GET /api/search?view=chats never returns a line the owner forgot, while the owner's plain search is answered as before.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, desktopApi, phoneApi, home } from "./testing/index-harness.ts";

const writeDb = () => {
  const db = new DatabaseSync(join(home, ".murage", "messages.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
};

describe("GET /api/chats", () => {
  it("lists the owner's chats newest first with paging and filters, archived ones only under their filter", async () => {
    const ember = (await desktopApi("POST", "/api/bots")).body.bot;
    const sage = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const extra = await desktopApi("POST", `/api/bots/${ember.id}/tasks`, { title: "Austin lease renewal" });
      expect(extra.status).toBe(201);
      const all = await desktopApi("GET", "/api/chats?limit=200");
      expect(all.status).toBe(200);
      const threads = [...all.body.chats, ...(all.body.pinned ?? [])].map((row: { threadId: string }) => row.threadId);
      expect(threads).toEqual(expect.arrayContaining([ember.threadId, sage.threadId, extra.body.task.threadId]));
      // no transcript on the wire: titles, times and marks only
      for (const row of all.body.chats) expect(Object.keys(row).every((key) => ["threadId", "title", "createdAt", "lastActivityAt", "botId", "groupId", "place", "pinned", "unread", "archived", "routine"].includes(key))).toBe(true);

      const mine = await desktopApi("GET", `/api/chats?bot=${ember.id}`);
      expect(mine.body.chats.every((row: { botId?: string }) => row.botId === ember.id)).toBe(true);
      expect(mine.body.total).toBe(2);
      const phone = await phoneApi("GET", `/api/chats?bot=${ember.id}`);
      expect(phone.status).toBe(200);
      expect(phone.body.total).toBe(2);
      const titled = await desktopApi("GET", `/api/chats?bot=${ember.id}&q=lease`);
      expect(titled.body.chats.map((row: { title: string }) => row.title)).toEqual(["Austin lease renewal"]);

      const first = await desktopApi("GET", `/api/chats?bot=${ember.id}&limit=1`);
      expect(first.body.chats).toHaveLength(1);
      expect(first.body.next).toEqual(expect.any(String));
      const second = await desktopApi("GET", `/api/chats?bot=${ember.id}&limit=1&before=${encodeURIComponent(first.body.next)}`);
      expect(second.body.chats).toHaveLength(1);
      expect(second.body.chats[0].threadId).not.toBe(first.body.chats[0].threadId);
      expect((await desktopApi("GET", "/api/chats?before=nope")).status).toBe(400);
      expect((await desktopApi("GET", "/api/chats?limit=0")).status).toBe(400);

      expect((await desktopApi("PATCH", `/api/bots/${sage.id}`, { hidden: true })).status).toBe(200);
      const after = await desktopApi("GET", "/api/chats?limit=200");
      expect([...after.body.chats, ...(after.body.pinned ?? [])].some((row: { threadId: string }) => row.threadId === sage.threadId)).toBe(false);
      const archived = await desktopApi("GET", "/api/chats?archived=1&limit=200");
      expect(archived.body.chats.find((row: { threadId: string }) => row.threadId === sage.threadId)).toMatchObject({ archived: true, botId: sage.id });
      expect((await phoneApi("GET", "/api/chats?archived=1")).body.chats).toEqual([]);
    } finally {
      await desktopApi("DELETE", `/api/bots/${ember.id}`);
      await desktopApi("DELETE", `/api/bots/${sage.id}`);
    }
  });

  it("is not answered to a door, which gets the unknown-route answer rather than a list", async () => {
    const door = await api("GET", "/api/chats");
    expect(door.status).toBeGreaterThanOrEqual(400);
    expect(door.body.chats).toBeUndefined();
  });
});

describe("GET /api/search?view=chats", () => {
  it("leaves out a line the owner forgot, for the owner too, and changes nothing without the option", async () => {
    // One bot per line: a second message to a bot that is still answering the first waits in its queue and is not in the
    // transcript yet, so each line goes to its own bot and is written at once.
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const forgetBot = (await desktopApi("POST", "/api/bots")).body.bot;
    const sourceBot = (await desktopApi("POST", "/api/bots")).body.bot;
    const bots = [bot, forgetBot, sourceBot];
    try {
      const needle = "zephyr lease clause";
      const lines = [`${needle} kept`, `${needle} to forget`, `${needle} source forgotten`];
      for (const [i, text] of lines.entries()) {
        expect((await desktopApi("POST", `/api/bots/${bots[i].id}/messages`, { text })).status).toBe(202);
      }
      const plain = `/api/search?q=${encodeURIComponent(needle)}&limit=40`;
      await expect.poll(async () => (await desktopApi("GET", plain)).body.hits.filter((hit: { role: string }) => hit.role === "user").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      // the owner's own lines (a fixture engine's reply may quote them; those are other rows)
      const hits: Array<{ messageId: string; snippet: string; role: string }> = (await desktopApi("GET", plain)).body.hits;
      const stamped = hits.find((hit) => hit.role === "user" && hit.snippet.includes("to forget"))!;
      const tombstoned = hits.find((hit) => hit.role === "user" && hit.snippet.includes("source forgotten"))!;
      expect(stamped && tombstoned).toBeTruthy();

      const db = writeDb();
      try {
        db.prepare("UPDATE messages SET json = json_set(json, '$.withheldFromBots', 'forgotten') WHERE thread_id = ? AND id = ?").run(forgetBot.threadId, stamped.messageId);
        db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,NULL,NULL,1,'owner-forget',1)")
          .run(`chats-test-${tombstoned.messageId}`, "source", `message:${sourceBot.threadId}:${tombstoned.messageId}`);
      } finally {
        db.close();
      }

      const chats = await desktopApi("GET", `${plain}&view=chats`);
      expect(chats.status).toBe(200);
      const shown = chats.body.hits.map((hit: { messageId: string }) => hit.messageId);
      expect(shown).not.toContain(stamped.messageId);
      expect(shown).not.toContain(tombstoned.messageId);
      const owners = chats.body.hits.filter((hit: { role: string }) => hit.role === "user");
      expect(owners.some((hit: { snippet: string }) => hit.snippet.includes("kept"))).toBe(true);
      // no owner line the view shows is one that was forgotten
      expect(owners.every((hit: { snippet: string }) => !hit.snippet.includes("to forget") && !hit.snippet.includes("source forgotten"))).toBe(true);
      const phone = await phoneApi("GET", `${plain}&view=chats&bot=${bot.id}`);
      expect(phone.status).toBe(200);
      expect(phone.body.hits.some((hit: { snippet: string }) => hit.snippet.includes("kept"))).toBe(true);
      expect(phone.body.hits.map((hit: { messageId: string }) => hit.messageId)).not.toContain(stamped.messageId);
      expect(phone.body.hits.map((hit: { messageId: string }) => hit.messageId)).not.toContain(tombstoned.messageId);

      // Filtering happens before LIMIT, not against the client's incomplete task window.
      expect((await desktopApi("GET", `${plain}&view=chats&bot=missing`)).body.hits).toEqual([]);
      expect((await desktopApi("GET", `${plain}&view=chats&pinned=1`)).body.hits).toEqual([]);
      await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { pinned: true });
      const pinned = await desktopApi("GET", `${plain}&view=chats&pinned=1&bot=${bot.id}&limit=1`);
      expect(pinned.body.hits).toHaveLength(1);
      expect(pinned.body.hits[0].threadId).toBe(bot.threadId);
      expect((await api("GET", `${plain}&view=chats`)).status).toBe(404);
      const refusedExisting = await api("GET", `${plain}&view=chats&threadId=${bot.threadId}`);
      const refusedMissing = await api("GET", `${plain}&view=chats&threadId=missing`);
      expect(refusedExisting).toEqual(refusedMissing);
      expect(refusedExisting).toEqual({ status: 404, body: { error: "no such route" } });

      // the owner's plain search, and every other caller of the route, is answered as before
      const again = (await desktopApi("GET", plain)).body.hits.map((hit: { messageId: string }) => hit.messageId);
      expect(again).toEqual(expect.arrayContaining([stamped.messageId, tombstoned.messageId]));
      for (const each of bots) await desktopApi("PATCH", `/api/bots/${each.id}`, { hidden: true });
      expect((await desktopApi("GET", `${plain}&view=chats`)).body.hits).toEqual([]);
      expect((await desktopApi("GET", `${plain}&view=chats&archived=1`)).body.hits.length).toBeGreaterThan(0);
      // a deleted conversation's rows are dropped with it: message-search-forgotten.test.ts ("does not return deleted conversations");
      // here a fixture turn may still hold the bot, which the delete refuses
    } finally {
      for (const each of bots) await desktopApi("DELETE", `/api/bots/${each.id}`);
    }
  });
});
