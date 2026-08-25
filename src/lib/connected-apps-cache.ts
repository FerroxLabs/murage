// The last connected-apps inventory we were SURE about.
//
// The panel is a modal: its in-memory inventory dies when it closes, so
// reopening paints an empty list until the network answers. When the answer
// is "the credential store was unreadable", it stays empty — and an empty
// list reads as "my connections are gone", which is never what happened.
//
// So the last authoritative inventory is kept where it survives a relaunch,
// and the panel opens showing it. Nothing secret goes in: app slugs, the
// connected-account ids the panel already displays, and a timestamp.
//
// This is for the HUMAN's view only. A bot's tool call always uses live
// state — a cached list may be optimistic, and acting on it would be wrong.
import type { ConnectorStatus } from "@/components/PluginsPanel";

export interface CachedInventory {
  at: number;
  services: Record<string, ConnectorStatus>;
}

export const CONNECTED_APPS_CACHE_KEY = "omb-connected-apps";

/** Reaching for localStorage is itself a failure point: a private window or
 * blocked site data throws on access, and a cache is never worth a crash. */
function store(explicit?: Storage): Storage | undefined {
  if (explicit) return explicit;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readCachedInventory(explicit?: Storage): CachedInventory | null {
  try {
    const raw = store(explicit)?.getItem(CONNECTED_APPS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.services)) return null;
    return { at: typeof parsed.at === "number" ? parsed.at : 0, services: parsed.services as Record<string, ConnectorStatus> };
  } catch {
    // A cache we cannot read is the same as no cache; it must never be the
    // reason the panel fails to paint.
    return null;
  }
}

export function writeCachedInventory(
  services: Record<string, ConnectorStatus>,
  now: number,
  explicit?: Storage,
): void {
  try {
    store(explicit)?.setItem(CONNECTED_APPS_CACHE_KEY, JSON.stringify({ at: now, services }));
  } catch {
    /* a cache is never worth a crash */
  }
}
