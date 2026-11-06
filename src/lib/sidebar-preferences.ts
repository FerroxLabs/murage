import { z } from "zod";

import { BOT_CHATS_SECTION_ID } from "./sidebar-layout";

/** Stored names stay as they were when the densities were renamed in 0.1.62:
 *  "compact" is Standard (the default), "comfortable" is Roomy, "icons" is
 *  the Rail. Nobody's saved choice moves. */
export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "murage.sidebarDensity";
export const SIDEBAR_COLLAPSED_SECTIONS_KEY = "murage.sidebarCollapsedSections.v1";
export const SIDEBAR_SECTION_ORDER_KEY = "murage.sidebarSectionOrder.v1";
/** "off" keeps the chosen density on a narrow window; anything else folds. */
export const SIDEBAR_AUTO_RAIL_KEY = "murage.sidebarAutoRail";

/** The new install's density (0.1.62): Standard, 280px. */
export const DEFAULT_SIDEBAR_DENSITY: SidebarDensity = "compact";
/** What an install that ran before 0.1.62 was showing without a saved choice. */
const EARLIER_DEFAULT_DENSITY: SidebarDensity = "comfortable";

/** Keys only an install that has already run leaves behind. Read once, at
 *  the first render of a 0.1.62 build (installKind below), before this run
 *  can write any of them itself: the point is that an existing person
 *  without a saved density keeps the sidebar they know, and only a first run
 *  gets the new defaults. */
const EARLIER_RUN_KEYS = [
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  "murage-email-gate",
  "murage-flux-invite-dismissed",
];

export function hasEarlierRun(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return Boolean(target && EARLIER_RUN_KEYS.some((key) => target.getItem(key) !== null));
  } catch {
    return false;
  }
}

/** "fresh" for an install whose first run is a 0.1.62 build, "upgraded" for
 *  one that ran before. Decided once and remembered: the first run itself
 *  writes some of the keys hasEarlierRun reads (the email gate, the language),
 *  so asking again on the second launch would call a new install old. */
export const NAV_INSTALL_KEY = "murage.navInstall";
export type InstallKind = "fresh" | "upgraded";

export function installKind(storage?: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>) | null): InstallKind {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const saved = target?.getItem(NAV_INSTALL_KEY);
    if (saved === "fresh" || saved === "upgraded") return saved;
    const kind: InstallKind = hasEarlierRun(target) ? "upgraded" : "fresh";
    target?.setItem?.(NAV_INSTALL_KEY, kind);
    return kind;
  } catch {
    return "fresh";
  }
}

export function parseSidebarDensity(value: string | null, fallback: SidebarDensity = DEFAULT_SIDEBAR_DENSITY): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return fallback;
  }
}

export function loadSidebarDensity(storage?: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>) | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const fallback = installKind(target) === "upgraded" ? EARLIER_DEFAULT_DENSITY : DEFAULT_SIDEBAR_DENSITY;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null, fallback);
  } catch {
    return DEFAULT_SIDEBAR_DENSITY;
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

export function loadAutoRail(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return target?.getItem(SIDEBAR_AUTO_RAIL_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveAutoRail(on: boolean, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_AUTO_RAIL_KEY, on ? "on" : "off");
  } catch {
    // as above: the session still honours the choice
  }
}

/** The window widths where the sidebar folds to the rail by itself: wider
 *  than a phone's drawer, too narrow to give the chat and a right-hand panel
 *  room beside a full sidebar. */
export const AUTO_RAIL_QUERY = "(min-width: 768px) and (max-width: 1099.98px)";

/** The density on screen: the chosen one, or the rail on a narrow window
 *  until the person picks a density themselves this session. */
export function effectiveSidebarDensity(chosen: SidebarDensity, { narrowWindow, autoRail, pinned }: { narrowWindow: boolean; autoRail: boolean; pinned: boolean }): SidebarDensity {
  return narrowWindow && autoRail && !pinned ? "icons" : chosen;
}

/** Sidebar density lives in the Sidebar, but Settings > General > Appearance
 *  picks it too, so the two share this small store. `pinned` is this
 *  session's "I chose": it stops the narrow-window rail. */
type DensityState = { density: SidebarDensity; autoRail: boolean; pinned: boolean };
let densityState: DensityState | null = null;
const densityListeners = new Set<() => void>();

export function sidebarDensityState(): DensityState {
  densityState ??= { density: loadSidebarDensity(), autoRail: loadAutoRail(), pinned: false };
  return densityState;
}

export function subscribeSidebarDensity(listener: () => void): () => void {
  densityListeners.add(listener);
  return () => densityListeners.delete(listener);
}

function publishDensity(next: DensityState): void {
  densityState = next;
  for (const listener of densityListeners) listener();
}

/** A person's own choice: saved, and pinned for the session. */
export function chooseSidebarDensity(density: SidebarDensity): void {
  saveSidebarDensity(density);
  publishDensity({ ...sidebarDensityState(), density, pinned: true });
}

export function chooseAutoRail(on: boolean): void {
  saveAutoRail(on);
  publishDensity({ ...sidebarDensityState(), autoRail: on });
}

/** For tests: forget the session and read storage again. */
export function resetSidebarDensityState(): void {
  densityState = null;
}

const stringListSchema = z.array(z.string().min(1).max(240));

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = stringListSchema.safeParse(parsed);
    return result.success ? [...new Set(result.data)].slice(0, 100) : [];
  } catch {
    return [];
  }
}

function loadStringList(
  key: string,
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseStringList(target?.getItem(key) ?? null);
  } catch {
    return [];
  }
}

function saveStringList(
  key: string,
  values: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const safe = [
      ...new Set(values.filter((value) => value.length > 0 && value.length <= 240)),
    ].slice(0, 100);
    target?.setItem(key, JSON.stringify(safe));
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // In-memory React state still keeps the interaction useful this session.
  }
}

/** Bot Chats fills itself, so a first run starts with it folded. An
 *  install that has run before keeps whatever it had. */
export function loadCollapsedSections(storage?: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>) | null): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    if (target && target.getItem(SIDEBAR_COLLAPSED_SECTIONS_KEY) === null && installKind(target) === "fresh") return [BOT_CHATS_SECTION_ID];
  } catch {
    return [];
  }
  return loadStringList(SIDEBAR_COLLAPSED_SECTIONS_KEY, storage);
}

export function saveCollapsedSections(
  ids: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  saveStringList(SIDEBAR_COLLAPSED_SECTIONS_KEY, ids, storage);
}

export function toggleCollapsedSection(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

export function loadSectionOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  return loadStringList(SIDEBAR_SECTION_ORDER_KEY, storage);
}

export function saveSectionOrder(
  ids: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  saveStringList(SIDEBAR_SECTION_ORDER_KEY, ids, storage);
}
