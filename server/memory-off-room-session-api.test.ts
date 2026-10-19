// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 keep-all refused (Fable High): with memory not active, a room member's engine keeps its native session across turns. A line its
// first prompt carried is then forgotten: the walker marks that session (deny_session), and the room path judges the retained session as
// the direct memory-off path judges its resume cursor, so the next turn starts a fresh session that never holds the forgotten line. An
// audience-only mark resets a room that does not answer only to the owner and never the owner's own room; with no revoke the session is
// kept turn after turn (no reset storm). Real server, an in-process engine that really keeps its sessions (server/testing/fake-keeping-driver.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const DOOR_TOKEN = "d".repeat(64);
/** A forwarded request with no owner proof: its words are "unproven", so the room turn does not answer only to the owner. */
const remote = { "x-murage-companion": "1", "x-murage-door-token": DOOR_TOKEN };
let fixture: VerificationServer, headers: Record<string, string>, dump: string, holdDir: string;
const api = async (method: string, path: string, body?: unknown, extra?: Record<string, string>) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(extra ?? headers) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text === "Kept reply").length;
type Row = { threadId: string; session?: string; fresh?: boolean; prompt?: string; context?: string[]; refused?: boolean; reset?: boolean };
const rows = (threadId: string): Row[] => existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Row).filter(row => row.threadId === threadId) : [];
const writes = (threadId: string) => rows(threadId).filter(row => row.prompt !== undefined);
const lastWrite = (threadId: string) => writes(threadId).at(-1)!;
const db = () => new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
const activeRevokes = () => { const handle = db(); try { return Number((handle.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'").get() as { n: number }).n); } finally { handle.close(); } };

const newBot = async (name: string, instanceId = "keep") => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "keep-1" } })).body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
const newRoom = async (name: string, botId: string) => (await api("POST", "/api/groups", { name, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).body.group as { id: string; threadId: string };
const idle = async (roomId: string) => { const state = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === roomId); return !state.working && !state.busyBotId; };
/** One room turn, answered: the reply lands and the room is idle again. */
const turn = async (room: { id: string; threadId: string }, text: string, from?: Record<string, string>) => {
  const before = await replies(room.threadId);
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text }, from)).status).toBe(202);
  await expect.poll(async () => await replies(room.threadId), { timeout: 60000 }).toBe(before + 1);
  await expect.poll(async () => await idle(room.id), { timeout: 30000 }).toBe(true);
};
const lineId = async (threadId: string, text: string) => (await messages(threadId)).find(message => message.role === "user" && message.text === text)!.id as string;
const forget = async (threadId: string, messageId: string) => {
  expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${threadId}:${messageId}` })).status).toBe(200);
};

describe.skipIf(process.platform === "win32")("memory not active: a room member's retained engine session", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: DOOR_TOKEN }, instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeKeepingDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-keeping-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeKeepingDriver());
      const dir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      fs.mkdirSync(path.join(dir,'keep-hold'),{recursive:true});
      cfg.instances.keep={driver:'fakeKeeping',environment:{FAKE_KEEP_DUMP:path.join(dir,'keep-dump'),FAKE_KEEP_HOLD:path.join(dir,'keep-hold')}};
      cfg.instances.once={driver:'fakeKeeping',environment:{FAKE_KEEP_DUMP:path.join(dir,'keep-dump'),FAKE_KEEP_REPORT_ONCE:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    dump = join(fixture.info.dataDir, "keep-dump");
    holdDir = join(fixture.info.dataDir, "keep-hold");
    mkdirSync(holdDir, { recursive: true });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    // capture: lines become sources that can be forgotten, and no turn is shown memory (the room path's not-active branch)
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
  }, 60000);
  afterAll(async () => { await fixture?.close(); }, 60000);

  it("with no revoke the member keeps one session across three turns", async () => {
    const bot = await newBot("Keeper three");
    const room = await newRoom("Three turns", bot.id);
    await turn(room, "first plain question");
    await turn(room, "second plain question");
    await turn(room, "third plain question");
    const all = writes(room.threadId);
    expect(all).toHaveLength(3);
    expect(new Set(all.map(row => row.session)).size).toBe(1);
    expect(all.map(row => row.fresh)).toEqual([true, false, false]);
    expect(rows(room.threadId).filter(row => row.reset)).toHaveLength(0);
    expect(fixture && readFileSync(fixture.info.logPath, "utf8").includes(`memory continuation reset thread=${room.threadId}`)).toBe(false);
  }, 180000);

  it("memory off: a forgotten line the first prompt carried ends the retained session; the next turn replays without it", async () => {
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
    const bot = await newBot("Keeper forget");
    const room = await newRoom("Forget room", bot.id);
    await turn(room, "the vault code is MAGENTA-41");
    await turn(room, "what else is on the list?");
    expect(writes(room.threadId).map(row => row.fresh)).toEqual([true, false]);
    expect(lastWrite(room.threadId).context!.join("\n")).toContain("MAGENTA-41");
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    await forget(room.threadId, await lineId(room.threadId, "the vault code is MAGENTA-41"));
    await expect.poll(activeRevokes, { timeout: 30000 }).toBe(0);
    await turn(room, "and one more thing");
    const third = lastWrite(room.threadId);
    expect(third.prompt).toContain("and one more thing");
    expect(third.fresh).toBe(true);
    expect(third.session).not.toBe(writes(room.threadId)[0]!.session);
    expect(third.context!.join("\n")).not.toContain("MAGENTA-41");
    expect(rows(room.threadId).some(row => row.reset)).toBe(true);
  }, 180000);

  it("an engine that reports its session only once: a line of a later turn it continued is forgotten, and the session still ends", async () => {
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
    const bot = await newBot("Keeper once", "once");
    const room = await newRoom("Once room", bot.id);
    await turn(room, "first quiet question");
    await turn(room, "second quiet question");
    await turn(room, "the boat is called CORAL-9");
    expect(writes(room.threadId).map(row => row.fresh)).toEqual([true, false, false]);
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    await forget(room.threadId, await lineId(room.threadId, "the boat is called CORAL-9"));
    await expect.poll(activeRevokes, { timeout: 30000 }).toBe(0);
    await turn(room, "what now?");
    const fourth = lastWrite(room.threadId);
    expect(fourth.prompt).toContain("what now?");
    expect(fourth.fresh).toBe(true);
    expect(fourth.context!.join("\n")).not.toContain("CORAL-9");
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
  }, 180000);

  it("a revoke between setup and the write refuses that write, and the re-dispatch starts a fresh session without the line", async () => {
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "capture" })).status).toBe(200);
    const bot = await newBot("Keeper late");
    const room = await newRoom("Late room", bot.id);
    await turn(room, "the locker code is CYAN-77");
    await turn(room, "anything to add?");
    expect(writes(room.threadId).map(row => row.fresh)).toEqual([true, false]);
    const kept = lastWrite(room.threadId).session;
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const target = await lineId(room.threadId, "the locker code is CYAN-77");
    // the next turn's setup passes (nothing is revoked yet); the engine holds it before the write
    writeFileSync(join(holdDir, "arm"), "");
    const before = await replies(room.threadId);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "last call" })).status).toBe(202);
    await expect.poll(() => existsSync(join(holdDir, "waiting")), { timeout: 30000 }).toBe(true);
    await forget(room.threadId, target);
    await expect.poll(activeRevokes, { timeout: 30000 }).toBe(0);
    writeFileSync(join(holdDir, "go"), "");
    await expect.poll(async () => await replies(room.threadId), { timeout: 60000 }).toBe(before + 1);
    await expect.poll(async () => await idle(room.id), { timeout: 30000 }).toBe(true);
    const after = rows(room.threadId).slice(-4);
    expect(rows(room.threadId).some(row => row.refused && row.session === kept)).toBe(true);
    const last = lastWrite(room.threadId);
    expect(last.prompt).toContain("last call");
    expect(last.fresh).toBe(true);
    expect(last.session).not.toBe(kept);
    expect(last.context!.join("\n")).not.toContain("CYAN-77");
    expect(after.some(row => row.reset)).toBe(true);
  }, 180000);

  it("an audience-only mark on the session keeps the owner's room and resets a room that answers to someone else", async () => {
    const ownerBot = await newBot("Keeper owner");
    const ownerRoom = await newRoom("Owner room", ownerBot.id);
    const otherBot = await newBot("Keeper other");
    const otherRoom = await newRoom("Other room", otherBot.id);
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    await turn(ownerRoom, "owner question one");
    await turn(ownerRoom, "owner question two");
    await turn(otherRoom, "forwarded question one", remote);
    await turn(otherRoom, "forwarded question two", remote);
    expect(writes(ownerRoom.threadId).map(row => row.fresh)).toEqual([true, false]);
    expect(writes(otherRoom.threadId).map(row => row.fresh)).toEqual([true, false]);
    // a receipt flip's mark as 1.0.2's Keep all left it: audience-only (memory_revoke_audience), on each member's session
    const handle = db();
    try {
      handle.exec("PRAGMA busy_timeout=10000");
      handle.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(910001);
      for (const room of [ownerRoom, otherRoom])
        handle.prepare("INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,?)").run(room.threadId, "keep", lastWrite(room.threadId).session!, 910001);
    } finally { handle.close(); }
    await turn(ownerRoom, "owner question three");
    await turn(otherRoom, "forwarded question three", remote);
    expect(writes(ownerRoom.threadId).map(row => row.fresh)).toEqual([true, false, false]);
    expect(writes(otherRoom.threadId).map(row => row.fresh)).toEqual([true, false, true]);
  }, 180000);
});
