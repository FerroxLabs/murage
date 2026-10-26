// The 0.1.59 call routes on the REAL harness (index.ts wiring, the store, the
// desktop gate), with the fast model and Flux audio pointed at a local stub so
// nothing leaves the machine. Unit tests cover the modules with injected
// dependencies; this proves the server hands them the right ones.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
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
    ].join("\n"),
  });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30_000);

afterAll(async () => {
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

async function settledBot(): Promise<{ id: string; threadId: string }> {
  const { body } = await api("POST", "/api/bots", { name: "Sable", modelSelection: { instanceId: "verification", model: "fake" } });
  const bot = body.bot;
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
  const before = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.length;

  const warm = await api("POST", `/api/bots/${bot.id}/voice-host`, { warm: true });
  expect(warm.status).toBe(202);

  const turn = await api("POST", `/api/bots/${bot.id}/voice-host`, { text: "What's on the board?", threadId: bot.threadId });
  expect(turn.status).toBe(200);
  const events = turn.text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice(5)));
  expect(events).toEqual([
    { type: "sentence", text: "Your board is ready." },
    { type: "sentence", text: "Two approvals are waiting." },
    { type: "done" },
  ]);
  const call = seen.filter((s) => s.path.endsWith("/chat/completions") && s.body?.stream).at(-1)!;
  const system = call.body.messages[0].content as string;
  expect(system).toContain("You are Sable");
  expect(system).toContain("Owner: Pull today's board together.");
  expect(system).toContain("You: hello from fake claude");
  expect(call.body.messages.at(-1)).toEqual({ role: "user", content: "What's on the board?" });

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
