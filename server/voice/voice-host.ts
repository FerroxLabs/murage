// The voice host: the fast half of a call.
//
// A call used to wait for the bot's engine (Claude Code, Codex, Fuigo) to
// finish a whole turn before a word was spoken. Measured on the owner's own
// question, that was about 7 seconds to first words and 23 seconds to an
// answer. The delay is the agent loop (plan, one tool after another, think),
// not the model: the same engine on a smaller model was slower still, while a
// fast model called directly through Flux starts answering in under a second.
//
// So a call has two layers and one bot. This file is the top layer: a direct
// streaming model call, not an agent, that speaks as the bot, answers what
// the bot's own state already knows, and hands everything else down to the
// engine. It is the same bot to the person on the call: its name, its
// personality text, its voice.
//
// WHAT IT MAY DO, ENFORCED BY SHAPE RATHER THAN BY PROMPT
// -------------------------------------------------------
// This module can read a snapshot it is given and emit events. It holds no
// store, no database, no connector and no engine. Its two tools do nothing
// here: `hand_down` and `cancel_task` become events, and the call screen
// carries them out through the same send and stop paths a typed message
// uses, under the same approvals. The host cannot change the world because
// nothing it can reach is able to.
//
// WHERE IT RUNS: Flux by default, or the owner's own model connection
// (voice-routes.ts picks; this file is handed the endpoint). Every provider
// used here speaks OpenAI-shaped streaming chat with tools, Anthropic through
// its OpenAI-compatible endpoint. Runs on the HARNESS, never the renderer:
// keys must not leave the server.
import { isUnavailable, markUnavailable, VoiceUnavailable, type VoiceEndpoint } from "./voice-routes.ts";

/** Beyond this the host has stalled; the call falls back to the engine. */
const FIRST_TOKEN_TIMEOUT_MS = 6_000;
const TURN_TIMEOUT_MS = 20_000;
/** A lookup that has not answered by now is handed down instead. Measured
 *  through Flux on 2026-09-23: first words 2.4 s, whole answer 3.7 s. */
const LOOKUP_TIMEOUT_MS = 8_000;

export interface VoiceHostState {
  botName: string;
  /** The bot's personality text, as the owner wrote it. */
  persona?: string;
  description?: string;
  /** Epoch ms; spoken ages are computed against it. */
  now: number;
  task: {
    title: string;
    /** A turn is running in the engine right now. */
    busy: boolean;
    /** The last few things the engine did, newest last, as short phrases. */
    activity: string[];
  };
  /** The current conversation, oldest first, already trimmed. */
  recent: Array<{ who: "owner" | "bot"; text: string; at: number }>;
  /** The bot's other tasks. */
  otherTasks: Array<{ title: string; at: number }>;
  /** What is waiting on the owner, from the inbox. */
  needsYou: Array<{ title: string; summary: string; at: number }>;
  /** An approval card open in this conversation right now. */
  approval?: string;
}

export interface VoiceHostTurn {
  role: "owner" | "host";
  text: string;
}

export type VoiceHostEvent =
  /** One whole sentence, ready to speak. Whole sentences rather than token
   *  deltas: a voice needs a sentence to sound right, and a sentence is the
   *  unit the promise filter below can judge. */
  | { type: "sentence"; text: string }
  | { type: "hand_down"; request: string }
  /** A web lookup started; its answer follows as sentences. */
  | { type: "lookup"; query: string }
  | { type: "cancel" }
  | { type: "done" }
  | { type: "error"; reason: VoiceHostFailure; message: string };

export type VoiceHostFailure = "key" | "auth" | "premium" | "unavailable" | "rate_limit" | "timeout" | "upstream";

const RECENT_CHARS = 600;

