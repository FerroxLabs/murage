// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROOM-ORDER-DESIGN (server lane): every statement the server makes about a room takes the next number of ONE run-wide clock
// (`roomClock`): a `group` frame, a real deletion's `group.deleted` frame, a scoped archive's `group.deleted` frame. A live room
// is numbered from `roomSeqs` (0 before its first statement), a removed one from the removal ledger for the answer life, and the
// DELETE answer carries the deletion's own version. The roster is the horizon: `roomClock`, `removedGroups[]` and `tasksEpoch`
// for the owner's surfaces only. R1: a builder re-reads the registry by id, so a route that awaited after a commit never speaks
// for a room another request deleted meanwhile (Astra r2 H1).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const PHONE_TOKEN = "e".repeat(64);
const posixOnly = describe.skipIf(process.platform === "win32");

// In the server: the step AFTER a conversation deletion's commit (`finish`) can be held once, until a gate file is written.
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const {pathToFileURL}=await import('node:url');
  const dir=process.env.MURAGE_DATA_DIR;const server=${JSON.stringify(SERVER)};
  const {ConversationDeletions}=await import(pathToFileURL(path.join(server,'conversation-deletion.ts')).href);
  const finish=ConversationDeletions.prototype.finish;
  ConversationDeletions.prototype.finish=async function(...args){
    if(fs.existsSync(path.join(dir,'finish-hold'))){
      fs.rmSync(path.join(dir,'finish-hold'));fs.writeFileSync(path.join(dir,'finish-held'),'1');
      while(!fs.existsSync(path.join(dir,'finish-gate')))await new Promise(r=>setTimeout(r,10));
      fs.rmSync(path.join(dir,'finish-gate'));
    }
    return finish.apply(this,args);
  };
