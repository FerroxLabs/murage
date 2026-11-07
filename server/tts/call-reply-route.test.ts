import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CallSpeechCoordinator, type CallSpeechReady } from "./call-coordinator.ts";
import { handleCallReply, type CallReplyRouteDeps } from "./call-reply-route.ts";
import { REST_ON_SCREEN } from "./speech-source.ts";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(synthesize?: CallReplyRouteDeps["synthesize"]) {
  const ready: CallSpeechReady[] = [];
  let visible = true;
  const speech = new CallSpeechCoordinator((_session, bot) => visible && bot === "bot");
  speech.attach({ callId: "call", threadId: "thread", targetId: "bot", principal: "owner" }, {}, event => { if (event.type === "call.speech.ready") ready.push(event); return true; });
  const provider = vi.fn(synthesize ?? (async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" })));
  const server = createServer((req, res) => {
    void handleCallReply(req, res, {
      readBody: async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); },
      speech,
      principal: (call, thread) => req.headers.authorization === "owner" && call === "call" && thread === "thread" ? "owner" : null,
      synthesize: provider,
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tts/call/reply`;
  const post = (body: unknown, authorization = "owner", signal?: AbortSignal) => fetch(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const seal = (text: string, generation = "generation") => {
    speech.begin("thread", "bot", generation);
    for (const [i, char] of [...text].entries()) speech.append("thread", "bot", generation, `delta-${i}`, char);
    expect(provider).not.toHaveBeenCalled();
    speech.item("thread", "bot", generation, "item", text);
    speech.settle("thread", "bot", generation, "message", true);
    return { callSessionId: "call", threadId: "thread", replyId: ready.at(-1)!.replyId };
  };
  return { speech, provider, post, seal, ready, url, hide: () => { visible = false; } };
}
describe("D24 call audio subscription", () => {
  it.each(["| ![password](x): |\n| --- |\nhunter2", "```\n![password](x):\n```\nhunter2", "    ![password](x):\nhunter2", "| <img alt=\"password\">: |\n| --- |\nhunter2", "```\n<img alt=\"password\">:\n```\nhunter2", "    <img alt=\"password\">:\nhunter2", "password: correct horse. battery staple.", "<img alt='password'>: hunter2", "```\npassword:\n```\nhunter2", "<murage-goal>password:</murage-goal> hunter2"])("protects the complete source before actual route synthesis: %s", async source => {
    const f = await fixture();
    const body = f.seal(source);
    const response = await f.post(body);
    expect(response.status).toBe(200);
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames.at(-1)).toEqual({ type: "complete" });
    expect(f.provider).toHaveBeenCalled();
    expect(f.provider.mock.calls.map(call => call[0]).join(" ")).not.toMatch(/hunter2|correct horse|battery staple/);
    expect((await f.post(body)).status).toBe(409);
  });
  it.each([
    ["finished sentences", "Hi there, friend. I'm checking the deploy now.", "Hi there, friend. I'm checking the deploy now."],
    ["first clause and later sentences", "Sure, I can pull that together for you, and send it after lunch. Anything else?", "Sure, I can pull that together for you, and send it after lunch. Anything else?"],
    ["clause boundary", "Sure, I can pull that together for you, and send it.", "Sure, I can pull that together for you, and send it."],
    ["later clause", "Okay, that one is done. I can pull that together for you, and send it after lunch.", "Okay, that one is done. I can pull that together for you, and send it after lunch."],
    ["code before clause", "Sure, here is the fix for you ```ts\nconst a = 1;\n``` and then, after that we are done.", "Sure, here is the fix for you code omitted and then, after that we are done."],
    ["four sentences", "One is first. Two is second. Three is third. Four is last.", "One is first. Two is second. Three is third. Four is last."],
    ["short settled block", "Done. The deploy is green.", "Done. The deploy is green."],
    ["code followed by prose", "Here is the fix.\n```ts\nconst a = 1;\n```\nThat is all.", "Here is the fix. code omitted That is all."],
    // red-at-head: benign goal tag; HEAD keeps surrounding prose.
    ["goal followed by prose", 'Plan is set for today. <murage-goal>{"goal":"secret words"}</murage-goal> Next up is the review.', REST_ON_SCREEN],
    ["tiny and lone sentences", "Sure. I will check the deploy now. Ok.", "Sure. I will check the deploy now. Ok."],
  ])("room outcome moves to sealed route rendering: %s", async (_name, source, expected) => {
    const f = await fixture();
    const response = await f.post(f.seal(source));
    expect((await response.text()).trim().split("\n").map(line => JSON.parse(line)).at(-1)).toEqual({ type: "complete" });
    expect(f.provider.mock.calls.map(call => call[0]).join(" ")).toBe(expected);
  });
  it("H-A3-2 actual RoomReplyVoice and Speaker consume server identity and audio without resubmitting text", async () => {
    const { RoomReplyVoice } = await import("../../src/lib/" + "group-call-stream.ts");
    const { Speaker } = await import("../../src/lib/tts/" + "index.ts");
    const f = await fixture();
    const actualFetch = globalThis.fetch;
    const fetcher = vi.fn((url: string, init?: RequestInit) => actualFetch(url === "/api/tts/call/reply" ? f.url : url, { ...init, headers: { ...init?.headers, authorization: "owner" } }));
    vi.stubGlobal("fetch", fetcher);
    const speaker = new Speaker();
    const play = vi.fn(async () => "ended");
    speaker.useOutput({ play, teardown() {}, pause() {}, resume() {}, streams: false });
    let playing: Promise<boolean> | undefined;
    const voice = new RoomReplyVoice((_member: unknown, reply: { callSessionId: string; replyId: string; threadId: string }) => { playing = speaker.playCallReply(reply); });
    try {
      for (const [index, source] of ["password: correct horse. battery staple.", "<img alt='password'>: hunter2", "```\npassword:\n```\nhunter2", "First sentence. Second sentence."].entries()) {
        f.provider.mockClear();
        f.seal(source, `generation-${index}`);
        const event = f.ready.at(-1)!;
        voice.ready({ id: "bot" }, { ...event, callSessionId: event.callId });
        expect(await playing).toBe(true);
        expect(f.provider.mock.calls.map(call => call[0]).join(" ")).not.toMatch(/hunter2|correct horse|battery staple/);
      }
      expect(f.provider.mock.calls.map(call => call[0])).toEqual(["First sentence.", "Second sentence."]);
      expect(play).toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => url === "/api/tts/call/reply")).toBe(true);
      expect(fetcher.mock.calls.every(([, init]) => Object.keys(JSON.parse(init!.body as string)).sort().join(",") === "callSessionId,replyId,threadId")).toBe(true);
    } finally { speaker.stop(); vi.unstubAllGlobals(); }
  });
  it("refuses raw text, forged and cross-principal identities before any synthesis", async () => {
    const f = await fixture(); const body = f.seal("A benign reply.");
    expect((await f.post({ ...body, text: "forged" })).status).toBe(400);
    expect((await f.post(body, "someone-else")).status).toBe(404);
    expect((await f.post({ ...body, threadId: "other" })).status).toBe(404);
    expect((await f.post({ ...body, replyId: "forged" })).status).toBe(409);
    expect(f.provider).not.toHaveBeenCalled();
    expect((await f.post(body)).status).toBe(200);
  });
  it("Stop cancels a provider reader and releases no late audio", async () => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn();
    const f = await fixture(async () => ({ mime: "audio/mpeg", stream: new ReadableStream<Uint8Array>({ start: () => started(), cancel }) }));
    const body = f.seal("A benign reply.");
    const request = f.post(body).then(response => response.text()).catch(() => "closed");
    await entered;
    f.speech.invalidate("thread");
    expect(await request).toBe('{"type":"failed"}\n');
    expect(cancel).toHaveBeenCalledOnce();
    expect((await f.post(body)).status).toBe(409);
  });
  it("membership loss during synthesis prevents audio delivery", async () => {
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const released = new Promise<void>(resolve => { finish = resolve; });
    const f = await fixture(async () => { started(); await released; return { mime: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]) }; });
    const response = f.post(f.seal("A benign reply.")).then(res => res.text());
    await entered; f.hide(); finish();
    expect(await response).toBe('{"type":"failed"}\n');
  });
  it("a truncated provider stream sends failed, never complete or a playable partial clip", async () => {
    const f = await fixture(async () => ({ mime: "audio/mpeg", stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("private synthetic diagnostic")); } }) }));
    const response = await f.post(f.seal("A benign reply."));
    expect(await response.text()).toBe('{"type":"failed"}\n');
  });
});
