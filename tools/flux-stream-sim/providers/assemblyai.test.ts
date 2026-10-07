// tools/flux-stream-sim/providers/assemblyai.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { DEFAULT_CONFIG, parseConnectQuery } from "../../../shared/flux-stream-contract.ts";
import type { ProviderEvent } from "../provider.ts";
import { OrderedSender, assemblyAIProvider, flushPending, mapAssemblyAI, newAaiState, providerParams } from "./assemblyai.ts";

type W = [string, number, number, boolean];
const turn = (o: number, eot: boolean, words: W[], transcript = "", fmt = true, conf = 0.5) => ({
  type: "Turn",
  turn_order: o,
  end_of_turn: eot,
  turn_is_formatted: fmt,
  transcript,
  utterance: "",
  end_of_turn_confidence: conf,
  words: words.map(([text, start, end, word_is_final]) => ({ text, start, end, confidence: 0.9, word_is_final })),
});
const run = (msgs: unknown[], state = newAaiState(true), now = 0) => msgs.flatMap((m) => mapAssemblyAI(m, state, now));
const texts = (events: ProviderEvent[], kind: ProviderEvent["kind"]) => events.filter((e) => e.kind === kind).map((e) => (e as { text: string }).text);

describe("mapAssemblyAI", () => {
  it("universal-streaming-english (P1): partials include in-progress words, finals are new words only", () => {
    const events = run([
      turn(0, false, [["My", 100, 300, false]]),
      turn(0, false, [["My", 100, 300, true], ["favorite", 320, 700, false]], "My"),
      turn(0, false, [["My", 100, 300, true], ["favorite", 320, 700, true], ["Brothers", 720, 1100, false]], "My favorite"),
      turn(0, true, [["My", 100, 300, true], ["favorite", 320, 700, true], ["Brothers.", 720, 1100, true]], "My favorite Brothers.", true, 0.86),
      turn(1, true, [], ""),
    ]);
    expect(events[0]).toEqual({ kind: "speech_started", audioMs: 100 });
    expect(texts(events, "partial").at(-1)).toBe("My favorite Brothers");
    expect(texts(events, "final")).toEqual(["My", "favorite", "Brothers."]);
    const ends = events.filter((e) => e.kind === "turn_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ text: "My favorite Brothers.", startMs: 100, endMs: 1100 });
    expect("semantic" in ends[0]).toBe(false); // the provider's confidence is a silence ramp (spike)
    expect(events.some((e) => e.kind === "turn_cancelled")).toBe(false); // turn 1 never opened
  });

  it("universal-3-6-pro (P2): SpeechStarted is used once, words finalize at the end", () => {
    const events = run([
      { type: "SpeechStarted", timestamp: 1216, confidence: 0.98 },
      turn(0, false, [["My", 1216, 1400, false], ["name", 1420, 1600, false]], "My name"),
      turn(0, true, [["My", 1216, 1400, true], ["name", 1420, 1600, true], ["is", 1620, 1700, true], ["Sonny.", 1720, 2100, true]], "My name is Sonny.", true, 1),
    ]);
    expect(events.filter((e) => e.kind === "speech_started")).toEqual([{ kind: "speech_started", audioMs: 1216 }]);
    expect(texts(events, "final")).toEqual(["My name is Sonny."]);
    expect(events.map((e) => e.kind).slice(-2)).toEqual(["final", "turn_end"]);
  });

  it("merges a duplicate end of turn (unformatted, then formatted) and drops a late repeat", () => {
    const events = run([
      turn(0, true, [["blues", 100, 400, true], ["brothers", 420, 900, true]], "blues brothers", false, 0.7),
      turn(0, true, [["Blues", 100, 400, true], ["Brothers.", 420, 900, true]], "Blues Brothers.", true, 0.7),
      turn(0, true, [["Blues", 100, 400, true]], "Blues", true),
    ]);
    expect(texts(events, "turn_end")).toEqual(["Blues Brothers."]);
  });

  it("uses an unformatted end alone after 300 ms", () => {
    const state = newAaiState(true);
    expect(mapAssemblyAI(turn(0, true, [["hello", 0, 300, true]], "hello", false), state, 1000).some((e) => e.kind === "turn_end")).toBe(false);
    expect(flushPending(state, 1200)).toEqual([]);
    expect(flushPending(state, 1310).at(-1)).toMatchObject({ kind: "turn_end", text: "hello" });
  });

  it("cancels an opened turn that ends with no words; an end without words still gets its finals", () => {
    expect(run([{ type: "SpeechStarted", timestamp: 500 }, turn(0, true, [], "")]).map((e) => e.kind)).toEqual(["speech_started", "turn_cancelled"]);
    const events = run([turn(0, false, [["hi", 100, 300, false]]), turn(0, true, [], "Hi.")]);
    expect(events.map((e) => e.kind)).toEqual(["speech_started", "partial", "final", "turn_end"]);
    expect(events.at(-1)).toMatchObject({ startMs: 100, endMs: 300 });
    expect(run([{ type: "SpeechStarted", timestamp: 50 }, turn(0, true, [], "Okay.")]).map((e) => e.kind)).toEqual(["speech_started", "final", "turn_end"]);
  });

  it("reconciles a text-only end with the immutable finals in spoken form (Astra 3 I1)", () => {
    // "twenty five" is final; the end says "25 dollars": only "dollars" is new, and the end agrees
    const numbers = run([turn(0, false, [["twenty", 100, 300, true], ["five", 320, 500, true]]), turn(0, true, [], "25 dollars")]);
    expect(numbers.filter((e) => e.kind === "final").map((e) => (e as { text: string }).text)).toEqual(["twenty five", "dollars"]);
    expect(numbers.at(-1)).toMatchObject({ kind: "turn_end", text: "25 dollars" });
    // "hello" is final; the end says "Bye.": the final stands and the end carries it, never a disagreement
    const state = newAaiState(true);
    const events = [turn(0, false, [["hello", 100, 300, true]]), turn(0, true, [], "Bye.")].flatMap((m) => mapAssemblyAI(m, state, 0));
    expect(events.filter((e) => e.kind === "final").map((e) => (e as { text: string }).text)).toEqual(["hello"]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", text: "hello" });
    expect(state.conflicts).toBe(1);
  });

  it("never promotes tentative words when the end carries none (Astra 2 I3)", () => {
    // tentative "hi", then an empty end: a cancellation, not a final "hi"
    const cancelled = run([turn(0, false, [["hi", 100, 300, false]]), turn(0, true, [], "")]);
    expect(cancelled.map((e) => e.kind)).toEqual(["speech_started", "partial", "turn_cancelled"]);
    // tentative "hi", then a text-only end "Bye.": the final and the end agree on "Bye."
    const replaced = run([turn(0, false, [["hi", 100, 300, false]]), turn(0, true, [], "Bye.")]);
    expect(replaced.filter((e) => e.kind === "final").map((e) => (e as { text: string }).text)).toEqual(["Bye."]);
    expect(replaced.at(-1)).toMatchObject({ kind: "turn_end", text: "Bye." });
    // words already final stand: an empty end closes the turn on them
    const kept = run([turn(0, false, [["hi", 100, 300, true], ["there", 320, 500, false]]), turn(0, true, [], "")]);
    expect(kept.filter((e) => e.kind === "final").map((e) => (e as { text: string }).text)).toEqual(["hi"]);
    expect(kept.at(-1)).toMatchObject({ kind: "turn_end", text: "hi" });
  });

  it("does not reopen a turn when the formatted end lands after the 300 ms wait", () => {
    const state = newAaiState(true);
    const events = [
      ...mapAssemblyAI(turn(0, true, [["blues", 100, 400, true]], "blues", false), state, 0),
      ...mapAssemblyAI(turn(0, true, [["Blues.", 100, 400, true]], "Blues.", true), state, 350),
    ];
    expect(events.filter((e) => e.kind === "turn_end")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "speech_started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "final")).toHaveLength(1);
  });
});

describe("ends carrying words (Astra 4 I4)", () => {
  it("never lets an end's own words override the finals already sent", () => {
    const state = newAaiState(true);
    const events = run([turn(0, false, [["hello", 100, 300, true]]), turn(0, true, [["Bye.", 100, 300, true]], "Bye.")], state);
    expect(texts(events, "final")).toEqual(["hello"]);
    expect(texts(events, "turn_end")).toEqual(["hello"]);
    expect(state.conflicts).toBe(1);
  });
  it("adds the new word after two finals a formatted end joined into one", () => {
    const events = run([
      turn(0, false, [["twenty", 100, 300, true], ["five", 320, 500, true], ["dol", 520, 700, false]]),
      turn(0, true, [["25", 100, 500, true], ["dollars", 520, 900, true]], "25 dollars"),
    ]);
    expect(texts(events, "final")).toEqual(["twenty five", "dollars"]);
    expect(texts(events, "turn_end")).toEqual(["25 dollars"]);
  });
  it("keeps the new word one formatted word shares with a final", () => {
    const events = run([
      turn(0, false, [["twenty", 100, 300, true], ["five", 320, 500, false]]),
      turn(0, true, [["25", 100, 500, true], ["dollars", 520, 900, true]], "25 dollars"),
    ]);
    expect(texts(events, "final")).toEqual(["twenty", "five dollars"]);
  });
  it("checks the end against the finals sent, not a later hypothesis", () => {
    const state = newAaiState(true);
    const events = run([
      turn(0, false, [["hello", 100, 300, true], ["there", 320, 500, false]]),
      turn(0, false, [["Yellow", 100, 300, false], ["there", 320, 500, false]]),
      turn(0, true, [], "Hello there."),
    ], state);
    expect(texts(events, "final")).toEqual(["hello", "there."]);
    expect(state.conflicts).toBe(0);
  });
});

describe("an end whose transcript disagrees with its words (Astra 5 I3)", () => {
  it("keeps the finals and counts the conflict", () => {
    const state = newAaiState(true);
    const events = run([turn(0, false, [["hello", 100, 300, true]]), turn(0, true, [["hello", 100, 300, true]], "Bye.")], state);
    expect(texts(events, "final")).toEqual(["hello"]);
    expect(texts(events, "turn_end")).toEqual(["hello"]);
    expect(state.conflicts).toBe(1);
  });
  it("keeps a formatted transcript that agrees in spoken form", () => {
    const state = newAaiState(true);
    const events = run([
      turn(0, false, [["twenty", 100, 300, true], ["five", 320, 500, true]]),
      turn(0, true, [["25", 100, 500, true], ["items.", 520, 900, true]], "25 items."),
    ], state);
    expect(texts(events, "turn_end")).toEqual(["25 items."]);
    expect(state.conflicts).toBe(0);
  });
});

describe("providerParams", () => {
  it("omits both turn knobs only when asked (the sim's provider-default switch), keeping everything else", () => {
    const omitted = providerParams(DEFAULT_CONFIG, true);
    expect(omitted).not.toHaveProperty("min_turn_silence");
    expect(omitted).not.toHaveProperty("max_turn_silence");
    expect(omitted).toMatchObject({ speech_model: "universal-3-6-pro", format_turns: "true" });
    expect(providerParams(DEFAULT_CONFIG)).toHaveProperty("max_turn_silence", "1280");
  });
  it("pins universal-3-6-pro, sends explicit silences at every eagerness (medium 400/1280), never the threshold, the legacy name or the key", () => {
    const medium = providerParams(DEFAULT_CONFIG);
    expect(medium).toMatchObject({ speech_model: "universal-3-6-pro", sample_rate: "16000", format_turns: "true", inactivity_timeout: "45", min_turn_silence: "400", max_turn_silence: "1280" });
    expect(medium).not.toHaveProperty("end_of_turn_confidence_threshold");
    expect(providerParams({ ...DEFAULT_CONFIG, eagerness: "low" })).toMatchObject({ min_turn_silence: "1500", max_turn_silence: "3000" });
    expect(providerParams({ ...DEFAULT_CONFIG, eagerness: "high" })).toHaveProperty("min_turn_silence");
    const manual = providerParams({ ...DEFAULT_CONFIG, turn_detection: "manual", max_silence_ms: 4000, keyterms: ["Sable"] });
    expect(manual).toMatchObject({ min_turn_silence: "4000", max_turn_silence: "4000", keyterms_prompt: '["Sable"]' });
    expect(JSON.stringify(manual)).not.toMatch(/token|authorization|threshold/i);
  });

  it("never sends the legacy silence name, and a client query carrying it is ignored, not applied", () => {
    const legacy = "min_end_of_turn_silence_when_confident";
    for (const eagerness of ["low", "medium", "high"] as const) {
      for (const turn_detection of ["semantic", "manual"] as const) {
        expect(JSON.stringify(providerParams({ ...DEFAULT_CONFIG, eagerness, turn_detection }))).not.toContain(legacy);
      }
    }
    const parsed = parseConnectQuery(new URLSearchParams(`${legacy}=900`));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ignored).toEqual([legacy]);
    expect(parsed.config).toEqual(DEFAULT_CONFIG); // the silences are unchanged
    const params = providerParams(parsed.config);
    expect(params).toMatchObject({ min_turn_silence: "400", max_turn_silence: "1280" });
    expect(JSON.stringify(params)).not.toContain("900");
  });
});

describe("OrderedSender", () => {
  it.each([8000, 16000, 24000])("chunks by sample rate %i and pads a tail before a barrier", (rate) => {
    const sent: Array<Buffer | string> = [];
    const s = new OrderedSender((d) => sent.push(d), rate, () => 0);
    s.audio(Buffer.alloc((rate / 50) * 2)); // 20 ms
    s.control({ type: "ForceEndpoint" });
    while (s.pump());
    expect(sent).toHaveLength(2);
    expect((sent[0] as Buffer).length).toBe(rate / 10); // 50 ms
    expect(sent[1]).toBe('{"type":"ForceEndpoint"}');
  });

  it("sends a backlog at once up to 3 s ahead of the provider clock, never over 1000 ms per chunk", () => {
    const sent: Buffer[] = [];
    let now = 0;
    const s = new OrderedSender((d) => typeof d !== "string" && sent.push(d), 16000, () => now);
    for (let i = 0; i < 80; i += 1) s.audio(Buffer.alloc(2048)); // 5.12 s
    s.pump();
    const ms = () => sent.reduce((n, b) => n + b.length, 0) / 32;
    expect(ms()).toBe(3000);
    now = 2200;
    s.pump();
    expect(ms()).toBe(5120);
    expect(sent.every((b) => b.length <= 32000)).toBe(true);
  });

  it("banks at most the burst over a long mute", () => {
    const sent: Buffer[] = [];
    let now = 0;
    const s = new OrderedSender((d) => typeof d !== "string" && sent.push(d), 16000, () => now);
    now = 60_000; // a minute of mute
    for (let i = 0; i < 157; i += 1) s.audio(Buffer.alloc(2048)); // then 10 s at once
    s.pump();
    expect(sent.reduce((n, b) => n + b.length, 0) / 32).toBeLessThanOrEqual(3000);
  });

  it("maps provider times after commit padding back to the accepted clock", () => {
    const s = new OrderedSender(() => undefined, 16000, () => 0);
    s.audio(Buffer.alloc(640)); // 20 ms, padded to 50 ms at the commit
    s.control({ type: "ForceEndpoint" });
    while (s.pump());
    s.audio(Buffer.alloc(32_000)); // 1 s more
    while (s.pump());
    expect(s.toAccepted(1050)).toBe(1020);
    expect(s.toAccepted(10)).toBe(10);
  });

  it("counts the padding each queued barrier will add, and coalesces a repeated barrier (Astra 3 I8)", () => {
    const s = new OrderedSender(() => undefined, 16000, () => 0);
    s.audio(Buffer.alloc(640)); // 20 ms
    s.control({ type: "ForceEndpoint" });
    expect(s.outstandingMs()).toBe(50); // 20 ms of audio padded to the 50 ms minimum
    s.control({ type: "ForceEndpoint" }); // right behind the same barrier: nothing added
    s.audio(Buffer.alloc(640));
    s.control({ type: "ForceEndpoint" });
    expect(s.outstandingMs()).toBe(100);
    s.audio(Buffer.alloc(3200)); // 100 ms: pacing may still leave a short tail before the barrier
    s.control({ type: "ForceEndpoint" });
    expect(s.outstandingMs()).toBe(250); // so the most that tail can need is reserved (Astra 4 I3)
  });

  it("covers the padding pacing can leave in front of a barrier (Astra 4 I3)", () => {
    const sent: Array<Buffer | string> = [];
    let now = 0;
    const s = new OrderedSender((d) => sent.push(d), 16000, () => now);
    s.audio(Buffer.alloc(3200)); // 100 ms spends credit first
    s.pump();
    s.audio(Buffer.alloc(2980 * 32));
    s.control({ type: "ForceEndpoint" });
    const reported = s.outstandingMs();
    while (s.pump()) now += 30;
    const audioMs = sent.filter((d): d is Buffer => typeof d !== "string").reduce((n, b) => n + b.length, 0) / 32 - 100;
    expect(audioMs).toBeGreaterThan(2980);
    expect(reported).toBeGreaterThanOrEqual(audioMs);
  });

  it("sends one KeepAlive and one merged update, never holding audio back (Astra 4 I3)", () => {
    const sent: Array<Buffer | string> = [];
    const s = new OrderedSender((d) => sent.push(d), 16000, () => 0);
    for (let i = 0; i < 1000; i += 1) s.control({ type: "KeepAlive" });
    s.control({ type: "UpdateConfiguration", min_turn_silence: 400 });
    s.control({ type: "UpdateConfiguration", keyterms_prompt: ["Sable"] });
    s.audio(Buffer.alloc(3200));
    s.control({ type: "Terminate" });
    expect(s.pump()).toBe(false);
    const texts = sent.filter((d): d is string => typeof d === "string");
    expect(texts.filter((x) => x.includes("KeepAlive"))).toHaveLength(1);
    expect(texts.filter((x) => x.includes("UpdateConfiguration"))).toEqual(['{"type":"UpdateConfiguration","min_turn_silence":400,"keyterms_prompt":["Sable"]}']);
    expect(texts.at(-1)).toBe('{"type":"Terminate"}');
  });
});

describe("assemblyAIProvider against a fake provider", () => {
  let server: WebSocketServer | null = null;
  afterEach(() => server?.close());

  it("connects with the key in the Authorization header, never the URL, and closes cleanly", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    let seenUrl = "";
    let seenAuth = "";
    server.on("connection", (ws, req) => {
      seenUrl = req.url ?? "";
      seenAuth = String(req.headers.authorization ?? "");
      ws.send(JSON.stringify({ type: "Begin", id: "x", expires_at: 0, configuration: {} }));
      ws.on("message", (d) => {
        if (String(d).includes("Terminate")) ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 0, session_duration_seconds: 1 }));
      });
    });
    const provider = assemblyAIProvider({ key: "aai-test-key", wsUrl: `ws://127.0.0.1:${port}/v3/ws` });
    const events: ProviderEvent[] = [];
    const session = await provider.connect(DEFAULT_CONFIG, {}, (e) => events.push(e));
    expect(seenAuth).toBe("aai-test-key");
    expect(seenUrl).toMatch(/speech_model=universal-3-6-pro/);
    expect(seenUrl).not.toMatch(/aai-test-key|token=/);
    await session.close(1500);
    expect(events.filter((e) => e.kind === "closed")).toHaveLength(1);
  });

  it("close() returns on the provider's Termination, not on the socket closing later", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "Begin", id: "x", expires_at: 0, configuration: {} }));
      ws.on("message", (d) => {
        if (String(d).includes("Terminate")) ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 0, session_duration_seconds: 1 }));
        // the real provider keeps the socket open about 0.9 s after Termination; this one never closes it
      });
    });
    const provider = assemblyAIProvider({ key: "aai-test-key", wsUrl: `ws://127.0.0.1:${port}/v3/ws` });
    const events: ProviderEvent[] = [];
    const session = await provider.connect(DEFAULT_CONFIG, {}, (e) => events.push(e));
    const at = Date.now();
    await session.close(5000);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(events.filter((e) => e.kind === "closed")).toHaveLength(1);
  });

  it("closes the socket when Begin never comes", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    let closed = false;
    server.on("connection", (ws) => ws.on("close", () => (closed = true)));
    const provider = assemblyAIProvider({ key: "k", wsUrl: `ws://127.0.0.1:${port}/v3/ws`, beginTimeoutMs: 200 });
    await expect(provider.connect(DEFAULT_CONFIG, {}, () => undefined)).rejects.toThrow(/begin/);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });
  it("maps a pending unformatted end onto the accepted clock when the provider closes abnormally", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    let seen = "";
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "Begin", id: "x", expires_at: 0, configuration: {} }));
      ws.on("message", (d, binary) => {
        if (!binary) seen += String(d);
        if (!binary && String(d).includes("ForceEndpoint")) return;
        if (binary && Buffer.from(d as Buffer).length === 32_000) {
          // an unformatted end with the 300 ms formatting wait still running, then a protocol error close
          ws.send(JSON.stringify(turn(0, true, [["hello", 1000, 1040, true]], "hello", false)));
          ws.close(1011);
        }
      });
    });
    const provider = assemblyAIProvider({ key: "k", wsUrl: `ws://127.0.0.1:${port}/v3/ws` });
    const events: ProviderEvent[] = [];
    const session = await provider.connect(DEFAULT_CONFIG, {}, (e) => events.push(e));
    session.sendAudio(Buffer.alloc(640)); // 20 ms, padded to 50 ms by the commit: 30 ms of provider clock is not audio
    session.commit();
    session.sendAudio(Buffer.alloc(32_000));
    await vi.waitFor(() => expect(events.some((e) => e.kind === "error")).toBe(true));
    expect(seen).toContain("ForceEndpoint");
    const end = events.find((e) => e.kind === "turn_end");
    expect(end).toMatchObject({ kind: "turn_end", text: "hello", startMs: 970, endMs: 1010 });
    expect(events.at(-1)).toMatchObject({ kind: "error" });
  });

  it("clears the close deadline timer when the socket closes first", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "Begin", id: "x", expires_at: 0, configuration: {} }));
      ws.on("message", (d) => {
        if (String(d).includes("Terminate")) {
          ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 0, session_duration_seconds: 1 }));
          ws.close(1000); // like the real service: the socket closes right after Termination
        }
      });
    });
    const provider = assemblyAIProvider({ key: "k", wsUrl: `ws://127.0.0.1:${port}/v3/ws` });
    const session = await provider.connect(DEFAULT_CONFIG, {}, () => undefined);
    const deadline = 45_000;
    const made: Array<ReturnType<typeof setTimeout>> = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSet(fn, ms);
      if (ms === deadline) made.push(handle);
      return handle;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(handle);
      return realClear(handle);
    }) as typeof clearTimeout);
    try {
      await session.close(deadline);
      expect(made).toHaveLength(1);
      expect(cleared.has(made[0])).toBe(true);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      for (const h of made) realClear(h);
    }
  });
  it("sends only min_turn_silence and max_turn_silence on a live update, never the legacy name", async () => {
    server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    const received: string[] = [];
    server.on("connection", (ws, req) => {
      received.push(req.url ?? "");
      ws.send(JSON.stringify({ type: "Begin", id: "x", expires_at: 0, configuration: {} }));
      ws.on("message", (d, binary) => {
        if (!binary) received.push(String(d));
      });
    });
    const provider = assemblyAIProvider({ key: "k", wsUrl: `ws://127.0.0.1:${port}/v3/ws` });
    const session = await provider.connect(DEFAULT_CONFIG, {}, () => undefined);
    expect(session.update({ ...DEFAULT_CONFIG, eagerness: "low" })).toBe(true);
    await vi.waitFor(() => expect(received.some((m) => m.includes("UpdateConfiguration"))).toBe(true));
    const update = JSON.parse(received.find((m) => m.includes("UpdateConfiguration"))!);
    expect(update).toMatchObject({ type: "UpdateConfiguration", min_turn_silence: 1500, max_turn_silence: 3000 });
    expect(received.join("\n")).not.toContain("min_end_of_turn_silence_when_confident");
    expect(received[0]).toMatch(/min_turn_silence=400/);
    expect(received[0]).toMatch(/max_turn_silence=1280/);
    await session.close(50);
  });
});
