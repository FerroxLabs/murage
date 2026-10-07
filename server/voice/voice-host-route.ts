// The HTTP door onto the voice host: `POST /api/bots/:id/voice-host`.
//
// A separate file for the same reason transcribe-route.ts is one: index.ts
// grows a few lines, and everything this route reads arrives through `deps`,
// so a test can hand it a fake bot and a fake inbox without a server.
//
// READ ONLY. The route builds a snapshot from what the store already holds
// and streams the host's events back as server-sent events. It never appends
// a message, starts a turn or answers an approval. When the host decides to
// hand work down, the call screen sends that request through the ordinary
// message route, so the engine turn, the steer queue, the approvals and the
// transcript are exactly the ones a typed message gets.
import type { IncomingMessage, ServerResponse } from "node:http";

import { houseRulesPrompt } from "../house-rules.ts";
import type { Message } from "../store.ts";
import { handDownResult, handDownStatus, parseHandDowns, type HandDownReceipt } from "./hand-downs.ts";
import {
  BRIEF_MAX_CHARS,
  type HostTiming,
  runVoiceBrief,
  runVoiceHostTurn,
  warmVoiceHost,
  type VoiceBriefOptions,
  type VoiceHostEvent,
  type VoiceHostOptions,
  type VoiceHostRoom,
  type VoiceHostState,
  type VoiceHostTurn,
} from "./voice-host.ts";
import type { VoiceEndpoint } from "./voice-routes.ts";

export const VOICE_HOST_PATH = /^\/api\/bots\/([\w-]+)\/voice-host$/;

/** The thread as the host sees it: the newest few messages. The prompt is
 *  rebuilt every turn, and its size is most of the time to first words
 *  (16 messages of 600 chars measured at a 3.1 s median on a live call,
 *  2026-09-30; voice-host.ts clips each to RECENT_CHARS). */
const RECENT_MESSAGES = 8;
const ACTIVITY_STEPS = 6;
const SAID_MAX_CHARS = 2_000;
/** Each of the host's own earlier lines, as the model reads it back. What
 *  the call screen keeps is not changed; a long spoken reply is only
 *  shortened here, with its end kept (it may say where the owner cut in). */
export const HOST_TURN_CHARS = 500;

/** A long host line for the model: its opening and its end. */
export function clipHostTurn(text: string, max = HOST_TURN_CHARS): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max * 0.3);
  return `${text.slice(0, max - tail - 3).trimEnd()} … ${text.slice(-tail).trimStart()}`;
}

export interface VoiceHostRouteBot {
  id: string;
  name: string;
  description?: string;
  persona?: string;
  threadId: string;
  busy?: boolean;
  hidden?: boolean;
  tasks?: Array<{ threadId: string; title: string; createdAt: number }>;
}

/** A channel, as a room call's snapshot reads it. */
export interface VoiceHostRouteGroup {
  id: string;
  name: string;
  threadId: string;
  memberIds: string[];
  busyBotId?: string | null;
  tasks?: Array<{ threadId: string; title: string; createdAt: number }>;
}

export interface VoiceHostRouteDeps {
  bot(id: string): VoiceHostRouteBot | null;
  /** A channel the caller may hold a room call in; null when it does not
   *  exist or this caller may not call it (index.ts: desktop only). */
  group?(id: string): VoiceHostRouteGroup | null;
  /** The active branch of a thread, oldest first. */
  activePath(threadId: string): Message[];
  /** What the harness holds for a hand-down's request row in a room: its
   *  state and note, or "missing" when the row is gone. */
  requestReceipt?(groupId: string, requestId: string): HandDownReceipt | undefined;
  lastActivityAt(threadId: string): number | undefined;
  /** Open decisions and unread news for this bot, newest first. */
  needsYou(botId: string): Array<{ title: string; summary: string; at: number }>;
  readBody(req: IncomingMessage): Promise<any>;
  /** Where the host and lookups run right now (voice-routes.ts). */
  endpoints(): { host: VoiceEndpoint | null; lookup: VoiceEndpoint[] };
  run?: (options: VoiceHostOptions) => AsyncGenerator<VoiceHostEvent>;
  brief?: (options: VoiceBriefOptions) => AsyncGenerator<VoiceHostEvent>;
  warm?: (host: VoiceEndpoint | null) => Promise<void>;
  now?: () => number;
}

