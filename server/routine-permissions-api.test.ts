import { powerBlockTestEnv } from "./testing/power-block-test.ts";
import { fakeEngineServerArgs } from "./testing/fake-engine-server.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Routine approval levels, end to end over real HTTP with the fake ACP agent
// asking to delete outside its folder mid-turn (the stop line):
//
//   - a routine uses its bot's No limits level, with only a named wipe card;
//   - every run works in the routine's one conversation, with a run marker;
//   - a routine set to Auto stops at the stop line, and its card offers
//     "Always allow for this routine", which covers the next run;
//   - the owner's own message in the routine's conversation is judged at the
//     routine's level, the level the composer shows there;
//   - Full access or No limits for a routine needs the bot's one-time warning.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { raiseLevel } from "./testing/raise-level.ts";
import { sessionBoundAcpPermissionEnvironment } from "./testing/acp-permission-fixture.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  // A displayed approval card carries an opaque handle; the respond route takes it as requestHandle + action.
  if (path.endsWith("/respond") && body && typeof body === "object") {
    const answer = body as { requestId?: unknown; behavior?: unknown };
    if (typeof answer.requestId === "string" && /^[pq]\./.test(answer.requestId) && (answer.behavior === "allow" || answer.behavior === "deny")) body = { requestHandle: answer.requestId, action: answer.behavior };
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const botState = async (botId: string) => (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
const taskState = async (botId: string, threadId: string) => (await botState(botId)).tasks.find((task: any) => task.threadId === threadId);
const threadMessages = async (threadId: string) => (((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[])
  .map((message) => message.card?.requestHandle ? { ...message, card: { ...message.card, requestId: message.card.requestHandle } } : message);
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card?.answered === undefined) ?? null;
const routineState = async (id: string) => (await api("GET", "/api/routines")).body.routines.find((routine: any) => routine.id === id);
const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);

async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function makeBot(name: string, instanceId = "deleter") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string; name: string };
}

