import WebSocket from "ws";
// The 0.1.59 call routes on the REAL harness (index.ts wiring, the store, the
// desktop gate), with the fast model and Flux audio pointed at a local stub so
// nothing leaves the machine. Unit tests cover the modules with injected
// dependencies; this proves the server hands them the right ones.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let stub: Server;
let stubUrl = "";
let desktop: Record<string, string>;
const seen: Array<{ path: string; body: any }> = [];
/** Flux's GET /v1/audio/voices for the stub key, as flux-router master
 *  answers it: filtered to the key, each row tagged with its entitlement. */
const ELEVEN = ["Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River", "Liam", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Adam", "Bill"];
const voiceList = (eleven: string[], entitlement = "open") => ({
  object: "list",
  data: [{ id: "marin", model: "flux-voice-speak" }, ...eleven.map((id) => ({ id, model: "flux-voice-speak-eleven" }))].map((row) => ({ ...row, name: row.id, entitlement })),
});
let fluxVoiceList: unknown = voiceList(ELEVEN);
const callSockets: WebSocket[] = [];
const callHeaders = new Map<string, Record<string, string>>();
let hostRefusal: { status: number; body: string } | null = null;

beforeAll(async () => {
  // Stands in for Flux: records every request, answers chat with two SSE
  // sentences, and answers Flux's voice list from `fluxVoiceList`.
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      seen.push({ path: req.url ?? "", body });
      if (req.url?.endsWith("/chat/completions") && body?.stream) {
        if (hostRefusal) { res.writeHead(hostRefusal.status, { "content-type": "application/json" }); res.end(hostRefusal.body); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const content of ["Your board is ready. ", "Two approvals are waiting."]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/audio/voices")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fluxVoiceList));
        return;
      }
      if (req.url?.endsWith("/audio/speech")) {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(Buffer.from([0xff, 0xf3, 0x44, 0xc4]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  stubUrl = `http://127.0.0.1:${address.port}/v1`;
  // The fixture passes almost no parent environment through; set the stub
  // endpoints inside the child before the server loads. The stub key must be
  // Flux-shaped (sk-flux-): any other value is never treated as a Flux key.
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: [
      `process.env.MURAGE_VOICE_ROUTE_BASE=${JSON.stringify(stubUrl)};`,
      `process.env.MURAGE_FLUX_AUDIO_API=${JSON.stringify(stubUrl)};`,
      `process.env.FLUX_API_KEY="sk-flux-stub-key";`,
      `const { DatabaseSync } = await import("node:sqlite"); const { existsSync } = await import("node:fs"); const { join } = await import("node:path");`,
      `const prepare = DatabaseSync.prototype.prepare; DatabaseSync.prototype.prepare = function(sql) { const stmt = prepare.call(this, sql); if (sql.startsWith("INSERT INTO speech_threads(thread_id,revision) VALUES(?,1)")) { const run = stmt.run.bind(stmt); stmt.run = (...args) => { if (existsSync(join(process.env.MURAGE_DATA_DIR, "d24-write-fault"))) throw new Error("fixture durable write failure"); return run(...args); }; } return stmt; };`,
      `const { SseWriter } = await import(${JSON.stringify(new URL("./sse-buffer.ts", import.meta.url).href)}); const send = SseWriter.prototype.send; SseWriter.prototype.send = function(frame) { if (frame.includes('"speech.sessionClosed"') && existsSync(join(process.env.MURAGE_DATA_DIR, "d24-drop-control"))) return false; return send.call(this, frame); };`,

    ].join("\n"),
  });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30_000);

afterAll(async () => {
  for (const socket of callSockets) socket.terminate();
  await fixture?.close();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

async function api<T = any>(method: string, path: string, body?: unknown, headers = desktop): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, text };
}

async function openCall(bot: { id: string; threadId: string }, caller = desktop) {
  const device = "desktop:fixture";
  const opened = await api("POST", "/api/calls/sessions", { botId: bot.id, threadId: bot.threadId, device }, caller);
  expect(opened.status).toBe(200);
  const callId = opened.body.callId;
  const ticket = await api("POST", `/api/calls/sessions/${callId}/ticket`, { device }, caller);
  expect(ticket.status).toBe(200);
  const socket = new WebSocket(fixture.info.url.replace("http:", "ws:") + `/api/calls/sessions/${callId}/live?ticket=${ticket.body.ticket}`, { headers: caller });
  callSockets.push(socket);
  const events: any[] = [];
  socket.on("message", bytes => events.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const headers = { ...caller, "x-murage-call-id": callId };
  callHeaders.set(bot.id, headers);
  return { events, headers };
}

async function settledBot(): Promise<{ id: string; threadId: string }> {
  const { body } = await api("POST", "/api/bots", { name: "Sable", modelSelection: { instanceId: "verification", model: "fake" } });
  const bot = body.bot;
  await openCall(bot);
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "Pull today's board together.", threadId: bot.threadId });
  for (let i = 0; i < 100; i += 1) {
    const { body: thread } = await api("GET", `/api/threads/${bot.threadId}/messages`);
    if (thread.messages?.some((m: any) => m.role === "bot" && m.text === "hello from fake claude")) return bot;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the fake engine never answered");
}

it("the voice host speaks from the bot's real thread, desktop only, and never writes to it", async () => {
  const bot = await settledBot();
  const call = { headers: callHeaders.get(bot.id)! };
  const before = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.length;

  const warm = await api("POST", `/api/bots/${bot.id}/voice-host`, { warm: true });
  expect(warm.status).toBe(202);

  const turn = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "What's on the board?", threadId: bot.threadId }, call.headers);
  expect(turn.status).toBe(200);
  const events = turn.text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice(5)));
  expect(events).toEqual([
    { type: "sentence", text: "Your board is ready." },
    { type: "sentence", text: "Two approvals are waiting." },
    { type: "done" },
    { type: "audio", callSessionId: expect.any(String), threadId: bot.threadId, replyId: expect.any(String) },
  ]);
  const modelCall = seen.filter((s) => s.path.endsWith("/chat/completions") && s.body?.stream).at(-1)!;
  const system = modelCall.body.messages[0].content as string;
  expect(system).toContain("You are Sable");
  expect(system).toContain("Owner: Pull today's board together.");
  expect(system).toContain("You: hello from fake claude");
  expect(modelCall.body.messages.at(-1)).toEqual({ role: "user", content: "What's on the board?" });

  // read only: the host's turn added nothing to the transcript
  expect((await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.length).toBe(before);

  // not from a phone or any non-desktop surface: the snapshot includes the inbox
  const calls = seen.length;
  const remote = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "hi" }, { "content-type": "application/json" });
  expect(remote.status).toBeGreaterThanOrEqual(400);
  expect(seen.length).toBe(calls);
}, 60_000);