function ago(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The host's whole brief. Built from the bot's own profile plus a short
 * "you are on a call" block, so the owner never configures the host
 * separately and the host never sounds like a different assistant.
 */
export function voiceHostPrompt(state: VoiceHostState): string {
  const lines: string[] = [];
  lines.push(`You are ${state.botName}, on a live voice call with the person you work for.`);
  // The profile sets HOW the bot sounds, never what it may take on: a
  // description like "runs my calendar" made the model turn an ordinary
  // research question away as "not my lane" in the live eval.
  if (state.persona?.trim() || state.description?.trim()) {
    lines.push("Your manner of speaking, in your owner's words. This shapes how you sound only; it never limits what you will take on:");
    if (state.description?.trim()) lines.push(clip(state.description, 400));
    if (state.persona?.trim()) lines.push(clip(state.persona, 1500));
  }
  lines.push(
    "",
    "How this call works. You are the fast voice of yourself. Your full working self (tools, files, connected apps, the web, memory) runs underneath and takes seconds to minutes. You can see only the snapshot below.",
    "",
    "Rules:",
    "- Speak the way people talk on the phone: one to three short sentences, no lists, no markdown, no emoji, no URLs read aloud.",
    "- Answer from what you can see below when it answers the question. Say how fresh it is when that matters (\"as of ten minutes ago\"). Never mention a snapshot, a working self, layers or tools; to the owner you are simply you.",
    "- A plain question of fact from the outside world (news, prices, scores, benchmarks, opening hours) that needs nothing of the owner's: say one short line such as \"Let me check.\", then call quick_lookup.",
    "- Anything else that needs doing, looking up, checking, writing, sending, deciding, or knowing more than you can see: first say one short neutral line such as \"Let me look into that.\", then call hand_down with a request your working self can act on without hearing this call. Use the owner's own words and add nothing they did not say. Do not guess instead, and never turn a request away as outside your role: your working self can research, check and do far more than you can see, so hand it down.",
    "- Never say something is started, sent, booked or done unless you can see it below, and never estimate time or progress (no \"almost done\", no \"in a minute\"). After hand_down, say you are on it, not that it is done.",
    "- If the owner asks about progress and nothing is running, say plainly that nothing is running (and, if you said earlier on this call that something could not start, that it could not start and why). Never hand the same request down again because they asked how it is going.",
    "- If work is already running and the owner asks how it is going, name only steps from the \"Steps so far\" list below, in plain words, and nothing else. If there is no list, say it is still working. If they ask to stop it, say so briefly and call cancel_task.",
    "- If an approval is waiting, tell the owner what it is and that a plain yes or no answers it.",
    "- The owner's words reach you through speech recognition, which mishears names (yours included) and small words. Answer what they meant; never correct or remark on how something came through.",
    "- If the owner is just chatting, chat back briefly, in character.",
    "",
    `Snapshot (now: ${new Date(state.now).toISOString()}):`,
    `Current task: ${state.task.title || "(untitled)"}. ${state.task.busy ? "Your working self is busy on it right now." : "Nothing is running."}`,
  );
  if (state.task.busy) {
    lines.push(
      state.task.activity.length
        ? `Steps so far, newest last (the only progress you may mention): ${state.task.activity.map((a) => clip(a, 80)).join("; ")}.`
        : "Steps so far: none reported yet.",
    );
  }
  if (state.approval) lines.push(`Waiting for the owner's approval: ${clip(state.approval, 300)}`);
  if (state.recent.length) {
    lines.push("This conversation so far, oldest first:");
    for (const m of state.recent) {
      lines.push(`[${ago(state.now, m.at)}] ${m.who === "owner" ? "Owner" : "You"}: ${clip(m.text, RECENT_CHARS)}`);
    }
  }
  if (state.needsYou.length) {
    lines.push("Waiting on the owner:");
    for (const item of state.needsYou) lines.push(`- ${clip(item.title, 120)}: ${clip(item.summary, 200)} (${ago(state.now, item.at)})`);
  }
  if (state.otherTasks.length) {
    lines.push(`Your other tasks: ${state.otherTasks.map((t) => `${clip(t.title, 60)} (${ago(state.now, t.at)})`).join("; ")}.`);
  }
  return lines.join("\n");
}

/**
 * Sentences the host must not say, whatever the prompt asked. A progress or
 * time estimate is a promise made on the engine's behalf, and the live eval
 * showed the model adding one ("should have it in a minute or two") in about
 * half the "how's it going" turns even when told not to.
 */
const PROMISE = /\b(in (a|one|two|a few|a couple( of)?) (sec|second|seconds|min|minute|minutes|moment|moments)|(a )?(few|couple( of)?) (minutes|seconds|moments)|almost (done|ready|there|finished)|nearly (done|ready|there|finished)|any (minute|second) now|shortly|right away)\b/i;

export function allowedSentence(sentence: string): boolean {
  return !PROMISE.test(sentence);
}

/** Split streamed text into sentences as they complete. */
export class SentenceSplitter {
  private pending = "";

  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];
    // a sentence ends at . ! ? or an em dash run-on only when followed by
    // whitespace, so "1,240.50" and "U.S." mid-sentence do not split early
    const boundary = /[.!?]["')\]]*\s+/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.pending))) {
      const sentence = this.pending.slice(last, match.index + match[0].length).trim();
      if (sentence) out.push(sentence);
      last = match.index + match[0].length;
    }
    this.pending = this.pending.slice(last);
    return out;
  }

  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = "";
    return rest ? [rest] : [];
  }
}

