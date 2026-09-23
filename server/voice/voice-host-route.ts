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

import type { Message } from "../store.ts";
import {
  BRIEF_MAX_CHARS,
  runVoiceBrief,
  runVoiceHostTurn,
  warmVoiceHost,
  type VoiceBriefOptions,
  type VoiceHostEvent,
  type VoiceHostOptions,
  type VoiceHostState,
  type VoiceHostTurn,
} from "./voice-host.ts";
import type { VoiceEndpoint } from "./voice-routes.ts";

export const VOICE_HOST_PATH = /^\/api\/bots\/([\w-]+)\/voice-host$/;

const RECENT_MESSAGES = 16;
const ACTIVITY_STEPS = 6;
const SAID_MAX_CHARS = 2_000;

export interface VoiceHostRouteBot {
  id: string;
  name: string;
  description?: string;
  persona?: string;
  threadId: string;
  busy?: boolean;
  tasks?: Array<{ threadId: string; title: string; createdAt: number }>;
}

export interface VoiceHostRouteDeps {
  bot(id: string): VoiceHostRouteBot | null;
  /** The active branch of a thread, oldest first. */
  activePath(threadId: string): Message[];
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
): VoiceHostState {
  const path = deps.activePath(threadId);
  const recent = path
    .filter((m) => m.kind === "text" && typeof m.text === "string" && m.text.trim())
    .slice(-RECENT_MESSAGES)
    .map((m) => ({ who: m.role === "user" ? ("owner" as const) : ("bot" as const), text: m.text!, at: m.at }));
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

function parseHistory(raw: unknown): VoiceHostTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: VoiceHostTurn[] = [];
  for (const entry of raw.slice(-12)) {
    const role = entry?.role === "host" ? "host" : entry?.role === "owner" ? "owner" : null;
    const text = typeof entry?.text === "string" ? entry.text.trim().slice(0, SAID_MAX_CHARS) : "";
    if (role && text) turns.push({ role, text });
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
  const threadId = typeof body.threadId === "string" && /^[\w-]+$/.test(body.threadId) ? body.threadId : bot.threadId;
  if (threadId !== bot.threadId && !(bot.tasks ?? []).some((t) => t.threadId === threadId)) {
    return sendJson(409, { error: "that task does not belong to this bot" });
  }

  const state = voiceHostState(bot, threadId, deps, (deps.now ?? Date.now)(), typeof body.approval === "string" ? body.approval : undefined);
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
  const events = brief
    ? (deps.brief ?? runVoiceBrief)({ state, answer: said, host, signal: controller.signal })
    : (deps.run ?? runVoiceHostTurn)({ state, history: parseHistory(body.history), said, host, lookup, signal: controller.signal });
  for await (const event of events) {
    if (controller.signal.aborted) break;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
  return true;
}