/** The snapshot the host speaks from. Exported for tests. */
export function voiceHostState(
  bot: VoiceHostRouteBot,
  threadId: string,
  deps: Pick<VoiceHostRouteDeps, "activePath" | "lastActivityAt" | "needsYou">,
  now: number,
  approval?: string,
  handedDown: string[] = [],
): VoiceHostState {
  const path = deps.activePath(threadId);
  const fromThisCall = new Set(handedDown.map((r) => r.trim()));
  // A turn that failed leaves an error step, not a message. It belongs in the
  // conversation the host sees, or "are you doing it?" is answered (and
  // handed down again) as if the work were under way.
  const failed = (m: Message) => m.kind === "activity" && m.tool?.ok === false && /^error:/i.test(m.tool.name ?? "");
  const recent = path
    .filter((m) => (m.kind === "text" && typeof m.text === "string" && m.text.trim() && !(m.role === "user" && fromThisCall.has(m.text.trim()))) || failed(m))
    .slice(-RECENT_MESSAGES)
    .map((m) =>
      failed(m)
        ? { who: "bot" as const, text: `(That attempt failed and nothing is running: ${m.tool!.errorDetails || m.tool!.name.replace(/^error:\s*/i, "")})`, at: m.at }
        : { who: m.role === "user" ? ("owner" as const) : ("bot" as const), text: m.text!, at: m.at },
    );
  // Steps from the running turn only: the chips after the owner's last line.
  let lastOwner = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i].role === "user" && path[i].kind === "text") {
      lastOwner = i;
      break;
    }
  }
  const activity = path
    .slice(lastOwner + 1)
    .filter((m) => m.kind === "activity" && m.tool)
    .map((m) => m.tool!.spoken || m.tool!.summary || m.tool!.name)
    .filter(Boolean)
    .slice(-ACTIVITY_STEPS);
  const tasks = bot.tasks ?? [];
  const current = tasks.find((t) => t.threadId === threadId);
  return {
    botName: bot.name,
    houseRules: houseRulesPrompt(),
    persona: bot.persona,
    description: bot.description,
    now,
    task: { title: current?.title ?? "", busy: Boolean(bot.busy) && bot.threadId === threadId, activity },
    recent,
    otherTasks: tasks
      .filter((t) => t.threadId !== threadId)
      .map((t) => ({ title: t.title, at: deps.lastActivityAt(t.threadId) ?? t.createdAt }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5),
    needsYou: deps.needsYou(bot.id).slice(0, 5),
    approval: approval?.trim() || undefined,
  };
}

const ROOM_HEARD = 6;
const ROOM_MEMBERS = 12;
const ROOM_NAME_CHARS = 40;

/** A member name as the prompt reads it: one line, bounded. */
function roomName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, ROOM_NAME_CHARS).trim() : "";
}

/** What was said to other members' voices on this call. Exported for tests. */
export function parseRoomHeard(raw: unknown): VoiceHostRoom["heard"] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceHostRoom["heard"] = [];
  for (const entry of raw) {
    const member = roomName(entry?.member);
    const owner = typeof entry?.owner === "string" ? entry.owner.trim().slice(0, 400) : "";
    const reply = typeof entry?.reply === "string" ? clipHostTurn(entry.reply.trim(), 400) : "";
    if (member && (owner || reply)) out.push({ member, owner, reply });
  }
  return out.slice(-ROOM_HEARD);
}

/** The snapshot a member's voice speaks from on a room call. Read only, like
 *  voiceHostState; no inbox and no other tasks: the room's own approval flow
 *  speaks decisions, and the snapshot stays small. Exported for tests. */
