import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import * as tts from "./index.ts";
import * as system from "./system-voices.ts";
import * as windows from "./windows-voices.ts";
import { resetUnavailable } from "../voice/voice-routes.ts";
import type { Clip } from "./elevenlabs.ts";
import ts from "typescript";
import { CallSpeechCoordinator, type CallSpeechReady } from "./call-coordinator.ts";
import { handleVoiceHostRoute } from "../voice/voice-host-route.ts";
import { handleCallReply } from "./call-reply-route.ts";
import { runVoiceBrief, runVoiceHostTurn } from "../voice/voice-host.ts";

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); resetUnavailable(); tts.useVoiceRoutes({ describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }), speech: () => [] }); vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const ready: CallSpeechReady[] = [];
  const players = new Set<{ stop(): void }>();
  const sessionCode = readFileSync(new URL("../../src/lib/bot-call-session.ts", import.meta.url), "utf8");
  const clearStart = sessionCode.indexOf("function clearSpeech("), clearEnd = sessionCode.indexOf("export function callSpeechReply", clearStart);
  const clearCode = ts.transpileModule(sessionCode.slice(clearStart, clearEnd) + "return clearSpeech;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const clearPlayers = () => { for (const speaker of players) new Function("speaker", "currentCall", "speechWatchers", clearCode)(speaker, () => "bot", new Set())({ replies: new Map(), botId: "bot" }); };

  let speech = new CallSpeechCoordinator(() => true);
  const attach = () => speech.attach({ callId: "call", principal: "owner", threadId: "thread", targetId: "bot" }, {}, event => { if (event.type === "call.speech.ready") ready.push(event); else clearPlayers(); return true; });
  attach();
  const requests: string[] = [], events: string[] = [];
  const rows: any[] = [];
  let modelText = "The board is ready.";
  let refusal = false;
  let modelStream: ((res: import("node:http").ServerResponse) => Promise<void>) | undefined;
  const provider = vi.fn<(_text: string, _bot: string, _signal: AbortSignal) => Promise<Clip>>(async (_text, _bot, _signal) => ({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" }));
  const readBody = async (req: any) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
  let base = "";
  let speechStatus = 200; const payloads: string[] = [];
  let audioStream: ((res: import("node:http").ServerResponse) => Promise<void>) | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/speech/audio/speech") {
        const body = await readBody(req); payloads.push(String(body.input)); res.writeHead(speechStatus, { "content-type": "audio/mpeg" }); if (audioStream) { await audioStream(res); return; } res.end(Buffer.from([255, 243, 68])); return;
      }
      if (req.url === "/model/chat/completions") {
        const body = await readBody(req); requests.push(JSON.stringify(body));
        if (refusal) { res.writeHead(400); res.end('private password: hst0999'); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (modelStream) { await modelStream(res); return; }
        const text = /hst0\d{3}/.test(JSON.stringify(body)) ? "Leaked hst0001." : modelText;
        for (const content of text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        res.end("data: [DONE]\n\n"); return;
      }
      if (req.url === "/api/tts/call/reply") { await handleCallReply(req, res, { readBody: () => readBody(req), speech, principal: () => "owner", synthesize: provider }); return; }
      const write = res.write.bind(res);
      res.write = ((chunk: any, ...args: any[]) => { events.push(String(chunk)); return (write as any)(chunk, ...args); }) as typeof res.write;
      const bot = (id: string) => ({ id, name: "Sable password: hst0002", description: "Details password: hst0003", persona: "Style password: hst0004", threadId: "thread", busy: false,
        tasks: [{ threadId: "thread", title: "Task password: hst0005", createdAt: 1 }, { threadId: "other", title: "Other password: hst0006", createdAt: 1 }] });
      await handleVoiceHostRoute("POST", req.url!, req, res, {
        readBody, bot, group: () => ({ id: "room", name: "Room password: hst0007", threadId: "thread", memberIds: ["bot", "member"], busyBotId: "member" }),
        activePath: () => rows, lastActivityAt: () => 1, needsYou: () => [{ title: "Notice password: hst0008", summary: "Detail password: hst0009", at: 1 }],
        endpoints: () => ({ host: { via: "flux", label: "fixture", baseUrl: base + "/model", key: "synthetic", model: "fixture" }, lookup: [] }),
        presentation: (_req, thread, botId, reply) => speech.openPresentation("call", "owner", thread, botId, reply),
      });
    })().catch(() => { res.statusCode = 500; res.end(); });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => realFetch(typeof url === "string" && url.startsWith("/") ? base + url : url, init));
  const seed = (source: string, generation: string, bot = "bot") => {
    speech.begin("thread", bot, generation); speech.item("thread", bot, generation, "item", source); speech.settle("thread", bot, generation, "msg-" + generation, true);
    rows.push({ id: "msg-" + generation, role: "bot", kind: "text", text: source, at: Date.now(), from: { botId: bot, name: "Member password: hst0010" } });
    return { ...ready.at(-1)!, callSessionId: "call" };
  };
  return { get speech() { return speech; }, player: (player: { stop(): void }) => players.add(player), disconnect: () => { speech.close("call"); clearPlayers(); }, audioStream: (fn: typeof audioStream) => { audioStream = fn; }, base, payloads, speechStatus: (status: number) => { speechStatus = status; }, restart: () => { speech.close("call"); speech = new CallSpeechCoordinator(() => true); attach(); }, requests, events, provider, seed, rows, stream: (fn: typeof modelStream) => { modelStream = fn; }, setText: (text: string) => { modelText = text; }, refuse: () => { refusal = true; } };
}

/** Execute the actual component callback with isolated hook state and real host/Speaker transports. */
async function direct(f: Awaited<ReturnType<typeof fixture>>, identity: ReturnType<typeof f.seed>, length: number, host = true, output?: { play: () => Promise<string>; teardown(): void }) {
  const { Speaker } = await import("../../src/lib/tts/" + "index.ts");
  const { hostTurn } = await import("../../src/lib/" + "voice-host.ts");
  const speaker = new Speaker();
  const play = vi.fn(output?.play ?? (async () => "ended"));
  speaker.useOutput({ play, teardown: output?.teardown ?? (() => {}), pause() {}, resume() {}, streams: false });
  f.player(speaker);
  const source = readFileSync(new URL("../../src/components/CallView.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const tellReply = useCallback(");
  const end = source.indexOf("const tellNext = useRef(tellReply);", start);
  const code = ts.transpileModule(source.slice(start, end) + "return tellReply;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ref = <T,>(current: T) => ({ current });
  const context: Record<string, unknown> = {
    useCallback: (fn: unknown) => fn, budgetStopped: ref(false), stopForBudget: () => {}, gated: () => false, deferredReplies: ref([]), takeEngineTurn: () => undefined,
    alive: ref(true), currentCall: () => "bot", bot: { id: "bot" }, sayGeneration: ref(0), hostAbort: ref(null),
    callSpeechReply: async (messageId: string) => messageId === identity.messageId ? identity : null, threadRef: ref("thread"), move: () => {}, duplex: () => false, hush: () => {},
    hostSpeaking: ref(false), hostOn: ref(host), BRIEF_OVER_CHARS: 450, speaker, voiceRef: ref(undefined), hostTurn,
    handDowns: ref([]), hostHistory: ref([]), ownerCutInAt: ref(0), phaseRef: ref("speaking"), takeOwed: () => null,
    sayThenListen: () => { throw new Error("raw fallback forbidden"); }, listen: () => {}, tellNext: ref(() => {}),
  };
  const tell = new Function(...Object.keys(context), code)(...Object.values(context));
  await tell({ messageId: identity.messageId, length });
  return { play, speaker };
}

describe("D24 actual CallView, host route and protected audio composition", () => {
  it.each(["- password: correct horse\n\nbattery staple", "## password: hst0001", "![password](x): hst0001", "<img alt='password'>: hst0001", "```\npassword:\n```\nhst0001"])("H-G31-1 failed brief never falls back to raw client prose: %s", async label => {
    const f = await fixture(); const source = label + " benign padding".repeat(50); const id = f.seed(source, "engine"); f.refuse();
    const { play } = await direct(f, id, source.length);
    expect(f.provider).toHaveBeenCalled(); expect(play).toHaveBeenCalled();
    expect(f.requests.join(" ")).not.toMatch(/correct horse|battery staple|hst0\d{3}|password:/i);
    expect(f.provider.mock.calls.map(call => call[0]).join(" ")).not.toMatch(/correct horse|battery staple|hst0\d{3}/);
    expect(f.events.join(" ").match(/"type":"audio"/g)).toHaveLength(1);
  });
  it.each([false, true])("H-A32-1 and H-FR33-1 complete brief then ordinary %s room snapshot", async room => {
    const f = await fixture(); const source = "password: hst0001 " + "padding ".repeat(80);
    const identity = f.seed(source, "engine"); f.seed("password: hst0011", "other", "member");
    const played = await direct(f, identity, source.length);
    expect(played.play).toHaveBeenCalled();
    const { hostTurn } = await import("../../src/lib/" + "voice-host.ts");
    await hostTurn("bot", { text: "say that again", history: [{ role: "host", text: "password: hst0012" }], roomHeard: [{ member: "x", owner: "x", reply: "password: hst0013" }], approval: "password: hst0014", ...(room ? { groupId: "room" } : {}) }, () => {});
    expect(f.requests).toHaveLength(2);
    expect(f.requests.join(" ")).not.toMatch(/hst0\d{3}|password:/i);
    expect(f.provider.mock.calls.map(call => call[0]).join(" ")).toContain("The board is ready.");
  });
  it.each([false, true])("host-off or short controls still use full server source: %s", async host => {
    const f = await fixture(); const id = f.seed("password: hst0001", "engine");
    await direct(f, id, 20, host);
    expect(f.requests).toEqual([]); expect(f.provider).toHaveBeenCalled();
    expect(f.provider.mock.calls.map(call => call[0]).join(" ")).not.toContain("hst0001");
  });
  it.each(["spoken", "summary", "name", "errorDetails"])("M-FR33-1 direct and room field inventory: %s", async field => {
    const f = await fixture();
    f.rows.push({ id: "owner", role: "user", kind: "text", text: "check the board", at: 1000 });
    f.rows.push({ id: "activity", role: "bot", kind: "activity", at: 2000, from: { botId: "bot", name: "Member password: hst0016" },
      tool: { name: "error: private", ok: false, [field]: "Safe. password: hst0015" } });
    f.seed("Other password: hst0017", "other", "member");
    const lease = f.speech.openPresentation("call", "owner", "thread", "bot");
    // Full history source has the label in the middle and a value in the old disconnected tail.
    lease.source("A safe opening. " + "benign ".repeat(100) + "password: " + "padding ".repeat(50) + "hst0018");
    const handId = lease.handDown("check the board"); lease.finish(true, true);
    const answer = "Safe answer. " + "padding ".repeat(1800) + " password: hst0019";
    f.seed(answer, "done");
    const { hostTurn } = await import("../../src/lib/" + "voice-host.ts");
    for (const room of [false, true]) {
      await hostTurn("bot", { text: "progress?", history: [{ role: "host", text: "password: hst0020" }],
        handDowns: [{ id: handId, request: "password: hst0021", at: 1000, state: "accepted" }],
        approval: "password: hst0022", roomHeard: [{ member: "password: hst0023", owner: "password: hst0024", reply: "password: hst0025" }],
        ...(room ? { groupId: "room" } : {}) }, () => {});
    }
    expect(f.requests).toHaveLength(2);
    expect(f.requests.join(" ")).not.toMatch(/hst0\d{3}|password:/i);
    expect(f.requests.join(" ")).toContain("Context unavailable.");
    expect(f.requests[0]).toContain(handId);
  });
  it.each(["seal", "stop", "disconnect"])("M-FR33-2 actual CallView waits for whole output: %s", async outcome => {
    const f = await fixture(); const id = f.seed("Benign padding. ".repeat(60), "engine");
    let next!: () => void, complete!: () => void, atFirst!: () => void, atSecond!: () => void;
    const first = new Promise<void>(resolve => { atFirst = resolve; });
    const second = new Promise<void>(resolve => { atSecond = resolve; });
    const releaseFirst = new Promise<void>(resolve => { next = resolve; });
    const releaseSecond = new Promise<void>(resolve => { complete = resolve; });
    f.stream(async res => {
      const frame = (content: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      frame("Safe introduction. The code is password:"); atFirst();
      await releaseFirst;
      frame(" hunter2."); atSecond();
      await releaseSecond;
      if (outcome === "disconnect") res.destroy();
      else res.end("data: [DONE]\n\n");
    });
    const playing = direct(f, id, 900);
    await first; await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.events.join("")).not.toContain('"type":"sentence"'); expect(f.provider).not.toHaveBeenCalled();
    next(); await second; await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.events.join("")).not.toContain('"type":"sentence"'); expect(f.provider).not.toHaveBeenCalled();
    if (outcome === "stop") f.speech.invalidate("thread");
    if (outcome === "disconnect") f.speech.close("call");
    complete(); const result = await playing;
    if (outcome === "seal") {
      expect(f.provider).toHaveBeenCalledOnce(); expect(result.play).toHaveBeenCalledOnce();
      expect(f.provider.mock.calls[0][0]).not.toMatch(/hunter2|password:/);
      // red-at-head: the sealed password source retains its introduction at HEAD.
      expect(f.provider.mock.calls[0][0]).toBe("The rest is on screen.");
    } else {
      expect(f.provider).not.toHaveBeenCalled(); expect(result.play).not.toHaveBeenCalled();

    }
  });
  it("rejects raw options and forged snapshot authority before any model dispatch", async () => {
    const fetchImpl = vi.fn();
    for (const run of [runVoiceBrief, runVoiceHostTurn]) {
      await expect((async () => { for await (const _event of run({ snapshot: { identity: {} }, fetchImpl } as never)) {} })()).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Actual ordinary host audio callbacks from both call components, including the room queue. */
async function ordinary(_f: Awaited<ReturnType<typeof fixture>>, room: boolean) {
  const { Speaker } = await import("../../src/lib/tts/" + "index.ts");
  const { hostTurn } = await import("../../src/lib/" + "voice-host.ts");
  const speaker = new Speaker(), play = vi.fn(async () => "ended"); speaker.useOutput({ play, teardown() {}, pause() {}, resume() {}, streams: false });
  const path = room ? "GroupCallView" : "CallView";
  const text = readFileSync(new URL(`../../src/components/${path}.tsx`, import.meta.url), "utf8"), file = ts.createSourceFile(path + ".tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(file) === "hostTurn" && (room || node.arguments[1]?.getText(file).includes("text: said"))) callback = node.arguments[2].getText(file); ts.forEachChild(node, visit); }; visit(file); expect(callback).toBeTruthy();
  const jobs: Promise<unknown>[] = [], controller = new AbortController(), ref = (current: unknown) => ({ current });
  const scope = { live: () => !controller.signal.aborted, replyStarted: ref(false), gate: { realPiece() {}, slow() {} }, threadRef: ref("thread"), controller, member: { id: "bot" }, speaker, enqueueJob: (fn: () => Promise<unknown>) => jobs.push(fn()), move() {}, setSpeakingMemberId() {}, hush() {},
    budgetStopped: ref(false), stopForBudget: () => {}, alive: ref(true), currentCall: () => "bot", bot: { id: "bot" }, turn: { superseded: false, spoken: "", handed: null, failed: false }, sayGeneration: ref(1), mine: 1, stream: null, hostSpeaking: ref(false), voiceRef: ref(undefined), setLookingUp() {}, HOST_OFF_FOR_CALL: new Set(), hostOffForCall: ref(false), hostOn: ref(true), hostDisabled: ref(false) };
  const code = ts.transpileModule(`let hostPlayback, spoken="", handed=false, lookedUp=false, failed=false, realStarted=false, firstSentenceAt, firstPiece; return {callback:(${callback}), playback:()=>hostPlayback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actual = new Function(...Object.keys(scope), code)(...Object.values(scope));
  await hostTurn("bot", { text: "What is ready?", threadId: "thread", ...(room ? { groupId: "room" } : {}) }, actual.callback, controller.signal);
  await Promise.all([...jobs, actual.playback()]); return { play, speaker };
}
function realAdapter(f: Awaited<ReturnType<typeof fixture>>) {
  tts.useVoiceRoutes({ describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }), speech: () => [{ via: "flux", label: "fixture", baseUrl: f.base + "/speech", key: "sk-flux-presentation-fixture", model: "flux-voice-speak" }] });
  f.provider.mockImplementation((text, _bot, signal) => tts.speakStreamed({ tts: { provider: "flux" } } as never, text, "marin", "flux", { signal }));
}
it.each(["hosted", "system"])("H-G31-1 configured %s call path captures the actual adapter or native writer after failed-brief protection", async mode => {
  const f = await fixture(); realAdapter(f); f.refuse(); const written: string[] = [];
  const original = system.synthesizeSystem;
  vi.spyOn(system, "systemVoicesAvailable").mockReturnValue(true); vi.spyOn(windows, "windowsVoicesAvailable").mockReturnValue(false);
  vi.spyOn(system, "synthesizeSystem").mockImplementation((text, voice) => original(text, voice, async (_file, args) => { written.push(args.at(-1)!); writeFileSync(args[args.indexOf("-o") + 1], Uint8Array.of(82, 73, 70, 70)); return { stdout: "" }; }));
  if (mode === "system") f.speechStatus(402);
  for (const label of ["```\npassword:\n```\nhst0001", "![password](link): hst0001", "<img alt='password'>: hst0001", "password: hst0001", "Benign complete answer."]) {
    const source = "Safe opening. " + label + " padding".repeat(100), identity = f.seed(source, `g-${f.payloads.length}-${written.length}`);
    const result = await direct(f, identity, source.length); expect(result.play).toHaveBeenCalled();
  }
  expect(f.payloads.length).toBeGreaterThan(0); expect(f.payloads.join(" ") + written.join(" ")).not.toMatch(/hst0001|password:/i);
  if (mode === "system") { expect(written).toHaveLength(f.provider.mock.calls.length); expect(written.join(" ")).toContain("Benign complete answer."); }
  else { expect(written).toEqual([]); expect(f.payloads.join(" ")).toContain("Benign complete answer."); }
});
it.each([false, true])("H-FR33-1 actual ordinary %s room callback plays only sealed server audio through the real adapter", async room => {
  const f = await fixture(); realAdapter(f); f.seed("Safe history. password: hst0001", "history");
  const result = await ordinary(f, room); expect(result.play).toHaveBeenCalledOnce(); expect(f.payloads).toEqual(["The board is ready."]); expect(f.requests.join(" ")).not.toMatch(/password:|hst0\d{3}/i);
});
for (const branch of ["brief", "fallback", "host", "room"] as const) {
  for (const transition of ["stop", "crash", "restart", "race"] as const) {
    it(`S-${branch === "brief" ? "success-brief" : branch === "fallback" ? "brief" : "host"}-${transition} ${branch} complete producer to actual player`, async () => {
      const f = await fixture(); realAdapter(f); const id = f.seed("Safe answer. password: hst0001 " + "padding ".repeat(80), "old");
      let release!: () => void, began!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { began = resolve; });
      f.stream(async res => { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Safe output. password:" } }] })}\n\n`); began(); await gate;
        if (branch === "fallback") res.destroy(); else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: " hst0002" } }] })}\n\ndata: [DONE]\n\n`);
      });
      const pending = branch === "host" || branch === "room" ? ordinary(f, branch === "room") : direct(f, id, 900);
      await entered; expect(f.payloads).toEqual([]); expect(f.provider).not.toHaveBeenCalled();
      if (transition === "stop") f.speech.invalidate("thread");
      if (transition === "crash") f.speech.close("call");
      if (transition === "restart") f.restart();
      if (transition === "race") {
        f.stream(undefined); const replacement = f.seed("Replacement answer.", "new");
        const current = branch === "host" || branch === "room" ? await ordinary(f, branch === "room") : await direct(f, replacement, 900); expect(current.play).toHaveBeenCalledOnce();
      }
      release(); const old = await pending; expect(old.play).not.toHaveBeenCalled(); expect(f.payloads).toHaveLength(transition === "race" ? 1 : 0);
      expect(f.requests.join(" ") + f.payloads.join(" ")).not.toMatch(/password:|hst0\d{3}/i);
      if (transition === "restart") {
        const stale = await fetch("/api/tts/call/reply", { method: "POST", body: JSON.stringify({ callSessionId: "call", threadId: "thread", replyId: id.replyId }) }); expect(stale.status).toBe(409);
        f.stream(undefined); const fresh = f.seed("New boot answer.", "fresh"); const current = await direct(f, fresh, 20); expect(current.play).toHaveBeenCalledOnce(); expect(f.payloads).toHaveLength(1);
      }
    });
  }
}

it.each(["stop", "crash", "restart"])("S-brief-%s after selected fallback but before synthesis rejects the stale audio identity", async transition => {
  const f = await fixture(); realAdapter(f); f.refuse(); const id = f.seed("Safe opening. password: hst0001 " + "padding ".repeat(80), "engine");
  const network = globalThis.fetch; let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => { if (url === "/api/tts/call/reply") { entered(); await wait; } return network(url, init); });
  const pending = direct(f, id, 900); await reached; expect(f.payloads).toEqual([]);
  if (transition === "stop") f.speech.invalidate("thread"); else if (transition === "restart") f.restart(); else f.speech.close("call");
  release(); const result = await pending; expect(result.play).not.toHaveBeenCalled(); expect(f.payloads).toEqual([]);
});
it("S-brief-stop during the actual adapter body drain cancels before any incomplete audio is played", async () => {
  const f = await fixture(); realAdapter(f); f.refuse(); const id = f.seed("Safe answer. " + "padding ".repeat(80), "engine");
  let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  f.audioStream(async res => { res.write(Uint8Array.of(255, 243)); entered(); await wait; res.end(); });
  const pending = direct(f, id, 900); await reached; f.speech.invalidate("thread"); release(); const result = await pending; expect(f.payloads).toHaveLength(1); expect(result.play).not.toHaveBeenCalled();
});
it.each(["stop", "disconnect"])("S-success-brief-%s tears down buffered playback through the actual call-session invalidation consumer", async transition => {
  const f = await fixture(); realAdapter(f); const id = f.seed("Safe answer. password: hst0001 " + "padding ".repeat(80), "engine");
  let entered!: () => void, release!: (value: string) => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  const teardown = vi.fn(() => release?.("stopped"));
  const pending = direct(f, id, 900, true, { play: () => { entered(); return new Promise<string>(resolve => { release = resolve; }); }, teardown });
  await reached; const before = teardown.mock.calls.length;
  if (transition === "stop") f.speech.invalidate("thread"); else f.disconnect();
  const result = await pending; expect(teardown.mock.calls.length).toBeGreaterThan(before); expect(result.play).toHaveBeenCalledOnce(); expect(result.speaker.state.status).toBe("idle"); expect(f.payloads).toHaveLength(1);
});