it("a call leaves one note in the thread, and an empty call leaves nothing", async () => {
  const bot = await settledBot();
  const count = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.length;
  const before = await count();
  const empty = await api("POST", `/api/bots/${bot.id}/call-note`, { threadId: bot.threadId, durationMs: 30_000, log: [] });
  expect(empty.body).toEqual({ ok: true, written: false });
  expect(await count()).toBe(before);

  const note = await api("POST", `/api/bots/${bot.id}/call-note`, {
    threadId: bot.threadId,
    durationMs: 3 * 60_000,
    log: [{ said: "What's on the board?", outcome: "answered", detail: "Your board is ready." }],
  });
  expect(note.body).toEqual({ ok: true, written: true });
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
  // the owner's words as an owner row, then Murage's status line (LINEAGE-DESIGN-S6 rule 21); the call's answers are in neither
  expect(messages.length).toBe(before + 2);
  expect(messages.at(-2)).toMatchObject({ role: "user", kind: "text", text: "What's on the board?", actorKind: "owner" });
  expect(messages.at(-1).murage?.status).toEqual({ key: "call_ended", data: { minutes: 3 } });
  expect(messages.at(-1).text ?? messages.at(-1).tool?.name).toBe("The voice call ended after 3 min.");
  expect(JSON.stringify(messages.slice(-2))).not.toContain("Your board is ready");

  const remote = await api("POST", `/api/bots/${bot.id}/call-note`, { log: [{ said: "x", outcome: "answered" }] }, { "content-type": "application/json" });
  expect(remote.status).toBeGreaterThanOrEqual(400);
  expect(await count()).toBe(before + 2);
}, 60_000);

