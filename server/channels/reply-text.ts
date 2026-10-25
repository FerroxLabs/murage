// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sentences the server itself writes into an outside chat (Telegram,
// Discord, Slack, WhatsApp): limit lines, pairing and link notices, approval
// prompts, buttons and outcomes, voice note replies, routine limit lines.
// They read in the owner's app language (config `language`; "" follows the
// system language), from the same packs the app uses (src/locales, keys
// `channelReply.<name>`). Packs are partial: a key a pack has not caught up on
// reads in English, and an unknown language reads in English.
//
// The packs are bundled with the server (JSON import, as model-vision.ts
// does), so a packaged server needs no files from src/ at run time.
import en from "../../src/locales/en.json" with { type: "json" };
import de from "../../src/locales/de.json" with { type: "json" };
import es from "../../src/locales/es.json" with { type: "json" };
import fr from "../../src/locales/fr.json" with { type: "json" };
import hi from "../../src/locales/hi.json" with { type: "json" };
import ja from "../../src/locales/ja.json" with { type: "json" };
import ptBr from "../../src/locales/pt-br.json" with { type: "json" };
import zh from "../../src/locales/zh.json" with { type: "json" };

export type ChannelReplyKey = Extract<keyof typeof en, `channelReply.${string}`>;
type Pack = Readonly<Record<string, string | undefined>>;

const english: Pack = en;
/** Every registered language but English, by code (the same codes as src/locales/index.ts).
 * Mutable only so a test can register a pack. */
export const channelReplyPacks: Record<string, Pack> = {
  de, es, fr, hi, ja, pt: ptBr, "pt-br": ptBr, zh,
};

let languageSetting: () => string | undefined = () => undefined;
let systemLanguage: () => string | undefined = defaultSystemLanguage;

/** Where the owner's app language comes from (index.ts passes `() => cfg.language`). */
export function setChannelReplyLanguage(source: () => string | undefined): void {
  languageSetting = source;
}
/** Tests only: the system language used when the setting is "". */
export function setChannelReplySystemLanguage(source: () => string | undefined): void {
  systemLanguage = source;
}

/** The desktop passes Electron's app locale; a bare server reads the POSIX locale, then Intl. */
function defaultSystemLanguage(): string | undefined {
  const env = process.env;
  for (const value of [env.MURAGE_SYSTEM_LANGUAGE, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const tag = value?.trim().split(/[.@]/)[0]?.replace(/_/g, "-");
    if (tag && tag !== "C" && tag !== "POSIX") return tag;
  }
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

/** "de-AT" → "de-at" if registered, else "de", else "en" (as src/lib/i18n.ts resolveLocale). */
function resolve(tag: string | undefined): string {
  const lower = tag?.trim().toLowerCase();
  if (!lower) return "en";
  if (lower === "en" || Object.hasOwn(channelReplyPacks, lower)) return lower;
  const base = lower.split("-")[0] ?? "";
  return Object.hasOwn(channelReplyPacks, base) ? base : "en";
}

function safely(read: () => string | undefined): string | undefined {
  try { return read(); } catch { return undefined; }
}

/** The owner's setting, or the system language when the setting is "". A POSIX-style
 * "pt_BR" reads as the locale tag "pt-BR". */
function chosenTag(): string | undefined {
  const chosen = safely(languageSetting)?.trim();
  return (chosen ? chosen : safely(systemLanguage)?.trim())?.replace(/_/g, "-");
}

/** The language code channel lines are written in now ("en", "de", "pt-br"). */
export function channelReplyLanguage(): string {
  return resolve(chosenTag());
}

/** A locale tag for times and numbers in channel lines: the chosen tag when it is
 * that language ("en-GB" keeps its 24-hour clock), else the pack's own code. A bare
 * language choice ("en") keeps the system's region when the system speaks that
 * language, so picking English on an en-GB machine still reads 15:40. */
export function channelReplyLocale(): string {
  const tag = chosenTag();
  const code = resolve(tag);
  const base = code.split("-")[0];
  const sameLanguage = (candidate: string | undefined): string | undefined => {
    try {
      const canonical = candidate ? Intl.getCanonicalLocales(candidate)[0] : undefined;
      return canonical && canonical.toLowerCase().split("-")[0] === base ? canonical : undefined;
    } catch { return undefined; /* not a locale tag */ }
  };
  const chosen = sameLanguage(tag);
  if (chosen?.includes("-")) return chosen;
  const system = sameLanguage(safely(systemLanguage)?.trim());
  if (system?.includes("-")) return system;
  // No region anywhere: the pack's own locale. Bare "pt" reads as the pt-BR pack it
  // shows, so its clock and numbers follow Brazil, not Intl's bare "pt".
  return code === "pt" || code === "pt-br" ? "pt-BR" : code;
}

/** One channel line in the owner's language, placeholders `{name}` filled in. */
export function channelReply(key: ChannelReplyKey, params?: Record<string, string | number>): string {
  const code = channelReplyLanguage();
  const pack = code === "en" ? undefined : channelReplyPacks[code];
  const template = pack?.[key] || english[key] || key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

/** The line a channel reply ends with when a task finished without any output: one translated sentence per
 * final status, so no raw English status word lands inside another language. Any other status reads as "ended". */
const TASK_OUTCOME_REPLY: Readonly<Record<string, ChannelReplyKey>> = {
  completed: "channelReply.taskCompleted",
  failed: "channelReply.taskFailed",
  cancelled: "channelReply.taskCancelled",
  blocked: "channelReply.taskBlocked",
  stopped: "channelReply.taskStopped",
};
export function taskOutcomeReply(status: string): string {
  return channelReply(Object.hasOwn(TASK_OUTCOME_REPLY, status) ? TASK_OUTCOME_REPLY[status]! : "channelReply.taskEnded");
}

/** "about 3:40 PM" style clock time in the channel language. */
export function channelReplyTime(at: number): string {
  try { return new Date(at).toLocaleTimeString(channelReplyLocale(), { hour: "numeric", minute: "2-digit" }); }
  catch { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
}

/** A count in the channel language ("4,000", "4.000"). */
export function channelReplyNumber(value: number): string {
  try { return value.toLocaleString(channelReplyLocale()); } catch { return value.toLocaleString("en-US"); }
}
