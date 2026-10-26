// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q4 (207, 24, 208): a bot's widget, from tool input or a murage-widget fence to the stored row, and a press back to
// the text of the owner's next message. The tree is normalised once, by parseWidgetInput (shared/widget.ts, ported from
// OpenMausBot); everything after reads the stored row. Settling is the route's: one owner send per widget, claimed in the
// same transaction as the row (server/index.ts, the widget respond route).
import { randomUUID } from "node:crypto";

import {
  parseWidgetInput, resolveWidgetAction, widgetAdvice, widgetPrefilled, widgetToText,
  type WidgetOther, type WidgetPayload, type WidgetRoot, type WidgetValues,
} from "../shared/widget.ts";
import type { Message } from "./store.ts";

/** What the widget code needs from the store. */
export interface WidgetStore {
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">, stableId?: string): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>, within?: () => void): Message | null;
  messageById(threadId: string, messageId: string): Message | undefined;
}

/** One line for a room: widgets are not drawn there. */
export const WIDGET_ROOM_REFUSAL = "Widgets are not available in rooms. Answer in text.";
/** The same audience refusal as ask_user and request_credential. */
export const WIDGET_REFUSED = "Show a widget from an owner conversation.";
/** The tool's result. */
export const WIDGET_SHOWN = "The widget is now visible. End this turn; when the owner presses a button their answer arrives as their next message.";

export type WidgetResult =
  | { ok: true; message: Message; widgetId: string; text: string }
  | { ok: false; status: 400 | 404 | 409; error: string; code?: string };

/** The widget's one owner send: every press of every ref names this, so the first settles and the rest meet the same row. */
export function widgetSendId(widgetId: string): string {
  return `widget-${widgetId}`;
}

function shownText(widgetId: string, root: WidgetRoot): string {
  const advice = widgetAdvice(root);
  return `${WIDGET_SHOWN} Widget id: ${widgetId}.${advice ? ` ${advice}` : ""}`;
}

/** Append a widget row from untrusted input: the tool's `widget`, or a fence's JSON. Nothing is written when it does not parse. */
export function showWidget(store: WidgetStore, threadId: string, input: unknown, turnId?: string, fenceOf?: { messageId: string; index: number }): WidgetResult {
  const parsed = parseWidgetInput(input);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return appendWidget(store, threadId, parsed.value, turnId, fenceOf);
}

/** The words a widget row carries in `text`: what 1.0.3 (which has no widget renderer), an export, a preview or replayed
 * history shows. The title and the choices, never empty. */
export function widgetFallbackText(root: WidgetRoot): string {
  return widgetToText(root) || "[widget]";
}

/** A widget is an ordinary bot `kind: "text"` row with a `widget` field beside its `text` (the client draws it by the field).
 * No new kind: 1.0.3's backup and restore check accepts every kind it knows and lets unknown fields pass, so a downgrade with
 * widget rows still backs up, restores and reads them as their text. The row's id IS the widget's id: one keyed read finds it. */
function appendWidget(store: WidgetStore, threadId: string, root: WidgetRoot, turnId?: string, fenceOf?: { messageId: string; index: number }): WidgetResult {
  const id = randomUUID();
  const widget: WidgetPayload = { id, root, ...(fenceOf ? { fenceOf } : {}) };
  // The engine's widget names the turn that showed it. With no turn (a late fence, a stale attempt) it stays an engine row that names
  // none, which write-time lineage rests on every open turn's parents (message-db.ts unattributedRefs), never Murage's own line.
  const row = { role: "bot" as const, kind: "text" as const, text: widgetFallbackText(root), widget };
  const message = store.appendMessage(threadId, turnId ? { ...row, turnId } : row, id);
  return { ok: true, message, widgetId: id, text: shownText(id, root) };
}

/** The row holding widget `widgetId` in this thread: the row of that id, if it holds that widget. */
export function findWidget(store: Pick<WidgetStore, "messageById">, threadId: string, widgetId: string): Message | undefined {
  if (!/^[\w-]{1,160}$/.test(widgetId)) return undefined;
  const message = store.messageById(threadId, widgetId);
  return message?.widget?.id === widgetId ? message : undefined;
}

/** Replace an open widget's tree in place. A settled widget is 409, an unknown id 404. */
export function updateWidget(store: WidgetStore, threadId: string, widgetId: unknown, input: unknown): WidgetResult {
  if (typeof widgetId !== "string" || !widgetId) return { ok: false, status: 400, error: "widgetId: is required." };
  const message = findWidget(store, threadId, widgetId);
  const widget = message?.widget;
  if (!message || !widget) return { ok: false, status: 404, error: "No widget with that id in this conversation." };
  if (widget.settled) return { ok: false, status: 409, code: "already_settled", error: "The owner already answered this widget; show a new one." };
  const parsed = parseWidgetInput(input);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const next: WidgetPayload = { ...widget, root: parsed.value, rev: (widget.rev ?? 0) + 1 };
  const patched = store.patchMessage(threadId, message.id, { widget: next, text: widgetFallbackText(parsed.value) });
  if (!patched) return { ok: false, status: 404, error: "No widget with that id in this conversation." };
  return { ok: true, message: patched, widgetId, text: `The widget is updated. Widget id: ${widgetId}.` };
}

export type WidgetPress =
  | { ok: true; text: string; settled: { ref: string; label: string; values: WidgetValues; sendId: string; other?: WidgetOther } }
  | { ok: false; status: 400 | 404 | 409; error: string; code?: string };

/** Check one press against the stored widget and build the owner's message ("{label}:" then "Field: value" lines). */
export function prepareWidgetPress(widget: WidgetPayload, body: Record<string, unknown>): WidgetPress {
  if (widget.settled) return { ok: false, status: 409, code: "already_settled", error: "This widget was already answered." };
  if (typeof body.ref !== "string" || !body.ref) return { ok: false, status: 400, error: "ref is required" };
  const rev = body.rev === undefined ? 0 : body.rev;
  if (rev !== (widget.rev ?? 0)) return { ok: false, status: 409, code: "widget_changed", error: "This widget changed. Check it and press again." };
  const resolved = resolveWidgetAction({ id: widget.id, root: widget.root }, body.ref, body.values, body.other);
  if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error };
  return {
    ok: true,
    text: resolved.text,
    settled: { ref: resolved.ref, label: resolved.label, values: resolved.values, sendId: widgetSendId(widget.id), ...(resolved.other ? { other: resolved.other } : {}) },
  };
}

/** 208: a settled widget's answers reopened in a NEW widget the owner can change and send again (its own send id). */
export function reopenWidget(store: WidgetStore, threadId: string, widgetId: string): WidgetResult {
  const message = findWidget(store, threadId, widgetId);
  const widget = message?.widget;
  if (!message || !widget) return { ok: false, status: 404, error: "No widget with that id in this conversation." };
  if (!widget.settled) return { ok: false, status: 409, code: "not_settled", error: "This widget is still open." };
  return appendWidget(store, threadId, widgetPrefilled(widget.root, widget.settled));
}