it("with Flux as the voice engine the 41 Flux voices (OpenAI and Grok) are listed, plus ElevenLabs' when Flux's voice list offers them", async () => {
  const put = await api("PUT", "/api/config", { tts: { provider: "flux" } });
  expect(put.status).toBe(200);
  const requests = seen.length;
  const voices = await api("GET", "/api/tts/voices");
  expect(voices.body.voices).toHaveLength(61);
  expect(voices.body.fluxEleven).toBe("on");
  // Grok voices lead the list, since they are what a bot starts with
  expect(voices.body.voices.slice(0, 28).every((v: { provider: string }) => v.provider === "grok")).toBe(true);
  expect(voices.body.voices.slice(41).every((v: { provider: string }) => v.provider === "elevenlabs")).toBe(true);
  expect(voices.body.voices.find((v: { id: string }) => v.id === "marin")).toMatchObject({ label: "Nora", gender: "female", provider: "openai" });
  expect(voices.body.voices.find((v: { id: string }) => v.id === "ara")).toMatchObject({ gender: "female", provider: "grok" });
  // the one request is Flux's free voice list; nothing is spoken to find out
  expect(seen.slice(requests).map((s) => s.path)).toEqual(["/v1/audio/voices"]);
  // kept: opening the list again does not ask Flux again
  await api("GET", "/api/tts/voices");
  expect(seen.length).toBe(requests + 1);
});

it("GET /api/tts/voices says why ElevenLabs' voices are missing (fluxEleven), and Check again reads Flux's list now", async () => {
  await api("PUT", "/api/config", { tts: { provider: "flux" } });
  try {
    fluxVoiceList = voiceList(ELEVEN, "premium_locked");
    // kept from the read before: unchanged until the owner checks again
    expect((await api("GET", "/api/tts/voices")).body.fluxEleven).toBe("on");
    const locked = await api("GET", "/api/tts/voices?recheck=1");
    expect(locked.body.fluxEleven).toBe("locked");
    expect(locked.body.voices).toHaveLength(41);

    fluxVoiceList = voiceList([]);
    const notOnKey = await api("GET", "/api/tts/voices?recheck=1");
    expect(notOnKey.body.fluxEleven).toBe("notOnKey");
    expect(notOnKey.body.voices.some((v: { provider: string }) => v.provider === "elevenlabs")).toBe(false);

    fluxVoiceList = voiceList(["Aria"]);
    const fixed = await api("GET", "/api/tts/voices?recheck=1");
    expect(fixed.body.fluxEleven).toBe("on");
    expect(fixed.body.voices.filter((v: { provider: string }) => v.provider === "elevenlabs").map((v: { id: string }) => v.id)).toEqual(["Aria"]);

    // another service's list carries no fluxEleven field
    const xai = await api("GET", "/api/tts/voices?provider=xai");
    expect(xai.body).not.toHaveProperty("fluxEleven");
  } finally {
    fluxVoiceList = voiceList(ELEVEN);
    await api("GET", "/api/tts/voices?recheck=1");
  }
});

