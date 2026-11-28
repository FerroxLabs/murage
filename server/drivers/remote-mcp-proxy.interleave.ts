// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Test support for the owner's MCP session machine (1.0.21 cause6 r3, DESIGN-R3 section 5): seeded
// interleavings of engine lines and relay answers.
//
// The schedule and its oracle (this file) know nothing of how a seal is made. They drive a RIG, which only
// carries bytes and timing: an engine line in, a relay answer out, a body that breaks, a POST that is cut,
// a chunk the turn refuses. Everything the oracle judges is OBSERVED from the proxy: the POSTs it made, the
// frames it gave the engine, its one log line per stale continuation, and the seals of the real seal object
// (createProxyTurnRelease). No rig ever writes a seal.
//  - `inProcessRig` (here): the real machine (createProxySession) behind the real relay POST (relayDeps ->
//    gatedFetch, the code `main` runs), sealing into a real createProxyTurnRelease. The stand-ins are the
//    network (`fetch`), the clock (`deadline`) and the turn's answer to a reserve (yes or no).
//  - `realProxyRig` (remote-mcp-proxy.replay.ts): the spawned proxy process, a real HTTP relay stand-in and
//    the supervisor's side of the release channel. A seal there is the process's own terminal notice.
(globalThis as Record<symbol, unknown>)[Symbol.for("murage.remote-mcp-proxy.session-only")] = true;
const { createProxySession, relayDeps } = await import("./remote-mcp-proxy.ts");
const { createProxyTurnRelease } = await import("../proxy-turn-release.ts");

export type Json = Record<string, any>;
/** `post`: its number, or a selector `kind[/method][@last]` = the oldest (or newest) request of that kind
 * that is still unanswered. */
export type Action =
  | { do: "engine"; method: string }
  | { do: "engine-answer"; nth: number }
  | { do: "answer"; post: number | string; as: string };

/** What a rig reports. Observations only. */
export interface RigEvents {
  /** The proxy POSTed `message` to the relay on `session`. `handle` names it for the rig's own calls. */
  posted(message: Json, session: string, handle: unknown): void;
  /** The proxy gave this POST up before it was answered in full (its caller aborted, its body was cancelled). */
  cancelled(handle: unknown): void;
  /** A frame the engine received as the answer to the request `id`. */
  answered(id: unknown, frame: Json): void;
  /** A frame the engine received that answers nothing (a notification, a forwarded question). */
  sent(frame: Json): void;
  /** One line the proxy logged. */
  logged(line: string): void;
  /** The machine threw (in the process this seals with the reason `handle`). */
  threw(text: string): void;
}
/** Bytes and timing, nothing else. `seals()` reads the real seal object. */
export interface Rig {
  /** True when the turn's reserve authority is the real one's wire (a refusal seals in proxy-turn-release). */
  real: boolean;
  engine(message: Json): void;
  whole(handle: unknown, status: number, body: string | null, headers: Record<string, string>): void;
  open(handle: unknown, status: number, headers: Record<string, string>): void;
  chunk(handle: unknown, text: string): void;
  end(handle: unknown): void;
  /** The body cannot be read any further (the connection is gone). */
  breakBody(handle: unknown): void;
  /** The POST fails with no answer at all. */
  reject(handle: unknown): void;
  /** One more chunk arrives on this POST and the turn refuses to reserve it. */
  refuseReserve(handle: unknown): void;
  /** The POST's own deadline passes now. False = it is not armed. Absent = this rig has the real clock. */
  deadline?(handle: unknown): boolean;
  /** Every seal reason the real seal object has given out, in order. */
  seals(): string[];
  /** Resolves once the proxy has gone quiet; with `until`, waits (bounded) for it to hold as well. */
  settle(until?: () => boolean): Promise<void>;
  stop(): Promise<void>;
}
export type MakeRig = (events: RigEvents) => Rig | Promise<Rig>;

type Kind = "engine-init" | "reopen-init" | "probe" | "handshake" | "call" | "note" | "reply";
interface Generation { origin: "engine" | "auto" | "none"; closes: number; granted: string | null; settled: boolean; offered: string; handshakes: number; handshakeAnswered: boolean }
interface Post {
  n: number; kind: Kind; method: string; rpcId: unknown; header: string; generation: Generation; closesAtSend: number;
  state: "held" | "stream" | "done"; answered: boolean; handle: unknown;
}
export interface Outcome {
  seed: number | null; actions: Action[]; violations: string[]; trace: string[]; sealed: string | null; stats: Record<string, number>;
  /** Asked for and not possible in the state it met. */
  skipped: string[];
  /** What the proxy did, as observed: its POSTs, the engine's answers, its stale-continuation lines. */
  wire: string[]; answers: string[]; logs: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RELAY = (code: string) => JSON.stringify({ code, error: `relay says ${code}` });
const HTML = "<html>bad gateway</html>";
const sseOf = (frame: Json) => `data: ${JSON.stringify(frame)}\n\n`;
const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } };
const HELLO = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } };
const HELLO_ELICITS = { ...HELLO, capabilities: { elicitation: { form: {} } } };

