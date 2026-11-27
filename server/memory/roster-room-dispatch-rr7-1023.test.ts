// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 RR7 (ASTRA :5102 on fix1022-row76-closer2 102054f868): the live-turn guard in roomNarrowed (server/memory/policy.ts) reads
// liveTurnGenerationOn, which the server's OWN dispatch feeds (server/index.ts beginInternalTurn -> internalCapabilities.begin). The
// earlier RR7 started a generation by hand in a private registry, and the HTTP draft ran the server in a separate process, so its
// mutants died only sometimes. Owners: q1023-rr7 owns this test file only (no product code); policy.ts roomNarrowed owns the guard;
// server/index.ts beginInternalTurn owns the generation it reads.
//
// The server runs IN THIS PROCESS (server/index.ts imported here, so liveTurnGenerationOn below is the very map its dispatch writes).
// A bot's direct turn is dispatched by the real message route and held by the in-process fixture engine before its turn.started
// (FAKE_LATE_SESSION_GATE without HANDBACK holds sendTurn): its generation is live, and the test asserts the two other liveness inputs
// of roomNarrowed are absent (memory is paused while it dispatches, so it takes no recall reader; no memory_open_turns row), so the
// generation alone decides. The held turn cannot move while the gate file is missing: the state is the same before and after the save.
// RR7-G: a direct turn on the leaver's own thread, the member removed by PATCH /api/groups. RR7-R: the room's own turn on the room thread,
// the member removed by deleting its bot.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { freePortBlock } from "../testing/ports.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { makeLateTerminalDriver } from "../testing/fake-late-terminal-driver.ts";
import { liveTurnGenerationOn } from "../internal-capabilities.ts";
import { liveRecallReaderOn } from "./recall-view.ts";
import { database } from "../database.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
const gate = join(DATA_DIR, "rr7-gate");
let url = "";
let headers: Record<string, string> = {};
const warned: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
/** The roster lines the server logged since `from` (an index into `warned`). */
const audience = (from: number) => warned.slice(from).filter(line => /roster audience change|memory receipts revoked/.test(line)).join("\n");
const openTurnRows = (threads: string[]) => Number(database().prepare("SELECT count(*) AS n FROM memory_open_turns WHERE thread_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(threads))!.n);

beforeAll(async () => {
  const original = console.warn.bind(console);
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(" ")); original(...args); });
  (BUILT_IN_DRIVERS as unknown as unknown[]).push(makeLateTerminalDriver());
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances: { rr7: { driver: "fakeLateTerminal", environment: { FAKE_LATE_SESSION_GATE: gate } } } }));
  const port = await freePortBlock([0, 1]);
  process.env.MURAGE_PORT = String(port);
  process.env.MURAGE_WEBHOOK_PORT = String(port + 1);
  url = `http://127.0.0.1:${port}`;
  await import("../index.ts");
  for (let n = 0; n < 600 && (await fetch(url + "/api/desktop-secret").catch(() => undefined))?.status !== 200; n++) await new Promise(resolve => setTimeout(resolve, 100));
  const proof = await (await fetch(url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
}, 120_000);
/** Releases the held turn and waits until every bot is idle and every room request has ended: its completion bookkeeping (the room
 *  turn's project budget check runs in a microtask after turn.completed) writes the database, which the suite's per-test teardown
 *  (server/testing/setup.ts settleTestHandles) closes. */
