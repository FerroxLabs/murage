// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two loop rows the server writes into a transcript, as stable KEYS and never as sentences. The words come from the
// language packs (src/locales, keys `loopNotice.<code>`), so each row reads in the person's own language; the English
// below is for surfaces with no language pack (a Markdown export, a log).
//
//   loop-notice:nudged                    the bot was nudged after 5 identical failures
//   loop-notice:repeat:<n>:<call>         the same call was repeated <n> times; <call> is "tool: arguments"

export const LOOP_NOTICE_PREFIX = "loop-notice:";

export type LoopNotice = { code: "nudged" } | { code: "repeat"; count: number; call: string };

export function loopNoticeName(code: "nudged"): string;
export function loopNoticeName(code: "repeat", count: number, call: string): string;
export function loopNoticeName(code: "nudged" | "repeat", count?: number, call?: string): string {
  return code === "nudged" ? `${LOOP_NOTICE_PREFIX}nudged` : `${LOOP_NOTICE_PREFIX}repeat:${count}:${call}`;
}

/** The notice a transcript activity name carries, or undefined for any other name. */
export function loopNotice(name: string | undefined | null): LoopNotice | undefined {
  if (typeof name !== "string" || !name.startsWith(LOOP_NOTICE_PREFIX)) return undefined;
  const rest = name.slice(LOOP_NOTICE_PREFIX.length);
  if (rest === "nudged") return { code: "nudged" };
  const match = /^repeat:(\d+):([\s\S]*)$/.exec(rest);
  return match ? { code: "repeat", count: Number(match[1]), call: match[2]! } : undefined;
}

/** English reading, for surfaces with no renderer locale. */
export function loopNoticeDisplayName(name: string | undefined | null): string | undefined {
  const notice = loopNotice(name);
  if (!notice) return undefined;
  return notice.code === "nudged" ? "Nudged after 5 identical failures" : `Same call repeated ${notice.count}×: ${notice.call} (it may be stuck)`;
}
