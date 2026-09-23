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

beforeAll(async () => {
  // Stands in for Flux: records every request, answers chat with two SSE
  // sentences, and must never be asked for voices (those are local).
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  stubUrl = `http://127.0.0.1:${address.port}/v1`;
  // The fixture passes almost no parent environment through; set the stub
  // endpoints inside the child before the server loads.
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: [
      `process.env.MURAGE_VOICE_ROUTE_BASE=${JSON.stringify(stubUrl)};`,
      `process.env.MURAGE_FLUX_AUDIO_API=${JSON.stringify(stubUrl)};`,
      `process.env.FLUX_API_KEY="stub-flux-key";`,
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
  expect(messages.length).toBe(before + 1);
  expect(messages.at(-1)).toMatchObject({ role: "bot", kind: "text" });
  expect(messages.at(-1).text).toContain("**Call notes** (3 min)");

  const remote = await api("POST", `/api/bots/${bot.id}/call-note`, { log: [{ said: "x", outcome: "answered" }] }, { "content-type": "application/json" });
  expect(remote.status).toBeGreaterThanOrEqual(400);
  expect(await count()).toBe(before + 1);
}, 60_000);

it("with Flux as the voice engine the 13 voices are listed without asking Flux", async () => {
  const put = await api("PUT", "/api/config", { tts: { provider: "flux" } });
  expect(put.status).toBe(200);
  const requests = seen.length;
  const voices = await api("GET", "/api/tts/voices");
  expect(voices.body.voices).toHaveLength(13);
  expect(voices.body.voices[0]).toMatchObject({ id: "marin", label: "Marin" });
  expect(seen.length).toBe(requests);
});