export function voiceHostRoomState(
  bot: VoiceHostRouteBot,
  group: VoiceHostRouteGroup,
  threadId: string,
  deps: Pick<VoiceHostRouteDeps, "activePath" | "bot">,
  now: number,
  opts: { approval?: string; handedDown?: string[]; heard?: VoiceHostRoom["heard"] } = {},
): VoiceHostState {
  const path = deps.activePath(threadId);
  const fromThisCall = new Set((opts.handedDown ?? []).map((r) => r.trim()));
  const own = (m: Message) => !m.from || m.from.botId === bot.id;
  // a room-wide error row has no sender: it is nobody's own failure
  const failed = (m: Message) => m.kind === "activity" && m.tool?.ok === false && /^error:/i.test(m.tool.name ?? "") && m.from?.botId === bot.id;
  const recent = path
    .filter((m) => (m.kind === "text" && typeof m.text === "string" && m.text.trim() && !(m.role === "user" && fromThisCall.has(m.text.trim()))) || failed(m))
    .slice(-RECENT_MESSAGES)
    .map((m) => {
      if (failed(m)) return { who: "bot" as const, text: `(That attempt failed and nothing is running: ${m.tool!.errorDetails || m.tool!.name.replace(/^error:\s*/i, "")})`, at: m.at };
      if (m.role === "user") return { who: "owner" as const, text: m.text!, at: m.at };
      if (!own(m)) return { who: "member" as const, name: roomName(m.from!.name), text: m.text!, at: m.at };
      return { who: "bot" as const, text: m.text!, at: m.at };
    });
  let lastOwner = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i].role === "user" && path[i].kind === "text") {
      lastOwner = i;
      break;
    }
  }
  const busy = group.busyBotId === bot.id && group.threadId === threadId;
  const activity = busy
    ? path.slice(lastOwner + 1).filter((m) => m.kind === "activity" && m.tool && own(m)).map((m) => m.tool!.spoken || m.tool!.summary || m.tool!.name).filter(Boolean).slice(-ACTIVITY_STEPS)
    : [];
  const members = group.memberIds
    .filter((id) => id !== bot.id)
    .map((id) => deps.bot(id))
    .filter((m): m is VoiceHostRouteBot => Boolean(m && !m.hidden))
    .slice(0, ROOM_MEMBERS)
    .map((m) => ({ name: roomName(m.name), ...(m.description?.trim() ? { description: m.description } : {}) }));
  const workingName = group.busyBotId && group.busyBotId !== bot.id ? deps.bot(group.busyBotId)?.name : undefined;
  return {
    botName: bot.name,
    houseRules: houseRulesPrompt(),
    persona: bot.persona,
    description: bot.description,
    now,
    task: { title: (group.tasks ?? []).find((t) => t.threadId === threadId)?.title ?? group.name, busy, activity },
    recent,
    otherTasks: [],
    needsYou: [],
    approval: opts.approval?.trim() || undefined,
    room: { name: group.name, members, working: workingName ? roomName(workingName) : null, heard: (opts.heard ?? []).slice(-ROOM_HEARD) },
  };
}

/** Exported for tests. */
export function parseHistory(raw: unknown): VoiceHostTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: VoiceHostTurn[] = [];
  for (const entry of raw.slice(-12)) {
    const role = entry?.role === "host" ? "host" : entry?.role === "owner" ? "owner" : null;
    const text = typeof entry?.text === "string" ? entry.text.trim().slice(0, SAID_MAX_CHARS) : "";
    const id = typeof entry?.handDown?.id === "string" && /^[\w-]{1,64}$/.test(entry.handDown.id) ? entry.handDown.id : "";
    const request = typeof entry?.handDown?.request === "string" ? entry.handDown.request.trim().slice(0, 2_000) : "";
    const handDown = role === "host" && id && request ? { id, request } : undefined;
    if (role && (text || handDown)) turns.push({ role, text: role === "host" ? clipHostTurn(text) : text, ...(handDown ? { handDown } : {}) });
  }
  return turns;
}

