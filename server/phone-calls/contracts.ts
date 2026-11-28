// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: C0 freezes contracts; F2 provides the store, F1 provides admission and trusted turns,
// F3 provides the service and cards, and F4 and F5 consume the owner API and cards.
import type { DatabaseSync } from "node:sqlite";
import type { PhoneCallService } from "./service.ts";
import type { PhoneErrorCode } from "./vapi-adapter.ts";

export const PHONE_BOT_DEFAULT = true;
export const ANALYSIS_GRACE_MS = 60 * 60 * 1000;
export const CALL_TEMPLATE_VERSION = 1;
export const PHONE_MENU_REASON = "phone_menu";

export type CallPurpose = "book" | "cancel" | "ask";
export type PhoneRetention = 30 | 90 | null;

export interface CallRow {
  id: string; vendorId: string; revision: number; assistantId: string; createdAt: number;
  status: "uncertain" | "scheduled" | "ringing" | "in_progress" | "ended" | "cancelled" | "abandoned";
  abandonCancel?: "attempted" | "confirmed" | "failed" | "not_found";
  purpose?: CallPurpose;
  booking?: string;
  cancel?: { by: string; state: "free" | "pending" | "cancelled" | "unclear" };
  intent?: string;
  identity?: string;
  analysisDue?: number;
  endedAt?: number;
  transcriptCleared?: boolean;
  /** F3: the owner's Cancel reached the vendor after the call had started (409), so it could not be cancelled. */
  cancelTooLate?: boolean;
  reconcileScan?: { ranges: [start: number, end: number][] } | "unpageable";
  /** The bot whose turn placed the call. Rows from before this field carry none (legacy, Q6). */
  botId?: string;
  /** A legacy call that archive cancelled at the vendor so it cannot dial; the owner chooses Keep (place it again) or Cancel. */
  held?: "held" | "kept" | "cancelled";
  /** On a held row: the replacement call a Keep is placing ("pending" until its row exists). Cancel stops that call. */
  keeping?: string;
  language: string; to: string; goal: string; details: string; limits: string; when?: string;
  /** Owner-only. Never put in engine context. */
  transcript?: string; reference?: string;
  structured?: Record<string, unknown>; endedReason?: string; cost?: number; lengthSeconds?: number;
}

/** Omit the scope for all calls, or omit its bot id for calls from legacy builds. */
export interface CallScope { botId?: string }

/** Where call rows live: memory in tests, sqlite (owner-only, not thread history) in the app (store.ts). */
export interface ShippedCallStore {
  get(id: string): CallRow | undefined; put(row: CallRow): void; live(): Iterable<CallRow>; abandoned(scope?: CallScope): Iterable<CallRow>; recent(limit?: number): CallRow[];
  /** Abandoned calls whose vendor stop is not confirmed (discovery pending, DELETE attempted or failed). Archive waits on them. */
  unstopped(scope?: CallScope): Iterable<CallRow>;
}

export interface CallWriteOptions {
  /** Synchronous phone-DB work committed with this write. */
  within?: (tx: DatabaseSync) => void;
  reconcileDue?: number | null;
}

/** F3 can settle the booking and re-arm its D6a report on the final complete miss. */
export type OnLastReconcileMiss = (row: CallRow) => { booking?: CallRow; within?: CallWriteOptions["within"] };