const releaseAndSettle = async () => {
  writeFileSync(gate, "release");
  const openRequests = () => Number(database().prepare("SELECT count(*) AS n FROM room_requests WHERE state NOT IN ('done','failed','cancelled','expired','unknown')").get()!.n);
  for (let n = 0; n < 300; n++) {
    const bots = (await api("GET", "/api/bots?messages=0").catch(() => undefined))?.body?.bots as Array<{ busy?: boolean }> | undefined;
    if (bots && !bots.some(bot => bot.busy) && openRequests() === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => setTimeout(resolve, 1_000));
  expect(openRequests(), "every room request ended before teardown").toBe(0);
};
afterAll(() => { writeFileSync(gate, "release"); });

const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "rr7", model: "late-1" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
const createRoom = async (name: string, ...ids: string[]) => {
  const made = await api("POST", "/api/groups", { name, memberIds: ids, setup: { bulletin: "", defaultResponder: { kind: "member", botId: ids[0] } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.group as { id: string; threadId: string };
};

posixOnly("RR7-R deleting a room member while the room's own dispatch holds the responder's turn in the room thread (before turn.started) is an audience change", async () => {
  // the room dispatch (index.ts beginInternalTurn from the room turn path, ASTRA :5102's production site). PATCH /api/groups refuses a
  // member change while the room works (409), so the member leaves the way the server still allows then: its bot is deleted (the
  // deletion's roster save narrows the room through the same roomNarrowed). It runs FIRST: the room turn's completion runs the project
  // budget gate, which holds the database handle the server opened at load, and the suite's per-test teardown closes that handle.
  rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
  // memory paused while it dispatches, as in RR7-G: the room turn takes no recall reader
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "paused" })).status).toBe(200);
  const lead = await createBot("RoomLead"), leaver = await createBot("RoomLeaver");
  const room = await createRoom("Room dispatch pitch room", lead.id, leaver.id);
  const narrowed = new Set([room.threadId, leaver.threadId]);
  expect(liveTurnGenerationOn(narrowed), "nothing is live before the dispatch").toBe(false);
  const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "plan the pitch together" });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 30_000 }).toBe(true);
  const isolated = () => {
    expect(liveRecallReaderOn(narrowed), "no recall reader on a narrowed thread").toBe(false);
    expect(openTurnRows([...narrowed]), "no open-turn row on a narrowed thread").toBe(0);
  };
  isolated();
  const generationLive = liveTurnGenerationOn([room.threadId]);
  const from = warned.length;
  const removed = await api("DELETE", `/api/bots/${leaver.id}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  isolated();
  expect(audience(from), "the live-turn guard names the audience change").toContain("rule=4-room-live");
  expect(generationLive, "the room's dispatch began the responder's generation in the room thread").toBe(true);
  await releaseAndSettle();
  expect(liveTurnGenerationOn([room.threadId])).toBe(false);
}, 120_000);

posixOnly("RR7-G removing a bot from a room while the server's own dispatch holds a turn on its thread (before turn.started) is an audience change", async () => {
  const lead = await createBot("DispatchLead"), leaver = await createBot("DispatchLeaver");
  const room = await createRoom("Dispatch pitch room", lead.id, leaver.id);
  rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true }); // the gate is armed again
  // no recall reader: memory is paused while the turn is dispatched (the state a recall-held turn dispatches in: index.ts takes the
  // dispatch's memory mode as "paused" then), so the turn takes no recall view and only the dispatch's generation is live. The roster
  // policy stays granted, so the save still decides scoped vs audience.
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "paused" })).status).toBe(200);
  const narrowed = new Set([room.threadId, leaver.threadId, lead.threadId]);
  expect(liveTurnGenerationOn(narrowed), "nothing is live before the dispatch").toBe(false);
  const sent = await api("POST", `/api/bots/${leaver.id}/messages`, { text: "plan the pitch", threadId: leaver.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 30_000 }).toBe(true);
  // the isolation: neither other liveness input of roomNarrowed is present, before or after the save
  const isolated = () => {
    expect(liveRecallReaderOn(narrowed), "no recall reader on a narrowed thread").toBe(false);
    expect(openTurnRows([...narrowed]), "no open-turn row on a narrowed thread").toBe(0);
  };
  isolated();
  const generationLive = liveTurnGenerationOn([leaver.threadId]);
  const from = warned.length;
  const removed = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [lead.id] });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  isolated();
  expect(audience(from), "the live-turn guard names the audience change").toContain("rule=4-room-live");
  expect(generationLive, "the server's dispatch began the leaver's generation").toBe(true);
  await releaseAndSettle();
  expect(liveTurnGenerationOn([leaver.threadId])).toBe(false);
}, 120_000);

posixOnly("RR7-G control: the same removal with no turn on the leaver's threads stays scoped to those threads", async () => {
  writeFileSync(gate, "release");
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
  const lead = await createBot("QuietLead"), leaver = await createBot("QuietLeaver");
  const room = await createRoom("Quiet room", lead.id, leaver.id);
  expect(liveTurnGenerationOn([room.threadId, leaver.threadId, lead.threadId])).toBe(false);
  const from = warned.length;
  const removed = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [lead.id] });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const lines = audience(from);
  expect(lines, "the removal is scoped to the room's and the leaver's threads").not.toContain("roster audience change");
  expect(lines).not.toContain("scope=global");
}, 120_000);