it("each agent speaks with its own voice service, chosen on the agent", async () => {
  const { body } = await api("POST", "/api/bots", { name: "Rex", modelSelection: { instanceId: "verification", model: "fake" } });
  const bot = body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, { voiceProvider: "xai", voice: "rex" });
  expect(patched.status).toBe(200);
  // this workspace has no xAI key of its own but has Flux: xAI's voice
  // "rex" is spoken through Flux's xAI alias, not swapped for an OpenAI voice
  const before = seen.length;
  const spoke = await api("POST", "/api/tts/speak", { text: "Morning.", voiceId: "rex", botId: bot.id });
  expect(spoke.status).toBe(200);
  expect(seen.slice(before)).toEqual([{ path: "/v1/audio/speech", body: { model: "flux-voice-speak-grok", input: "Morning.", voice: "rex", response_format: "mp3" } }]);
  const voices = await api("GET", `/api/tts/voices?provider=xai`);
  expect(voices.body.voices).toHaveLength(28);
  const config = await api("GET", "/api/config");
  expect(config.body.tts.available).toMatchObject({ xai: true });
});


it("D24 phone code omission moves to the real prepare/speak provider boundary", async () => {
  await api("PUT", "/api/config", { tts: { provider: "flux" } });
  const prepared = await api("POST", "/api/tts/prepare", { text: "Hello.\n```\ncode\n```", voiceId: "marin" });
  expect(prepared.status).toBe(200);
  const before = seen.length;
  for (const text of prepared.body.utterances) {
    expect((await api("POST", "/api/tts/speak", { text, voiceId: "marin" })).status).toBe(200);
  }
  const payloads = seen.slice(before).filter((s) => s.path.endsWith("/audio/speech")).map((s) => s.body.input);
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.join(" ")).toContain("Hello.");
  expect(payloads.join(" ").toLowerCase()).toContain("code omitted");
  expect(payloads.join(" ")).not.toContain("```");
});

it.each([
  "```\npassword:\n```\nhunter2",
  "    password:\n\nhunter2",
  "<tool_output>password:</tool_output>\nhunter2",
  "| ![password](x): |\n| --- |\nhunter2",
  "```\n![password](x):\n```\nhunter2",
  "    ![password](x):\nhunter2",
  "| <img alt=\"password\">: |\n| --- |\nhunter2",
  "```\n<img alt=\"password\">:\n```\nhunter2",
  "    <img alt=\"password\">:\nhunter2",
  "![password](x): hunter2",
  "[password](https://example.test): hunter2",
  '<img alt="password">: hunter2',
])("D24 complete source reaches prepare before omission: %s", async (text) => {
  await api("PUT", "/api/config", { tts: { provider: "flux" } });
  const prepared = await api("POST", "/api/tts/prepare", { text, voiceId: "marin" });
  expect(prepared.status).toBe(200);
  expect(JSON.stringify(prepared.body.utterances)).not.toContain("hunter2");
  const before = seen.length;
  for (const utterance of prepared.body.utterances) {
    expect((await api("POST", "/api/tts/speak", { text: utterance, voiceId: "marin" })).status).toBe(200);
  }
  const payloads = seen.slice(before).filter((s) => s.path.endsWith("/audio/speech"));
  expect(payloads.length).toBeGreaterThan(0);
  expect(JSON.stringify(payloads)).not.toContain("hunter2");
});


