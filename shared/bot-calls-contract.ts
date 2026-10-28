// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls, contract v2 (design BOT-CALLS-109 rev 4.2, section 7.1). The
// numbers of the session protocol and the closed sentences, shared by the
// harness, the desktop and the phone's web layer. The routes and SSE hints are
// in docs/contracts/calls-109.yaml; the push side is apps/mobile/contract/push.json.
// No imports: every surface loads this file.

export const CALLS_CONTRACT_VERSION = 2;

/** The one silence constant: the server's session timeout and the client's own give-up both come from it. */
const SILENCE_MS = 60_000;

/** The session protocol (design 5.7). */
export const CALL_PROTOCOL = {
  /** The server pings the call channel this often (websocket ping frames); the client sends its numbered heartbeat this
   *  often too, every time, without waiting for the last one to be answered. */
  pingEveryMs: 20_000,
  /** No pong, no frame and no call request for this long ends the session `lost`. */
  silenceEndsMs: SILENCE_MS,
  /** The client ends a call on its own only after this long with no echo from the server. The clock starts when an echo
   *  ARRIVES, which is never before the server counted the frame, so the client always gives up after the server has. */
  clientGivesUpMs: SILENCE_MS + SILENCE_MS / 4,
  /** Last resort only: a session older than this ends `backstop`. */
  backstopMs: 4 * 3600_000,
  /** Every ringing device rings at once for this long. */
  ringMs: 45_000,
  /** A ticket for the call channel is single-use and lives this long. */
  ticketMs: 60_000,
  /** The header every call request carries once the call has an id. */
  callIdHeader: "x-murage-call-id",
  /** A seen report needs the card on screen, focused and foreground, this long. */
  seenAfterMs: 2_000,
} as const;

/** A device names itself in answers and sessions: `desktop:<clientId>` or
 *  `phone:<bindingId>`. Stable per device, so an answer retry is recognised. */
export const CALL_DEVICE = /^(desktop|phone):[A-Za-z0-9_-]{1,64}$/;
export const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Text outside the unlocked app, on every phone at every preview setting,
 *  and the desktop's OS notification for a hidden window (design 3, 8). */
export const CALL_CLOSED_TEXT = {
  ring: { title: "Murage is calling", body: "Answer to hear what it is." },
  note: { title: "Murage", body: "Murage has a message for you." },
} as const;

/** Words on the call surfaces inside the unlocked app (design 8). */
export const CALL_COPY = {
  answeredElsewhere: "Answered on your other device.",
  declined: "You declined.",
  dropped: "The call dropped.",
  stoppedByYou: "Stopped by you.",
  endedByRestore: "Ended by a restore.",
  anotherCallStarted: "You started another call.",
} as const;

/** The SSE hints and call-channel frames (design 6). */
export type CallHint =
  | { type: "call.ring"; intentId: string; botId: string; threadId: string; deadlineAt: number }
  | { type: "call.answered"; intentId: string; callId: string; device: string; threadId: string }
  // threadId scopes the hint to its conversation (sse-visibility.ts); a hint without one never reaches a phone
  | { type: "call.ended"; intentId?: string; callId?: string; threadId?: string };

/** The answer route's refusals (design 5.4). */
export type AnswerRefusal = "answered_elsewhere" | "expired";
