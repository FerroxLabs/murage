// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One state machine for the update surface. The round button beside the account menu (UpdateIndicator), the centred card and
// the bottom-left pop-up (both in UpdateBanner) all read the updater bridge's state through useUpdaterState; the only things
// they share beyond it are whether the card is open and how the pop-up stands, which live here. Module latches rather than
// store actions: neither side owns app state.
import { useEffect, useSyncExternalStore } from "react";
import type { UpdaterState } from "@/types/muragebox";

let open = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

export const openUpdateCard = (): void => publish(true);
export const closeUpdateCard = (): void => publish(false);

export function useUpdateCardOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => open,
    () => false,
  );
}

/** How the pop-up stands. `following`: an update is under way, so the pop-up has a job. `closed`: the owner closed it, "during"
 * the download (it comes back when the update is ready) or once "ready" (it stays closed for that version). */
export interface UpdatePopupLatch {
  following: boolean;
  version?: string;
  closed: "no" | "during" | "ready";
}

const NOT_FOLLOWING: UpdatePopupLatch = { following: false, closed: "no" };
const CLOSED_KEY = "murage.updatePopup.closed";
type Status = UpdaterState["status"];

/** The next latch for this updater state. Returns the same object when nothing changed. A plain "available" or a check that
 * failed never starts it: the pop-up appears for a download, not for news. */
export function nextPopupLatch(latch: UpdatePopupLatch, state: Pick<UpdaterState, "status" | "version"> | null): UpdatePopupLatch {
  if (!state) return latch;
  const { status, version } = state;
  if (version && version !== latch.version) return nextPopupLatch({ ...NOT_FOLLOWING, version }, state);
  if (status === "idle") return latch.following ? { ...latch, following: false } : latch;
  const starts = status === "downloading" || status === "downloaded" || status === "installing" || status === "deferred" || status === "handed-off";
  const reopens = latch.closed === "during" && status === "downloaded";
  if ((latch.following || !starts) && !reopens) return latch;
  return { ...latch, following: true, closed: reopens ? "no" : latch.closed };
}

/** Closing for now. Before anything is under way there is nothing to close, so a Later on "available" cannot hide the download. */
export function closePopupLatch(latch: UpdatePopupLatch, status: Status | undefined): UpdatePopupLatch {
  if (!latch.following) return latch;
  const closed = status === "downloading" || status === "error" || status === "available" ? "during" : "ready";
  return { ...latch, closed };
}

/** The pop-up has nothing to say while a check runs, and nothing for idle. */
export function popupVisible(latch: UpdatePopupLatch, status: Status | undefined): boolean {
  return latch.following && latch.closed === "no" && status !== undefined && status !== "idle" && status !== "checking";
}

export interface UpdatePopupRect {
  left: number;
  top: number;
  width: number;
}

export interface UpdatePopupPlace {
  left: number;
  right?: number;
  top?: string;
  bottom?: number;
  width?: number;
  maxHeight?: number;
}

const NARROW_BELOW = 768; // the md breakpoint: below it the sidebar is a drawer and the composer runs the full width
const POPUP_WIDTH = 300;
const RAIL_UP_TO = 200; // anything this thin is the 64px rail, too thin to hold the pop-up
const CORNER = 16; // bottom-4 left-4, the corner the Undo toast uses
const GAP = 8;

/** Where the pop-up goes. Over the sidebar, just above its footer, so it covers neither the account menu nor the composer; on
 * the rail it starts at the rail and runs over the empty space above the composer; in a narrow window it hangs under the
 * header, because the bottom is the composer. An Undo toast in the corner lifts it clear. */
export function updatePopupPlace({ footer, viewportWidth, viewportHeight, toastHeight }: { footer: UpdatePopupRect | null; viewportWidth: number; viewportHeight: number; toastHeight: number }): UpdatePopupPlace {
  if (viewportWidth < NARROW_BELOW) return { left: 12, right: 12, top: "calc(var(--inset-top, 0px) + 56px)" };
  const aboveToast = toastHeight > 0 ? CORNER + toastHeight + GAP : 0;
  const hasFooter = footer !== null && footer.width > 0;
  const bottom = Math.max(hasFooter ? viewportHeight - footer.top + GAP : CORNER, aboveToast);
  const maxHeight = viewportHeight - bottom - CORNER;
  if (!hasFooter) return { left: CORNER, width: POPUP_WIDTH, bottom, maxHeight };
  const rail = footer.width < RAIL_UP_TO;
  const inset = rail ? GAP : 12;
  return { left: footer.left + inset, width: rail ? POPUP_WIDTH : footer.width - inset * 2, bottom, maxHeight };
}

function readClosed(): UpdatePopupLatch {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? "null") as { version?: unknown; closed?: unknown } | null;
    // The version can be missing: the updater does not always name it once the download is done.
    if (stored && (stored.closed === "during" || stored.closed === "ready")) return { following: false, version: typeof stored.version === "string" ? stored.version : undefined, closed: stored.closed };
  } catch { /* nothing remembered: the pop-up shows */ }
  return NOT_FOLLOWING;
}

function writeClosed(next: UpdatePopupLatch): void {
  try {
    if (next.closed === "no") window.localStorage.removeItem(CLOSED_KEY);
    else window.localStorage.setItem(CLOSED_KEY, JSON.stringify({ version: next.version, closed: next.closed }));
  } catch { /* remembered for this window only */ }
}

