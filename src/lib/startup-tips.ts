// SPDX-License-Identifier: AGPL-3.0-or-later
// The daily start-up tips (FIRSTRUN-1019 section 1.3, slice B). Twelve tips, one per start, rotating. The splash runs before the
// server, so the renderer works out the NEXT start's tip here and hands it to main inside the cached picture
// (src/components/StartupPictureWriter.tsx); nothing here touches the network or the disk.
import { botRole } from "./bot-role";
import type { TipStrings } from "../locales/startup-tips";

/** The twelve tips, in rotation order. The ids are also the glyph keys the splash draws (electron/startup-splash.mjs). */
export const STARTUP_TIP_IDS = ["search", "brief", "hire", "drop", "needs", "routines", "byname", "voice", "today", "levels", "phone", "notify"] as const;
export type StartupTipId = (typeof STARTUP_TIP_IDS)[number];
export const STARTUP_TIP_COUNT = STARTUP_TIP_IDS.length;

export type TipOs = "mac" | "win" | "other";
export interface TipContext {
  /** The Chief's name, or null when nobody is named (then the plain words are used). */
  chief: string | null;
  /** The first teammates, in sidebar order, Chief excluded. Only the first two are ever used. */
  mates: readonly string[];
  os: TipOs;
  /** False where phone pairing cannot work: the phone tip is then skipped. */
  phoneAvailable: boolean;
}

const NAME_MAX = 20;

/** The index after this one, wrapping 11 to 0. Anything that is not a tip index starts the rotation at 0. */
export function nextTipIndex(index: number): number {
  return Number.isInteger(index) && index >= 0 && index < STARTUP_TIP_COUNT ? (index + 1) % STARTUP_TIP_COUNT : 0;
}

export function tipAvailable(id: StartupTipId, ctx: Pick<TipContext, "phoneAvailable">): boolean {
  return id !== "phone" || ctx.phoneAvailable;
}

/** The first tip at or after `from` (wrapping) that this computer can use. */
export function pickTipIndex(from: number, ctx: Pick<TipContext, "phoneAvailable">): number {
  const start = Number.isInteger(from) && from >= 0 ? from % STARTUP_TIP_COUNT : 0;
  for (let step = 0; step < STARTUP_TIP_COUNT; step += 1) {
    const index = (start + step) % STARTUP_TIP_COUNT;
    if (tipAvailable(STARTUP_TIP_IDS[index], ctx)) return index;
  }
  return start;
}

export function shortcutKey(os: TipOs | boolean): string {
  return os === "mac" || os === true ? "Cmd+K" : "Ctrl+K";
}

export function startupOs(platform: string | undefined): TipOs {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return "other";
}

/** A name for a sentence: at most 20 characters, then an ellipsis. */
export function tipName(name: string): string {
  const letters = [...name.trim()];
  return letters.length > NAME_MAX ? `${letters.slice(0, NAME_MAX).join("").trimEnd()}…` : letters.join("");
}

const upperFirst = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** One tip in the person's words. Placeholders are replaced in one pass, so a name that looks like a placeholder stays as typed. */
export function tipText(id: StartupTipId, ctx: TipContext, strings: TipStrings): { id: StartupTipId; head: string; line: string; try: string } {
  const chief = ctx.chief?.trim() ? tipName(ctx.chief) : strings["fallback.chief"];
  const first = ctx.mates[0]?.trim() ? tipName(ctx.mates[0]) : chief;
  const second = ctx.mates[1]?.trim() ? tipName(ctx.mates[1]) : first;
  const values: Record<string, string> = {
    chief,
    m1: first,
    m2: second,
    key: shortcutKey(ctx.os),
    surfaces: strings[`surfaces.${ctx.os}`] ?? strings["surfaces.other"],
  };
  const fill = (template: string) => upperFirst(template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match)));
  return { id, head: fill(strings[`${id}.head`]), line: fill(strings[`${id}.line`]), try: fill(strings[`${id}.try`]) };
}

export interface TipBot {
  id: string;
  name: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
  individual?: boolean;
  section?: string;
}

/** The Chief (the named one, else the workspace Chief) and every other visible bot in list order. */
export function rosterForTips<Bot extends TipBot>(bots: readonly Bot[], chiefBotId: string | null): { chief: Bot | null; mates: Bot[] } {
  const visible = bots.filter((bot) => !bot.hidden);
  const chief = (chiefBotId ? visible.find((bot) => bot.id === chiefBotId) : undefined) ?? visible.find((bot) => botRole(bot) === "chief") ?? null;
  return { chief, mates: visible.filter((bot) => bot !== chief) };
}
