// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN Q2 ruling (1.0.20, the owner must see his own bot's text): in an
// OWNER-ONLY audience (the workspace owner in his own direct bot thread; no
// channel person, room, guest or export) a turn-wide or fail-closed audience
// mask never blanks a row. Each row is shown on its own scan instead: the
// collector's projection when it has one, else the row's own text when both
// secret scanners pass it whole. Every other audience keeps the mask.
// Owners: written by lane redacted-owner-n2 (fix/1020-redacted-owner2) and extended by
// hunt-redact2 (fix/1020-redact-residual-fable); the collector and
// policy it reads belong to the harness (server/harness/audience-collector.ts).
// On the late tip (fix/1020-redact-residual-fable) only two call sites use it: the error row the host writes
// (index.ts runtime.error) and the read of a room the owner runs (ownerOnlyTranscript). The broad reply/tool
// fallback of owner2 (ownerView over every field) is NOT taken: see fableclose-b/rd/DECISIONS.md.
import { redactSecretsInText } from "./redact.ts";
import { checkTurnUnit } from "./redact-stream-release.ts";

const MARKER = "«redacted»";


/** Host facts about a thread's live audience, each read from the host's own
 * records (never a request body or provider event). */
export type OwnerDisplayFacts = Readonly<{
  /** The thread is a bot's own direct thread (store.botByThread). */
  directBotThread: boolean;
  /** The thread is a room (store.groupByThread): other members read it. */
  room: boolean;
  /** threadHumanPrincipal(thread) is the workspace owner. */
  ownerPrincipal: boolean;
  /** The running turn answers to someone else (a channel person's chain). */
  notOwnerTurn: boolean;
  /** A paired channel run is live on the thread. */
  pairedChannel: boolean;
}>;

export function ownerOnlyDisplay(facts: OwnerDisplayFacts): boolean {
  return ownerDisplayFailedCheck(facts) === undefined;
}

/** redact-marker 1021: the first owner-only check above that is false (undefined when all pass), for the log line of a reply held
 * back for a shared audience. Only the check's name is logged, never a field of the row. */
export function ownerDisplayFailedCheck(facts: OwnerDisplayFacts): keyof OwnerDisplayFacts | undefined {
  if (facts.directBotThread !== true) return "directBotThread";
  if (facts.room !== false) return "room";
  if (facts.ownerPrincipal !== true) return "ownerPrincipal";
  if (facts.notOwnerTurn !== false) return "notOwnerTurn";
  if (facts.pairedChannel !== false) return "pairedChannel";
  return undefined;
}

/** Who READS stored rows (transcript reads, SSE frames): the owner-only
 * audience above, and also a room the owner runs, read on the owner's own
 * desktop or phone. Rows the host WRITES for a room keep the shared mask
 * (ownerOnlyDisplay): the other members' engines read those rows. */
export function ownerOnlyRead(facts: OwnerDisplayFacts): boolean {
  if (ownerOnlyDisplay(facts)) return true;
  return facts.room === true && facts.ownerPrincipal === true && facts.notOwnerTurn === false && facts.pairedChannel === false;
}

/** The reason line of an error row whose provider text the audience may not see. */
export const ERROR_REASON_WITHHELD = "Murage could not show the reason for this error.";
/** An error row's reason: the owner's own scan of it (ownerShownText), but a
 * bare marker is never the reason: Murage says so in its own words instead. */
export function shownErrorReason(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean)): string {
  const shown = ownerShownText(displayed, raw, ownerOnly);
  return shown.replaceAll(MARKER, "").trim() ? shown : ERROR_REASON_WITHHELD;
}
/** An error row's details: absent rather than a bare marker. */
export function shownErrorDetails(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean)): string | undefined {
  const shown = typeof raw === "string" ? ownerShownOptional(displayed, raw, ownerOnly) : displayed;
  return typeof shown === "string" && shown.replaceAll(MARKER, "").trim() ? shown : undefined;
}

/** 1.0.20 redact-1020: what a routine run reads of a runtime event (RoutineManager.handleRuntimeEvent's presentation). A turn the collector
 * masked or never owned (a relay sealed by a revoked memory context ends the turn with an unowned error) projects only the bare marker; the
 * routine used to store that as its error or output, and its card in the owner's chat read «redacted». Its error reason follows the error
 * row (shownErrorReason: the owner's own clean words, else Murage's withheld sentence); a reply or summary that is only the marker is left
 * out, so the run keeps what it had. Every other field is the projection, or the event as before when there is none. */