// Read once: the window can go and come back while the updater keeps running, and a closed pop-up stays closed through that.
let popupLatch: UpdatePopupLatch = readClosed();
const popupListeners = new Set<() => void>();

function commitPopupLatch(next: UpdatePopupLatch): void {
  if (next === popupLatch) return;
  const closedChanged = next.closed !== popupLatch.closed || next.version !== popupLatch.version;
  popupLatch = next;
  if (closedChanged) writeClosed(next);
  for (const listener of [...popupListeners]) listener();
}

/** A close from the pop-up or the card. */
export const closeUpdatePopup = (status: Status | undefined): void => commitPopupLatch(closePopupLatch(popupLatch, status));
/** The round button during a download: bring the progress back. */
export const showUpdatePopup = (): void => commitPopupLatch({ ...popupLatch, following: true, closed: "no" });

/** Whether the pop-up is up. The latch is worked out during render so the first frame of a download already has it. */
export function useUpdatePopup(state: UpdaterState | null): boolean {
  const stored = useSyncExternalStore(
    (listener) => {
      popupListeners.add(listener);
      return () => { popupListeners.delete(listener); };
    },
    () => popupLatch,
    () => popupLatch,
  );
  const latch = nextPopupLatch(stored, state);
  useEffect(() => commitPopupLatch(latch), [latch]);
  return popupVisible(latch, state?.status);
}

// The sidebar footer the pop-up sits above. The pop-up can come up before the sidebar exists (a download during the terms
// screen), so the footer says when it mounts and when it goes, and the pop-up measures again then.
let anchor: HTMLElement | null = null;
const anchorListeners = new Set<() => void>();

function setAnchor(next: HTMLElement | null): void {
  if (anchor === next) return;
  anchor = next;
  for (const listener of [...anchorListeners]) listener();
}

/** The footer's ref: it registers the element while mounted. A footer that is replaced does not clear its successor. */
export function updatePopupAnchorRef(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined;
  setAnchor(element);
  return () => { if (anchor === element) setAnchor(null); };
}

export const updatePopupAnchor = (): HTMLElement | null => anchor;
export function subscribeUpdatePopupAnchor(listener: () => void): () => void {
  anchorListeners.add(listener);
  return () => { anchorListeners.delete(listener); };
}

/** The mounted footer, or null; the pop-up re-renders when it comes or goes. */
export function useUpdatePopupAnchor(): HTMLElement | null {
  return useSyncExternalStore(subscribeUpdatePopupAnchor, updatePopupAnchor, () => null);
}

/** Where focus may go when a keyboard inside the pop-up closes it, best first; the caller focuses each in turn until one takes
 *  it (a control can turn disabled or hidden while focus was in the pop-up). Inside a modal window everything outside that window
 *  is inert, so the round button in the sidebar is never a choice there: the control focus came from (when it is still in the
 *  window), then the window's controls, then the window itself. With no window open: where focus came from, then the round
 *  button. */
export function popupFocusReturn<E extends { isConnected: boolean }>(input: {
  host: E | null;
  origin: E | null;
  inHost: (element: E) => boolean;
  inPopup: (element: E) => boolean;
  hostControls: () => E[];
  button: () => E | null;
}): E[] {
  const { host, origin, inHost, inPopup } = input;
  const usable = (element: E | null): element is E => Boolean(element && element.isConnected && !inPopup(element) && (!host || inHost(element)));
  const order: E[] = [];
  const add = (element: E | null) => { if (usable(element) && !order.includes(element)) order.push(element); };
  add(origin);
  if (host) {
    for (const control of input.hostControls()) add(control);
    if (host.isConnected) order.push(host);
  } else add(input.button());
  return order;
}

/** States that give the round button a reason to be on screen: something to do, something under way, or something wrong. */
export function indicatorShows(status: UpdaterState["status"] | undefined): boolean {
  return status === "available" || status === "downloading" || status === "downloaded" || status === "installing" || status === "deferred" || status === "handed-off" || status === "error";
}

/** The button's accessible name, by state. */
export function indicatorLabelKey(status: UpdaterState["status"]): "updates.indicatorAvailable" | "updates.indicatorBusy" | "updates.indicatorReady" | "updates.indicatorProblem" {
  if (status === "available") return "updates.indicatorAvailable";
  if (status === "downloaded" || status === "handed-off") return "updates.indicatorReady";
  if (status === "error") return "updates.indicatorProblem";
  return "updates.indicatorBusy";
}

const INSTALLER_URL = /^https:\/\/github\.com\/FerroxLabs\/murage-releases\/releases\/(?:latest|download\/v\d+\.\d+\.\d+\/Murage-\d+\.\d+\.\d+-(?:arm64|x64)\.dmg)$/;

/** macOS: this copy cannot update itself in place, so the card offers the dmg for that version. Null for every other state,
 *  and for a link that is not one of the public release links (the main process makes them; nothing else is opened). */
export function installerOffer(s: UpdaterState | null | undefined): { version: string; url: string } | null {
  if (s?.status !== "error" || s.action !== "download-installer" || !s.version) return null;
  return { version: s.version, url: s.downloadUrl && INSTALLER_URL.test(s.downloadUrl) ? s.downloadUrl : "https://github.com/FerroxLabs/murage-releases/releases/latest" };
}