it.each(["direct", "room"])("H-A3-1 %s phone action preserves raw source through Speaker and real routes", async (conversation) => {
  await api("PUT", "/api/config", { tts: { provider: "flux" } });
  const phone = { "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": process.env.MURAGE_TEST_DOOR_TOKEN! };
  const realFetch = globalThis.fetch;
  const prepared: string[] = [];
  // Load the browser helper through Vite, without adding DOM sources to the server tsc project.
  const { toggleReadAloud } = await import("../src/lib/" + "read-aloud.ts");
  const { Speaker } = await import("../src/lib/tts/" + "index.ts");
  const sp = new Speaker();
  sp.useOutput({ streams: false, play: async () => "ended", pause() {}, resume() {}, teardown() {} });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (typeof input === "string" && (input.startsWith("/api/tts/") || input === "/api/config")) {
      if (input.endsWith("/prepare")) prepared.push(JSON.parse(String(init?.body)).text);
      return realFetch(fixture.info.url + input, { ...init, headers: phone });
    }
    return realFetch(input, init);
  });
  try {
    const phoneSurface = await import("../src/lib/" + "surface.ts");
    await phoneSurface.surface();
    expect(phoneSurface.knownComputer()).toBe(false);
    for (const text of ["Hello.\n```\ncode\n```", "```\npassword:\n```\nhunter2", "    password:\n\nhunter2", "<tool_output>password:</tool_output>\nhunter2"]) {
      const before = seen.length;
      toggleReadAloud(sp, { text, messageId: conversation + "-message", voiceId: "marin" });
      await vi.waitFor(() => expect(sp.state.status).toBe("idle"));
      expect(sp.state.error).toBeUndefined();
      expect(prepared.at(-1)).toBe(text);
      const payloads = seen.slice(before).filter((s) => s.path.endsWith("/audio/speech"));
      expect(payloads.length).toBeGreaterThan(0);
      expect(JSON.stringify(payloads)).not.toContain("hunter2");
      if (text.startsWith("Hello.")) expect(payloads.map((s) => s.body.input).join(" ")).toContain("code omitted");
    }
  } finally { sp.stop(); vi.restoreAllMocks(); }
});


it("L-FR33-1 real brief and ordinary routes log refusal metadata without response bodies", async () => {
  const { body } = await api("POST", "/api/bots", { name: "Refusal fixture", modelSelection: { instanceId: "verification", model: "fake" } });
  const call = await openCall(body.bot);
  try {
    for (const brief of [false, true]) for (const refusal of ["password: hst0001", JSON.stringify({ error: { message: "password: hst0001" } })]) {
      hostRefusal = { status: 400, body: refusal };
      let replyId: string | undefined;
      if (brief) {
        call.events.length = 0;
        await api("POST", `/api/bots/${body.bot.id}/messages`, { text: "A benign answer.", threadId: body.bot.threadId });
        await vi.waitFor(() => expect(call.events.some(event => event.type === "call.speech.ready")).toBe(true), { timeout: 10000 });
        replyId = call.events.find(event => event.type === "call.speech.ready").replyId;
      }
      const result = await api("POST", `/api/bots/${body.bot.id}/voice-host`, { text: "A benign answer.", brief, replyId }, call.headers);
      expect(result.status).toBe(200);
      expect(result.text).toContain('"type":"error"');
      expect(result.text).not.toMatch(/hst0001|password:/);
    }
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log).toContain("refusal provider=flux status=400");
    expect(log).not.toMatch(/hst0001|password:/);
  } finally { hostRefusal = null; }
});


it("P-call-admission actual paired direct host audio, hidden revocation and phone room refusal", async () => {
  const phone = { "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": process.env.MURAGE_TEST_DOOR_TOKEN!, "x-murage-stream-principal": "companion:fixture:session" };
  const bot = (await api("POST", "/api/bots", { name: "Phone call fixture", modelSelection: { instanceId: "verification", model: "fake" } })).body.bot;
  const call = await openCall(bot, phone);
  const result = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "hello", threadId: bot.threadId }, call.headers);
  expect(result.status).toBe(200);
  const audio = result.text.split("\n\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(event => event.type === "audio");
  expect(audio).toBeDefined();
  const { type: _type, ...identity } = audio;
  const other = { ...phone, "x-murage-stream-principal": "companion:other:session" };
  expect((await api("POST", "/api/tts/call/reply", identity, other)).status).toBe(404);
  const before = seen.filter(row => row.path.endsWith("/audio/speech")).length;
  const playback = await api("POST", "/api/tts/call/reply", identity, phone);
  expect(playback.status).toBe(200); expect(playback.text).toContain('"type":"complete"');
  expect(seen.filter(row => row.path.endsWith("/audio/speech")).length).toBeGreaterThan(before);
  const room = (await api("POST", "/api/groups", { name: "Phone room refusal", memberIds: [bot.id] })).body.group;
  expect((await api("POST", "/api/calls/sessions", { botId: room.id, threadId: room.threadId, device: "phone:fixture" }, phone)).status).toBe(404);
  expect((await api("POST", "/api/calls/sessions", { botId: bot.id, threadId: room.threadId, device: "phone:fixture" }, phone)).status).toBe(404);
  const pending = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "hello", threadId: bot.threadId }, call.headers);
  expect(pending.status).toBe(200);
  const next = pending.text.split("\n\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(event => event.type === "audio");
  await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
  expect((await api("POST", "/api/tts/call/reply", { callSessionId: next.callSessionId, replyId: next.replyId, threadId: next.threadId }, phone)).status).toBe(404);
});

