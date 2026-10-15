// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance, renderer side. The server owns the record
// (server/terms.ts, DATA_DIR/terms-acceptance.json); this file only asks,
// and tells it when the owner ticked the box and pressed Accept. Nothing is
// remembered in browser storage: a cleared browser or a second device must not
// be able to skip the screen, or to ask again after the owner said yes.
import { useCallback, useEffect, useRef, useState } from "react";
import { version as packageVersion } from "../../package.json";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION, type TermsStatus } from "../../shared/terms";

export { PRIVACY_URL, TERMS_URL, TERMS_VERSION };

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

/** "loading": not answered yet. "needed": show the screen. "clear": go on.
 *  "unreachable": the check itself failed (network, HTTP, malformed answer).
 *  That is NOT clear: the gate stays up in a "couldn't check, retrying" state
 *  until the server answers, then behaves normally. Background routines and
 *  channels run server-side and are not touched by the screen. */
export type TermsPhase = "loading" | "needed" | "clear" | "unreachable";

export function termsPhase(status: TermsStatus | null | undefined): TermsPhase {
  if (status === undefined) return "loading";
  if (status === null) return "unreachable";
  return status.accepted === true && status.version === TERMS_VERSION ? "clear" : "needed";
}

/** Seconds-scale wait before the next automatic check: 2s, 4s, 8s, 16s, then 30s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt));
}

/** After this many failed checks in a row the screen also says where to accept. */
export const TERMS_HINT_AFTER_FAILURES = 3;

/** The Accept button works only once the box is ticked and nothing is being saved. */
export function canAccept(ticked: boolean, saving: boolean): boolean {
  return ticked && !saving;
}

function isStatus(value: unknown): value is TermsStatus {
  return Boolean(value) && typeof value === "object"
    && typeof (value as TermsStatus).accepted === "boolean" && typeof (value as TermsStatus).version === "string";
}

/** How long the first check may take before it counts as "could not check". */
export const TERMS_REQUEST_TIMEOUT_MS = 10_000;
/** The ceiling the per-attempt deadline climbs to. */
export const TERMS_REQUEST_TIMEOUT_MAX_MS = 60_000;

/** Deadline for the check after `failures` consecutive failed ones: 10s, 20s, 40s, then 60s,
 *  so a slow but valid answer is eventually let through. */
export function termsDeadlineMs(failures: number): number {
  return Math.min(TERMS_REQUEST_TIMEOUT_MAX_MS, TERMS_REQUEST_TIMEOUT_MS * 2 ** Math.max(0, failures));
}

/** Bounds one request: aborts it and rejects when it outlives the deadline,
 *  even if the request ignores the abort signal. An outer signal aborts it too. */
export function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number = TERMS_REQUEST_TIMEOUT_MS, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuter: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timed out")); }, ms);
    if (outer) {
      onOuter = () => { controller.abort(); reject(new Error("aborted")); };
      if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter, { once: true });
    }
  });
  return Promise.race([run(controller.signal), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
    if (outer && onOuter) outer.removeEventListener("abort", onOuter);
  });
}

/** null means "could not check", never "nothing to accept". A stalled check
 *  ends as null after the deadline, so the gate can retry. */
export async function fetchTermsStatus(request: Request, timeoutMs: number = TERMS_REQUEST_TIMEOUT_MS, outer?: AbortSignal): Promise<TermsStatus | null> {
  try {
    const answer = await withDeadline((signal) => request("/api/terms", { signal }), timeoutMs, outer);
    return isStatus(answer) ? answer : null;
  } catch {
    return null;
  }
}

export interface TermsChecker {
  /** Ask now. Coalesces: does nothing while a check is already in flight. Restarts the backoff. */
  retry(): void;
  /** Adopt an answer from elsewhere (acceptance): drop the in-flight check so it cannot overwrite it. */
  settle(status: TermsStatus): void;
  /** Abort the in-flight check and cancel the next one. */
  dispose(): void;
}

/** The check loop, free of React. One request in flight at most; a superseded or
 *  disposed request is aborted and its answer is never delivered. */
export function createTermsChecker(
  request: Request,
  on: { checking(value: boolean): void; status(value: TermsStatus | null): void },
): TermsChecker {
  let inflight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let failures = 0;
  let backoff = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    inflight = null;
  };
  const check = () => {
    if (disposed || inflight) return;
    const mine = new AbortController();
    inflight = mine;
    on.checking(true);
    void fetchTermsStatus(request, termsDeadlineMs(failures), mine.signal).then((answer) => {
      if (disposed || inflight !== mine) return;
      inflight = null;
      on.checking(false);
      on.status(answer);
      if (answer === null) {
        failures += 1;
        timer = setTimeout(() => { timer = undefined; check(); }, retryDelayMs(backoff));
        backoff += 1;
      } else {
        failures = 0;
        backoff = 0;
      }
    });
  };
  check();
  return {
    retry() {
      if (disposed || inflight) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      backoff = 0;
      check();
    },
    settle(status) {
      if (disposed) return;
      cancel();
      failures = 0;
      backoff = 0;
      on.checking(false);
      on.status(status);
    },
    dispose() { disposed = true; cancel(); },
  };
}

/** How long the acceptance POST may take before it counts as stalled. */
export const TERMS_ACCEPT_TIMEOUT_MS = 20_000;

/** A refusal the server gave on purpose (403/404/405): this surface is not
 *  allowed to record the agreement, so trying again here cannot help. */
