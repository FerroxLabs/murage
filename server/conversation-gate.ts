// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Who may reach the conversation routes at all.
 *
 * Any process on this computer can open the harness's loopback port, and a
 * bot with a shell is one of them. Before this gate, a request that carried no
 * proof was treated as a "remote" caller, and a remote caller was served
 * everything a phone's sidebar shows: every visible bot's and room's
 * transcript, the search index, the live event stream, and the sends and
 * interrupts that act on a conversation.
 *
 * A conversation route now answers only to a caller that proves who it is:
 * the desktop app with this launch's secret, or the paired phone's companion
 * carrying the launch credential it shares with this harness. Everything else
 * receives the same 404 an unknown route would, so a caller learns nothing
 * about what is behind the door. A bot's own capability token is never proof
 * here: bots reach the harness through their scoped `/api/internal/*`,
 * `/api/box`, `/api/repo` and `/api/opencode` routes, which this gate does
 * not touch. */

const CONVERSATION_PREFIXES = /^\/api\/(?:bots|threads|groups)(?:\/|$)/;
const CONVERSATION_EXACT = new Set(["/api/search", "/api/events"]);

/** Every route that reads a transcript, sends into a conversation, or stops
 * one: the bot, thread and room families, the search index and the event
 * stream. Method is deliberately not part of the question. */
export function isConversationRoute(path: string): boolean {
  return CONVERSATION_EXACT.has(path) || CONVERSATION_PREFIXES.test(path);
}

export type ConversationSubject =
  | { scope: "bot"; botId: string }
  | { scope: "group"; groupId: string }
  | { scope: "thread"; threadId: string };

/** The one conversation a path acts on, when its second segment names one. */
export function conversationSubject(path: string): ConversationSubject | null {
  const match = /^\/api\/(bots|threads|groups)\/([\w-]+)(?:\/|$)/.exec(path);
  if (!match) return null;
  const id = match[2]!;
  if (match[1] === "bots") return { scope: "bot", botId: id };
  if (match[1] === "groups") return { scope: "group", groupId: id };
  return { scope: "thread", threadId: id };
}

/** What a missing conversation of this kind answers, so a hidden one is
 * indistinguishable from it to a caller that may not see it. */
export function missingConversationError(subject: ConversationSubject): string {
  switch (subject.scope) {
    case "bot": return "no such bot";
    case "group": return "no such channel";
    case "thread": return "no such conversation";
  }
}
