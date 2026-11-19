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
const MAX_UNITS = 262_144;

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
  return facts.directBotThread === true && facts.room === false && facts.ownerPrincipal === true
    && facts.notOwnerTurn === false && facts.pairedChannel === false;
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

/** Both scanners pass the whole text unchanged, within budget. */
export function ownerTextIsClean(text: string): boolean {
  if (text.length > MAX_UNITS) return false;
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