/** The real machine and the real relay POST in this process. Stand-ins: the network, the clock, the turn's
 * yes or no to a reserve. The seal object is the real one; its `terminal` port is the only place a seal is read. */
export function inProcessRig(events: RigEvents): Rig {
  interface Held {
    state: "held" | "stream" | "done"; signal: AbortSignal;
    resolve: (response: Response) => void; reject: (error: unknown) => void;
    feed: Array<{ chunk?: string; end?: true; error?: unknown }>; fed: (() => void) | null;
  }
  interface Deadline { controller: AbortController; armed: boolean }
  let activity = 0;
  let refusals = 0;
  const notices: string[] = [];
  const deadlines = new Map<AbortSignal, Deadline>();
  const release = createProxyTurnRelease("interleave", {
    verdict: () => Promise.reject(new Error("no frame is released through this object")),
    envelope: () => Promise.resolve(),
    seal() {},
    terminal(_frame: unknown, reason: string) { activity++; notices.push(reason); },
    close() {},
  } as never);
  /** proxyTransportLost: the seal object throws once it is sealed, and the caller is not told. */
  const lost = (reason: string) => { activity++; try { release.transportLost(reason); } catch { /* sealed */ } };
  function push(held: Held, event: { chunk?: string; end?: true; error?: unknown }): void {
    held.feed.push(event);
    const fed = held.fed;
    held.fed = null;
    fed?.();
  }
  const machine = createProxySession({
    ...relayDeps("http://relay.invalid/api/internal/mcp-remote/s", () => "turn", {
      fetch(_url: string, init: RequestInit & { signal: AbortSignal }) {
        activity++;
        const session = String((init.headers as Record<string, string>)["mcp-session-id"] ?? "");
        return new Promise<Response>((resolve, reject) => {
          const held: Held = { state: "held", signal: init.signal, resolve, reject, feed: [], fed: null };
          events.posted(JSON.parse(String(init.body)), session, held);
          // what fetch does when its caller aborts: a pending request rejects and an open body errors, with the caller's reason
          init.signal.addEventListener("abort", () => {
            if (held.state === "done") return;
            const was = held.state;
            held.state = "done";
            events.cancelled(held);
            if (was === "held") reject(init.signal.reason); else push(held, { error: init.signal.reason });
          });
        });
      },
      // the turn's answer only: yes, or no. What a no does to the mount is the proxy's business (T24).
      reserve: async () => { activity++; if (refusals > 0) { refusals--; throw new Error("MEMORY_CONTEXT_REVOKED"); } },
      lost,
    }),
    send: async (frame: Json) => { activity++; events.sent(frame); },
    hints: async (_method: string, frame: Json) => frame,
    deadline() {
      const deadline: Deadline = { controller: new AbortController(), armed: true };
      deadlines.set(deadline.controller.signal, deadline);
      return { signal: deadline.controller.signal, pause: () => { deadline.armed = false; }, resume: () => { deadline.armed = true; } };
    },
    replySignal: () => new AbortController().signal,
    log(line: string) { activity++; events.logged(line); },
    strict: true,
  });
  const at = (handle: unknown) => handle as Held;
  return {
    real: false,
    engine(message: Json) {
      const req = { published: Promise.resolve(true), cancel() {}, respond(frame: Json) { activity++; events.answered(message.id, frame); return Promise.resolve(); } };
      void machine.handle(message, req as never).catch((error: unknown) => { activity++; events.threw(error instanceof Error ? error.message : String(error)); });
    },
    whole(handle, status, body, headers) {
      at(handle).state = "done";
      at(handle).resolve(new Response(body, { status, headers: { "content-type": "application/json", ...headers } }));
    },
    // the body is pulled, as a network body is: a fault is met when it is READ
    open(handle, status, headers) {
      const held = at(handle);
      const encoder = new TextEncoder();
      held.state = "stream";
      held.resolve(new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (held.feed.length === 0) await new Promise<void>((resolve) => { held.fed = resolve; });
          activity++;
          const event = held.feed.shift()!;
          if (event.chunk !== undefined) return controller.enqueue(encoder.encode(event.chunk));
          if (event.end) return controller.close();
          controller.error(event.error);
        },
        cancel() { if (held.state !== "done") { held.state = "done"; events.cancelled(held); } },
      }, { highWaterMark: 0 }), { status, headers }));
    },
    chunk(handle, text) { push(at(handle), { chunk: text }); },
    end(handle) { at(handle).state = "done"; push(at(handle), { end: true }); },
    breakBody(handle) { at(handle).state = "done"; push(at(handle), { error: new Error("socket closed") }); },
    reject(handle) {
      at(handle).state = "done";
      at(handle).reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    },
    refuseReserve(handle) { refusals++; push(at(handle), { chunk: ": more\n\n" }); },
    deadline(handle) {
      const deadline = deadlines.get(at(handle).signal);
      if (!deadline?.armed || deadline.controller.signal.aborted) return false;
      deadline.controller.abort(new Error("timeout"));
      return true;
    },
    seals: () => notices,
    async settle() {
      for (let still = 0, seen = -1; still < 3; ) {
        await new Promise((resolve) => setImmediate(resolve));
        if (seen === activity) still++; else { seen = activity; still = 0; }
      }
    },
    stop: async () => {},
  };
}

