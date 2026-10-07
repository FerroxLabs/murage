// The renderer's half of dictation clean-up (server/voice/dictation-cleanup.ts).
//
// The setting is a per-device switch, on by default, kept beside the other
// device preferences in localStorage: a phone and a Mac can differ, and there
// is nothing in it the server needs to know.

import { desktopCallerHeaders } from "./live-events";

export const CLEANUP_PREF_KEY = "murage.cleanUpDictation";

type PrefStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;

function storageOf(storage?: PrefStorage | null): PrefStorage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** On unless the person turned it off. Unreadable storage counts as on. */
export function cleanupEnabled(storage?: PrefStorage | null): boolean {
  try {
    return storageOf(storage)?.getItem(CLEANUP_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setCleanupEnabled(on: boolean, storage?: PrefStorage | null): void {
  try {
    storageOf(storage)?.setItem?.(CLEANUP_PREF_KEY, on ? "on" : "off");
  } catch {
    // a blocked store only means the choice is not remembered
  }
}

/** What the speech helper added to the box: the text after what was already
 *  there, or null when the start of the box was edited meanwhile (then there
 *  is nothing to tidy that is ours to change) or nothing was said. */
export function dictatedPortion(base: string, text: string): string | null {
  if (!text.startsWith(base)) return null;
  const said = text.slice(base.length).trim();
  return said ? said : null;
}

export function joinDictation(before: string, said: string): string {
  const head = before.trimEnd();
  return head ? `${head} ${said}` : said;
}

/** One step back: the box as it was before clean-up replaced it. */
export interface CleanupUndo {
  raw: string;
  cleaned: string;
}

export const undoCleanup = (undo: CleanupUndo): string => undo.raw;

/** Offered only while the box still holds exactly what clean-up wrote. */
export function undoOffered(undo: CleanupUndo | null, text: string): boolean {
  return Boolean(undo) && undo!.cleaned === text;
}

export interface CleanupTarget {
  botId?: string;
  groupId?: string;
}

/** Longer than the server's own 4 s, so its answer wins the race. */
const CLIENT_TIMEOUT_MS = 6_000;

/** Tidy a finished dictation. Any failure returns the raw text. */
export async function requestCleanup(
  text: string,
  target: CleanupTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; cleaned: boolean }> {
  const raw = { text, cleaned: false };
  try {
    const res = await fetchImpl("/api/voice/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json", ...desktopCallerHeaders() },
      body: JSON.stringify({ text, ...(target.botId ? { botId: target.botId } : {}), ...(target.groupId ? { groupId: target.groupId } : {}) }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    if (!res.ok) return raw;
    const body = (await res.json().catch(() => null)) as { text?: unknown; cleaned?: unknown } | null;
    if (typeof body?.text !== "string" || !body.text.trim()) return raw;
    return { text: body.text, cleaned: body.cleaned === true };
  } catch {
    return raw;
  }
}

/**
 * Decide what a finished clean-up does to the box. Returns null when it must
 * change nothing: it did not tidy anything, or the person typed, sent or
 * switched draft while it was in flight (the box no longer holds exactly what
 * it held when dictation stopped), so what they typed is kept.
 */
export function applyCleanupResult(input: {
  atStop: string;
  base: string;
  current: string;
  result: { text: string; cleaned: boolean };
}): { next: string; undo: CleanupUndo } | null {
  if (!input.result.cleaned || input.current !== input.atStop) return null;
  const next = joinDictation(input.base, input.result.text);
  return { next, undo: { raw: input.atStop, cleaned: next } };
}

/** How long to wait for the recognizer's final line after asking it to finish. */
export const FINISH_DEADLINE_MS = 1_500;

/**
 * Stop dictation without dropping its last words: ask the helper to finish,
 * keep listening, and call `done` when it reports the end, or after the
 * deadline, or at once if the request itself fails. `done` runs exactly once.
 * Returns a canceller.
 */
export function finishThenStop(options: {
  finish: () => Promise<unknown>;
  onEnd: (cb: () => void) => () => void;
  done: () => void;
  deadlineMs?: number;
}): () => void {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;
  const settle = (run: boolean) => {
    if (over) return;
    over = true;
    if (timer) clearTimeout(timer);
    off?.();
    if (run) options.done();
  };
  off = options.onEnd(() => settle(true));
  timer = setTimeout(() => settle(true), options.deadlineMs ?? FINISH_DEADLINE_MS);
  try {
    void Promise.resolve(options.finish()).catch(() => settle(true));
  } catch {
    settle(true);
  }
  return () => settle(false);
}
