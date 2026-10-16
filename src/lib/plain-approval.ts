// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The plain-words approval text (shared/approval-plain.ts), loaded after the
// first paint (spec §6). It brings the strict read-only shell parser and the
// connected-app action tables with it, which a chat does not need before its
// first approval. The app fetches it when idle (App.tsx), and the first card
// that asks for it fetches it too. Until it arrives, plainApproval() answers
// undefined and every caller keeps a neutral wording ("wants to use a tool",
// "Approval requested", the request shown in full), which never makes an
// action sound safer than it is. The components below subscribe with
// usePlainApprovalReady() and re-render once it is here.
//
// A fetch that fails is tried again: three tries a few seconds apart, then
// once more each time the window comes back into focus, until it arrives.
import { useEffect, useSyncExternalStore } from "react";
import type { PlainApproval } from "../../shared/approval-plain";

export type { PlainApproval };

type PlainModule = typeof import("../../shared/approval-plain");

/** The waits between the three tries of one round. */
export const PLAIN_APPROVAL_RETRY_DELAYS_MS = [1_000, 4_000] as const;

const importPlain = (): Promise<PlainModule> => import("../../shared/approval-plain");
let importer: () => Promise<PlainModule> = importPlain;
let loaded: PlainModule | undefined;
let loading: Promise<PlainModule> | undefined;
/** a round failed: the next one starts on window focus (or an explicit load) */
let waitingForFocus = false;
/** a round has failed at least once: a caller that waits for the words may go on with the neutral wording */
let roundFailed = false;
/** How long a call waits for the words before it asks in the neutral wording: an import that neither arrives nor fails
 * (a stalled fetch) must never leave a request unspoken. */
export const PLAIN_APPROVAL_WAIT_MS = 3_000;
/** the wait ran out: settled in the neutral wording; the words may still arrive later and fill the cache */
let waitExpired = false;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
/** told when the words arrive and when a round fails (usePlainApprovalSettled) */
const settledListeners = new Set<() => void>();

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function onWindowFocus(): void {
  if (!waitingForFocus || loaded) return;
  waitingForFocus = false;
  void loadPlainApproval().catch(() => undefined);
}

function waitForFocus(): void {
  waitingForFocus = true;
  if (typeof window === "undefined") return;
  window.removeEventListener("focus", onWindowFocus);
  window.addEventListener("focus", onWindowFocus, { once: true });
}

/** One round: up to three tries with a growing wait between them. */
async function round(): Promise<PlainModule> {
  for (let tryIndex = 0; ; tryIndex++) {
    try {
      const module = await importer();
      loaded = module;
      waitingForFocus = false;
      for (const listener of [...listeners, ...settledListeners]) listener();
      return module;
    } catch (error) {
      if (tryIndex >= PLAIN_APPROVAL_RETRY_DELAYS_MS.length) throw error;
      await wait(PLAIN_APPROVAL_RETRY_DELAYS_MS[tryIndex]);
    }
  }
}

/** Fetch the plain-words module once. A round that fails rejects and the
 * next round starts on window focus or on the next explicit call. */
export function loadPlainApproval(): Promise<PlainModule> {
  if (loaded) return Promise.resolve(loaded);
  waitingForFocus = false;
  loading ??= round().then(
    (module) => { loading = undefined; return module; },
    (error: unknown) => {
      loading = undefined;
      roundFailed = true;
      waitForFocus();
      for (const listener of [...settledListeners]) listener();
      throw error;
    },
  );
  return loading;
}

/** Start a round from a render path, unless one failed and focus has not come back yet. */
function ensurePlainApproval(): void {
  if (loaded || loading || waitingForFocus) return;
  void loadPlainApproval().catch(() => undefined);
}

/** A card's action in plain words, or undefined while the words are still loading. */
export function plainApproval(tool: string | undefined, detail: string | undefined): PlainApproval | undefined {
  if (!loaded) {
    ensurePlainApproval();
    return undefined;
  }
  return loaded.plainApproval(tool, detail);
}

/** Called once the plain words arrive; usePlainApprovalReady() re-renders through this. */
export function subscribePlainApproval(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const isReady = () => loaded !== undefined;

/** true once the plain words are here (no subscription; for non-React callers). */
export function plainApprovalReady(): boolean {
  return isReady();
}

/** true once the plain words are here; a component that reads them re-renders then. */
export function usePlainApprovalReady(): boolean {
  const ready = useSyncExternalStore(subscribePlainApproval, isReady, isReady);
  useEffect(() => {
    if (!ready) ensurePlainApproval();
  }, [ready]);
  return ready;
}

const isSettled = () => loaded !== undefined || roundFailed || waitExpired;

/** Start the bounded wait (once): after PLAIN_APPROVAL_WAIT_MS without the words, settled is true in the neutral wording. */
export function startPlainApprovalWait(ms: number = PLAIN_APPROVAL_WAIT_MS): void {
  if (isSettled() || waitTimer) return;
  waitTimer = setTimeout(() => {
    waitTimer = undefined;
    if (isSettled()) return;
    waitExpired = true;
    for (const listener of [...settledListeners]) listener();
  }, ms);
}

/** Whether a call's speech effect must hold back for the words: only while a NEW approval (one not asked yet) is open and the
 * words have neither arrived nor failed nor outwaited PLAIN_APPROVAL_WAIT_MS. An approval already asked is never asked again
 * when the words arrive late: it is not new. */
export function holdForPlainWords(approvalRequestId: string | undefined, askedRequestId: string | undefined, settled: boolean): boolean {
  return approvalRequestId !== undefined && askedRequestId !== approvalRequestId && !settled;
}

/** usePlainApprovalSettled() without a subscription, for non-React callers. */
export function plainApprovalSettled(): boolean {
  return isSettled();
}

/** Called once the plain words arrive or a round to fetch them fails. */
export function subscribePlainApprovalSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

/** true once the plain words are here, or once a round to fetch them has
 * failed. A call waits on this before it speaks an approval, so it says the
 * plain words ("Can I search the web?") and never the wording used while they
 * load; when they cannot be fetched, or do not arrive within
 * PLAIN_APPROVAL_WAIT_MS, it goes on with the neutral wording instead of
 * leaving the request unspoken. Starts a fetch and the wait when needed. */
export function usePlainApprovalSettled(): boolean {
  const settled = useSyncExternalStore(subscribePlainApprovalSettled, isSettled, isSettled);
  useEffect(() => {
    if (settled) return;
    void loadPlainApproval().catch(() => undefined);
    startPlainApprovalWait();
  }, [settled]);
  return settled;
}

/** Tests only: swap the module fetch (pass nothing to restore it) and forget what loaded. */
export function resetPlainApprovalForTests(fetchModule?: () => Promise<PlainModule>): void {
  importer = fetchModule ?? importPlain;
  loaded = undefined;
  loading = undefined;
  roundFailed = false;
  waitExpired = false;
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = undefined;
  if (typeof window !== "undefined") window.removeEventListener("focus", onWindowFocus);
  waitingForFocus = false;
}
