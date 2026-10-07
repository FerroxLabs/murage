// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E1 (SPEC-P 3.2, 5.2, 8): the turn engine on a real server with fake
// engines. What failed before (0161 lanes/sim/BASELINE.md): a busy member was
// skipped ("skipped this round") and nobody came back; the lead picked up 0
// of 13 results without the owner typing again; a follow-up sent while the
// room worked lived only in memory.
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse } from "./testing/sse.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const lines = (thread: any[]) => thread.map((m) => `${m.from?.name ?? m.actorKind ?? m.role}: ${m.tool?.name ?? String(m.text ?? "").slice(0, 100)}`).join("\n");
const idle = async (roomId: string) => { const state = await groupState(roomId); return Boolean(state) && !state.working && !state.busyBotId; };

posixOnly("the turn engine: queue, durable sends, wakes, caps", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate')}};
      cfg.instances.lead={driver:'grokAgent',displayName:'Lead fixture',environment:{FAKE_ACP_MODE:'lead-delegate'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      cfg.instances.looper={driver:'grokAgent',displayName:'Looping lead fixture',environment:{FAKE_ACP_MODE:'lead-loop'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const bot = async (name: string, instanceId: string) => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
    expect(created.status).toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return made;
  };
  const room = async (name: string, memberIds: string[], defaultResponder: unknown = { kind: "everyone" }) => {
    const created = await api("POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.group as { id: string; threadId: string };
  };
  const hideEveryone = async () => { for (const existing of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${existing.id}`, { hidden: true }); };

  it("a message in a quiet room sends no queue frame: nothing waited", async () => {
    const quietBot = await bot("Quill", "verification");
    const quiet = await room("Quiet", [quietBot.id], { kind: "mentions" });
    const stream = await openSse(`${fixture.info.url}/api/events`, headers);
    try {
      await stream.until((frame) => frame.kind === "hello");
      expect((await api("POST", `/api/groups/${quiet.id}/messages`, { text: "just a note" })).status).toBe(202);
      await stream.until((frame) => JSON.stringify(frame).includes("just a note"), 10000);
      await expect(stream.until((frame) => frame.kind === "room.requests" && frame.groupId === quiet.id, 1500)).rejects.toThrow();
    } finally { stream.close(); }
  }, 30000);

  it("a member busy speaking in another room is queued, not skipped, and answers in place", async () => {
    await hideEveryone();
    const tess = await bot("Tess", "verification"), quinn = await bot("Quinn", "piGate");
    const other = await room("Other", [quinn.id]);
    const office = await room("Office", [tess.id, quinn.id]);
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/groups/${other.id}/messages`, { text: "Quinn, a long one please." })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    expect((await groupState(other.id)).busyBotId).toBe(quinn.id);

    expect((await api("POST", `/api/groups/${office.id}/messages`, { text: "Both of you: one line each." })).status).toBe(202);
    // Tess answers; Quinn is queued with one line saying so
    await expect.poll(async () => (await messages(office.threadId)).some((m) => m.from?.botId === tess.id && m.kind === "text"), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await messages(office.threadId)).some((m) => m.actorKind === "murage" && /Quinn is busy right now/.test(m.tool?.name ?? "")), { timeout: 20000 }).toBe(true);
    const queue = (await api("GET", `/api/groups/${office.id}/requests?open=1`)).body.requests as any[];
    expect(queue.map((request) => [request.verb, request.toBotId, request.state])).toContainEqual(["room_turn", quinn.id, "queued"]);

    writeFileSync(gate, "");
    await expect.poll(async () => (await messages(office.threadId)).some((m) => m.from?.botId === quinn.id && m.kind === "text" && m.text), { timeout: 30000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${lines(await messages(office.threadId))}`); });
    const thread = await messages(office.threadId);
    expect(thread.some((m) => /skipped this round/.test(m.tool?.name ?? ""))).toBe(false);
    const asked = thread.find((m) => m.role === "user");
    const quinnReply = thread.find((m) => m.from?.botId === quinn.id && m.kind === "text");
    // envelope v2: the reply carries its request and what it answers
    expect(quinnReply.requestId).toBeTruthy();
    expect(quinnReply.replyToId).toBe(asked.id);
    expect(quinnReply.actorKind).toBe("bot");
    await expect.poll(() => idle(office.id), { timeout: 20000 }).toBe(true);
  }, 120000);

  it("owner sends written while the room works survive a restart and dedupe on their send id", async () => {
    await hideEveryone();
    const quinn = await bot("Quinn2", "piGate");
    const desk = await room("Desk", [quinn.id]);
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/groups/${desk.id}/messages`, { text: "first thing" })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);

    const sent = await api("POST", `/api/groups/${desk.id}/messages`, { text: "second thing, while you work", sendId: "send-two-000000001" });
    expect(sent.status).toBe(202);
    expect(sent.body.queued).toBe(true);
    const again = await api("POST", `/api/groups/${desk.id}/messages`, { text: "second thing, while you work", sendId: "send-two-000000001" });
    expect(again.body.queueId).toBe(sent.body.queueId);
    const conflict = await api("POST", `/api/groups/${desk.id}/messages`, { text: "something else", sendId: "send-two-000000001" });
    expect(conflict.status).toBe(409);
    // off the transcript until the room is free
    expect((await messages(desk.threadId)).some((m) => m.text === "second thing, while you work")).toBe(false);

    await fixture.restart();
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    writeFileSync(gate, "");
    await expect.poll(async () => {
      const thread = await messages(desk.threadId);
      const at = thread.findIndex((m) => m.role === "user" && m.text === "second thing, while you work");
      return at >= 0 && thread.slice(at + 1).some((m) => m.from?.botId === quinn.id && m.kind === "text");
    }, { timeout: 45000 }).toBe(true).catch(async (error) => { throw new Error(`${error}\n${lines(await messages(desk.threadId))}`); });
    const thread = await messages(desk.threadId);
    const copies = thread.filter((m) => m.role === "user" && m.text === "second thing, while you work");
    expect(copies).toHaveLength(1);
    expect(copies[0].queueId).toBe(sent.body.queueId);
    expect(copies[0].requestId).toBe(sent.body.queueId);
    // it waited for the next launch: nothing queued starts while Murage closes
    expect(thread.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["first thing", "second thing, while you work"]);
    await expect.poll(() => idle(desk.id), { timeout: 20000 }).toBe(true);
  }, 150000);

  it("a teammate's result wakes the lead, which answers without the owner typing again", async () => {
    await hideEveryone();
    const lead = await bot("Finch", "lead");
    const worker = await bot("Jax", "verification"); // newest first: list_bots names Jax first
    const team = await room("Team", [lead.id, worker.id], { kind: "member", botId: lead.id });
    expect((await api("POST", `/api/groups/${team.id}/messages`, { text: "LEAD_ASSIGN: get Jax to do it" })).status).toBe(202);
    await expect.poll(async () => (await messages(team.threadId)).some((m) => m.from?.botId === lead.id && /lead saw the result and is done/.test(m.text ?? "")), { timeout: 60000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${lines(await messages(team.threadId))}`); });
    const thread = await messages(team.threadId);
    expect(thread.filter((m) => m.role === "user")).toHaveLength(1);
    const result = thread.find((m) => /replied to the delegated task/.test(m.text ?? ""));
    expect(result.to).toEqual([lead.id]);
    // SPEC-P 10: the result and the woken lead's answer both answer the
    // owner's message, in this thread (the AFTER-PF run lost both)
    const owner = thread.find((m) => m.role === "user");
    expect(result.replyToId).toBe(owner.id);
    await expect.poll(async () => (await messages(team.threadId)).find((m) => m.from?.botId === lead.id && /lead saw the result and is done/.test(m.text ?? ""))?.replyToId, { timeout: 20000 }).toBe(owner.id);
    const requests = (await api("GET", `/api/groups/${team.id}/requests`)).body.requests as any[];
    expect(requests.filter((request) => request.verb === "wake")).toHaveLength(1);
    expect(requests.find((request) => request.verb === "ask").state).toBe("done");
    await expect.poll(() => idle(team.id), { timeout: 20000 }).toBe(true);
  }, 120000);

  it("bot-level Stop ends the bot's live turns in its own chat and in a room at once", async () => {
    await hideEveryone();
    const quinn = await bot("Quinn3", "piGate");
    const desk = await room("Stop room", [quinn.id]);
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/bots/${quinn.id}/messages`, { threadId: quinn.threadId, text: "work in your own chat" })).status).toBeLessThan(300);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    rmSync(`${gate}.waiting`, { force: true });
    // busy in its own chat, and still admitted in the room under its thread ceiling
    expect((await api("POST", `/api/groups/${desk.id}/messages`, { text: "and here too" })).status).toBe(202);
    await expect.poll(async () => (await groupState(desk.id)).busyBotId, { timeout: 15000 }).toBe(quinn.id);
    expect((await messages(desk.threadId)).some((m) => /busy right now/.test(m.tool?.name ?? ""))).toBe(false);
    expect((await api("POST", `/api/bots/${quinn.id}/interrupt`, { all: "yes" })).status).toBe(400);
    const stop = await api("POST", `/api/bots/${quinn.id}/interrupt`, { all: true });
    expect(stop.status).toBe(200);
    expect(stop.body.stopped).toBe(2);
    await expect.poll(() => idle(desk.id), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === quinn.id).busy, { timeout: 20000 }).toBe(false);
    writeFileSync(gate, "");
  }, 90000);

  it("who a bot can message is set on the desktop, validated, and shown on the bot", async () => {
    await hideEveryone();
    const a = await bot("Ada", "verification"), b = await bot("Bex", "verification");
    expect((await api("PATCH", `/api/bots/${a.id}/message-allow`, { mode: "list", botIds: [b.id] })).body).toEqual({ messageAllow: { mode: "list", botIds: [b.id] } });
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((x: any) => x.id === a.id).messageAllow).toEqual({ mode: "list", botIds: [b.id] });
    expect((await api("PATCH", `/api/bots/${a.id}/message-allow`, { mode: "list", botIds: [a.id] })).status).toBe(400);
    // Ids of deleted bots are dropped rather than refused (message-allow.ts), so an unknown id leaves an empty list.
    expect((await api("PATCH", `/api/bots/${a.id}/message-allow`, { mode: "list", botIds: ["no-such-bot"] })).body).toEqual({ messageAllow: { mode: "list", botIds: [] } });
    expect((await api("PATCH", `/api/bots/${a.id}/message-allow`, { mode: "anyone" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${a.id}/message-allow`, { mode: "team" })).body).toEqual({ messageAllow: { mode: "team" } });
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((x: any) => x.id === a.id).messageAllow).toBeUndefined();
    // desktop only: a caller without the desktop proof is refused
    const bare = await fetch(`${fixture.info.url}/api/bots/${a.id}/message-allow`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "team" }) });
    expect(bare.status).toBe(404);
  }, 60000);

  it("a turn queued for words nobody proved were the owner's gets no owner material, even after the owner writes (SPEC-P 6.1)", async () => {
    await hideEveryone();
    const { readFileSync, rmSync: rm, writeFileSync: write } = await import("node:fs");
    const tess = await bot("Tessa", "verification"), uma = await bot("Uma", "verification");
    expect((await api("PUT", `/api/bots/${tess.id}/memory`, { text: "# Memory\n\n- NOTEBOOK_CANARY_OWNER_ONLY the launch is Tuesday\n" })).status).toBe(200);
    const hold = await room("Hold room", [tess.id], { kind: "member", botId: tess.id });
    const office = await room("Script office", [tess.id, uma.id], { kind: "member", botId: tess.id });
    const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { pid: number; prompt: unknown; systemPrompt: string | null }; } catch { return null; } };
    rm(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/groups/${hold.id}/messages`, { text: "__fixture_hold_authority__ hold-tessa" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes("hold-tessa"), { timeout: 15000 }).toBe(true);
    const held = dump()!.pid;
    // words from a caller that proved nothing (no desktop proof): Tessa is speaking elsewhere, so it waits
    const unproven = await fetch(`${fixture.info.url}/api/groups/${office.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "@Tessa question from a script" }) });
    expect(unproven.status).toBe(202);
    await expect.poll(async () => (await messages(office.threadId)).some((m) => m.actorKind === "murage" && /Tessa is busy right now/.test(m.tool?.name ?? "")), { timeout: 15000 }).toBe(true);
    // the owner writes next, to someone else
    expect((await api("POST", `/api/groups/${office.id}/messages`, { text: "@Uma owner question" })).status).toBe(202);
    await expect.poll(async () => (await messages(office.threadId)).some((m) => m.from?.botId === uma.id && m.kind === "text"), { timeout: 20000 }).toBe(true);
    await expect.poll(() => idle(office.id), { timeout: 20000 }).toBe(true);
    rm(fixture.fixtureDumpPath, { force: true });
    write(join(fixture.fixtureFinishGateDir, String(held)), "");
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes("question from a script"), { timeout: 30000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${lines(await messages(office.threadId))}`); });
    const queued = dump()!;
    expect(queued.systemPrompt ?? "").not.toContain("NOTEBOOK_CANARY_OWNER_ONLY");
    await expect.poll(() => idle(office.id), { timeout: 20000 }).toBe(true);
    await expect.poll(() => idle(hold.id), { timeout: 20000 }).toBe(true);
  }, 90000);

  it("an audience flip mid-session gives a new session (SPEC-P 13.1)", async () => {
    await hideEveryone();
    const vee = await bot("Vee", "verification");
    const { readFileSync, rmSync: rm } = await import("node:fs");
    const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { pid: number; argv: string[] };
    const settle = () => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === vee.id).busy, { timeout: 20000 }).toBe(false);
    // memory off: with memory on every turn re-prepares its context and starts
    // a new session anyway, which would prove nothing here
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    rm(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${vee.id}/messages`, { threadId: vee.threadId, text: "one, from the owner" })).status).toBeLessThan(300);
    await settle();
    const first = dump();
    expect((await api("POST", `/api/bots/${vee.id}/messages`, { threadId: vee.threadId, text: "two, from the owner" })).status).toBeLessThan(300);
    await settle();
    // the owner's second turn keeps the owner's session (same process or a resume of it)
    const second = dump();
    expect(second.pid === first.pid || second.argv.includes("--resume"), JSON.stringify({ first: [first.pid, first.argv.filter((a) => a.startsWith("--"))], second: [second.pid, second.argv.filter((a) => a.startsWith("--"))] })).toBe(true);
    // words no owner surface proved it sent: another audience, so a new session
    const unproven = await fetch(`${fixture.info.url}/api/bots/${vee.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: vee.threadId, text: "three, unproven" }) });
    expect(unproven.status).toBeLessThan(300);
    await settle();
    const third = dump();
    expect(third.pid).not.toBe(second.pid);
    expect(third.argv).not.toContain("--resume");
    // and back to the owner: not the unproven session either
    expect((await api("POST", `/api/bots/${vee.id}/messages`, { threadId: vee.threadId, text: "four, from the owner" })).status).toBeLessThan(300);
    await settle();
    const fourth = dump();
    expect(fourth.pid).not.toBe(third.pid);
    expect(fourth.argv).not.toContain("--resume");
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
  }, 90000);

  it("a lead that keeps handing work over is paused after six team steps, with one line", async () => {
    await hideEveryone();
    const lead = await bot("Loop", "looper");
    const worker = await bot("Jax2", "verification");
    const team = await room("Loop room", [lead.id, worker.id], { kind: "member", botId: lead.id });
    expect((await api("POST", `/api/groups/${team.id}/messages`, { text: "LEAD_ASSIGN: keep going" })).status).toBe(202);
    await expect.poll(async () => (await messages(team.threadId)).some((m) => m.actorKind === "murage" && /Paused: 6 team steps/.test(m.tool?.name ?? "")), { timeout: 120000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${lines(await messages(team.threadId))}`); });
    await expect.poll(() => idle(team.id), { timeout: 30000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const requests = (await api("GET", `/api/groups/${team.id}/requests`)).body.requests as any[];
    // six wakes ran; the seventh hand-over was refused at the ask, with the one line
    expect(requests.filter((request) => request.verb === "wake" && request.state === "done")).toHaveLength(6);
    expect(requests.some((request) => request.state === "running" || request.state === "queued")).toBe(false);
    expect((await messages(team.threadId)).filter((m) => /Paused: 6 team steps/.test(m.tool?.name ?? ""))).toHaveLength(1);
    // "continue" is a new owner message with a fresh budget: the lead runs again under it
    const turnsBefore = requests.filter((request) => request.verb === "room_turn").length;
    expect((await api("POST", `/api/groups/${team.id}/messages`, { text: "continue, LEAD_ASSIGN" })).status).toBe(202);
    await expect.poll(async () => ((await api("GET", `/api/groups/${team.id}/requests?limit=100`)).body.requests as any[])
      .filter((request) => request.verb === "room_turn" && request.toBotId === lead.id && request.state !== "queued").length, { timeout: 30000 }).toBeGreaterThan(turnsBefore);
    // stop the loop: interrupt the room and drop what waits
    await api("POST", `/api/groups/${team.id}/interrupt`, {});
    for (const request of (await api("GET", `/api/groups/${team.id}/requests?open=1`)).body.requests) await api("POST", `/api/groups/${team.id}/requests/${request.id}/cancel`, {});
  }, 200000);
});
