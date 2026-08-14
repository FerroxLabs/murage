// Unsent composer text, kept per thread. The Composer is keyed by bot/room
// id, so switching threads unmounts it and its local text state dies with
// it. Drafts live in localStorage, so coming back to a bot — in this
// session or after a restart — finds what you were typing still there.
import { useCallback, useState } from "react";

const KEY = "omb-drafts";

type Drafts = Record<string, string>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// Storage is best-effort: a full quota, a locked-down origin, or a garbled
// value must never cost a keystroke — every failure reads as "no drafts".
function read(store: Store): Drafts {
  try {
    const raw = store?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Drafts) : {};
  } catch {
    return {};
  }
}

export function getDraft(store: Store, id: string): string {
  const text = read(store)[id];
  return typeof text === "string" ? text : "";
}

export function setDraft(store: Store, id: string, text: string): void {
  const drafts = read(store);
  // an emptied composer drops its entry rather than storing "" forever
  if (text) drafts[id] = text;
  else delete drafts[id];
  try {
    store?.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — the draft just doesn't outlive the mount */
  }
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` doesn't shield it.
function getStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** useState for the composer text, persisted under `id` (a bot or room). */
export function useDraft(id: string): [string, (next: string) => void] {
  const store = getStore();
  const [text, setText] = useState(() => getDraft(store, id));
  const set = useCallback(
    (next: string) => {
      setText(next);
      setDraft(store, id, next);
    },
    [store, id],
  );
  return [text, set];
}
