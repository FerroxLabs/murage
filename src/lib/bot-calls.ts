// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls on the desktop (design BOT-CALLS-109 rev 4.2, sections 3 and 8; routes in docs/contracts/calls-109.yaml).
// The words, the receipt sentences and the small helpers the call card, the ring banner, the "Call me when this finishes"
// button and the "Calls off for today" switch share. Pure, so the renderer suite (no DOM) can test it.
import { CALL_COPY, CALL_DEVICE } from "../../shared/bot-calls-contract";

/** The window event the live stream raises for each SSE frame of kind "call"; the app re-reads GET /api/calls/active on each. */
export { CALL_EVENT } from "./bot-call-event";

/** What a call card row carries (server/store.ts Message.botCall). */
export interface BotCallMark { intentId: string; botId: string; state: string; outcome: string | null; tier: "A" | "B"; at: number; minutes?: number; ended?: string }
export interface ReceiptStep { check: string; result: string; detail?: string }
export interface CallView {
  intentId: string; botId: string; threadId: string; state: string; outcome: string | null; factKind: string;
  createdAt: number; rangAt: number | null; endedAt: number | null; receipt: { steps: ReceiptStep[]; stop?: string; ended?: string };
}
export interface ActiveCalls {
  ringing: { intentId: string; botId: string; botName: string | null; threadId: string; rangAt: number | null; deadlineAt: number | null } | null;
  live: Array<{ callId: string; sessionId: string; intentId: string | null; botId: string; threadId: string | null; device: string; openedAt: number }>;
  offUntil: number | null;
}

/** Design 8, verbatim where it gives the words. No em dashes, plain words. */
export const BOT_CALL_WORDS = {
  callBack: "Call back",
  callMeNow: "Call me now",
  neverAgain: "Don't call me about this again",
  whyCalled: "Why I called",
  answer: "Answer",
  notNow: "Not now",
  textInstead: "Text me instead",
  ringing: (bot: string) => `${bot} is calling`,
  callMeWhenDone: "Call me when this finishes",
  callMeWhenDoneSet: "I'll call you when this finishes",
  offToday: "Calls off for today",
  offTodayHelp: "Back on at midnight.",
  offTodayOn: (until: string) => `Calls are off until ${until}.`,
  offTodayRefusal: "Calls are off for today. Turn them back on to get this call.",
  turnBackOn: "Turn calls back on",
  history: "History",
  historyEmpty: "No calls yet.",
  failed: "That didn't go through. Try again.",
  couldNotConnect: "The call couldn't connect, so it ended. Try again in a moment.",
  ...CALL_COPY,
} as const;

/** The receipt as sentences (design 8 "Receipts"): every check that changed what happened, the stopping one last. */
export function receiptLines(receipt: CallView["receipt"] | undefined, outcome: string | null): string[] {
  const out: string[] = [];
  for (const step of receipt?.steps ?? []) {
    const line = stepLine(step);
    if (line) out.push(line);
  }
  if (outcome === "cancelled") out.push(CALL_COPY.stoppedByYou);
  if (outcome === "restored") out.push(CALL_COPY.endedByRestore);
  if (receipt?.ended === "lost") out.push(CALL_COPY.dropped);
  return out;
}

function stepLine(s: ReceiptStep): string | null {
  const n = s.detail;
  switch (s.check) {
    case "fresh": return s.result === "late" ? "Murage wasn't running at the time, so I messaged instead." : null;
    case "rule":
      if (s.result === "message_only") return "You set this rule to message only.";
      if (s.result === "restore_held") return "Calls are paused after a restore, so I messaged instead.";
      return s.result === "off" ? "This rule is off, so I messaged instead." : null;
    case "bot": return s.result === "off" ? "Calls are off for this bot, so I messaged instead." : null;
    case "voice": return s.result === "none" ? "No voice is set up for calls, so I messaged instead." : null;
    case "device": return s.result === "none" ? "No device rings for calls, so I messaged instead." : null;
    case "live": return s.result === "on_call" ? "You were on a call, so I messaged instead." : null;
    case "cooldown": return "You said Not now a short while ago, so I messaged instead.";
    case "cap":
      return s.result === "bot_hour" || s.result === "owner_hour"
        ? `Over the hourly limit (${n}), so I messaged instead.`
        : `Over the daily limit (${n}), so I messaged instead.`;
    case "how": return s.result === "text_first" ? `I messaged first and would ring if you hadn't seen it in ${n} minutes.` : null;
    case "quiet":
      if (s.result === "emergency") return "Emergency rule, so I rang during quiet hours.";
      if (s.result === "timed") return null;
      return "Quiet hours, so I left a message without a notification.";
    case "off_today":
      if (s.result === "emergency") return "Emergency rule, so I rang although calls were off for today.";
      return s.result === "off_today" ? "Calls were off for today, so I left a message." : null;
    case "calendar":
      if (s.result === "busy") return s.detail === "emergency" ? "Emergency rule, so I rang although your calendar showed busy." : "Calendar: busy, so I messaged instead.";
      if (s.result === "unsure") return "Couldn't check your calendar, so I messaged instead.";
      return null;
    default: return null;
  }
}

/** The buttons a card shows for the intent as it is now (design 3 and 8). */
export function cardActions(mark: Pick<BotCallMark, "state" | "outcome">): Array<"callBack" | "callMeNow" | "neverAgain" | "whyCalled"> {
  if (mark.state === "waiting" || (mark.state === "done" && mark.outcome === "texted")) return ["callMeNow", "neverAgain", "whyCalled"];
  if (mark.state !== "done") return [];
  switch (mark.outcome) {
    case "missed": case "declined": case "text_instead": case "late": return ["callBack", "neverAgain", "whyCalled"];
    case "answered": return ["callBack", "whyCalled"];
    case "cancelled": case "restored": return ["whyCalled"];
    default: return [];
  }
}

/** This computer's name in answers and sessions (`desktop:<id>`, CALL_DEVICE), kept so an answer retry is recognised. */
export function desktopCallDevice(storage: Pick<Storage, "getItem" | "setItem"> | null, random: () => string): string {
  const key = "murage.callDevice";
  let saved: string | null = null;
  try { saved = storage?.getItem(key) ?? null; } catch { saved = null; }
  if (saved && CALL_DEVICE.test(saved)) return saved;
  const made = `desktop:${random().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "app"}`;
  try { storage?.setItem(key, made); } catch { /* this launch only */ }
  return made;
}

/** desktopCallDevice with this window's storage: the one device name the ring's Answer and an ordinary call both use. */
export function thisCallDevice(): string {
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { storage = null; }
  return desktopCallDevice(storage, () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)));
}

/** turn-end's refusal: true when the answer is "Calls off for today" (409 calls_off_today), so the app offers to turn them back on. */
export function isCallsOffToday(error: unknown): boolean {
  const e = error as { status?: number; body?: { code?: unknown; error?: unknown } } | null;
  return e?.status === 409 && (e.body?.code === "calls_off_today" || e.body?.error === "calls_off_today");
}

/** "Calls off for today": on until offUntil (in the future), else off. */
export const callsOffNow = (offUntil: number | null | undefined, now: number): boolean => typeof offUntil === "number" && offUntil > now;

/** The device's IANA zone, so "today" ends at this computer's midnight. */
export function deviceZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}
