// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Like Murage so far?" card: one quiet ask for a GitHub star.
//
// Everything here is local. The counts (which days Murage was used, whether the last turn went well, the snooze) sit in this
// window's own storage under one key, and nothing is sent anywhere: no request, no usage event. The only outbound step is
// the owner's own click on "Star on GitHub", which opens the project page in the system browser.
//
// It shows once the owner has finished a turn on 5 different days and the last turn finished well. "Not now" waits 14 days;
// a second "Not now", or a star click, ends it for good; Settings can turn it off. It never shows over an approval card,
// during a running turn, or anywhere but the owner's own desktop window, and not in a store build unless the build says so.
import { inNativeShell } from "./native-shell";
import { openedInBrowser } from "./open-external";

export const STAR_URL = "https://github.com/FerroxLabs/murage";
export const STAR_STORE_NAME = "murage.starPrompt.v1";
export const STAR_DAYS_NEEDED = 5;
export const STAR_SNOOZE_DAYS = 14;
/** The most days kept: far more than the count needs, so the record stays small. */
const MAX_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StarState {
  /** Local calendar days (YYYY-MM-DD) with a finished turn, oldest first, the newest MAX_DAYS. */
  days: string[];
  /** The newest finished turn went well. */
  lastTurnOk: boolean;
  /** Not before this time (epoch ms). 0 means no snooze. */
  snoozeUntil: number;
  /** How many times "Not now" was pressed. */
  notNow: number;
  /** The star button was pressed. */
  starred: boolean;
  /** Settings turned the card off. */
  off: boolean;
}

export interface StarContext {
  now: number;
  /** Whether the harness confirmed this renderer is on the owner's computer. */
  desktop: boolean | undefined;
  storeBuild: boolean;
  allowInStores: boolean;
  turnRunning: boolean;
  approvalOpen: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem">;

export const freshStarState = (): StarState => ({ days: [], lastTurnOk: false, snoozeUntil: 0, notNow: 0, starred: false, off: false });

/** The owner's local calendar day, so "5 different days" means days on their clock. */
export function dayKey(now: number): string {
  const date = new Date(now);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** A finished turn: count the day once, and remember whether it went well. */
export function noteTurnFinished(state: StarState, ok: boolean, now: number): StarState {
  const key = dayKey(now);
  const days = state.days.includes(key) ? state.days : [...state.days, key].slice(-MAX_DAYS);
  return { ...state, days, lastTurnOk: ok };
}

export const clickNotNow = (state: StarState, now: number): StarState => ({
  ...state,
  notNow: state.notNow + 1,
  snoozeUntil: now + STAR_SNOOZE_DAYS * DAY_MS,
});

export const clickStar = (state: StarState): StarState => ({ ...state, starred: true });

export const setStarPromptOn = (state: StarState, on: boolean): StarState => ({ ...state, off: !on });
export const starPromptSetting = (state: StarState): boolean => !state.off;

/** Whether the card may be up right now. Every "never" lives here so a screen cannot forget one. */
export function starPromptShows(state: StarState, context: StarContext): boolean {
  if (state.off || state.starred || state.notNow >= 2) return false;
  if (context.desktop !== true) return false;
  if (context.storeBuild && !context.allowInStores) return false;
  if (context.turnRunning || context.approvalOpen) return false;
  if (!state.lastTurnOk || state.days.length < STAR_DAYS_NEEDED) return false;
  return context.now >= state.snoozeUntil;
}

/** Storage is untrusted: a damaged or hand-edited value reads as a fresh start, never as a crash or a prompt. */
export function parseStarState(raw: string | null | undefined): StarState {
  const fresh = freshStarState();
  if (!raw) return fresh;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fresh; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh;
  const record = value as Record<string, unknown>;
  const count = (input: unknown) => (typeof input === "number" && Number.isInteger(input) && input > 0 && input < 1_000 ? input : 0);
  return {
    days: Array.isArray(record.days)
      ? [...new Set(record.days.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)))].slice(-MAX_DAYS)
      : [],
    lastTurnOk: record.lastTurnOk === true,
    snoozeUntil: typeof record.snoozeUntil === "number" && Number.isFinite(record.snoozeUntil) && record.snoozeUntil > 0 ? record.snoozeUntil : 0,
    notNow: count(record.notNow),
    starred: record.starred === true,
    off: record.off === true,
  };
}

function ownStorage(): Store | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function readStarState(storage: Store | undefined = ownStorage()): StarState {
  try { return parseStarState(storage?.getItem(STAR_STORE_NAME)); } catch { return freshStarState(); }
}

export function writeStarState(state: StarState, storage: Store | undefined = ownStorage()): void {
  try { storage?.setItem(STAR_STORE_NAME, JSON.stringify(state)); } catch { /* no storage: the card simply asks again next launch */ }
}

// One state per window, shared by the store's turn frames, the card and the Settings row.
const listeners = new Set<() => void>();
let current: StarState | undefined;

function load(): StarState {
  return (current ??= readStarState());
}

function commit(next: StarState): void {
  current = next;
  writeStarState(next);
  for (const listener of [...listeners]) listener();
}

export const getStarState = (): StarState => load();
export function subscribeStarState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Replaying an old turn after reconnect must not count as activity today. */
export function noteStarTurn(event: { type: string; ok?: boolean }, computer: boolean | undefined, replayed: boolean): void {
  if (computer !== true || replayed || event.type !== "turn.completed") return;
  commit(noteTurnFinished(load(), event.ok !== false, Date.now()));
}
export const pressNotNow = (): void => commit(clickNotNow(load(), Date.now()));
export const pressStar = (): void => commit(clickStar(load()));
export const switchStarPrompt = (on: boolean): void => commit(setStarPromptOn(load(), on));

/** The page opens in the system browser. True means handed off; false means it did not open, and the card stays. */
export function openStarPage(): Promise<boolean> {
  return openedInBrowser(STAR_URL);
}

/** The App Store, Play Store, Mac App Store and Windows Store builds hide outbound links, so this card is hidden there too. The
 * phone apps load this page inside their shell; the desktop store builds say so through the preload (--murage-store=1). */
export function isStoreBuild(): boolean {
  const desktopStore = globalThis.window?.muragebox?.storeBuild === true;
  return desktopStore || inNativeShell();
}

/** The build flag that says a store build may show the card after all (VITE_MURAGE_STAR_IN_STORES=1). */
export function starAllowedInStores(): boolean {
  return (import.meta.env?.VITE_MURAGE_STAR_IN_STORES as string | undefined)?.trim() === "1";
}