it("S-settle real engine dispatch records generation and successful settlement, and idle owner Stop invalidates it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const bot = await settledBot();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    let settlement: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      settlement = db.prepare("SELECT s.*,g.state,g.prompt_id,g.provider_turn_id FROM speech_settlements s JOIN speech_generations g USING(generation_id) WHERE s.thread_id=?").get(bot.threadId);
      expect(settlement).toBeDefined();
    });
    expect(settlement).toMatchObject({ state: "completed", outcome: "completed" });
    expect(settlement!.prompt_id).toBeTruthy(); expect(settlement!.provider_turn_id).toBeTruthy();
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.find((message: any) => message.id === settlement!.message_id)).toMatchObject({ turnTerminal: true, speechGenerationId: settlement!.generation_id });
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stopped.status).toBe(200);
    expect(db.prepare("SELECT state FROM speech_generations WHERE generation_id=?").get(String(settlement!.generation_id))?.state).toBe("invalid");
    expect(Number(db.prepare("SELECT revision FROM speech_threads WHERE thread_id=?").get(bot.threadId)?.revision)).toBeGreaterThan(Number(settlement!.revision));
  } finally { db.close(); }
});

it("D24 real desktop routes bind to live SSE, speak historical stored replies once, and close on stream loss", async () => {
  const bot = await settledBot();
  await api("PATCH", `/api/bots/${bot.id}`, { voiceProvider: "flux", voice: "marin" });
  let message: any;
  await vi.waitFor(async () => {
    message = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.find((m: any) => m.role === "bot" && m.turnTerminal && m.kind === "text");
    expect(message).toBeDefined();
  });
  const disconnect = new AbortController();
  const stream = await fetch(fixture.info.url + "/api/events", { headers: desktop, signal: disconnect.signal });
  const reader = stream.body!.getReader(); let raw = "";
  while (!raw.includes("\n\n")) { const chunk = await reader.read(); raw += new TextDecoder().decode(chunk.value); }
  const hello = JSON.parse(raw.split("\n\n")[0].slice(6)); expect(hello.connectionId).toEqual(expect.any(String));
  const session = await api("POST", "/api/tts/reply/session", { threadId: bot.threadId, connectionId: hello.connectionId }); expect(session.status).toBe(200);
  const target = { sessionId: session.body.sessionId, threadId: bot.threadId, messageId: message.id };
  const metadata = await api("POST", "/api/tts/reply/target", target); expect(metadata.status).toBe(200); expect(metadata.body.available).toBe(true);
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  const count = seen.filter(row => row.path.endsWith("/audio/speech")).length;
  const response = await fetch(fixture.info.url + "/api/tts/reply", { method: "POST", headers: desktop, body: JSON.stringify({ ...target, action: "speak", commandSequence: 1 }) });
  expect(response.status).toBe(200);
  const { ReplyFrameReader } = await import("../shared/reply-speech.ts"); const frames: string[] = []; const parser = new ReplyFrameReader(frame => frames.push(frame.type)); parser.push(new Uint8Array(await response.arrayBuffer())); parser.finish();
  expect(frames).toEqual(["start", "audio", "complete"]); expect(seen.filter(row => row.path.endsWith("/audio/speech"))).toHaveLength(count + 1);
  expect((await api("POST", "/api/tts/reply", { ...target, action: "speak", commandSequence: 1 })).status).toBe(200);
  expect(seen.filter(row => row.path.endsWith("/audio/speech"))).toHaveLength(count + 1);
  disconnect.abort(); await reader.cancel().catch(() => {});
  await vi.waitFor(async () => expect((await api("POST", "/api/tts/reply/target", target)).status).toBe(409));
  expect((await api("POST", "/api/tts/reply/session", { threadId: bot.threadId, connectionId: hello.connectionId })).status).toBe(409);
  expect((await api("POST", "/api/tts/reply/target", target, { "content-type": "application/json" })).status).toBe(404);
});