export function routinePresentation<T extends object>(event: T, displayed: T | undefined, ownerOnly: boolean | (() => boolean)): T {
  const out = { ...(displayed ?? event) } as Record<string, unknown>;
  const own = (value: object | undefined, field: string) => value && Object.getOwnPropertyDescriptor(value, field)?.value;
  for (const field of ["text", "summary"]) {
    const shown = own(displayed, field);
    if (typeof shown === "string" && shown.replaceAll(MARKER, "").trim()) out[field] = shown;
    else delete out[field];
  }
  const message = own(event, "message");
  if (message !== undefined) {
    const shown = own(displayed, "message");
    out.message = shownErrorReason(typeof shown === "string" ? shown : undefined, message, ownerOnly);
  }
  return out as T;
}

/** 1.0.20 redact2: the line an owner-only thread shows instead of an assistant message it may not show whole. */
export const REPLY_WITHHELD = "Murage held back this message because it may repeat something that must stay hidden.";
/** The text an assistant message row stores (index.ts item.completed assistant_text). A turn the collector masked for a fence, not
 * its own secret scan (a memory context revoked mid-turn, a replaced or unowned source), projected only the bare marker, and the owner's
 * thread showed his bot's own progress messages as «redacted» bubbles. The owner alone gets his bot's words when both scanners pass
 * them whole (ownerShownText; never on a turn its own secret scan latched), else the projection with its inline redactions; a message that would be only the marker becomes
 * REPLY_WITHHELD. Shared audiences keep the projection with its inline redactions; MAIN-RULING 2026-11-23T00:58:16Z (redact-marker): a
 * message that would be only the marker is REPLY_WITHHELD for EVERY reader (a non-owner-marked turn, a live paired channel run or an
 * owner lookup that threw used to save the bare marker, a «redacted» bubble and sidebar line). */
export function ownerReplyText(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean), secretLatched: boolean | (() => boolean) = false): string {
  if (typeof displayed === "string" && !displayed.includes("«redacted")) return displayed;
  const owner = typeof ownerOnly === "function" ? ownerOnly() : ownerOnly;
  // a shared audience, or the turn's own secret scan latched: its raw words are never shown, only the projection's inline redactions
  const shown = !owner || (typeof secretLatched === "function" ? secretLatched() : secretLatched) ? displayed ?? MARKER : ownerShownText(displayed, raw, true);
  return markerOnly(shown) ? REPLY_WITHHELD : shown;
}

/** MAIN-RULING 2026-11-23T00:58:16Z (redact-marker): a display text that is only the marker is the held-back sentence (the room
 * coordinator's unmasked reply, whose sanitizer masks a unit that already quotes a marker whole). */
export function withheldIfMarkerOnly(text: string): string {
  return markerOnly(text) ? REPLY_WITHHELD : text;
}

/** The text is nothing but the marker (once or more, with whitespace). */
export function markerOnly(text: string): boolean {
  return text.includes(MARKER) && !text.replaceAll(MARKER, "").trim();
}

/** Both scanners pass the whole text unchanged, within budget. */
export function ownerTextIsClean(text: string): boolean {

  try {
    const unit = checkTurnUnit(text);
    return !unit.detected && !unit.exhausted && redactSecretsInText(text) === text;
  } catch { return false; }
}

/** The text a row stores for one display field of a runtime event.
 * `displayed` is the collector's projection (undefined when it emitted none,
 * e.g. audience.omitted); `raw` is the event's own field. Shared audiences get
 * the projection or the marker, as before. The owner alone gets a clean
 * projection, else his own bot's text when it scans clean, else the
 * projection (a real hit stays redacted) or the marker. */
export function ownerShownText(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean)): string {
  // A clean projection is the same for every audience; the audience is asked only when it could matter.
  if (typeof displayed === "string" && !displayed.includes("«redacted")) return displayed;
  if (!(typeof ownerOnly === "function" ? ownerOnly() : ownerOnly)) return displayed ?? MARKER;
  if (typeof raw === "string" && ownerTextIsClean(raw)) return raw;
  return displayed ?? MARKER;
}

/** ownerShownText for an optional field: an absent projection of a shared
 * audience stays absent rather than becoming the marker. */
export function ownerShownOptional(displayed: string | undefined, raw: string, ownerOnly: boolean | (() => boolean)): string | undefined {
  const shown = ownerShownText(displayed, raw, ownerOnly);
  return displayed === undefined && shown === MARKER ? undefined : shown;
}
