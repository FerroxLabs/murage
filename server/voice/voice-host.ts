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
import { isUnavailable, markUnavailable, notPermitted, VoiceUnavailable, type VoiceEndpoint } from "./voice-routes.ts";
import { splitSentences } from "../tts/speech-text.ts";
import { sameRequest } from "./hand-downs.ts";

/** Beyond this the host has stalled; the call falls back to the engine. */
const FIRST_TOKEN_TIMEOUT_MS = 6_000;
const TURN_TIMEOUT_MS = 20_000;
/** A lookup that has not answered by now is handed down instead. Measured
 *  through Flux on 2026-09-23: first words 2.4 s, whole answer 3.7 s. */
const LOOKUP_TIMEOUT_MS = 8_000;
/** Telling a finished answer reads the whole answer and the call first:
 *  six seconds to first words failed live on a long calendar answer. */
const BRIEF_FIRST_TOKEN_TIMEOUT_MS = 15_000;
const BRIEF_TURN_TIMEOUT_MS = 60_000;

export interface VoiceHostState {
  botName: string;
  /** The owner's House Rules block (house-rules.ts), "" when off. It opens
   *  the host's brief exactly as it opens every other prompt of the bot. */
  houseRules?: string;
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
  /** A host turn that handed work down: it becomes a tool call in the
   *  host's context, answered by that work's live status. */
  handDown?: { id: string; request: string };
}

/**
 * The call so far as chat messages. A turn that handed work down is an
 * assistant message with a `hand_down` tool call, followed by the tool
 * result: what became of the work (hand-downs.ts). The model then knows a
 * refused, failed, running or finished hand-down for what it is.
 */
