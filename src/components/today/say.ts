// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A TodayText (src/lib/today-model.ts) as words. The owner's own words pass through; a key goes through t(), and a
// count of exactly 1 uses the key's `...One` form when the catalogue has one (the existing plural rule: needsOne,
// appsOne). Today slice 1.0.18.
import { en, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import type { TodayText } from "@/lib/today-model";

export function say(text: TodayText): string {
  if ("raw" in text) return text.raw;
  const one = `${text.key}One`;
  const key = text.params?.n === 1 && Object.hasOwn(en, one) ? one : text.key;
  return t(key as LocaleKey, text.params);
}

const RAN_LOOK = new Set(["ux.l2a.today.lead.ran", "ux.l2a.today.lead.look"]);
const DECIDE = "ux.l2a.today.lead.decide";

/** The lead line's parts (leadLine) as the design's sentence (section 2): "Today: {ran} routines ran, {look} worth a
 *  look. {decide} to decide. Next: {name} at {time}." Parts at 0 are already dropped; with no count at all it is the
 *  quiet line, then Next. */
export function leadSentence(parts: readonly TodayText[]): string {
  const keyOf = (part: TodayText) => ("key" in part ? part.key : "");
  const ranLook = parts.filter((part) => RAN_LOOK.has(keyOf(part))).map(say);
  const decide = parts.filter((part) => keyOf(part) === DECIDE).map(say);
  const rest = parts.filter((part) => !RAN_LOOK.has(keyOf(part)) && keyOf(part) !== DECIDE).map(say);
  const counts = [ranLook.length ? `${ranLook.join(", ")}.` : "", decide.length ? `${decide.join(", ")}.` : ""].filter(Boolean).join(" ");
  return [counts ? t("ux.l2a.today.lead.today", { line: counts }) : "", ...rest].filter(Boolean).join(" ");
}

/** HH:MM on the viewer's clock, the same clock every Today block uses. */
export function clockLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "{when}" for a run: HH:MM today, else the weekday and time. */
export function whenLabel(at: number, now: number): string {
  const a = new Date(at), b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? clockLabel(at) : new Intl.DateTimeFormat(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" }).format(at);
}