it.each([true, false])("S-db-remote actual phone Stop revokes a downloaded desktop player, control enqueue=%s, and recovery needs a fresh session", async delivered => {
  const bot = await settledBot(); await api("PATCH", `/api/bots/${bot.id}`, { voiceProvider: "flux", voice: "marin" });
  let message: any;
  await vi.waitFor(async () => { message = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.find((m: any) => m.role === "bot" && m.turnTerminal && m.kind === "text"); expect(message).toBeDefined(); });
  const { ReplyController } = await import("../src/lib/tts/" + "reply-controller.ts");
  const players: any[] = [], bodies: any[] = [], controls: any[] = []; let sessionRevision = 0;
  const controller = new ReplyController({ enabled: true, post: async (path: string, body: unknown, signal?: AbortSignal) => { bodies.push({ path, body }); const response = await fetch(fixture.info.url + path, { method: "POST", headers: desktop, body: JSON.stringify(body), signal }); if (path.endsWith("/session") && response.ok) sessionRevision = Number((await response.clone().json() as { revision: number }).revision); return response; }, player: (_blob: unknown, ended: () => void) => { const player = { ended, play: vi.fn(async () => {}), stop: vi.fn() }; players.push(player); return player; } });
  controller.configure({ desktop: true, hydrated: true, threadId: bot.threadId, visible: true, call: false });
  const disconnect = new AbortController();
  const response = await fetch(fixture.info.url + "/api/events", { headers: desktop, signal: disconnect.signal });
  const reader = response.body!.getReader(); let hello: any;
  const pumping = (async () => {
    let pending = "";
    for (;;) {
      const part = await reader.read(); if (part.done) { controller.disconnect(); return; }
      pending += new TextDecoder().decode(part.value);
      for (;;) { const at = pending.indexOf("\n\n"); if (at < 0) break; const raw = pending.slice(0, at); pending = pending.slice(at + 2); const line = raw.split("\n").find(line => line.startsWith("data:")); if (!line) continue; const event = JSON.parse(line.slice(5));
        if (event.kind === "hello") { hello = event; controller.hello(event.connectionId, event.bootId); }
        else if (event.kind === "caught-up") controller.caughtUp();
        else { controls.push(event); controller.receive(event); }
      }
    }
  })().catch(() => controller.disconnect());
  const fault = join(fixture.info.dataDir, "d24-write-fault"), drop = join(fixture.info.dataDir, "d24-drop-control");
  try {
    await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
    controller.manual({ threadId: bot.threadId, messageId: message.id }); await vi.waitFor(() => expect(players).toHaveLength(1));
    const target = bodies.find(row => row.path === "/api/tts/reply/target").body;
    // A synthetic live candidate stands for the room's next member. No synthesis may ever launch for it.
    controller.receive({ kind: "speech.ready", threadId: bot.threadId, messageId: "queued-member", settlementId: "queued-settlement", revision: sessionRevision, bootId: hello.bootId });
    expect(controller.queue).toHaveLength(1);
    const sent = bodies.filter(row => row.path === "/api/tts/reply").length;
    writeFileSync(fault, "fixture only"); if (!delivered) writeFileSync(drop, "fixture only");
    const phone = { "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": process.env.MURAGE_TEST_DOOR_TOKEN! };
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }, phone); expect(stopped.status).toBe(503);
    await vi.waitFor(() => expect(players[0].stop).toHaveBeenCalledOnce()); if (delivered) expect(controls).toContainEqual(expect.objectContaining({ kind: "speech.sessionClosed", sessionId: target.sessionId, reason: "durable_stop_failed" }));
    else expect(controls.some(event => event.kind === "speech.sessionClosed")).toBe(false);
    expect(controller.snapshot.status).toBe("disconnected"); players[0].ended(); expect(bodies.filter(row => row.path === "/api/tts/reply")).toHaveLength(sent);
    expect((await api("POST", "/api/tts/reply/target", target)).status).toBe(409);
    expect((await api("POST", "/api/tts/reply/session", { connectionId: hello.connectionId, threadId: bot.threadId })).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 1100)); // exercise a failed coordinator recovery tick
    expect((await api("POST", "/api/tts/reply/session", { connectionId: hello.connectionId, threadId: bot.threadId })).status).toBe(409);
    unlinkSync(fault);
    if (!delivered) return; // actual stream termination above already executed the same player/queue teardown
    let recovered: any;
    await vi.waitFor(async () => { recovered = await api("POST", "/api/tts/reply/session", { connectionId: hello.connectionId, threadId: bot.threadId }); expect(recovered.status).toBe(200); }, { timeout: 4000 });
    expect(recovered.body.sessionId).not.toBe(target.sessionId); expect((await api("POST", "/api/tts/reply/target", target)).status).toBe(409); expect(controller.snapshot.status).toBe("disconnected"); expect(players).toHaveLength(1);
  } finally { try { unlinkSync(fault); } catch {} try { unlinkSync(drop); } catch {} disconnect.abort(); await reader.cancel().catch(() => {}); await pumping; controller.disconnect(); }
}, 15_000);