export function historyMessages(history: VoiceHostTurn[], results: Record<string, string> = {}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const turn of history.slice(-12)) {
    if (turn.role === "owner") {
      out.push({ role: "user", content: turn.text });
    } else if (turn.handDown) {
      out.push({
        role: "assistant",
        content: turn.text || null,
        tool_calls: [{ id: turn.handDown.id, type: "function", function: { name: "hand_down", arguments: JSON.stringify({ request: turn.handDown.request }) } }],
      });
      out.push({ role: "tool", tool_call_id: turn.handDown.id, content: results[turn.handDown.id] ?? "Sent to your working self." });
    } else {
      out.push({ role: "assistant", content: turn.text });
    }
  }
  return out;
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
  if (state.houseRules?.trim()) lines.push(state.houseRules.trim(), "");
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
    "- First, does what came through make sense as something a person would say to you? Speech recognition turns noise and mumbles into nonsense (\"Have your jam honey\"). If it doesn't make sense, call no tool and hand nothing down: say you didn't catch that and ask them to say it again. Never answer nonsense with \"on it\", \"let me look into that\" or any promise.",
    "- Speak the way people talk on the phone: one to three short sentences, no lists, no markdown, no emoji, no URLs read aloud.",
    "- Answer from what you can see below when it answers the question. Say how fresh it is when that matters (\"as of ten minutes ago\"). Never mention a snapshot, a working self, layers or tools; to the owner you are simply you.",
    "- Questions about the owner's own things (their day, board, inbox, calendar, approvals, what is waiting on them) are never web lookups: answer from what you can see below, or hand them down. The current date and time are at the top of the snapshot.",
    "- A plain question of fact from the outside world (news, headlines, prices, scores, benchmarks, opening hours) that needs nothing of the owner's: say one short line such as \"Let me check.\", then call quick_lookup. This holds even if it was asked before on this call or in the conversation, or an earlier attempt was handed down or failed: a spoken answer now beats waiting on a task. Hand it down instead only when they ask for something made from it (a report, a document, a message to someone).",
    "- Anything else that needs doing, looking up, checking, writing, sending, deciding, or knowing more than you can see: first say one short neutral line such as \"Let me look into that.\", then call hand_down with a request your working self can act on without hearing this call. Use the owner's own words and add nothing they did not say. Do not guess instead, and never turn a request away as outside your role: your working self can research, check and do far more than you can see, so hand it down.",
    "- Never say something is started, sent, booked or done unless you can see it below, and never estimate time or progress (no \"almost done\", no \"in a minute\"). After hand_down, say you are on it, not that it is done.",
    "- If the owner asks about progress and nothing is running, say plainly that nothing is running (and, if you said earlier on this call that something could not start, that it could not start and why). Never hand the same request down again because they asked how it is going.",
    "- If work is already running and the owner asks how it is going, name only steps from the \"Steps so far\" list below, in plain words, and nothing else. If there is no list, say it is still working. If they ask to stop it, say so briefly and call cancel_task.",
    "- If an approval is waiting, answer what the owner asks about it from what you can see, in plain words (never a tool's internal name), and end by asking for a plain yes or no. Never decide it for them, never hand it down, and never say it is approved or denied.",
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
  /** Sentences already given out, in a plain form, for sentencesFrom. */
  readonly said = new Set<string>();

  push(delta: string): string[] {
    this.pending += delta;
    // one splitter for every spoken path (speech-text.ts): "Sept. 14" and
    // "the U.S. economy" stay in one sentence. A boundary needs the
    // whitespace after it, so a sentence is never cut while it streams in.
    const { sentences, rest } = splitSentences(this.pending, false);
    this.pending = rest;
    return sentences;
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

/** How a Flux lookup stream ended: its completion frame, with the sources
 *  and what Flux actually charged. */
interface LookupOutcome { done: boolean; citations?: string[]; searches?: number; costUsd?: string }

/** Read an OpenAI-shaped streaming completion into text and tool pieces.
 *  `lookup` collects a Flux lookup's completion frame. */
async function* readCompletion(body: ReadableStream<Uint8Array>, lookup?: LookupOutcome): AsyncGenerator<StreamPart> {
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
      if (frame?.object === "flux.voice.lookup.error") throw new Error(`lookup failed: ${frame?.error?.code ?? "unknown"}`);
      if (frame?.object === "flux.voice.lookup.done") {
        if (lookup) {
          lookup.done = true;
          if (Array.isArray(frame.citations)) lookup.citations = frame.citations.filter((c: unknown): c is string => typeof c === "string");
          if (Number.isInteger(frame.searches)) lookup.searches = frame.searches;
          if (typeof frame.cost_usd === "string") lookup.costUsd = frame.cost_usd;
        }
        continue;
      }
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
    if (!sentence || !allowedSentence(sentence)) continue;
    // gpt-6-luna without reasoning says its whole reply twice, a line apart
    // (seen in the raw stream, 2026-09-23): a sentence is said once a reply
    const plain = sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (splitter.said.has(plain)) continue;
    splitter.said.add(plain);
    yield sentence;
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "hand_down",
      description:
        "Give real work to your full working self (tools, files, apps, memory). Use for anything the snapshot cannot answer, except news, headlines and other plain facts from the web, which go to quick_lookup even if they were handed down before. Returns immediately; the work continues after you speak.",
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
        "Look one thing up on the web and answer it aloud yourself, for a question of fact that needs no files, apps or actions (news, prices, scores, benchmarks, opening hours). Never for something to be DONE, even if doing it starts with a search (book, reserve, buy, send, schedule, order): that is hand_down. Takes a few seconds; if it takes too long it is handed down automatically.",
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

function failure(status: number, provider = "Flux", said = ""): { reason: VoiceHostFailure; message: string } {
  const plan = provider === "Flux" ? "a paid Flux plan" : `credit on your ${provider} account`;
  // the key is fine; this feature is not switched on for it
  if (status === 403 && notPermitted(said)) return { reason: "unavailable", message: `Fast replies on calls are not switched on for this ${provider} key yet.` };
  if (status === 401 || status === 403) return { reason: "auth", message: `${provider} rejected the saved key.` };
  if (status === 402) return { reason: "premium", message: `Fast replies on calls need ${plan}.` };
  if (status === 404) return { reason: "unavailable", message: `Fast replies on calls are not available for this ${provider} account.` };
  if (status === 429) return { reason: "rate_limit", message: `${provider} is rate-limiting this account.` };
  return { reason: "upstream", message: `${provider} returned ${status}.` };
}

/** The display name of the provider behind an endpoint, for messages. */
function providerName(endpoint: VoiceEndpoint): string {
  return { flux: "Flux", xai: "xAI", openai: "OpenAI", anthropic: "Anthropic", groq: "Groq", openrouter: "OpenRouter" }[endpoint.via as string] ?? endpoint.label;
}

/**
 * Output length and sampling for a chat request, in the provider's terms.
 * OpenAI's current models refuse max_tokens (they take
 * max_completion_tokens) and any temperature but the default; every other
 * provider here takes the classic pair.
 */
/** What the provider said when it refused. A 400 is our request's fault and
 *  the provider says which part: logged for whoever reads the server log,
 *  never spoken. */
async function logRefusal(res: Response, provider: string): Promise<string> {
  const said = await res.text().catch(() => "");
  let message = said;
  try {
    const body = JSON.parse(said);
    message = body?.error?.message ?? body?.message ?? body?.detail ?? said;
  } catch {
    // not JSON: the text as sent
  }
  message = String(message).replace(/\s+/g, " ").slice(0, 300);
  if (res.status === 400) console.warn(`[voice-host] ${provider} refused the request: ${message}`);
  return message;
}

function sampling(endpoint: VoiceEndpoint, maxTokens: number): Record<string, number | string> {
  // OpenAI's current models reason by default, and refuse function tools on
  // this endpoint while they do ("set reasoning_effort to 'none'", its own
  // words for gpt-6-luna, 2026-09-23). A voice host must not think first.
  return endpoint.via === "openai" ? { max_completion_tokens: maxTokens, reasoning_effort: "none" } : { max_tokens: maxTokens, temperature: 0.2 };
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
      ...sampling(host, 1),
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
    if (!res.ok || !res.body) {
      const said = await logRefusal(res, providerName(endpoint));
      // a valid key this account may not use lookups with: the next source
      if (res.status === 403 && notPermitted(said)) throw new VoiceUnavailable("Flux lookups aren't switched on for this key yet.");
      throw new Error(`lookup ${res.status}`);
    }
    // Flux's contract (2026-09-23): HTTP 200 and [DONE] alone are not
    // success. Only a flux.voice.lookup.done frame is; an error frame can
    // come before or after text, and a stream that just ends is a dropped
    // connection. What was said before either is kept by the caller.
    const outcome: LookupOutcome = { done: false };
    for await (const part of readCompletion(res.body, outcome)) if (part.kind === "text") yield part.text;
    if (!outcome.done) throw new Error("lookup ended without finishing");
    if (outcome.costUsd) console.log(`[voice] lookup via Flux: ${outcome.searches ?? "?"} searches, $${outcome.costUsd}, ${outcome.citations?.length ?? 0} sources`);
    return;
  }
  if (endpoint.via === "xai" || endpoint.via === "openai") {
    const res = await post(
      "/responses",
      {
        model: endpoint.model,
        stream: true,
        max_output_tokens: 300,
        // OpenAI reasons first by default: 7.9-9 s for a news lookup, 4.6-5.8 s
        // without (measured 2026-09-23)
        ...(endpoint.via === "openai" ? { reasoning: { effort: "none" } } : {}),
        tools: [{ type: "web_search" }],
        input: [
          { role: "system", content: LOOKUP_INSTRUCTIONS },
          { role: "user", content: query },
        ],
      },
      bearer,
    );
    if (!res.ok || !res.body) {
      await logRefusal(res, providerName(endpoint));
      throw new Error(`lookup ${res.status}`);
    }
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
    if (!res.ok || !res.body) {
      await logRefusal(res, providerName(endpoint));
      throw new Error(`lookup ${res.status}`);
    }
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
  /** The live status of each hand-down in `history`, by id. */
  results?: Record<string, string>;
  /** Requests handed down on this call that are still running. A new
   *  hand-down of the same work is refused in code, not left to the prompt. */
  running?: string[];
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
    ...historyMessages(options.history, options.results),
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
          ...sampling(host, 300),
        }),
        signal: controller.signal,
      });
    } catch {
      if (options.signal?.aborted) return;
      yield timedOut
        ? { type: "error", reason: "timeout", message: "The fast reply took too long." }
        : { type: "error", reason: "upstream", message: `Couldn't reach ${providerName(host)}.` };
      return;
    }
    if (!res.ok || !res.body) {
      const said = await logRefusal(res, providerName(host));
      yield { type: "error", ...failure(res.status, providerName(host), said) };
      return;
    }

    // tool calls arrive in pieces keyed by index; assemble, then act once
    const calls = new Map<number, { name: string; args: string }>();
    const splitter = new SentenceSplitter();
    let spoke = false;
    let streamed = "";
    try {
      for await (const part of readCompletion(res.body)) {
        if (!spoke) {
          spoke = true;
          clearTimeout(firstToken);
        }
        if (part.kind === "text") {
          for (const sentence of sentencesFrom(splitter, part.text)) {
            streamed += `${sentence} `;
            yield { type: "sentence", text: sentence };
          }
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
    let spoken = "";
    for (const sentence of sentencesFrom(splitter, null)) {
      spoken += `${sentence} `;
      yield { type: "sentence", text: sentence };
    }

    // The lead-in line without the call (heard live: "Let me check." and
    // then nothing). The line promised a check or a look into it, so it
    // happens: a check is a quick lookup, a look into it is a hand-down.
    // Not while work is running or an approval is open: there "let me check"
    // is about that work, not a question for the web.
    if (!calls.size && !options.state.task.busy && !(options.running ?? []).length && !options.state.approval) {
      const said = `${streamed} ${spoken}`;
      if (/\blet me (check|find out|see what)\b|\bchecking (that|now)\b/i.test(said)) {
        calls.set(-1, { name: "quick_lookup", args: JSON.stringify({ query: options.said }) });
      } else if (/\blet me (look into|look at|get on|work on|dig into)\b/i.test(said)) {
        calls.set(-1, { name: "hand_down", args: JSON.stringify({ request: options.said }) });
      }
    }

    let handed = false;
    for (const { name, args } of calls.values()) {
      // Something to be done is work, even when doing it starts with a
      // search: grok-4.20 looked up "book me a table" instead of handing it
      // down, whatever the tool text said.
      if (name === "quick_lookup" && !handed && (WORK_ASKED.test(options.said) || OWNERS_OWN.test(options.said))) {
        handed = true;
        yield { type: "hand_down", request: options.said };
      } else if (name === "quick_lookup" && !handed && lookupSource) {
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
        // a lookup takes seconds: never start one in silence (Pipecat speaks
        // a line the moment a tool call starts; some models skip the line)
        if (!`${streamed} ${spoken}`.trim()) yield { type: "sentence", text: "Let me check." };
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
          // judged below: an answer already begun is kept, none is handed down.
          // Whole sentences that arrived before the failure are still said;
          // a half-finished one is not.
          if (!lookup.signal.aborted) {
            const tail = citations.flush();
            for (const sentence of [...(tail ? [...sentencesFrom(lookupSplitter, tail)] : []), ...sentencesFrom(lookupSplitter, null)]) {
              if (!/[.!?]["'”’)\]]*$/.test(sentence)) continue;
              answered = true;
              yield { type: "sentence", text: sentence };
            }
          }
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
        const work = request || options.said;
        // the same work is already running: say so instead of starting it
        // twice (LiveKit's on_duplicate="reject", done in code)
        if ((options.running ?? []).some((running) => sameRequest(running, work))) {
          yield { type: "sentence", text: "That's already under way." };
        } else {
          yield { type: "hand_down", request: work };
        }
      }
    }
    // Never say it is stopping without stopping: the model sometimes answers
    // "stop that" with "Stopping it." and no cancel_task. When work is
    // running, the owner asked to stop, and the reply says so, stop it.
    const cancelled = [...calls.values()].some((c) => c.name === "cancel_task");
    if (
      !cancelled &&
      !handed &&
      options.state.task.busy &&
      STOP_ASKED.test(options.said) &&
      !KEEP_GOING.test(options.said) &&
      STOP_SAID.test(`${streamed} ${spoken}`) &&
      !KEEP_GOING.test(`${streamed} ${spoken}`)
    ) {
      yield { type: "cancel" };
    }
    yield { type: "done" };
  } finally {
    clearTimeout(firstToken);
    clearTimeout(wholeTurn);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** About the owner's own things, which the web cannot know: what is waiting
 *  on me, my calendar, my inbox. grok-4.20 once looked up "current time and
 *  date" for "What's waiting on me?". */
const OWNERS_OWN = /\b(waiting (on|for) me|on my plate|my (day|board|inbox|e-?mails?|mail|calendar|schedule|meetings?|approvals?|tasks?|to-?dos?|week|morning|afternoon|evening|tonight))\b/i;
/** The owner asked for something to be DONE: book me a, send the, order... */
const WORK_ASKED = /\b(book|reserve|buy|order|purchase|send|email|text|message|schedule|pay|sign (me )?up|register|cancel|move|reschedule)\s+(me|us|a|an|the|my|our|it|that|this|him|her|them|some|\d)\b/i;
const STOP_ASKED = /\b(stop|cancel|never ?mind|forget (it|that)|halt|drop it)\b/i;
/** "Don't stop", "keep going", "I won't stop it": the opposite of a stop. */
const KEEP_GOING = /\b(don'?t|do not|won'?t|will not|not|never)\s+(\w+\s+){0,2}(stop|cancel|halt)|\bkeep (going|at it|on)|\bcarry on\b/i;
const STOP_SAID = /\b(stop(ping|ped)?|cancel(l?ing|l?ed)?|halt(ing|ed)?|dropp(ing|ed))\b/i;

/** Longest finished answer the host is asked to brief (about 3,000 words). */
export const BRIEF_MAX_CHARS = 20_000;

export interface VoiceBriefOptions {
  state: VoiceHostState;
  /** The working self's finished answer, as it appears in the chat. */
  answer: string;
  host: VoiceEndpoint | null;
  /** The call so far, so the answer is told as a reply to what was asked
   *  and nothing already said is said again. */
  history?: VoiceHostTurn[];
  results?: Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * A finished answer from the working self, told on the call. Neither LiveKit
 * nor Pipecat runs a separate summarizer: the result comes back into the same
 * conversation and the same voice model says it, as a reply to what was
 * asked. This is that. The wording follows LiveKit's REPLY_INSTRUCTIONS_AT_TAIL
 * (livekit-agents voice/tool_executor.py, Apache-2.0) and Pipecat's
 * _FINAL_DESCRIPTION (pipecat processors/aggregators/async_tool_messages.py,
 * BSD-2-Clause). Same event stream as a host turn; any failure is an `error`
 * event and the caller reads the answer out instead.
 */
export async function* runVoiceBrief(options: VoiceBriefOptions): AsyncGenerator<VoiceHostEvent> {
  const host = options.host;
  if (!host) {
    yield { type: "error", reason: "key", message: "Fast replies on calls need a Flux key or a model connection." };
    return;
  }
  const answer = clip(options.answer, BRIEF_MAX_CHARS);
  const alreadyInResults = Object.values(options.results ?? {}).some((result) => result.includes(answer.slice(0, 200)));
  const prompt = [
    voiceHostPrompt(options.state),
    "",
    "Your working self has just finished and written its answer into the chat.",
    alreadyInResults ? "The answer is the latest hand_down result above." : `Its answer:\n${answer}`,
    "Tell the owner now, as a spoken reply to what they asked. Answer it in full: for a list, every item in its own short sentence (the most important eight if there are more); keep every fact as written and add nothing.",
    "Do NOT repeat information you have already told the owner on this call. No lists, no markdown, no URLs, no headings read out, no preamble. If the answer asks them a question, end with that question; otherwise finish with a few words saying the details and sources are in the chat.",
  ].join("\n");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const firstToken = setTimeout(abort, BRIEF_FIRST_TOKEN_TIMEOUT_MS);
  const wholeTurn = setTimeout(abort, BRIEF_TURN_TIMEOUT_MS);
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
            ...historyMessages(options.history ?? [], options.results),
            // some providers need the conversation to end on a user turn; this
            // is an event marker, not something the owner said
            { role: "user", content: "[Call event: your working self's answer is ready. Tell me now.]" },
          ],
          stream: true,
          ...sampling(host, 500),
        }),
        signal: controller.signal,
      });
    } catch {
      if (!options.signal?.aborted) yield { type: "error", reason: "upstream", message: "Couldn't reach the fast model." };
      return;
    }
    if (!res.ok || !res.body) {
      const said = await logRefusal(res, providerName(host));
      yield { type: "error", ...failure(res.status, providerName(host), said) };
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
