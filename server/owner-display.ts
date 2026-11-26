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
import { TEXT_RULES, redactSecretsInText } from "./redact.ts";
import { ENGINE_ERROR_KIND_PREFIX, engineErrorCategory, engineKindReason } from "../shared/provider-error.ts";
import { checkTurnUnit } from "./redact-stream-release.ts";
import { MASKED_VALUE_BOUNDS, lightValue, normValue, skeletonValue, type MaskedClass, type MaskedValueView } from "./harness/masked-values.ts";

const MARKER = "«redacted»";


/** Keep display text with inline redactions and omit projections made entirely of markers. */
export function visibleProjectedText(text: unknown): string | undefined {
  return typeof text === "string" && text.replaceAll(MARKER, "").trim() ? text : undefined;
}

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
export function shownErrorReason(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean), kind?: unknown): string {
  const shown = ownerShownText(displayed, raw, ownerOnly);
  // An error that carries an engine kind is never "could not show the reason": the kind is a field the driver checked
  // against its own list (never message text), so Murage words it itself for every audience.
  return shown.replaceAll(MARKER, "").trim() ? shown : engineKindReason(kind) ?? ERROR_REASON_WITHHELD;
}
/** An error row's details: absent rather than a bare marker. */
export function shownErrorDetails(displayed: string | undefined, raw: unknown, ownerOnly: boolean | (() => boolean), kind?: unknown): string | undefined {
  const shown = typeof raw === "string" ? ownerShownOptional(displayed, raw, ownerOnly) : displayed;
  if (typeof shown === "string" && shown.replaceAll(MARKER, "").trim()) return shown;
  // details the audience may not read still name the engine kind (a checked token, not provider text)
  const category = engineErrorCategory(kind);
  return category ? `${ENGINE_ERROR_KIND_PREFIX}${category}` : undefined;
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
    out.message = shownErrorReason(typeof shown === "string" ? shown : undefined, message, ownerOnly, own(event, "errorKind"));
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

/** 1.0.22 cause B: the second step of the reply row (index.ts item.completed assistant_text, right after ownerReplyText). `stored`
 * is what ownerReplyText gave, the 1.0.21 outcome. In the owner's own direct chat, on a turn its own secret scan latched (or that
 * withheld text unscanned), the reply's own words are stored instead when ownerLatchedVerdict says "shown": the turn's masked-value
 * list is complete and the reply repeats none of it. A clean projection, a shared audience and a turn that is not latched keep
 * `stored` untouched. */
export function ownerLatchedReplyText(stored: string, displayed: string | undefined, raw: unknown, ownerOnly: boolean, secretLatched: boolean | (() => boolean), maskedValues: (() => MaskedValueView | undefined) | undefined): string {
  if (typeof displayed === "string" && !displayed.includes("«redacted")) return stored;
  if (!ownerOnly || !(typeof secretLatched === "function" ? secretLatched() : secretLatched)) return stored;
  return ownerLatchedVerdict(raw, maskedValues) === "shown" ? raw as string : stored;
}

/** Why a row of a latched owner turn is, or is not, shown raw. Only this code is ever logged: never a value, a length or an index. */
export type OwnerLatchedVerdict = "shown" | "value" | "scan" | "carry" | "unavailable" | `incomplete:${NonNullable<MaskedValueView["reason"]>}`;
/** 1.0.22 cause B (deep1022-causeB-design/DESIGN.md 5.1; MAIN-RULING 2026-11-22T18:02:24Z (1) narrowed for the owner's own direct
 * chat): a later text of a secret-latched turn is a CHECKED chunk only when ALL hold: (a) the turn's masked-value list exists and is
 * complete; (b) the text is a string; (c) both scanners pass it whole; (d) both scanners pass it joined to the end of the previous
 * reply (a label or half a value at the end of reply N is read with reply N+1); (e) it repeats none of the masked values, whole,
 * re-spaced, re-cased, quoted or in part. Anything else, and any throw, keeps the 1.0.21 outcome. */
export function ownerLatchedVerdict(raw: unknown, maskedValues: (() => MaskedValueView | undefined) | undefined): OwnerLatchedVerdict {
  try {
    const view = maskedValues?.();
    if (!view) return "unavailable";
    if (view.complete !== true) return `incomplete:${view.reason ?? "unavailable"}`;
    if (typeof raw !== "string" || !ownerTextIsClean(raw)) return "scan";
    if (!cleanAfter(view.carry, raw)) return "carry";
    if (repeatsMaskedValue(view, raw)) return "value";
    return "shown";
  } catch { return "unavailable"; }
}

/** q1023-heldscan: the line the host logs for a reply held back for the owner: the verdict code, then only CLASS NAMES (never a value,
 * a length or an index): `value class=<kind of the masked value the reply repeats>`, `scan rules=<the scanner rules that fire on the
 * reply>`, and for every hold the kinds of token the turn masked (`masked=uuid:2,digits:1`). The first word is the verdict code. */
export function ownerLatchedWhy(raw: unknown, maskedValues: (() => MaskedValueView | undefined) | undefined): string {
  const verdict = ownerLatchedVerdict(raw, maskedValues);
  try {
    const view = maskedValues?.();
    const parts: string[] = [verdict];
    if (verdict === "value" && view && typeof raw === "string") parts.push(`class=${repeatedClass(view, raw) ?? "other"}`);
    if (verdict === "scan" && typeof raw === "string") parts.push(`rules=${scanRuleNames(raw).join("+") || "none"}`);
    if (view) {
      const counts = new Map<string, number>();
      for (const value of view.values) counts.set(value.cls ?? "other", (counts.get(value.cls ?? "other") ?? 0) + 1);
      parts.push(`masked=${[...counts].map(([cls, n]) => `${cls}:${n}`).join(",") || "none"}`);
    }
    return parts.join(" ");
  } catch { return verdict; }
}
/** The names of the secret-scanner rules that fire on the text (redact.ts TEXT_RULES), "label" when only the label scanner does. */
export function scanRuleNames(text: string): string[] {
  const names: string[] = [];
  try {
    for (const [name, rule] of TEXT_RULES) { let hit = false; rule(text, () => { hit = true; }); if (hit) names.push(name); }
    if (!names.length && !ownerTextIsClean(text)) names.push("label");
  } catch { names.push("error"); }
  return names;
}

/** The text read after the end of the previous reply, as the same line and as the next line: neither scanner finds anything that
 * reaches into the text. */
function cleanAfter(carry: string, raw: string): boolean {
  if (!carry) return true;
  for (const left of carry.endsWith("\n") ? [carry] : [carry, `${carry}\n`]) {
    const joined = left + raw, unit = checkTurnUnit(joined);
    if (unit.exhausted || (unit.detected && !unit.spans)) return false;
    if ((unit.spans ?? []).some(span => span.to > left.length)) return false;
    if (!redactSecretsInText(joined).endsWith(raw)) return false;
  }
  return true;
}

/** Design 2.3: the text (read after the previous reply's end, `view.carry`) holds a value the turn masked. A match counts only when
 * it ends inside the text itself. WHOLE: a value's normalised form occurs (re-spaced, re-cased, backticked, split over lines).
 * PART: any 6-char window that mixes letters, digits or other characters, or any 12-char window, of a value occurs. SHORT values
 * (under 8 normalised chars) count whole only, and a single-class one only as a word of its own. Linear in the text. */
export function repeatsMaskedValue(view: MaskedValueView, text: string): boolean { return repeatedClass(view, text) !== undefined; }
/** The class of the masked value the text repeats (the first rule that matches), undefined when it repeats none. */
export function repeatedClass(view: MaskedValueView, text: string): MaskedClass | undefined {
  const own = repeatsIn(view, text);
  if (own) return own;
  // ASTRA N1: the same text with its percent-escapes decoded (a value written %-encoded)
  if (text.includes("%")) { let decoded = text; try { decoded = decodeURIComponent(text); } catch { decoded = text.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))); } if (decoded !== text) { const found = repeatsIn(view, decoded); if (found) return found; } }
  return undefined;
}
function repeatsIn(view: MaskedValueView, text: string): MaskedClass | undefined {
  const joined = normValue(view.carry + text), boundary = normValue(view.carry).length;
  if (joined.length <= boundary) return undefined;
  const light = lightValue(view.carry + text), lightBoundary = lightValue(view.carry).length;
  for (const value of view.values) {
    const n = value.norm.length;
    if (n >= 8 || value.mixed) {
      for (let at = joined.indexOf(value.norm); at >= 0; at = joined.indexOf(value.norm, at + 1)) if (at + n > boundary) return value.cls ?? "other";
      continue;
    }
    // SHORT, one class of character: only as a word of its own (`admin` in "log in as admin", not in "administrator"), also when
    // its characters are set apart or it holds a character the normal form drops (`blue_sky`, `o'brien`, `d-r-a-g-o-n`: up to
    // three characters that are not letters or digits between two of its own; self-review H1, ASTRA N4)
    const spaced = new RegExp(`(?<![\\p{L}\\p{N}])${[...value.norm].map(ch => ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")).join("[^\\p{L}\\p{N}]{0,3}")}(?![\\p{L}\\p{N}])`, "gu");
    for (let m = spaced.exec(light); m; m = spaced.exec(light)) { if (m.index + m[0].length > lightBoundary) return value.cls ?? "other"; if (m[0].length === 0) spaced.lastIndex++; }
  }
  // ASTRA N2: the value with other separators between its characters (`ab-cd-ef-gh` written `ab.cd.ef.gh`): letters and digits only
  const bones = skeletonValue(joined), bonesBoundary = skeletonValue(joined.slice(0, boundary)).length;
  for (const value of view.values) {
    const bone = skeletonValue(value.norm);
    // only where it says something the WHOLE rule above did not: the value or the text holds another character
    if (bone.length >= 8 && (bone.length !== value.norm.length || bones.length !== joined.length)) for (let at = bones.indexOf(bone); at >= 0; at = bones.indexOf(bone, at + 1)) if (at + bone.length > bonesBoundary) return value.cls ?? "other";
  }
  const { MIXED_GRAM, ANY_GRAM } = MASKED_VALUE_BOUNDS;
  for (let at = Math.max(0, boundary - MIXED_GRAM + 1); at + MIXED_GRAM <= joined.length; at++) { const gram = joined.slice(at, at + MIXED_GRAM); if (view.gramsMixed.has(gram)) return view.gramsMixed.classOf?.(gram) ?? "other"; }
  for (let at = Math.max(0, boundary - ANY_GRAM + 1); at + ANY_GRAM <= joined.length; at++) { const gram = joined.slice(at, at + ANY_GRAM); if (view.gramsAny.has(gram)) return view.gramsAny.classOf?.(gram) ?? "other"; }
  return undefined;
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