async function makeRoutine(botId: string, extra: Record<string, unknown> = {}) {
  const created = await desktopApi("POST", "/api/routines", {
    name: "RWA watch", prompt: "Sweep", botId, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.routine as { id: string };
}

async function runOnce(routineId: string) {
  const started = await desktopApi("POST", `/api/routines/${routineId}/run`);
  expect(started.status).toBe(201);
  return started.body.run.id as string;
}

const settled = async (runId: string) => {
  const result = await poll(async () => {
    const run = await runState(runId);
    return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
  }, 25_000);
  if(!result){const pending=await runState(runId);console.error('Routine did not settle',JSON.stringify(pending),JSON.stringify(await threadMessages(pending.threadId)));}
  return result;
};

describe("routine approval levels", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-routine-levels-");
    // A disposable home: OS temp, or the checkout's .murage-scratch on Linux.
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        deleter: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE, FAKE_ACP_PROMPT_DUMP: join(home, "last-prompt.json") }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
        // 0.1.60 Linux pass D2: a routine deleting its own dated temp file
        tempfile: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: 'tmp="tempfile_$(date +%s).txt" && date > "$tmp" && cat "$tmp" >> notes/log.md && rm "$tmp"' }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
        // 1.0.3 routine carve-out: a write whose target a value holds runs,
        // and the run's history says so; a literal home delete still holds
        vartarget: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: 'OUT="$(cat target.txt)"; cat x > "$OUT"' }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
        homedelete: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "rm -rf ~" }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
        // a bot's own always-allow card (the plain shell ask)
        asker: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission" }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
        // and one whose delete cannot be placed at all
        unplaced: {
          driver: "grokAgent",
          environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: 'tmp="$(cat list.txt)"; rm "$tmp"' }),
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    child = spawn(process.execPath, fakeEngineServerArgs(join(SERVER_DIR, "index.ts")), {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: { ...powerBlockTestEnv(), ...fixturePlatformEnv(),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_DATA_DIR: join(home, ".murage"),
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await stopFixtureServer(child);
    await removeTempDir(home);
  });

  it("a routine uses No limits, runs an ordinary delete without a card, and uses one conversation across runs", async () => {
    const bot = await makeBot("Dax");
    expect((await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id);
    expect((await routineState(routine.id)).permissionMode).toBe("unlimited");
    const runId = await runOnce(routine.id);
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    expect(threadId).toBeTruthy();
    const first = await settled(runId);
    expect(first, `run never settled. stderr: ${stderr.slice(-1500)}`).toMatchObject({ status: "completed" });
    const second = await settled(await runOnce(routine.id));
    expect(second).toMatchObject({ status: "completed" });
    // one conversation, remembered on the routine, with both runs in it
    expect(second!.threadId).toBe(first!.threadId);
    expect((await routineState(routine.id)).threadId).toBe(first!.threadId);
    const messages = await threadMessages(first!.threadId);
    expect(messages.filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
    const steps = messages.filter((m) => m.kind === "activity" && Array.isArray(m.tool?.steps));
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.tool.name).toBe("Approved 1 step (No limits)");
      expect(step.tool.steps).toEqual([expect.stringContaining(DELETE_OUTSIDE)]);
    }
    expect(await liveCard(first!.threadId)).toBeNull();
    expect(messages.filter((m) => m.kind === "activity" && m.tool?.name === "Run now: RWA watch")).toHaveLength(2);
    // the engine is told this is a new run, and the earlier run's copy of the
    // instruction in the history is labelled as that run, not a new request
    const prompt = JSON.parse(readFileSync(join(home, "last-prompt.json"), "utf8")) as Array<{ type: string; text?: string }>;
    const sent = prompt.map((part) => part.text ?? "").join("\n");
    expect(sent).toContain('[This is a new run of the routine "RWA watch" that the owner started with Run now.');
    expect(sent).toMatch(/User: \[Earlier run of the routine "RWA watch", started with Run now\]\nSweep/);
    // the owner's own bubble stays exactly what the routine says
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["Sweep", "Sweep"]);
  }, 90_000);

  it("a routine on Auto stops at the stop line, and Always allow for this routine covers its next run", async () => {
    const bot = await makeBot("Rae");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id, { permissionMode: "auto" });
    const runId = await runOnce(routine.id);
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => liveCard(threadId!), 20_000);
    expect(card, `no card on Auto. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(card.card).toMatchObject({ routineId: routine.id });
    expect(card.card.routineAllowKey).toBe(`stop:delete:${join(home, "Documents", "old").replaceAll("\\", "/").replace(/^([a-z]:)/i, "/$1")}`);
    // a forged key is refused; the card's own is kept on the routine
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow`, { answer: true, allowKey: "stop:delete:/", threadId, requestId: card.card.requestId })).status).toBe(409);
    expect((await api("POST", `/api/routines/${routine.id}/always-allow`, { answer: true, allowKey: card.card.routineAllowKey, threadId, requestId: card.card.requestId })).status).toBe(404);
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow`, { answer: true, allowKey: card.card.routineAllowKey, threadId, requestId: card.card.requestId })).status).toBe(200);
    // the one always-allow request saved the grant and answered this card: a second answer finds nothing waiting
    expect((await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).body).toMatchObject({ error: "request_unavailable" });
    expect(await settled(runId)).toMatchObject({ status: "completed" });
    expect((await routineState(routine.id)).alwaysAllow).toEqual([card.card.routineAllowKey]);

    const next = await settled(await runOnce(routine.id));
    expect(next).toMatchObject({ status: "completed", threadId });
    const automaticRows = await threadMessages(threadId!);
    expect(automaticRows.some((m) => String(m.tool?.name ?? "").includes("(always allowed for this routine)")),
      JSON.stringify(automaticRows.filter(m=>m.kind==='activity').map(m=>m.tool))).toBe(true);

    // removed in the editor: the next run asks again
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow/remove`, { key: card.card.routineAllowKey })).status).toBe(200);
    expect((await routineState(routine.id)).alwaysAllow).toBeUndefined();
  }, 120_000);

  it("a routine's own dated temp file is deleted inside its folder, with no card on Auto", async () => {
    const bot = await makeBot("Tem", "tempfile");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id, { permissionMode: "auto" });
    const run = await settled(await runOnce(routine.id));
    expect(run, `stderr: ${stderr.slice(-1500)}`).toMatchObject({ status: "completed" });
    expect((await threadMessages(run!.threadId)).filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
  }, 90_000);

  it("a delete it cannot place still asks, and its card offers this routine", async () => {
    const bot = await makeBot("Unp", "unplaced");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id, { permissionMode: "auto" });
    const runId = await runOnce(routine.id);
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => liveCard(threadId!), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(card.card.held).toContain("cannot place");
    // a routine's card offers the routine's own row: the task allowance reader ignores automated turns (design 1.2)
    expect(card.card.routineAllowKey).toMatch(/^stop:delete:unplaced:/);
    expect(card.card.taskAllowKey).toBeUndefined();
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow`, { answer: true, allowKey: card.card.routineAllowKey, threadId, requestId: card.card.requestId })).status).toBe(200);
    await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    expect(await settled(runId)).toMatchObject({ status: "completed" });
    // the next run of the same command is covered
    const next = await settled(await runOnce(routine.id));
    expect(next).toMatchObject({ status: "completed" });
  }, 120_000);

  it("a routine's write to a target a value holds runs on Auto, and the run's history records it", async () => {
    const bot = await makeBot("Var", "vartarget");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id, { permissionMode: "auto" });
    const run = await settled(await runOnce(routine.id));
    expect(run, `stderr: ${stderr.slice(-1500)}`).toMatchObject({ status: "completed" });
    expect((await threadMessages(run!.threadId)).filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
    expect(run!.notes).toEqual(['Ran without asking, target held in a value: a redirect to "$OUT"']);
  }, 90_000);

  it("a routine's literal home delete still holds, even at No limits", async () => {
    const bot = await makeBot("Hom", "homedelete");
    expect((await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id);
    expect((await routineState(routine.id)).permissionMode).toBe("unlimited");
    const runId = await runOnce(routine.id);
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => liveCard(threadId!), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(card.card.held).toContain("whole home folder");
    expect(card.card.routineAllowKey).toBeUndefined();
    expect((await runState(runId)).notes).toBeUndefined();
    await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    await settled(runId);
  }, 90_000);

  it("the owner's message in a routine's conversation runs at the routine's level", async () => {
    const bot = await makeBot("Kit");
    expect((await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id);
    const runId = await runOnce(routine.id);
    const routineThread = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    expect(routineThread).toBeTruthy();
    const run = await settled(runId);
    expect(run).toMatchObject({ status: "completed" });
    const threadId = run!.threadId as string;
    // the conversation's own task copied No limits when it was made
    expect((await taskState(bot.id, threadId)).noLimits).toBe(true);
    expect((await threadMessages(threadId)).filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "auto" })).status).toBe(200);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "tidy my documents" })).status).toBe(202);
    const card = await poll(() => liveCard(threadId), 20_000);
    expect(card, "the owner's turn ran at the conversation's copied level, not the routine's").not.toBeNull();
    expect(card.card.held).toContain("outside its folder");
    await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  }, 90_000);

  it("a display handle is resolved on its own thread only: another routine's card is never reached through this routine", async () => {
    const first = await makeBot("Han");
    const second = await makeBot("Hob");
    for (const bot of [first, second]) expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    const mine = await makeRoutine(first.id, { permissionMode: "auto" });
    const theirs = await makeRoutine(second.id, { permissionMode: "auto" });
    const myRun = await runOnce(mine.id);
    const theirRun = await runOnce(theirs.id);
    const myThread = await poll(async () => (await runState(myRun))?.threadId ?? null, 20_000);
    const theirThread = await poll(async () => (await runState(theirRun))?.threadId ?? null, 20_000);
    const myCard = await poll(() => liveCard(myThread!), 20_000);
    const theirCard = await poll(() => liveCard(theirThread!), 20_000);
    expect(myCard && theirCard, `stderr: ${stderr.slice(-1500)}`).toBeTruthy();
    expect(theirCard.card.requestId).toMatch(/^p\./);
    const key = myCard.card.routineAllowKey;
    // the other routine's handle, on my thread: it names no card here
    expect((await desktopApi("POST", `/api/routines/${mine.id}/always-allow`, { answer: true, allowKey: key, threadId: myThread, requestId: theirCard.card.requestId })).status).toBe(409);
    // their thread and their handle through my routine: not my routine's conversation
    expect((await desktopApi("POST", `/api/routines/${mine.id}/always-allow`, { answer: true, allowKey: key, threadId: theirThread, requestId: theirCard.card.requestId })).status).toBe(404);
    // my handle, my thread, their routine: the card is not theirs
    expect((await desktopApi("POST", `/api/routines/${theirs.id}/always-allow`, { answer: true, allowKey: key, threadId: myThread, requestId: myCard.card.requestId })).status).toBe(404);
    expect((await routineState(mine.id)).alwaysAllow).toBeUndefined();
    expect((await routineState(theirs.id)).alwaysAllow).toBeUndefined();
    expect((await liveCard(myThread!))?.card.requestId).toBe(myCard.card.requestId);
    expect((await liveCard(theirThread!))?.card.requestId).toBe(theirCard.card.requestId);
    // and the right pairing still works
    expect((await desktopApi("POST", `/api/routines/${mine.id}/always-allow`, { answer: true, allowKey: key, threadId: myThread, requestId: myCard.card.requestId })).status).toBe(200);
    expect((await routineState(mine.id)).alwaysAllow).toEqual([key]);
    expect((await routineState(theirs.id)).alwaysAllow).toBeUndefined();
  }, 120_000);

  it("a bot's Always allow takes the card's display handle, and never another thread's or another bot's card", async () => {
    const owner = await makeBot("Bao", "asker");
    const other = await makeBot("Bix", "asker");
    const peer = await makeBot("Bez", "asker");
    expect((await desktopApi("POST", `/api/bots/${other.id}/messages`, { threadId: other.threadId, text: "log the time" })).status).toBe(202);
    const otherCard = await poll(() => liveCard(other.threadId), 20_000);
    expect(otherCard, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(otherCard.card.requestId).toMatch(/^p\./);
    const key = (otherCard.card.exactAllowKey ?? otherCard.card.allowKey) as string;
    const bodyFor = (threadId: string, requestId: string) => ({ answer: true, allowKey: key, threadId, requestId });
    // another bot's handle on this bot's own thread names no card there; this bot naming the other's thread is refused outright
    expect((await desktopApi("POST", `/api/bots/${owner.id}/always-allow`, bodyFor(owner.threadId, otherCard.card.requestId))).status).toBe(409);
    expect((await desktopApi("POST", `/api/bots/${owner.id}/always-allow`, bodyFor(other.threadId, otherCard.card.requestId))).status).not.toBe(200);
    expect((await botState(owner.id)).alwaysAllow ?? []).not.toContain(key);
    expect((await liveCard(other.threadId))?.card.requestId).toBe(otherCard.card.requestId);
    // a room is a shared transcript: a member's handle for a card it did not raise saves nothing for the other member
    const group = await desktopApi("POST", "/api/groups", { name: "Handle room", memberIds: [owner.id, peer.id], setup: { bulletin: "Fixture only", defaultResponder: { kind: "member", botId: owner.id } } });
    expect(group.status, JSON.stringify(group.body)).toBe(201);
    const room = group.body.group as { id: string; threadId: string };
    expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "say hi" })).status).toBe(202);
    const roomCard = await poll(() => liveCard(room.threadId), 20_000);
    expect(roomCard, `no room card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(roomCard.from?.botId).toBe(owner.id);
    const roomKey = (roomCard.card.exactAllowKey ?? roomCard.card.allowKey) as string;
    const roomBody = { answer: true, allowKey: roomKey, threadId: room.threadId, requestId: roomCard.card.requestId };
    expect((await desktopApi("POST", `/api/bots/${peer.id}/always-allow`, roomBody)).status).toBe(409);
    expect((await botState(peer.id)).alwaysAllow ?? []).not.toContain(roomKey);
    expect((await liveCard(room.threadId))?.card.requestId).toBe(roomCard.card.requestId);
    // the card's own bot, with the handle the client holds, is saved and answered
    expect((await desktopApi("POST", `/api/bots/${owner.id}/always-allow`, roomBody)).status).toBe(200);
    expect((await botState(owner.id)).alwaysAllow).toContain(roomKey);
    expect((await desktopApi("POST", `/api/bots/${other.id}/always-allow`, bodyFor(other.threadId, otherCard.card.requestId))).status).toBe(200);
    expect((await botState(other.id)).alwaysAllow).toContain(key);
  }, 120_000);

  it("Full access or No limits for a routine needs the bot's one-time warning", async () => {
    const bot = await makeBot("Unwarned");
    const refused = await desktopApi("POST", "/api/routines", { name: "Bold", prompt: "p", botId: bot.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, permissionMode: "unlimited" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Turn on No limits for Unwarned");
    const routine = await makeRoutine(bot.id);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "full" })).status).toBe(409);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "auto" })).status).toBe(200);
    // and a routine's level is the desktop app's decision alone
    expect((await api("PATCH", `/api/routines/${routine.id}`, { permissionMode: "ask" })).status).toBe(404);
  }, 30_000);
});