/** Runs one schedule on a rig: generated from `seed`, or the given `replay` list (an action that is not
 * possible in the state it meets is skipped, which is what lets a failing schedule be shrunk). */
export async function runSchedule(seed: number | null, replay: Action[] | null = null, makeRig: MakeRig = inProcessRig): Promise<Outcome> {
  const random = mulberry32(seed ?? 1);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const violations: string[] = [];
  const trace: string[] = [];
  const stats: Record<string, number> = {};
  const bump = (key: string) => { stats[key] = (stats[key] ?? 0) + 1; };
  const actions: Action[] = [];
  const posts: Post[] = [];
  const skipped: string[] = [];
  const answersSeen: string[] = [];
  const logs: string[] = [];
  /** The turn refused a reserve: nothing after it is this turn's (and on the real wire the mount is sealed). */
  let turnOver = false;
  let sessions = 0;
  const lastId = () => `sess-${sessions}`;

  // ---- what the wire says about which session is the live one (never read from the machine) ----
  const none: Generation = { origin: "none", closes: 0, granted: null, settled: true, offered: "", handshakes: 0, handshakeAnswered: false };
  let live: Generation = none;
  let unanswered = 0;
  let probes = 0;
  let goneAnswers = 0;
  const isLive = (post: Post) => post.generation === live && post.generation.closes === post.closesAtSend;

  // ---- the engine side ----
  const requests = new Map<number, { method: string; answers: Json[]; posts: number }>();
  let nextRpc = 1;
  /** Questions a server asked that the machine handed to the engine (its own ids), not yet answered by it. */
  const asked: string[] = [];
  const toolPending = () => [...requests.values()].some((request) => request.method === "tools/call" && request.answers.length === 0);
  const fail = (text: string) => { violations.push(text); };

  const events: RigEvents = {
    posted(message: Json, session: string, handle: unknown) {
      const method = typeof message.method === "string" ? message.method : "";
      const rpcId = message.id;
      const kind: Kind = !method ? "reply"
        : method === "initialize" ? (String(rpcId).startsWith("reopen-") ? "reopen-init" : "engine-init")
        : method === "ping" && String(rpcId).startsWith("murage-probe-") ? "probe"
        : method === "notifications/initialized" && session !== "" ? "handshake"
        : rpcId !== undefined ? "call" : "note";
      if (kind === "engine-init" || kind === "reopen-init") {
        live = { origin: kind === "engine-init" ? "engine" : "auto", closes: 0, granted: null, settled: false, offered: "", handshakes: 0, handshakeAnswered: false };
        if (session !== "") fail(`A4 an initialize was posted on session ${session}`);
      } else if (kind !== "reply" && session !== (live.granted ?? "")) {
        fail(`A4 ${method} was posted on session "${session}" but the newest initialize ${live.granted === null ? "opened none" : `opened "${live.granted}"`}`);
      }
      // A7: a probe only ever follows a session-gone answer to a call or a handshake (counted over the run; sharing one probe is W10's)
      if (kind === "probe" && ++probes > goneAnswers) fail(`A7 probe ${probes} was posted after only ${goneAnswers} session-gone answer(s) to a call or a handshake`);
      if (kind === "handshake" && ++live.handshakes > 1) fail(`A5 a second notifications/initialized was posted on one session (${session})`);
      if (kind === "call" && typeof rpcId === "number" && requests.has(rpcId)) {
        const request = requests.get(rpcId)!;
        if (++request.posts > 2) fail(`A7 request ${rpcId} was posted ${request.posts} times`);
        if (request.posts === 2 && session !== "" && !live.handshakeAnswered) fail(`A5 the resent request ${rpcId} was posted on ${session} before that session's handshake was answered`);
      }
      // a reply to a request the server made rides on the fence of the call whose stream asked it
      const askedOn = kind === "reply" ? posts.find((other) => `srv-${other.n}` === String(rpcId)) : undefined;
      const post: Post = { n: posts.length, kind, method, rpcId, header: session, generation: askedOn?.generation ?? live, closesAtSend: askedOn?.closesAtSend ?? live.closes, state: "held", answered: false, handle };
      posts.push(post);
      trace.push(`  POST #${post.n} ${kind} ${method || "(reply)"} id=${String(rpcId)} @"${session}"`);
    },
    cancelled(handle: unknown) {
      const post = posts.find((other) => other.handle === handle);
      if (post) post.state = "done";
    },
    answered(id: unknown, frame: Json) {
      const text = "error" in frame ? `error ${JSON.stringify(frame.error?.message)}` : frame.result?.isError ? `tool-error ${JSON.stringify(frame.result.content?.[0]?.text)}` : "result";
      trace.push(`  ANSWER id=${String(id)} ${text}`);
      const request = typeof id === "number" ? requests.get(id) : undefined;
      if (!request) return fail(`A3 the engine got an answer to something it did not ask (id ${String(id)})`);
      answersSeen.push(`${request.method} ${text}`);
      request.answers.push(frame);
      if (request.answers.length > 1) fail(`A3 request ${String(id)} (${request.method}) was answered ${request.answers.length} times`);
      if (/session was replaced/.test(JSON.stringify(frame))) bump("T21 own error");
    },
    sent(frame: Json) {
      if (frame.method === "elicitation/create") { asked.push(String(frame.id)); bump("question forwarded to the engine"); trace.push(`  ASKS the engine ${String(frame.id)}`); }
    },
    logged(line: string) {
      const text = line.replace(/ gen=.*\s*$/, "").replace("[remote-mcp-proxy] ", "").trim();
      bump(text); logs.push(text); trace.push(`  ${line.trim()}`);
    },
    threw(text: string) { fail(`A8 handle threw: ${text}`); },
  };
  const rig = await makeRig(events);
  const seals = () => rig.seals();
  const quiet = (until?: () => boolean) => rig.settle(until);
  const isOpen = (post: Post) => post.state === "held" || post.state === "stream";
  function find(selector: number | string): Post | null {
    if (typeof selector === "number") return posts[selector] ?? null;
    const [what, pick] = selector.split("@");
    const [kind, ...rest] = what!.split("/");
    const method = rest.join("/");
    const matching = posts.filter((post) => isOpen(post) && post.kind === kind && (!method || post.method === method));
    return (pick === "last" ? matching.at(-1) : matching[0]) ?? null;
  }
  const whole = (post: Post, status: number, body: string | null, headers: Record<string, string> = {}) => { post.state = "done"; rig.whole(post.handle, status, body, headers); };

  // ---- what each answer is, what the wire then says about the session, and whether the mount must seal ----
  const INIT = ["init-ok", "init-ok-reused", "init-rpc-error", "init-non-object", "no-frame", "sse-hold", "html-503", "relay-server-error", "relay-no-answer", "reject", "deadline"] as const;
  const REOPEN = [...INIT, "sse-hold", "sse-hold", "sse-hold", "init-ok"] as const;
  const CALL = ["ok", "ok", "ok", "ok-sse", "ok-asks", "no-frame", "sse-hold", "gone", "gone", "relay-server-error", "relay-no-answer", "relay-wrong-address", "html-503", "ledger-409", "reject", "deadline"] as const;
  const NOTE = ["accepted", "accepted", "html-503", "relay-server-error", "reject", "deadline"] as const;
  const SHAKE = ["accepted", "accepted", "accepted", "error-200", "gone", "relay-no-answer", "relay-server-error", "html-503", "reject", "deadline"] as const;
  const PROBE = ["ok", "error-200", "gone", "gone", "gone", "relay-no-answer", "html-503", "reject", "deadline"] as const;
  const SEALS = new Set(["no-frame", "html-503", "reject", "deadline", "break", "end", "reserve-refused"]);
  const STREAM = ["answer", "answer", "answer", "error-answer", "server-ping", "server-ping", "server-asks", "server-asks", "break", "break", "end", "deadline", "reserve-refused"] as const;
  const REPLY = ["accepted", "accepted", "accepted", "reject", "reject"] as const;
  function choices(post: Post): readonly string[] {
    const all = allChoices(post);
    return rig.deadline ? all : all.filter((choice) => choice !== "deadline"); // the real clock cannot be scheduled
  }
  function allChoices(post: Post): readonly string[] {
    if (post.state === "stream") return STREAM;
    if (post.state !== "held") return [];
    if (post.kind === "reply") return REPLY;
    if (post.kind === "reopen-init") return REOPEN;
    if (post.kind === "engine-init") return INIT;
    if (post.kind === "probe") return PROBE;
    if (post.kind === "handshake") return SHAKE;
    if (post.kind === "note") return NOTE;
    return post.header === "" ? CALL.filter((choice) => choice !== "gone") : CALL;
  }
  /** The generation of `post` closes now (the wire shows why). Counted only for a post that is still live. */
  const closes = (post: Post) => { post.generation.closes++; post.generation.settled = true; };

  function deliver(post: Post, as: string): { faulted: boolean; mustSeal: boolean; mayCascade: boolean } | null {
    const liveNow = isLive(post);
    const init = post.kind === "engine-init" || post.kind === "reopen-init";
    const engineOwned = post.kind === "engine-init" || post.kind === "call" || post.kind === "note";
    const tool = post.kind === "call" && post.method === "tools/call";
    let sealingFault = false; // a fault the 1.0.21 rules seal for when it is about the live session
    let relayDecision = false;
    const initFailed = () => { if (init && liveNow && !post.generation.settled) closes(post); };
    const shakeFailed = (code: string) => {
      if (post.kind !== "handshake") return;
      post.generation.handshakeAnswered = true;
      if (liveNow && post.generation.origin === "auto" && !["server-error", "wrong-address", "session-gone"].includes(code) && unanswered++ === 0) closes(post);
    };
    if (post.state === "stream") {
      if (as === "deadline") {
        if (!rig.deadline?.(post.handle)) return null;
        sealingFault = engineOwned;
        if (!post.answered) initFailed();
      } else if (as === "break") {
        // q1022-connparity (MAIN-RULING 2026-11-25T17:42:59Z CONNPARITY-1022): a stream that breaks mid-call never seals
        // (design 399 / T14g superseded). An engine request's own break closes its session if it is the live one; the
        // proxy reconnects once and fails that request by name.
        const engineBreak = (post.kind === "call" || post.kind === "engine-init") && !post.answered && post.rpcId !== undefined;
        sealingFault = false;
        if (!post.answered) initFailed();
        if (engineBreak && !init && liveNow && post.generation.closes === 0) closes(post);
        post.state = "done";
        rig.breakBody(post.handle);
      } else if (as === "end") {
        // q1022-connparity (MAIN-RULING SEAN 2026-11-25): an engine request's stream that ends with no answer fails
        // that request alone and closes its session if it is the live one (the next call reconnects); never a seal.
        const engineEnd = (post.kind === "call" || post.kind === "engine-init") && !post.answered && post.rpcId !== undefined;
        sealingFault = !engineEnd && !post.answered && (post.rpcId !== undefined);
        if (!post.answered) initFailed();
        if (engineEnd && !init && liveNow && post.generation.closes === 0) closes(post);
        post.state = "done";
        rig.end(post.handle);
      } else if (as === "reserve-refused") {
        // T24: the turn refuses this chunk. The rig only says no. On the real wire the refusal itself seals
        // (proxy-turn-release, whatever session the POST was for), so there the mount MUST be sealed. In
        // this process only the proxy's own code can seal: it must for the live session and for a tool call.
        if (!post.answered) initFailed();
        turnOver = true;
        rig.refuseReserve(post.handle);
        return { faulted: true, mustSeal: rig.real || liveNow || tool, mayCascade: false };
      } else if (as === "server-ping" || as === "server-asks") {
        rig.chunk(post.handle, sseOf(as === "server-ping" ? { jsonrpc: "2.0", id: `srv-${post.n}`, method: "ping" } : { jsonrpc: "2.0", id: `srv-${post.n}`, method: "elicitation/create", params: { mode: "form", message: "ok?", requestedSchema: { type: "object", properties: {} } } }));
        return { faulted: false, mustSeal: false, mayCascade: true };
      } else if (as === "answer" || as === "error-answer") {
        if (post.answered || post.rpcId === undefined) return null;
        post.answered = true;
        const ok = as === "answer";
        if (init && liveNow && !post.generation.settled) { if (ok) { post.generation.granted = post.generation.offered; post.generation.settled = true; } else closes(post); }
        rig.chunk(post.handle, sseOf(ok ? { jsonrpc: "2.0", id: post.rpcId, result: init ? INIT_RESULT : {} } : { jsonrpc: "2.0", id: post.rpcId, error: { code: -32603, message: "server said no" } }));
        return { faulted: false, mustSeal: false, mayCascade: true };
      } else return null;
      return { faulted: sealingFault, mustSeal: sealingFault && (liveNow || tool), mayCascade: !sealingFault };
    }
    if (post.state !== "held") return null;
    const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: post.rpcId, result });
    switch (as) {
      case "init-ok": case "init-ok-reused": {
        const id = as === "init-ok" || sessions === 0 ? `sess-${++sessions}` : lastId();
        if (liveNow && !post.generation.settled) { post.generation.granted = id; post.generation.settled = true; }
        whole(post, 200, answer(INIT_RESULT), { "mcp-session-id": id });
        break;
      }
      case "init-rpc-error": initFailed(); whole(post, 200, JSON.stringify({ jsonrpc: "2.0", id: post.rpcId, error: { code: -32603, message: "server said no" } }), { "mcp-session-id": `sess-${++sessions}` }); break;
      case "init-non-object": initFailed(); whole(post, 200, answer("nope")); break;
      case "ok": whole(post, 200, answer(post.method === "tools/list" ? { tools: [{ name: "echo" }] } : {})); break;
      // a whole body (not a stream) in which the server first asks something of its own: the reply is a POST of the call's
      case "ok-asks": whole(post, 200, sseOf({ jsonrpc: "2.0", id: `srv-${post.n}`, method: "ping" }) + sseOf({ jsonrpc: "2.0", id: post.rpcId, result: {} }), { "content-type": "text/plain" }); break;
      case "ok-sse": whole(post, 200, sseOf({ jsonrpc: "2.0", id: post.rpcId, result: {} }), { "content-type": "text/event-stream" }); break;
      case "error-200": whole(post, 200, JSON.stringify({ jsonrpc: "2.0", id: post.rpcId ?? null, error: { code: -32601, message: "server said no" } })); if (post.kind === "handshake") { post.generation.handshakeAnswered = true; if (liveNow) unanswered = 0; } break;
      case "accepted": whole(post, 202, null); if (post.kind === "handshake") { post.generation.handshakeAnswered = true; if (liveNow) unanswered = 0; } break;
      case "no-frame":
        sealingFault = init || post.kind === "call";
        initFailed();
        whole(post, 200, random() < 0.5 ? "   " : JSON.stringify({ jsonrpc: "2.0", id: "someone-else", result: {} }));
        break;
      case "sse-hold": {
        if (post.rpcId === undefined) return null;
        const headers: Record<string, string> = { "content-type": "text/event-stream" };
        if (init) { post.generation === live && liveNow ? (post.generation.offered = `sess-${++sessions}`) : ++sessions; headers["mcp-session-id"] = `sess-${sessions}`; }
        post.state = "stream";
        rig.open(post.handle, 200, headers);
        return { faulted: false, mustSeal: false, mayCascade: true };
      }
      case "gone":
        if (post.kind === "call" || post.kind === "handshake") goneAnswers++;
        if (post.kind === "probe" && liveNow) closes(post);
        shakeFailed("session-gone");
        whole(post, 404, RELAY("session-gone"));
        break;
      case "relay-server-error": case "relay-no-answer": case "relay-wrong-address":
        relayDecision = true;
        initFailed(); shakeFailed(as.slice(6));
        whole(post, 502, RELAY(as.slice(6)));
        break;
      case "html-503":
        sealingFault = post.kind !== "probe";
        initFailed(); shakeFailed("");
        whole(post, 503, HTML, { "content-type": "text/html" });
        break;
      case "ledger-409": whole(post, 409, JSON.stringify({ error: "This turn can no longer use the server." })); break;
      case "reject":
        sealingFault = true;
        initFailed(); shakeFailed("no-answer");
        post.state = "done";
        rig.reject(post.handle);
        break;
      case "deadline":
        if (!rig.deadline?.(post.handle)) return null;
        sealingFault = engineOwned || post.kind === "handshake" && post.generation.origin === "engine";
        initFailed(); shakeFailed("no-answer");
        break;
      default: return null;
    }
    // q1022-connparity: the relay's own answer for a tool call (the server erred, dropped or did not answer) fails that
    // call alone with the may-have-run line and closes its session if live, so the next call reconnects (was design 399: seal).
    if (relayDecision && tool) { if (liveNow && post.generation.closes === 0) closes(post); return { faulted: false, mustSeal: false, mayCascade: true }; }
    return { faulted: sealingFault, mustSeal: sealingFault && (liveNow || tool), mayCascade: !sealingFault };
  }

  function engine(called: string): void {
    let method = called;
    const message: Json = { jsonrpc: "2.0", method };
    if (method === "initialize+elicit") { message.method = method = "initialize"; message.params = HELLO_ELICITS; }
    else if (method === "initialize") message.params = HELLO;
    if (!method.startsWith("notifications/")) {
      message.id = nextRpc++;
      requests.set(message.id, { method, answers: [], posts: 0 });
      if (method !== "initialize") message.params = method === "tools/call" ? { name: "echo", arguments: {} } : {};
    }
    rig.engine(message);
  }

  // ---- one step: an action, then everything it causes, then the per-step checks ----
  let judged = 0; // how many seals the steps so far have judged
  async function step(action: Action): Promise<boolean> {
    const before = seals().length;
    const since = () => seals().slice(before);
    const note = () => { for (const reason of seals().slice(judged)) trace.push(`  SEAL ${reason}`); judged = seals().length; };
    let verdict: ReturnType<typeof deliver> = { faulted: false, mustSeal: false, mayCascade: true };
    let target: Post | null = null;
    let label: string;
    if (action.do === "engine") { engine(action.method); label = `engine ${action.method}`; }
    else if (action.do === "engine-answer") {
      const id = asked.splice(action.nth % Math.max(asked.length, 1), 1)[0];
      if (id === undefined) { skipped.push(JSON.stringify(action)); return false; }
      label = `engine answers the question ${id}`;
      rig.engine({ jsonrpc: "2.0", id, result: { action: "accept", content: {} } });
    } else {
      const wanted = action.post;
      target = find(wanted);
      if (!target && typeof wanted === "string") { await quiet(() => find(wanted) !== null); target = find(wanted); }
      if (!target || !choices(target).includes(action.as)) { skipped.push(JSON.stringify(action)); return false; }
      const wasLive = isLive(target);
      label = `#${target.n} ${target.kind} ${target.method} <- ${action.as}${wasLive ? " (live)" : " (stale)"}`;
      trace.push(label);
      verdict = deliver(target, action.as);
      if (!verdict) { trace.pop(); skipped.push(JSON.stringify(action)); return false; }
      const mustSeal = verdict.mustSeal;
      if (verdict.faulted) bump(wasLive ? "fault on the live session" : target.method === "tools/call" ? "stale fault on a tool call" : "stale fault");
      const turn = action.as === "reserve-refused";
      if (turn) bump(wasLive ? "reserve refused on the live session" : "reserve refused on a stale session");
      // A1: a seal for a fault on a request that is not on the live session, and is no tool call
      await quiet(mustSeal ? () => seals().length > before : undefined);
      note();
      const sealedNow = seals().length > before;
      const cascade = verdict.mayCascade && toolPending() && since().every((reason) => /^relay-status=5\d\d$/.test(reason));
      if (sealedNow && !turn && !wasLive && target.method !== "tools/call") fail(`A1 a late ${action.as} on ${target.kind} ${target.method} (#${target.n}, not the live session) sealed the mount: ${since().join(", ")}`);
      if (mustSeal && !sealedNow) fail(`A2 ${action.as} on ${turn ? "a chunk the turn refused," : wasLive ? "the live session's" : "a tool call's"} ${target.kind} ${target.method} (#${target.n}) did not seal the mount`);
      if (sealedNow && !mustSeal && !cascade && (wasLive || target.method === "tools/call" || turn)) fail(`A2 ${action.as} on ${target.kind} ${target.method} (#${target.n}) sealed the mount (${since().join(", ")}) and no rule seals for it`);
      // T24 on the real wire: the seal is the refusal's own, made in the transport before any fence is read
      if (turn && rig.real && sealedNow && since()[0] !== "upstream-reserve") fail(`T24 the turn refused a chunk on ${target.kind} ${target.method} (#${target.n}) and the mount was sealed for something else first: ${since().join(", ")}`);
      actions.push({ do: "answer", post: target.n, as: action.as });
      return true;
    }
    trace.push(label);
    await quiet();
    note();
    if (seals().length > before && !(toolPending() && since().every((reason) => /^relay-status=5\d\d$/.test(reason)))) fail(`A2 ${label} sealed the mount (${since().join(", ")}) with no tool call waiting`);
    actions.push(action);
    return true;
  }

  const ENGINE = ["tools/list", "tools/list", "tools/call", "tools/call", "resources/list", "ping", "notifications/initialized", "notifications/initialized", "notifications/roots/list_changed", "initialize", "initialize+elicit", "initialize+elicit"] as const;
  try {
  if (replay) {
    for (const action of replay) { if (seals().length > 0 || turnOver) { skipped.push(JSON.stringify(action)); continue; } await step(action); }
  } else {
    await step({ do: "engine", method: random() < 0.5 ? "initialize" : "initialize+elicit" });
    const length = 12 + Math.floor(random() * 49);
    for (let done = 1; done < length && seals().length === 0 && !turnOver && violations.length === 0; done++) {
      const open = posts.filter((post) => post.state === "held" || post.state === "stream");
      const roll = random();
      if (asked.length > 0 && roll > 0.9) { await step({ do: "engine-answer", nth: Math.floor(random() * asked.length) }); continue; }
      // an engine initialize while the proxy's own reopen is unanswered is the supersede the BLOCKs were about
      if (open.some((post) => post.kind === "reopen-init") && random() < 0.2) { await step({ do: "engine", method: "initialize+elicit" }); continue; }
      if (open.length === 0 || roll < 0.32) { await step({ do: "engine", method: pick(ENGINE) }); continue; }
      // any held request may be answered next: the oldest half as often as any, so late answers are common
      const post = random() < 0.5 ? open[Math.floor(random() * Math.ceil(open.length / 2))]! : pick(open);
      // A fault that seals ends the schedule. Most are kept for requests that are no longer on the live session,
      // which is where the invariants are; one in eight is still spent on the live one (A2).
      let as = pick(choices(post));
      const ends = (choice: string) => SEALS.has(choice) || choice.startsWith("relay-") && post.method === "tools/call";
      if (ends(as) && (isLive(post) || post.method === "tools/call") && random() < 0.875) as = pick(choices(post).filter((choice) => !ends(choice)));
      await step({ do: "answer", post: post.n, as });
    }
  }

  // ---- the final drain: the engine finishes its handshake and every held request is answered well ----
  for (let rounds = 0; rounds < 200 && seals().length === 0 && !turnOver && violations.length === 0; rounds++) {
    const open = posts.filter((post) => post.state === "held" || post.state === "stream");
    if (open.length === 0) {
      const waiting = [...requests.entries()].filter(([, request]) => request.answers.length === 0);
      if (waiting.length === 0 || rounds > 150) break;
      // a call waits for the engine's own handshake on a session the engine opened: the engine sends it
      trace.push("drain: engine notifications/initialized");
      engine("notifications/initialized");
      await quiet();
      if (posts.every((post) => post.state === "done")) { rounds += 50; }
      continue;
    }
    const post = open[0]!;
    const as = post.state === "stream" ? (post.answered ? "end" : "answer") : post.kind === "engine-init" || post.kind === "reopen-init" ? "init-ok" : post.kind === "handshake" || post.kind === "note" || post.kind === "reply" ? "accepted" : "ok";
    trace.push(`drain: #${post.n} ${post.kind} <- ${as}`);
    if (!deliver(post, as)) { fail(`drain could not answer #${post.n}`); break; }
    await quiet();
  }
  if (seals().length === 0 && !turnOver && violations.length === 0) {
    await quiet(() => [...requests.values()].every((request) => request.answers.length >= 1));
    for (const [id, request] of requests) if (request.answers.length !== 1) fail(`A3/A6 request ${id} (${request.method}) has ${request.answers.length} answers after every held request was answered, and the mount is not sealed`);
    const reopens = posts.filter((post) => post.kind === "reopen-init").length;
    if (reopens > 4 * actions.filter((action) => action.do === "engine").length) fail(`A7 ${reopens} reopens for ${actions.length} actions`);
  }
  // a seal no step accounted for (it came after its step was judged): never silent
  await quiet();
  if (seals().length > judged) fail(`A1/A2 the mount was sealed after the last step was judged: ${seals().slice(judged).join(", ")}`);
  if (seals().some((reason) => reason === "handle")) fail("A8 the machine threw (sealed with the reason handle)");
  for (const reason of seals()) if (reason.startsWith("stale-tool:")) bump("T22 stale tool call sealed");
  if (seals().length > 0) bump("sealed"); else bump("not sealed");
  stats.steps = actions.length;
  stats.posts = posts.length;
  return {
    seed, actions, violations, trace, sealed: seals()[0] ?? null, stats, skipped,
    wire: posts.map((post) => `${post.kind} ${post.method || "(reply)"} @${post.header}`), answers: answersSeen, logs,
  };
  } finally {
    await rig.stop();
  }
}

/** Drops actions while the schedule still fails: the smallest failing schedule is the one to read. */
export async function shrink(actions: Action[], makeRig: MakeRig = inProcessRig): Promise<Outcome> {
  let best = await runSchedule(null, actions, makeRig);
  for (let changed = true, passes = 0; changed && passes < 6; passes++) {
    changed = false;
    for (let at = best.actions.length - 1; at >= 0; at--) {
      const fewer = best.actions.filter((_action, index) => index !== at);
      const tried = await runSchedule(null, fewer, makeRig);
      if (tried.violations.length > 0) { best = tried; changed = true; }
    }
  }
  return best;
}

export function describeFailure(outcome: Outcome): string {
  return [`seed ${outcome.seed}: ${outcome.violations.join(" | ")}`, `schedule: ${JSON.stringify(outcome.actions)}`, ...outcome.trace].join("\n");
}