export class TermsRefusedError extends Error {
  readonly refused = true;
  constructor(message: string) { super(message); this.name = "TermsRefusedError"; }
}

export function isTermsRefusal(error: unknown): boolean {
  if (error instanceof TermsRefusedError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404 || status === 405;
}

/** Throws with the server's words when it refuses, so the screen can say it did not save.
 *  The POST is bounded: when it stalls or the network drops, the acceptance may still
 *  have landed, so the authoritative status is asked before giving up. Only a
 *  status that says "accepted this version" counts as success; otherwise it throws and
 *  the button comes back for a retry. This always settles. */
export async function sendTermsAcceptance(
  request: Request,
  version: string = TERMS_VERSION,
  timeoutMs: number = TERMS_ACCEPT_TIMEOUT_MS,
): Promise<TermsStatus> {
  let answer: unknown;
  try {
    answer = await withDeadline((signal) => request("/api/terms/accept", {
      method: "POST",
      signal,
      body: JSON.stringify({ version, ageConfirmed: true, appVersion: packageVersion }),
    }), timeoutMs);
  } catch (error) {
    if (isTermsRefusal(error)) throw new TermsRefusedError(error instanceof Error ? error.message : "refused");
    const landed = await fetchTermsStatus(request, Math.min(timeoutMs, TERMS_REQUEST_TIMEOUT_MS));
    if (landed && landed.accepted === true && landed.version === version) return landed;
    throw error;
  }
  if (!isStatus(answer) || !answer.accepted) throw new Error("not recorded");
  return answer;
}

/** Seconds-scale wait between checks while the screen is up: 10s, 15s, 22s, then 30s. */
export function watchDelayMs(attempt: number): number {
  return Math.min(30_000, Math.round(10_000 * 1.5 ** Math.max(0, attempt)));
}

/** Least gap between automatic (focus or visibility) checks. The Retry button is exempt. */
export const WATCH_AUTO_MIN_GAP_MS = 5_000;

/** While the terms screen shows, the owner may accept somewhere else (the
 *  desktop, when this surface cannot). Ask again on a slow timer and at once
 *  when the window comes back into view; hand over only a status that says
 *  the current terms are accepted. Returns `recheck` (for a button) and `stop`. */
export function watchTermsAcceptance(
  request: Request,
  onAccepted: (status: TermsStatus) => void,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null = typeof document === "undefined" ? null : document,
  win: Pick<Window, "addEventListener" | "removeEventListener"> | null = typeof window === "undefined" ? null : window,
): { recheck(): void; stop(): void } {
  let stopped = false;
  let busy = false;
  let attempt = 0;
  let lastStart = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void check(); }, watchDelayMs(attempt));
    attempt += 1;
  };
  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    lastStart = Date.now();
    const mine = new AbortController();
    controller = mine;
    const answer = await fetchTermsStatus(request, TERMS_REQUEST_TIMEOUT_MS, mine.signal);
    busy = false;
    if (controller === mine) controller = undefined;
    if (stopped) return;
    if (answer && answer.accepted === true && answer.version === TERMS_VERSION) { stopped = true; onAccepted(answer); return; }
    schedule();
  };
  // Focus and visibility events are throttled across completed requests: at most one
  // automatic check per WATCH_AUTO_MIN_GAP_MS, extra events coalesce into one trailing check.
  const soon = () => {
    if (stopped || doc?.visibilityState === "hidden") return;
    const wait = lastStart + WATCH_AUTO_MIN_GAP_MS - Date.now();
    if (wait <= 0) { attempt = 0; void check(); return; }
    if (trailing) return;
    trailing = setTimeout(() => { trailing = undefined; attempt = 0; void check(); }, wait);
  };
  doc?.addEventListener("visibilitychange", soon);
  win?.addEventListener("focus", soon);
  schedule();
  return {
    recheck() { attempt = 0; void check(); },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (trailing) clearTimeout(trailing);
      trailing = undefined;
      controller?.abort();
      doc?.removeEventListener("visibilitychange", soon);
      win?.removeEventListener("focus", soon);
    },
  };
}

export function useTerms(request: Request) {
  const [status, setStatus] = useState<TermsStatus | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState(0);
  const checker = useRef<TermsChecker | null>(null);
  useEffect(() => {
    const mine = createTermsChecker(request, {
      checking: setChecking,
      status: (value) => { setFailures((count) => (value === null ? count + 1 : 0)); setStatus(value); },
    });
    checker.current = mine;
    return () => { mine.dispose(); if (checker.current === mine) checker.current = null; };
  }, [request]);
  const accept = useCallback(async () => {
    const answer = await sendTermsAcceptance(request);
    if (checker.current) checker.current.settle(answer); else setStatus(answer);
  }, [request]);
  // The screen is up: the owner may accept on the computer instead. Look again on a timer and on return.
  const needed = termsPhase(status) === "needed";
  const watcher = useRef<{ recheck(): void } | null>(null);
  useEffect(() => {
    if (!needed) return;
    const mine = watchTermsAcceptance(request, (answer) => { if (checker.current) checker.current.settle(answer); else setStatus(answer); });
    watcher.current = mine;
    return () => { mine.stop(); if (watcher.current === mine) watcher.current = null; };
  }, [needed, request]);
  const recheck = useCallback(() => { watcher.current?.recheck(); }, []);
  /** The Retry button: ask now (joins a check already running), backoff restarts from the shortest wait. */
  const retry = useCallback(() => { checker.current?.retry(); }, []);
  return { status, phase: termsPhase(status), accept, retry, recheck, checking, failures };
}