it("H3 failed durable phone Stop tears down call playback and refuses outstanding call speech", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Call Stop fixture", modelSelection: { instanceId: "verification", model: "fake" } })).body.bot;
  const call = await openCall(bot);
  const socket = callSockets.at(-1)!;
  const identity = async () => {
    const result = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "hello", threadId: bot.threadId }, call.headers);
    expect(result.status).toBe(200);
    const audio = result.text.split("\n\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(event => event.type === "audio");
    expect(audio).toBeDefined();
    return { callSessionId: audio.callSessionId, replyId: audio.replyId, threadId: audio.threadId };
  };
  await api("PUT", "/api/config", { tts: { provider: "flux" } });
  await api("PATCH", `/api/bots/${bot.id}`, { voiceProvider: "flux", voice: "marin" });
  const playing = await identity();
  const { Speaker } = await import("../src/lib/tts/" + "index.ts");
  const speaker = new Speaker();
  let finish!: (result: "ended" | "cut") => void;
  const teardown = vi.fn(() => finish?.("cut"));
  const play = vi.fn(() => new Promise<"ended" | "cut">(resolve => { finish = resolve; }));
  speaker.useOutput({ play, teardown, pause() {}, resume() {}, streams: false });
  socket.on("message", data => { if (JSON.parse(String(data)).type === "call.speech.invalidated") speaker.stop(); });
  socket.on("close", () => speaker.stop());
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => realFetch(input.startsWith("/") ? fixture.info.url + input : input, { ...init, headers: { ...desktop, ...init?.headers } }));
  const fault = join(fixture.info.dataDir, "d24-write-fault");
  try {
    const playback = speaker.playCallReply(playing);
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce()); teardown.mockClear();
    const pending = await identity();
    writeFileSync(fault, "fixture only");
    const phone = { "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": process.env.MURAGE_TEST_DOOR_TOKEN! };
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }, phone)).status).toBe(503);
    await vi.waitFor(() => expect(teardown).toHaveBeenCalled()); await playback;
    expect((await api("POST", "/api/tts/call/reply", pending)).status).toBeGreaterThanOrEqual(400);
  } finally { try { unlinkSync(fault); } catch { /* fixture cleanup */ } speaker.stop(); vi.unstubAllGlobals(); }
});
