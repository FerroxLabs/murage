// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What of a runtime event leaves the server. A permission ask carries
// server-side records next to its card fields: the engine's raw tool call,
// the MCP mounts and the F12 record (`execEnv`), whose `env` is the exact map
// handed to the engine process, provider API key included on a turn with a
// configured provider. A window, a paired phone or a companion stream allowed
// to see the thread reads the card, never those records.
//
// An ask goes out as an ALLOWLIST: every field of `request.opened` is named
// below as out (true) or kept in the server (false), so a field added to the
// contract later does not compile until someone decides which it is.
import type { RuntimeEvent } from "./contracts.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;

const REQUEST_OPENED_OUT: Record<keyof RequestOpened, boolean> = {
  eventId: true,
  provider: true,
  providerInstanceId: true,
  threadId: true,
  createdAt: true,
  turnId: true,
  itemId: true,
  requestId: true,
  // the native protocol message: an engine's own frame can hold anything
  raw: false,
  type: true,
  requestType: true,
  tool: true,
  summary: true,
  choices: true,
  approvalScope: true,
  questionTool: true,
  questions: true,
  folderTrust: true,
  filePaths: true,
  toolResultDirs: true,
  // the engine's raw call is the stop line's, and can be a whole file
  toolCall: false,
  toolInput: true,
  reason: true,
  toolKind: true,
  toolIdentity: true,
  // proven against server-side only (shared/app-action-grant.ts)
  mcpMounts: false,
  toolEngine: true,
  toolInputMissing: true,
  localHold: false,
  // how the gates read the command text: server-side only
  commandShell: false,
  // the map handed to the engine process: credentials
  execEnv: false,
  toolInputTruncated: true,
};

const OUT_FIELDS = Object.entries(REQUEST_OPENED_OUT).filter(([, out]) => out).map(([name]) => name);

/** The ask as it leaves the server: the allowlisted fields only. */
export function requestOpenedOut(event: RequestOpened): RequestOpened {
  const source = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of OUT_FIELDS) if (Object.hasOwn(source, name) && source[name] !== undefined) out[name] = source[name];
  return out as unknown as RequestOpened;
}

/** The runtime frame a stream gets (live, and the replay buffer that resumes
 * it): a tool's input and result stay out, and an ask goes out allowlisted. */
export function windowRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "item.started") return { ...event, input: undefined };
  if (event.type === "item.completed" && event.itemType === "tool") return { ...event, result: undefined };
  if (event.type === "request.opened") return requestOpenedOut(event);
  return event;
}

/** The record the thread's event log keeps: everything a bug report needs,
 * never the map handed to the engine process. */
export function loggedRuntimeEvent<T>(event: T): T {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "request.opened" || !Object.hasOwn(event, "execEnv")) return event;
  const { execEnv: _handed, ...rest } = event as T & { execEnv?: unknown };
  return rest as T;
}