`;

posixOnly("the room clock", () => {
  let fixture: VerificationServer;
  let desktop: Record<string, string> = {};
  const phone = { "x-murage-companion": "1", "x-murage-companion-token": PHONE_TOKEN };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as any };
  };
  const flag = (name: string) => writeFileSync(join(fixture.info.dataDir, name), "1");
  const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
  const roster = async (headers = desktop, query = "view=sidebar") => (await call("GET", `/api/bots?${query}`, undefined, headers)).body;
  const newBot = async (name: string) => { const made = await call("POST", "/api/bots", { name }); expect(made.status).toBeLessThan(300); return made.body.bot as { id: string }; };
  const newRoom = async (name: string) => {
    const bot = await newBot(`${name} member`);
    const made = await call("POST", "/api/groups", { name, memberIds: [bot.id] });
    expect(made.status).toBe(201);
    return made.body.group as { id: string; recordSeq: number; recordEpoch: string };
  };

  function openStream(headers: Record<string, string> = desktop) {
    const controller = new AbortController();
    const frames: any[] = [];
    void (async () => {
      try {
        const res = await fetch(`${fixture.info.url}/api/events`, { headers, signal: controller.signal });
        const reader = res.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    return { frames, close: () => controller.abort() };
  }

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, env: { MURAGE_COMPANION_TOKEN: PHONE_TOKEN } });
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret", undefined, {})).body.secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("one clock: statements about different rooms and both frame kinds take strictly increasing numbers; a deletion passes every answer built before it", async () => {
    const stream = openStream();
    await until(() => stream.frames.some((frame) => frame.kind === "hello"));
    const a = await newRoom("Clock A");
    const b = await newRoom("Clock B");
    // a room is numbered from the first request on, and two rooms never share a number
    expect(typeof a.recordSeq).toBe("number");
    expect(b.recordSeq).not.toBe(a.recordSeq);
    const renamed = await call("PATCH", `/api/groups/${a.id}`, { name: "Clock A2" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group.recordSeq).toBeGreaterThan(Math.max(a.recordSeq, b.recordSeq));
    expect(renamed.body.group.recordEpoch).toBe(a.recordEpoch);

    const deleted = await call("DELETE", `/api/groups/${a.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(deleted.body).toMatchObject({ ok: true, recordEpoch: a.recordEpoch });
    expect(deleted.body.alreadyDeleted).toBeUndefined();
    expect(deleted.body.recordSeq).toBeGreaterThan(renamed.body.group.recordSeq);
    await until(() => stream.frames.some((frame) => frame.kind === "group.deleted" && frame.groupId === a.id));
    const frame = stream.frames.find((candidate) => candidate.kind === "group.deleted" && candidate.groupId === a.id);
    expect(frame).toMatchObject({ recordSeq: deleted.body.recordSeq, recordEpoch: a.recordEpoch });
    expect(frame.audience).toBeUndefined();
    // every `group` frame of the run is numbered, and the numbers over all frames and both kinds are distinct and increasing in arrival order
    const numbered = stream.frames.filter((candidate) => (candidate.kind === "group" && candidate.group?.recordSeq !== undefined) || (candidate.kind === "group.deleted" && candidate.recordSeq !== undefined))
      .map((candidate) => candidate.kind === "group" ? candidate.group.recordSeq : candidate.recordSeq);
    expect(numbered.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < numbered.length; i++) expect(numbered[i]).toBeGreaterThan(numbered[i - 1]);
    for (const candidate of stream.frames.filter((f) => f.kind === "group")) expect(typeof candidate.group.recordEpoch).toBe("string");
    stream.close();

    // a retried DELETE learns what happened with the same version; an id the ledger never held is 404 as before
    expect((await call("DELETE", `/api/groups/${a.id}`)).body).toEqual({ ok: true, alreadyDeleted: true, recordSeq: deleted.body.recordSeq, recordEpoch: a.recordEpoch });
    expect((await call("DELETE", "/api/groups/never-existed")).status).toBe(404);
    // the roster is the horizon: the clock covers the deletion, and the removal is listed with its version
    const listed = await roster();
    expect(listed.roomClock).toBeGreaterThanOrEqual(deleted.body.recordSeq);
    expect(listed.tasksEpoch).toBe(a.recordEpoch);
    expect(listed.removedGroups).toContainEqual({ id: a.id, recordSeq: deleted.body.recordSeq, recordEpoch: a.recordEpoch, kind: "deleted" });
    expect(listed.groups.some((row: any) => row.id === a.id)).toBe(false);
    // the surviving room is numbered in the roster, in the sidebar view and the full one
    expect(listed.groups.find((row: any) => row.id === b.id)).toMatchObject({ recordSeq: b.recordSeq, recordEpoch: a.recordEpoch });
    const full = await roster(desktop, "messages=0");
    expect(full.roomClock).toBeGreaterThanOrEqual(deleted.body.recordSeq);
    expect(full.removedGroups).toContainEqual(expect.objectContaining({ id: a.id, kind: "deleted" }));
    expect(full.tasksEpoch).toBe(a.recordEpoch);
  }, 60_000);

  it("a room nobody has stamped yet is numbered 0 (R2); an archive and a restore each take a number of their own", async () => {
    const stream = openStream();
    const remote = openStream(phone);
    await until(() => stream.frames.some((frame) => frame.kind === "hello") && remote.frames.some((frame) => frame.kind === "hello"));
    const room = await newRoom("Archive me");
    const archived = await call("PATCH", `/api/groups/${room.id}`, { hidden: true });
    expect(archived.status).toBe(200);
    // the archive's removal goes to the scoped streams only, numbered after the room's own hidden frame
    await until(() => remote.frames.some((frame) => frame.kind === "group.deleted" && frame.groupId === room.id && frame.audience === "remote"));
    expect(stream.frames.some((frame) => frame.kind === "group.deleted" && frame.groupId === room.id)).toBe(false);
    const hide = remote.frames.find((frame) => frame.kind === "group.deleted" && frame.groupId === room.id);
    const hiddenFrame = stream.frames.filter((frame) => frame.kind === "group" && frame.group.id === room.id).at(-1);
    expect(hiddenFrame.group.hidden).toBe(true);
    expect(hide.recordSeq).toBeGreaterThan(hiddenFrame.group.recordSeq);
    expect(hide.recordEpoch).toBe(room.recordEpoch);
    // the archive's own removal is listed for the phone as a hide, never for the desktop (which keeps the record hidden)
    expect((await roster(phone)).removedGroups).toContainEqual({ id: room.id, recordSeq: hide.recordSeq, recordEpoch: room.recordEpoch, kind: "hidden" });
    expect((await roster()).removedGroups.some((entry: any) => entry.id === room.id)).toBe(false);
    const restored = await call("PATCH", `/api/groups/${room.id}`, { hidden: false });
    expect(restored.status).toBe(200);
    expect(restored.body.group.recordSeq).toBeGreaterThan(hide.recordSeq);
    // the restore clears the hide
    expect((await roster(phone)).removedGroups.some((entry: any) => entry.id === room.id)).toBe(false);
    stream.close();
    remote.close();
  }, 60_000);

  it("the roster extras belong to the owner's surfaces: desktop gets deletions, the owner's phone hides and visible deletions, a script's grant nothing", async () => {
    const seen = await newRoom("Seen by phone");
    const archived = await newRoom("Archived then gone");
    expect((await call("PATCH", `/api/groups/${archived.id}`, { hidden: true })).status).toBe(200);
    const kept = await newBot("Scripted");
    expect((await call("DELETE", `/api/groups/${seen.id}`)).status).toBe(200);
    const gone = await call("DELETE", `/api/groups/${archived.id}`);
    expect(gone.status).toBe(200);

    const desk = await roster();
    expect(desk.removedGroups.every((entry: any) => entry.kind === "deleted")).toBe(true);
    expect(desk.removedGroups.map((entry: any) => entry.id)).toEqual(expect.arrayContaining([seen.id, archived.id]));
    const scoped = await roster(phone);
    expect(scoped.tasksEpoch).toBe(desk.tasksEpoch);
    expect(typeof scoped.roomClock).toBe("number");
    expect(scoped.removedGroups.find((entry: any) => entry.id === seen.id)).toMatchObject({ kind: "deleted", recordEpoch: seen.recordEpoch });
    // the archived room was not visible to the phone when it was deleted (r1-H3): deleting it adds nothing to the phone's list
    expect(scoped.removedGroups.some((entry: any) => entry.id === archived.id && entry.kind === "deleted")).toBe(false);

    const grant = await call("POST", "/api/mcp-grants", { botId: kept.id });
    expect(grant.status).toBe(201);
    for (const query of ["view=sidebar", "messages=0", ""]) {
      const scripted = await call("GET", `/api/bots?${query}`, undefined, { authorization: `Bearer ${grant.body.token}` });
      expect(scripted.status).toBe(200);
      for (const key of ["removedGroups", "roomClock", "removed", "tasksEpoch"]) expect(scripted.body).not.toHaveProperty(key);
    }
  }, 60_000);

  it("r1-H3: the real store.deleteGroup, the real listener and the real ledger list a deleted room for the phone iff it was visible to it", async () => {
    const visible = await newRoom("Visible");
    const hiddenRoom = await newRoom("Hidden");
    expect((await call("PATCH", `/api/groups/${hiddenRoom.id}`, { hidden: true })).status).toBe(200);
    // the phone holds the visible room, not the archived one
    const before = await roster(phone);
    expect(before.groups.some((row: any) => row.id === visible.id)).toBe(true);
    expect(before.groups.some((row: any) => row.id === hiddenRoom.id)).toBe(false);
    for (const room of [visible, hiddenRoom]) expect((await call("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
    const after = (await roster(phone)).removedGroups as Array<{ id: string; kind: string }>;
    expect(after.some((entry) => entry.id === visible.id && entry.kind === "deleted")).toBe(true);
    expect(after.some((entry) => entry.id === hiddenRoom.id && entry.kind === "deleted")).toBe(false);
    // the desktop lists both deletions
    const desk = (await roster()).removedGroups as Array<{ id: string; kind: string }>;
    for (const room of [visible, hiddenRoom]) expect(desk.some((entry) => entry.id === room.id && entry.kind === "deleted")).toBe(true);
  }, 60_000);

  it("R1 (Astra r2 H1): a task delete paused after its commit, then a room delete, then the cleanup resuming: no group frame after group.deleted, and the answer carries the deletion's version", async () => {
    const stream = openStream();
    await until(() => stream.frames.some((frame) => frame.kind === "hello"));
    const room = await newRoom("Race");
    const task = await call("POST", `/api/groups/${room.id}/tasks`, { title: "Second" });
    expect(task.status).toBe(201);
    const threadId = task.body.task.threadId as string;

    flag("finish-hold");
    const taskDelete = call("DELETE", `/api/groups/${room.id}/tasks/${threadId}`);
    await until(() => existsSync(join(fixture.info.dataDir, "finish-held")));
    // the task is gone from the room (the commit happened); the route still holds the record it committed
    const roomDelete = await call("DELETE", `/api/groups/${room.id}`);
    expect(roomDelete.status).toBe(200);
    await until(() => stream.frames.some((frame) => frame.kind === "group.deleted" && frame.groupId === room.id));
    rmSync(join(fixture.info.dataDir, "finish-held"));
    flag("finish-gate");
    const resumed = await taskDelete;
    expect(resumed.status).toBe(200);
    // the retained record is numbered by the ledger with the deletion's own version: a client drops it at its tombstone
    expect(resumed.body.group).toMatchObject({ id: room.id, recordSeq: roomDelete.body.recordSeq, recordEpoch: room.recordEpoch });
    // settle the stream behind a later room's frame, then read what came after the deletion
    const marker = await newRoom("Race marker");
    await until(() => stream.frames.some((frame) => frame.kind === "group" && frame.group?.id === marker.id));
    const deletedAt = stream.frames.findIndex((frame) => frame.kind === "group.deleted" && frame.groupId === room.id);
    expect(deletedAt).toBeGreaterThanOrEqual(0);
    expect(stream.frames.slice(deletedAt + 1).filter((frame) => frame.kind === "group" && frame.group?.id === room.id)).toEqual([]);
    // and the roster lists the room as deleted at exactly that version
    expect((await roster()).removedGroups).toContainEqual({ id: room.id, recordSeq: roomDelete.body.recordSeq, recordEpoch: room.recordEpoch, kind: "deleted" });
    stream.close();
  }, 60_000);

  it("a restart is a new run: a room deleted before it is unnumbered again, and its DELETE is a 404", async () => {
    const room = await newRoom("Before restart");
    expect((await call("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
    await fixture.restart();
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret", undefined, {})).body.secret };
    const after = await roster();
    expect(after.tasksEpoch).not.toBe(room.recordEpoch);
    expect(after.removedGroups).toEqual([]);
    expect((await call("DELETE", `/api/groups/${room.id}`)).status).toBe(404);
    // a persisted room is numbered 0 until its first statement in the new run (R2)
    for (const survivor of after.groups) expect(survivor).toMatchObject({ recordSeq: expect.any(Number), recordEpoch: after.tasksEpoch });
  }, 120_000);
});

describe("room clock (static)", () => {
  const source = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
  const between = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, from).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("nextRoomSeq is the only writer of roomClock, stampLiveRoom the only writer of roomSeqs, and the deletion listener the only other caller of nextRoomSeq()", () => {
    expect(source.match(/\broomClock\b\s*(\+\+|--|[-+*]?=(?!=))|(\+\+|--)\s*roomClock\b/g)).toEqual(["roomClock =", "++roomClock"]);
    expect(source.match(/let roomClock = 0;/g)).toHaveLength(1);
    expect(between("function nextRoomSeq()", "\n}\n")).toContain("++roomClock");
    expect(source.match(/\broomSeqs\.(set|clear)\(/g)).toEqual(["roomSeqs.set("]);
    expect(between("function stampLiveRoom(", "\n}\n")).toContain("roomSeqs.set(groupId, seq)");
    // the allocator's callers: stampLiveRoom, and the change listener's two removal statements (archive, deletion)
    const callers = [...source.matchAll(/nextRoomSeq\(\)(?!:)/g)].map((match) => match.index!);
    expect(callers).toHaveLength(3);
    const live = source.indexOf("function stampLiveRoom(");
    const listener = between("store.onChange((change) => {", "// ── message pages");
    const listenerStart = source.indexOf(listener);
    const inside = (index: number, start: number, text: string) => index >= start && index < start + text.length;
    const liveText = between("function stampLiveRoom(", "\n}\n");
    expect(callers.filter((index) => inside(index, live, liveText))).toHaveLength(1);
    expect(callers.filter((index) => inside(index, listenerStart, listener))).toHaveLength(2);
    // the deletion statement removes the live entry, allocates after the registry forgot the room, and records the visibility with it
    expect(listener).toMatch(/case "group\.deleted": \{[\s\S]*?const seq = nextRoomSeq\(\);\s*roomSeqs\.delete\(change\.groupId\);[\s\S]*?roomRemovals\.deleted\(change\.groupId, seq, taskDelta\.epoch, visible\);[\s\S]*?broadcast\(groupDeletedFrame\(change\.groupId, seq\)\)/);
    // stampLiveRoom refuses a room the registry lacks in test and dev, and mints nothing otherwise
    expect(between("function stampLiveRoom(", "\n}\n")).toMatch(/NODE_ENV === "test" \|\| process\.env\.NODE_ENV === "development"\) throw/);
  });

  it("the deletion listener passes an explicit VisibilityStore adapter, never a spread of the store (r1-H3)", () => {
    expect(source).not.toMatch(/visibleToCompanion\(\s*\{\s*\.\.\.store/);
    expect(source).not.toMatch(/\.\.\.store\s*[,}]/);
    expect(source).toMatch(/visibleToCompanion\(removedRoomVisibility\(change\.groupId, change\.group\), \{ scope: "group", groupId: change\.groupId \}\)/);
    const adapter = between("const removedRoomVisibility =", "\n});\n");
    for (const lookup of ["bot:", "botByThread:", "group:", "groupByThread:"]) expect(adapter).toContain(lookup);
    expect(adapter).toContain("id === groupId ? removed : store.group(id)");
  });

  it("roomNumbers falls back to the ledger, and withRecordNumbers numbers rooms through it", () => {
    expect(between("function roomNumbers(", "\n}\n")).toMatch(/roomSeqs\.get\(groupId\) \?\? 0[\s\S]*roomRemovals\.deletion\(groupId\)/);
    expect(between("function withRecordNumbers(", "\n}\n")).toContain("roomNumbers(id)");
  });

  it("the roster reads roomClock beside the rows and the ledgers, with no await between", () => {
    const section = between("const audience = rosterAudience(req, url);", "pendingSends: pendingSendsSnapshot(new Set(bots.map");
    expect(section.replace(/\/\/.*$/gm, "")).not.toMatch(/\bawait\b/);
    expect(section).toContain("const horizon = roomClock;");
    expect(section).toContain("roomClock: horizon, removedGroups: removedGroups ?? []");
  });

  it("DELETE /api/groups/:id answers through roomDeletionAnswer alone", () => {
    expect(source.match(/function roomDeletionAnswer\(/g)).toHaveLength(1);
    const route = between("const deleteGroupId = m[1]!;", "    m = path.match(/^\\/api\\/groups\\/([\\w-]+)\\/messages$/);");
    expect(route).not.toContain("json(res, 200");
    expect(route.match(/roomDeletionAnswer\(/g)).toHaveLength(2);
  });
});