/** F2 provides indexed operations. The shipped methods remain available through the split. */
export interface CallStore extends ShippedCallStore {
  insert(row: CallRow, options?: CallWriteOptions): void;
  update(row: CallRow, options?: CallWriteOptions): boolean;
  settle(cancelRow: CallRow, booking: CallRow, options?: CallWriteOptions): boolean;
  delete(id: string, options?: CallWriteOptions): boolean;
  firstUncertain(): CallRow | undefined;
  duePending(now: number, limit?: number): CallRow[];
  markReconcileMiss(id: string, now: number, onLastMiss?: OnLastReconcileMiss): void;
  revisionLive(revision: number): boolean;
  liveByIdentity(botId: string, identity: string): CallRow | undefined;
  byIntent(botId: string, intent: string, identity: string): CallRow | undefined;
  analysisDue(now: number, limit?: number): CallRow[];
  scheduledOlderThan(revision: number, limit?: number): CallRow[];
  countScheduledOlderThan(revision: number, cap?: number): number;
  liveForBot(botId: string, limit?: number, after?: string): CallRow[];
  liveLegacy(limit?: number, after?: string): CallRow[];
  transcriptsOlderThan(cutoff: number, limit?: number): CallRow[];
  botMayPhone(botId: string): boolean;
  setBotMayPhone(botId: string, on: boolean): void;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

/** Whether a turn lists the phone tools (3a, 3b, 3f). Only the desktop shell with a held key, only an owner-audience turn without a
 *  project role, only on an engine that mounts Murage's agents tools. An owner turn on an engine without them hears the plain line. */
export interface PhoneMountInput { agentsMcp: boolean; ownerAudience: boolean; projectRole?: boolean; botAllowed: boolean }
export type PhoneMountVerdict = { mounted: true } | { mounted: false; line: string | null };
/** What `place` needs to know about the bot asking: its id, and whether Archive has fenced it. */
export interface PhoneCallContext {
  botId?: string; fenced?: () => boolean; intent?: string;
  /** Called synchronously with the new call id as its row is stored, before the vendor is asked. */
  onIntent?: (call: string) => void;
}
/** The internal capability claim read by the route. */
export interface PhoneToolClaim { botId?: string; threadId?: string; generation?: string; notOwnerAudience?: boolean }

export interface PhoneAdmissionDeps { botMayPhone(botId: string): boolean }

/** F1 resolves this server-provided claim through its turn record before supplying intent to F3. */
export interface PhoneAskTurn { botId: string; threadId: string; dispatchGeneration: string }
export interface PhoneAskContext { botId: string; intent: string }

export interface PhoneRequestIdentity {
  purpose: CallPurpose;
  booking?: string;
  to: string;
  goal: string;
  details: string;
  limits: string;
  when?: string;
  language?: string;
}

export interface PhoneAskCard extends Omit<PhoneRequestIdentity, "purpose"> {
  purpose?: CallPurpose;
  language: string;
  settings_revision: number;
  cancelOf?: { business: string; to: string; time?: string };
  languageFallback?: { wanted: string; language: string };
  sameRequest?: true;
  max_seconds?: number;
}

export interface PhoneResultCard extends Record<string, unknown> {
  call: string;
  status: CallRow["status"];
  language: string;
  settings_revision: number;
  purpose?: CallPurpose;
  booking?: string;
  outcome?: string;
  reason?: string;
  time?: string;
  length_seconds?: number;
  cost?: { amount: number; currency: "USD" };
  has_reference?: boolean;
}

export interface PhoneOwnerCard extends PhoneResultCard {
  to: string;
  goal: string;
  details: string;
  limits: string;
  when?: string;
  held?: CallRow["held"];
  transcript?: string;
  reference?: string;
  dashboard: string;
  bookingState?: "booked" | "cancelling" | "cancelled" | "unclear";
  /** The result line as a phoneCalls copy key (section 5.9). */
  line?: string;
}

export type PhoneDeleteOutcome = { ok: true } | {
  ok: false;
  error: "not_found" | "live" | "checking" | "cancel_pending";
};

/** F3 provides these; F5 serves them to F4. */
export interface PhoneOwnerApi extends Pick<PhoneCallService,
  "activeSettings" | "olderScheduled" | "numbers" | "saveSettings" | "refreshOwnerCalls" |
  "recentOwnerCards" | "ownerCard" | "decideHeld" | "cancel" | "sharedTranscript"> {
  botMayPhone(botId: string): boolean;
  setBotMayPhone(botId: string, on: boolean): void;
  deleteCall(id: string): PhoneDeleteOutcome;
  retention(): PhoneRetention;
  setRetention(retention: PhoneRetention): void;
}

export type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: PhoneErrorCode };