/** Returns true when it handled the request. */
export async function handleVoiceHostRoute(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: VoiceHostRouteDeps,
): Promise<boolean> {
  const match = path.match(VOICE_HOST_PATH);
  if (!match || method !== "POST") return false;
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
  };
  const body = await deps.readBody(req).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(400, { error: "body must be a JSON object" });
  if (body.warm === true) {
    if (!deps.bot(match[1])) return sendJson(404, { error: "no such bot" });
    void (deps.warm ?? warmVoiceHost)(deps.endpoints().host);
    return sendJson(202, { ok: true });
  }
  // `brief: true` carries a finished answer to tell in a few sentences,
  // not something the owner said
  const brief = body.brief === true;
  const said = typeof body.text === "string" ? body.text.trim() : "";
  if (!said) return sendJson(400, { error: "text required" });
  if (said.length > (brief ? BRIEF_MAX_CHARS : SAID_MAX_CHARS)) return sendJson(413, { error: "that is too long for one spoken turn" });
  const bot = deps.bot(match[1]);
  if (!bot) return sendJson(404, { error: "no such bot" });
  const groupId = typeof body.groupId === "string" && /^[\w-]+$/.test(body.groupId) ? body.groupId : null;
  if (body.groupId !== undefined && !groupId) return sendJson(400, { error: "bad channel id" });
  const group = groupId ? deps.group?.(groupId) ?? null : null;
  if (groupId && !group) return sendJson(404, { error: "no such channel" });
  if (group && !group.memberIds.includes(bot.id)) return sendJson(409, { error: "that bot is not in this channel" });
  const ownThread = group ? group.threadId : bot.threadId;
  const threadId = typeof body.threadId === "string" && /^[\w-]+$/.test(body.threadId) ? body.threadId : ownThread;
  const owns = group
    ? threadId === group.threadId || (group.tasks ?? []).some((t) => t.threadId === threadId)
    : threadId === bot.threadId || (bot.tasks ?? []).some((t) => t.threadId === threadId);
  if (!owns) return sendJson(409, { error: group ? "that task does not belong to this channel" : "that task does not belong to this bot" });

  // requests handed down on this call are in the host's context as tool
  // calls; listing them again as the owner's words made them look unanswered
  const handedDown = parseHandDowns(body.handDowns).map((h) => h.request);
  const approval = typeof body.approval === "string" ? body.approval : undefined;
  const now = (deps.now ?? Date.now)();
  const state = group
    ? voiceHostRoomState(bot, group, threadId, deps, now, { approval, handedDown, heard: parseRoomHeard(body.roomHeard) })
    : voiceHostState(bot, threadId, deps, now, approval, handedDown);
  const controller = new AbortController();
  // `close` fires on the response when the client goes away mid-stream
  res.on("close", () => controller.abort());
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const { host, lookup } = deps.endpoints();
  // What became of each piece of work handed down on this call, read from
  // the thread (hand-downs.ts): the host's context carries it as a tool
  // result, and work still running cannot be handed down again.
  const history = parseHistory(body.history);
  // In a room the thread holds every member's rows: a hand-down's outcome is
  // read from the owner's lines and this member's own rows only.
  const fullThread = deps.activePath(threadId);
  const thread = group ? fullThread.filter((m) => m.role === "user" || m.from?.botId === bot.id) : fullThread;
  const busy = group ? group.busyBotId === bot.id && group.threadId === threadId : Boolean(bot.busy) && bot.threadId === threadId;
  const results: Record<string, string> = {};
  const running: string[] = [];
  for (const handDown of parseHandDowns(body.handDowns)) {
    const receipt = handDown.requestId && group ? deps.requestReceipt?.(group.id, handDown.requestId) : undefined;
    const status = handDownStatus(handDown, thread, busy, receipt);
    results[handDown.id] = handDownResult(status);
    if (status.kind === "running" || status.kind === "starting") running.push(handDown.request);
  }
  let timing: HostTiming | null = null;
  const events = brief
    ? (deps.brief ?? runVoiceBrief)({ state, answer: said, host, history, results, signal: controller.signal })
    : (deps.run ?? runVoiceHostTurn)({ state, history, said, host, lookup, results, running, signal: controller.signal, onTiming: (t) => (timing = t) });
  // One line per turn in the harness log: what the host chose and how fast,
  // never what was said. A live call is otherwise a black box afterwards.
  const started = Date.now();
  let first: number | null = null;
  const chose = new Set<string>();
  for await (const event of events) {
    if (controller.signal.aborted) break;
    if (first === null && event.type !== "done") first = Date.now() - started;
    chose.add(event.type === "error" ? `error:${event.reason}` : event.type);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  chose.delete("done");
  const t = timing as HostTiming | null;
  const stages = t
    ? `; headers ${t.headersMs ?? "-"} ms, first token ${t.firstTokenMs ?? "-"} ms, first piece ${t.firstPieceMs ?? "-"} ms (${t.firstPiece ? `${t.firstPiece}, ${t.firstPieceChars} chars` : "-"}), attempts ${t.attempts}`
    : "";
  console.log(`[voice-host] ${brief ? "brief" : group ? "room turn" : "turn"} via ${host?.via ?? "none"}: ${[...chose].join(",") || "nothing"}; first ${first ?? "-"} ms, all ${Date.now() - started} ms${controller.signal.aborted ? " (hung up)" : ""}${stages}`);
  res.end();
  return true;
}
