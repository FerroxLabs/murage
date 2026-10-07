// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Is Netlify connected, and does Netlify accept the connection? The owner
// connects in one of two ways (the Netlify sign-in, or a pasted access token),
// and either must pass this check before the Connect Netlify card says
// "Connected". The answer names the way and the reason, never the token.
import { tokenWorks } from "./netlify.ts";
import { PublishError } from "./errors.ts";
import { netlifyConnection, netlifyToken } from "./token.ts";

export type NetlifyCheck =
  | { connected: true; via: "token" | "sign-in" }
  | { connected: false; reason: "none" | "rejected" | "unreachable"; via?: "token" | "sign-in" };

export async function checkNetlifyConnection(options: { servers: Record<string, unknown> | undefined; fetchImpl?: typeof fetch; now?: number }): Promise<NetlifyCheck> {
  const via = netlifyConnection(options.servers, options.now), token = netlifyToken(options.servers, options.now);
  if (!via || !token) return { connected: false, reason: "none" };
  try {
    return (await tokenWorks({ token, fetchImpl: options.fetchImpl })) ? { connected: true, via } : { connected: false, reason: "rejected", via };
  } catch (error) {
    if (error instanceof PublishError) return { connected: false, reason: "unreachable", via };
    throw error;
  }
}

/** What the bot is told, as the owner's next message, once Netlify is connected. */
export const NETLIFY_CONNECTED_PROMPT = "Murage connection update: the owner connected Netlify. Continue the task that paused for this connection. Do not ask them to connect it again.";

/** What a desktop Connect Netlify press asks for: which card, in which chat. */
export interface ConnectPress { botId?: string; threadId?: string; messageId?: string }
export interface ConnectResume { botId: string; threadId: string; resumeKey: string; labels: string[]; prompt: string }

/** The /api/publish/netlify/check route after its desktop and body checks. When Netlify accepts the
 * connection, the card turns Connected and the bot that raised it (in a group chat, that member, not
 * the chat's first bot) is resumed, once: a second press finds the card already Connected. */
export async function settleNetlifyConnect(deps: {
  check: () => Promise<NetlifyCheck>;
  cards: { connectBot: (threadId: string, messageId: string) => string | undefined; markConnected: (threadId: string, messageId: string) => boolean };
  threadBot: (threadId: string) => string | undefined;
  resume: (entry: ConnectResume) => void;
}, press: ConnectPress): Promise<NetlifyCheck> {
  const result = await deps.check();
  if (!result.connected || !press.threadId || !press.messageId) return result;
  const botId = deps.cards.connectBot(press.threadId, press.messageId) ?? press.botId ?? deps.threadBot(press.threadId);
  if (!deps.cards.markConnected(press.threadId, press.messageId)) return result;
  if (botId) deps.resume({ botId, threadId: press.threadId, resumeKey: `netlify-${press.messageId}`, labels: ["Netlify"], prompt: NETLIFY_CONNECTED_PROMPT });
  return result;
}
