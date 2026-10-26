// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one line a sidebar row shows for a conversation (1.0.2). The boot roster
// (GET /api/bots?view=sidebar) carries this per bot and room instead of any
// transcript rows, and the renderer keeps it current from live frames. It is a
// type of its own, not a Message: nothing that renders or edits a transcript
// can take one, so a cut row never reaches a transcript.
import type { EMBER_COLOR_HEX } from "./ember-colors.ts";
import type { GroupGoalRunCardData } from "./group-goal-run.ts";
import type { ProviderErrorInfo } from "./provider-error.ts";
import { isProviderSafetyBlock } from "./provider-safety.ts";

type EmberColorName = keyof typeof EMBER_COLOR_HEX;

export type SidebarLineKind = "text" | "options" | "activity" | "screen" | "connector" | "mcpSignIn" | "secret" | "routine.run" | "goal.run";

export interface SidebarLine {
  /** The row it was made from (bot: the branch head; room: the newest row). */
  messageId: string;
  at: number;
  role: "bot" | "user";
  kind: SidebarLineKind;
  /** The first SIDEBAR_TEXT_CHARS code points of the row's text, raw markdown; the client reads it as plain text. */
  text?: string;
  /** Rooms: which member said it. */
  from?: { botId: string; name: string; color: EmberColorName };
  /** What the one-line readings of an activity row read (host stop, send notice, folder trust, failed turn, the avatar's alert); never the run's payload. */
  tool?: {
    name: string;
    ok?: boolean;
    setup?: boolean;
    errorKind?: string;
    authRequired?: boolean;
    providerError?: ProviderErrorInfo;
    localFailure?: string;
    localFailureEngine?: string;
    /** The provider's safety systems refused the turn, read from the error details on the server so the details never travel. */
    blocked?: true;
  };
  /** Options rows: the card's title. */
  cardTitle?: string;
  /** Connection cards: which app and where the sign-in stands, so the row reads "<app> · <state>" in the reader's language. */
  connector?: { label: string; status: "required" | "authorizing" | "connected" | "failed" };
  /** Goal runs: the status and the first SIDEBAR_TEXT_CHARS of the goal and detail. */
  goalRun?: { status: GroupGoalRunCardData["status"]; goal: string; detail?: string };
  /** User rows: the outbox reconciles a send against this after a reload. */
  sendId?: string;
  /** User rows: a drained steer-queue entry. */
  queueId?: string;
}

export const SIDEBAR_TEXT_CHARS = 160;

/** The fields of a stored or held message a line is made from. */
export interface SidebarLineSource {
  id: string;
  at: number;
  role: "bot" | "user";
  kind: SidebarLineKind;
  text?: string;
  from?: { botId: string; name: string; color: string };
  tool?: {
    name: string;
    ok?: boolean;
    setup?: boolean;
    errorKind?: string;
    authRequired?: boolean;
    errorDetails?: string;
    providerError?: ProviderErrorInfo;
    localFailure?: string;
    localFailureEngine?: string;
  };
  card?: { title?: string };
  connector?: { label: string; status: "required" | "authorizing" | "connected" | "failed" };
  goalRun?: { status: GroupGoalRunCardData["status"]; goal: string; detail?: string };
  sendId?: string;
  queueId?: string;
}

const head = (text: string): string => {
  const points = [...text];
  return points.length > SIDEBAR_TEXT_CHARS ? points.slice(0, SIDEBAR_TEXT_CHARS).join("") : text;
};

/** The line for one message. Pure; the only builder: the server makes boot and thread-frame lines with it, the renderer makes live ones. */
export function sidebarLineOf(message: SidebarLineSource): SidebarLine {
  const line: SidebarLine = { messageId: message.id, at: message.at, role: message.role, kind: message.kind };
  if (typeof message.text === "string" && message.text) line.text = head(message.text);
  if (message.from) line.from = { botId: message.from.botId, name: head(message.from.name), color: message.from.color as EmberColorName };
  if (message.tool) {
    const source = message.tool;
    // An engine's error can be long; the readings match its leading code or label, so the head of the name is what they need.
    const tool: NonNullable<SidebarLine["tool"]> = { name: head(source.name) };
    if (source.ok !== undefined) tool.ok = source.ok;
    if (source.setup !== undefined) tool.setup = source.setup;
    if (source.errorKind !== undefined) tool.errorKind = source.errorKind;
    if (source.authRequired !== undefined) tool.authRequired = source.authRequired;
    if (source.providerError !== undefined) tool.providerError = source.providerError;
    if (source.localFailure !== undefined) tool.localFailure = source.localFailure;
    if (source.localFailureEngine !== undefined) tool.localFailureEngine = source.localFailureEngine;
    if (source.name.startsWith("error:") && (isProviderSafetyBlock(source.name.slice(6)) || (typeof source.errorDetails === "string" && isProviderSafetyBlock(source.errorDetails)))) tool.blocked = true;
    line.tool = tool;
  }
  if (message.kind === "options" && typeof message.card?.title === "string") line.cardTitle = head(message.card.title);
  if (message.kind === "connector" && message.connector) line.connector = { label: head(message.connector.label), status: message.connector.status };
  if (message.goalRun) {
    line.goalRun = { status: message.goalRun.status, goal: head(message.goalRun.goal ?? "") };
    if (typeof message.goalRun.detail === "string") line.goalRun.detail = head(message.goalRun.detail);
  }
  if (message.role === "user" && typeof message.sendId === "string") line.sendId = message.sendId;
  if (message.role === "user" && typeof message.queueId === "string") line.queueId = message.queueId;
  return line;
}

/** Whether two lines say the same thing (a recompute that changed nothing keeps the held object, so a row's cache holds). */
export function sameSidebarLine(a: SidebarLine | undefined, b: SidebarLine | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