/** Markdown is for eyes: a voice would read the asterisks. */
export function spokenText(sentence: string): string {
  return sentence
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type StreamPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; index: number; name?: string; args?: string };

/** Read an OpenAI-shaped streaming completion into text and tool pieces. */
async function* readCompletion(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let frame: any;
      try {
        frame = JSON.parse(data);
      } catch {
        continue;
      }
      if (frame?.object === "flux.voice.lookup.error") throw new Error("lookup failed");
      const delta = frame?.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) yield { kind: "text", text: delta.content };
      for (const part of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        yield {
          kind: "tool",
          index: typeof part?.index === "number" ? part.index : 0,
          name: typeof part?.function?.name === "string" ? part.function.name : undefined,
          args: typeof part?.function?.arguments === "string" ? part.function.arguments : undefined,
        };
      }
    }
  }
}

/** Speakable sentences from a stream of text pieces. */
function* sentencesFrom(splitter: SentenceSplitter, text: string | null): Generator<string> {
  for (const raw of text === null ? splitter.flush() : splitter.push(text)) {
    const sentence = spokenText(raw);
    if (sentence && allowedSentence(sentence)) yield sentence;
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "hand_down",
      description:
        "Give real work to your full working self (tools, files, apps, web, memory). Use for anything the snapshot cannot answer. Returns immediately; the work continues after you speak.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The complete request, in the owner's terms, that your working self can act on without hearing this call.",
          },
        },
        required: ["request"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quick_lookup",
      description:
        "Look one thing up on the web and answer it aloud yourself, for a question of fact that needs no files, apps or actions (news, prices, scores, benchmarks, opening hours). Takes a few seconds; if it takes too long it is handed down automatically.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The question to look up, self-contained." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description: "Stop the work that is currently running, because the owner asked to.",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

function failure(status: number): { reason: VoiceHostFailure; message: string } {
  if (status === 401 || status === 403) return { reason: "auth", message: "Flux rejected the workspace key." };
  if (status === 402) return { reason: "premium", message: "Fast replies on calls need a paid Flux plan." };
  if (status === 404) return { reason: "unavailable", message: "Fast replies on calls are not available for this Flux account." };
  if (status === 429) return { reason: "rate_limit", message: "Flux is rate-limiting this account." };
  return { reason: "upstream", message: `Flux returned ${status}.` };
}

/**
 * Open the connection and wake the model when a call starts, so the owner's
 * first question does not pay the cold start (measured 2.3-5 s cold against
 * about 1.3 s warm). One token, fire and forget; a failure here only means
 * the first reply is slower.
 */
export async function warmVoiceHost(host: VoiceEndpoint | null, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!host) return;
  await fetchImpl(`${host.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: host.model,
      messages: [{ role: "user", content: "Say ok." }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(FIRST_TOKEN_TIMEOUT_MS),
  })
    .then((res) => res.body?.cancel())
    .catch(() => undefined);
}

/**
 * Drop citation markers from streamed lookup text. xAI appends
 * `[[1]](https://…)` after sentences even when asked not to, and a marker can
 * arrive split across chunks, so an unfinished `[` is held back until it
 * either closes into a marker (dropped) or turns out to be ordinary text.
 */
export class CitationFilter {
  private held = "";

  push(text: string): string {
    this.held += text;
    let out = "";
    for (;;) {
      const open = this.held.indexOf("[");
      if (open < 0) {
        out += this.held;
        this.held = "";
        return out;
      }
      out += this.held.slice(0, open);
      this.held = this.held.slice(open);
      const marker = this.held.match(/^\[\[?\d+\]?\]/);
      if (!marker) {
        if (/^\[\[?\d*\]?$/.test(this.held)) return out; // a marker may still be arriving
        out += "["; // an ordinary bracket
        this.held = this.held.slice(1);
        continue;
      }
      const rest = this.held.slice(marker[0].length);
      if (rest === "") return out; // its link may follow
      if (rest.startsWith("(")) {
        const close = rest.indexOf(")");
        if (close >= 0) {
          this.held = rest.slice(close + 1);
          continue;
        }
        if (/^\([^\s]*$/.test(rest)) return out; // the link is still arriving
      }
      this.held = rest; // a bare marker: drop it
    }
  }

  /** At the end of the stream a half-arrived marker is dropped, not spoken. */
  flush(): string {
    const rest = /^\[\[?\d*\]?\]?(\([^\s)]*)?$/.test(this.held) ? "" : this.held;
    this.held = "";
    return rest;
  }
}

const LOOKUP_INSTRUCTIONS =
  "You are answering aloud on a phone call. Answer in two or three short spoken sentences with the key facts and where they come from. No markdown, no URLs, no lists.";

/** Text pieces from a Responses-API stream (xAI and OpenAI share the shape). */
async function* responsesText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const event of sseEvents(body)) {
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") yield event.delta;
    if (event?.type === "error" || event?.type === "response.failed") throw new Error("lookup failed");
  }
}

/** Text pieces from an Anthropic Messages stream. */
async function* anthropicText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const event of sseEvents(body)) {
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") yield event.delta.text;
    if (event?.type === "error") throw new Error("lookup failed");
  }
}

/** Parsed `data:` events of an SSE body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // a malformed frame is skipped
      }
    }
  }
}

/**
 * A web lookup, as text pieces, on whichever source serves lookups: Flux's
 * `/v1/voice/lookup` (xAI's web search behind Flux; Flux's older search route
 * never went live), or the owner's own xAI, OpenAI or Anthropic key with that
 * provider's own web search tool.
 */
async function* lookupText(query: string, endpoint: VoiceEndpoint, call: typeof fetch, signal: AbortSignal): AsyncGenerator<string> {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(`${endpoint.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  const bearer = { authorization: `Bearer ${endpoint.key}` };
  if (endpoint.via === "flux") {
    const res = await post("/voice/lookup", { query, instructions: LOOKUP_INSTRUCTIONS, model: endpoint.model }, bearer);
    // 404: Flux's lookup capability is not switched on for this account yet
    if (res.status === 404) throw new VoiceUnavailable("Flux lookups aren't switched on for this account yet.");
    if (!res.ok || !res.body) throw new Error(`lookup ${res.status}`);
    for await (const part of readCompletion(res.body)) if (part.kind === "text") yield part.text;
    return;
  }
  if (endpoint.via === "xai" || endpoint.via === "openai") {
    const res = await post(
      "/responses",
      {
        model: endpoint.model,
        stream: true,
        max_output_tokens: 300,
        tools: [{ type: "web_search" }],
        input: [
          { role: "system", content: LOOKUP_INSTRUCTIONS },
          { role: "user", content: query },
        ],
      },
      bearer,
    );
    if (!res.ok || !res.body) throw new Error(`lookup ${res.status}`);
    yield* responsesText(res.body);
    return;
  }
  if (endpoint.via === "anthropic") {
    const res = await post(
      "/messages",
      {
        model: endpoint.model,
        stream: true,
        max_tokens: 400,
        system: LOOKUP_INSTRUCTIONS,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: query }],
      },
      { "x-api-key": endpoint.key, "anthropic-version": "2023-06-01" },
    );
    if (!res.ok || !res.body) throw new Error(`lookup ${res.status}`);
    yield* anthropicText(res.body);
    return;
  }
  throw new Error(`no lookup on ${endpoint.via}`);
}

export interface VoiceHostOptions {
  state: VoiceHostState;
  /** Earlier exchanges on this call, oldest first. */
  history: VoiceHostTurn[];
  /** What the owner just said. */
  said: string;
  /** Where the host runs; null when no source can serve it. */
  host: VoiceEndpoint | null;
  /** Where lookups run, in the order to try them; none offers no lookup
   *  tool (the host hands down). */
  lookup?: VoiceEndpoint | VoiceEndpoint[] | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * One host turn, as a stream of events. Never throws: every failure is an
 * `error` event, because the caller's answer to any failure is the same
 * (fall back to handing the words to the engine) and a throw would be one
 * more path to forget.
 */
export async function* runVoiceHostTurn(options: VoiceHostOptions): AsyncGenerator<VoiceHostEvent> {
  const host = options.host;
  if (!host) {
    yield { type: "error", reason: "key", message: "Fast replies on calls need a Flux key or a model connection." };
    return;
  }
  // a source that said lookups are not switched on is skipped for a while
  const lookupSources = [options.lookup ?? []].flat().filter((source) => !isUnavailable(source));
  const lookupSource = lookupSources.length > 0;
  const tools = lookupSource ? TOOLS : TOOLS.filter((tool) => tool.function.name !== "quick_lookup");
  const messages = [
    { role: "system", content: voiceHostPrompt(options.state) },
    ...options.history.slice(-12).map((turn) => ({
      role: turn.role === "owner" ? "user" : "assistant",
      content: turn.text,
    })),
    { role: "user", content: options.said },
  ];

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const firstToken = setTimeout(abort, FIRST_TOKEN_TIMEOUT_MS);
  const wholeTurn = setTimeout(abort, TURN_TIMEOUT_MS);
  const call = options.fetchImpl ?? fetch;
  let timedOut = false;
  controller.signal.addEventListener("abort", () => { timedOut = !options.signal?.aborted; }, { once: true });

  try {
    let res: Response;
    try {
      res = await call(`${host.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: host.model,
          messages,
          tools,
          stream: true,
          max_tokens: 300,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch {
      if (options.signal?.aborted) return;
      yield timedOut
        ? { type: "error", reason: "timeout", message: "The fast reply took too long." }
        : { type: "error", reason: "upstream", message: "Couldn't reach Flux." };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", ...failure(res.status) };
      return;
    }

    // tool calls arrive in pieces keyed by index; assemble, then act once
    const calls = new Map<number, { name: string; args: string }>();
    const splitter = new SentenceSplitter();
    let spoke = false;
    try {
      for await (const part of readCompletion(res.body)) {
        if (!spoke) {
          spoke = true;
          clearTimeout(firstToken);
        }
        if (part.kind === "text") {
          for (const sentence of sentencesFrom(splitter, part.text)) yield { type: "sentence", text: sentence };
        } else {
          const entry = calls.get(part.index) ?? { name: "", args: "" };
          entry.name += part.name ?? "";
          entry.args += part.args ?? "";
          calls.set(part.index, entry);
        }
      }
    } catch {
      if (options.signal?.aborted) return;
      yield timedOut
        ? { type: "error", reason: "timeout", message: "The fast reply took too long." }
        : { type: "error", reason: "upstream", message: "The fast reply was cut off." };
      return;
    }
    for (const sentence of sentencesFrom(splitter, null)) yield { type: "sentence", text: sentence };

    let handed = false;
    for (const { name, args } of calls.values()) {
      if (name === "quick_lookup" && !handed && lookupSource) {
        let query = "";
        try {
          const parsed = JSON.parse(args || "{}");
          query = typeof parsed?.query === "string" ? parsed.query.trim() : "";
        } catch {
          // fall through to the owner's own words
        }
        query ||= options.said;
        handed = true;
        clearTimeout(wholeTurn);
        yield { type: "lookup", query };
        // The lookup has its own clock. Nothing heard by LOOKUP_TIMEOUT_MS,
        // or any failure before the first sentence: the engine takes it, so
        // the owner still gets an answer, just a slower one.
        const lookup = new AbortController();
        const stopLookup = () => lookup.abort();
        options.signal?.addEventListener("abort", stopLookup, { once: true });
        const deadline = setTimeout(stopLookup, LOOKUP_TIMEOUT_MS);
        const lookupSplitter = new SentenceSplitter();
        const citations = new CitationFilter();
        let answered = false;
        try {
          for (const source of lookupSources) {
            try {
              for await (const text of lookupText(query, source, call, lookup.signal)) {
                for (const sentence of sentencesFrom(lookupSplitter, citations.push(text))) {
                  if (!answered) clearTimeout(deadline);
                  answered = true;
                  yield { type: "sentence", text: sentence };
                }
              }
              break;
            } catch (error) {
              // not switched on, and nothing said yet: the next source takes it
              if (!(error instanceof VoiceUnavailable) || answered) throw error;
              markUnavailable(source);
            }
          }
          const tail = citations.flush();
          for (const sentence of [...(tail ? [...sentencesFrom(lookupSplitter, tail)] : []), ...sentencesFrom(lookupSplitter, null)]) {
            answered = true;
            yield { type: "sentence", text: sentence };
          }
        } catch {
          // judged below: an answer already begun is kept, none is handed down
        } finally {
          clearTimeout(deadline);
          options.signal?.removeEventListener("abort", stopLookup);
        }
        if (options.signal?.aborted) return;
        if (!answered) yield { type: "hand_down", request: query };
      } else if (name === "quick_lookup" && !handed) {
        // asked for a lookup that is not on offer (every source refused):
        // the engine takes the question rather than it going unanswered
        handed = true;
        let query = "";
        try {
          const parsed = JSON.parse(args || "{}");
          query = typeof parsed?.query === "string" ? parsed.query.trim() : "";
        } catch {}
        yield { type: "hand_down", request: query || options.said };
      } else if (name === "cancel_task") {
        yield { type: "cancel" };
      } else if (name === "hand_down" && !handed) {
        // one hand-down per owner turn: a model that calls it twice for one
        // sentence would start the same work twice
        let request = "";
        try {
          const parsed = JSON.parse(args || "{}");
          request = typeof parsed?.request === "string" ? parsed.request.trim() : "";
        } catch {
          // malformed arguments: hand down the owner's own words instead
        }
        handed = true;
        yield { type: "hand_down", request: request || options.said };
      }
    }
    yield { type: "done" };
  } finally {
    clearTimeout(firstToken);
    clearTimeout(wholeTurn);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Longest finished answer the host is asked to brief (about 3,000 words). */
export const BRIEF_MAX_CHARS = 20_000;

export interface VoiceBriefOptions {
  state: VoiceHostState;
  /** The working self's finished answer, as it appears in the chat. */
  answer: string;
  host: VoiceEndpoint | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * A long finished answer, told the way a person would on the phone: the
 * gist in two or three sentences, then that the full version is in the chat.
 * A page of headings and bullets read aloud is minutes of listening to what
 * the owner can skim in seconds. Same event stream as a host turn; any
 * failure is an `error` event and the caller reads the answer out instead.
 */
export async function* runVoiceBrief(options: VoiceBriefOptions): AsyncGenerator<VoiceHostEvent> {
  const host = options.host;
  if (!host) {
    yield { type: "error", reason: "key", message: "Fast replies on calls need a Flux key or a model connection." };
    return;
  }
  const prompt = [
    `You are ${options.state.botName}, on a live voice call with the person you work for.`,
    "Your working self just finished what they asked for and wrote the answer below into the chat, which they can read later.",
    "Tell them the gist the way people talk on the phone: at most three short sentences, the most important point first, no lists, no markdown, no URLs, no reading out of headings.",
    "Keep every fact exactly as written; add nothing. If the answer asks them a question, end with that question.",
    "Then say, in a few words, that the full version is in the chat.",
  ].join("\n");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const firstToken = setTimeout(abort, FIRST_TOKEN_TIMEOUT_MS);
  const wholeTurn = setTimeout(abort, TURN_TIMEOUT_MS);
  const call = options.fetchImpl ?? fetch;
  try {
    let res: Response;
    try {
      res = await call(`${host.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: host.model,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: clip(options.answer, BRIEF_MAX_CHARS) },
          ],
          stream: true,
          max_tokens: 200,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch {
      if (!options.signal?.aborted) yield { type: "error", reason: "upstream", message: "Couldn't reach the fast model." };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", ...failure(res.status) };
      return;
    }
    const splitter = new SentenceSplitter();
    try {
      for await (const part of readCompletion(res.body)) {
        clearTimeout(firstToken);
        if (part.kind === "text") for (const sentence of sentencesFrom(splitter, part.text)) yield { type: "sentence", text: sentence };
      }
    } catch {
      if (!options.signal?.aborted) yield { type: "error", reason: "upstream", message: "The brief was cut off." };
      return;
    }
    for (const sentence of sentencesFrom(splitter, null)) yield { type: "sentence", text: sentence };
    yield { type: "done" };
  } finally {
    clearTimeout(firstToken);
    clearTimeout(wholeTurn);
    options.signal?.removeEventListener("abort", abort);
  }
}
