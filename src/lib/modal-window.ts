// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The open modal window (a <dialog> opened with showModal(): bot settings, Files, What's new, ...). It sits in the browser's top
// layer and makes the rest of the page inert, so anything that must stay usable beside it (the "?" help tab and panel, the update
// pop-up) is drawn inside it instead, through a portal. One watcher serves all of them.
//
// The top window is the one opened last, as the top layer orders them, not the last one in the document: a window can be opened
// over another one that comes later in the page. Each window is stamped when it is seen opening, and the newest stamp wins.

type QueryRoot = Pick<Document, "querySelectorAll">;
type ElementLike = Pick<Element, "matches">;
let nextStamp = 0;
const stamps = new WeakMap<object, number>();

function openWindows(root: QueryRoot): HTMLElement[] {
  try {
    return [...root.querySelectorAll<HTMLElement>("dialog:modal")];
  } catch {
    // An engine that does not know :modal counts any open dialog.
    return [...root.querySelectorAll<HTMLElement>("dialog[open]")];
  }
}

function isOpenWindow(element: ElementLike): boolean {
  try {
    return element.matches("dialog:modal");
  } catch {
    return element.matches("dialog[open]");
  }
}

/** One `open` change, in the order it happened: a window that opened (or closed and opened again) becomes the newest. */
export function noteModalWindowChange(element: ElementLike): void {
  stamps.delete(element);
  if (isOpenWindow(element)) stamps.set(element, nextStamp++);
}

type ObserverLike = Pick<MutationObserver, "observe" | "disconnect">;
type ChangeRecord = { target: unknown; attributeName: string | null };
type ObserverMaker = new (callback: (records?: readonly ChangeRecord[]) => void) => ObserverLike;

function noteRecords(records: readonly ChangeRecord[] | undefined): void {
  for (const record of records ?? []) {
    const target = record.target as Partial<ElementLike> | null;
    if (record.attributeName === "open" && typeof target?.matches === "function") noteModalWindowChange(target as ElementLike);
  }
}

// One page-wide record of the opening order, started when this module loads (with the first paint, before any window can open),
// so a watcher that starts late (the update pop-up comes up mid-download) still knows which window is on top. Its observer is
// made first, so the page delivers each change to it before any watcher.
let orderStarted = false;
export function startModalWindowOrder(root: Node | null = typeof document === "undefined" ? null : document.documentElement, Observer: ObserverMaker | undefined = typeof MutationObserver === "function" ? (MutationObserver as unknown as ObserverMaker) : undefined): boolean {
  if (orderStarted || !root || !Observer) return orderStarted;
  new Observer(noteRecords).observe(root, { subtree: true, attributes: true, attributeFilter: ["open"] });
  orderStarted = true;
  return true;
}
startModalWindowOrder();

/** The open modal window on top, or null. A window not seen opening (only when the order record could not start) is stamped
 *  in document order, after every window already stamped. */
export function openModalWindow(root: QueryRoot = document): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topStamp = -1;
  for (const found of openWindows(root)) {
    let stamp = stamps.get(found);
    if (stamp === undefined) {
      stamp = nextStamp++;
      stamps.set(found, stamp);
    }
    if (stamp > topStamp) { top = found; topStamp = stamp; }
  }
  return top;
}

/** Calls `onChange` with the open modal window, now and whenever that changes: one watch on `open` attributes for the whole page
 *  (showModal and close set and clear it), plus, only while a window is held, a watch for that window being taken out of the
 *  page. Returns the stop. */
export function watchModalWindow(
  onChange: (host: HTMLElement | null) => void,
  doc: Pick<Document, "querySelectorAll" | "body"> = document,
  Observer: ObserverMaker = MutationObserver as unknown as ObserverMaker,
): () => void {
  let host: HTMLElement | null = null;
  let removal: ObserverLike | null = null;
  let first = true;
  const update = () => {
    const next = openModalWindow(doc);
    if (next !== host || first) { host = next; first = false; onChange(host); }
    if (host && !removal) {
      removal = new Observer(() => { if (host && !host.isConnected) update(); });
      removal.observe(doc.body, { childList: true, subtree: true });
    } else if (!host && removal) {
      removal.disconnect();
      removal = null;
    }
  };
  const opens = new Observer((records) => {
    // The page-wide record already took these in, in order; without it (no document when this module loaded), take them here.
    if (!orderStarted) noteRecords(records);
    update();
  });
  opens.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  update();
  return () => { opens.disconnect(); removal?.disconnect(); removal = null; };
}
