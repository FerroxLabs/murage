// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One reader of /api/health for everything that shows the later memory work (the strip, the detail and the reclaim offer in Memory settings, the
// mode line). It owns no rules: it feeds each look to the app family of the reducer (shared/upgrade-machine.mjs) and asks the reducer when to
// look again. It polls only while someone is listening; the reducer says when polling may stop (idle, on a known launch, no storage conversion
// running) and what wakes it again: the shell's server lifecycle notice, the live-events stream opening, the window coming back into view, a new
// listener. There is one request in flight at most and one timer at most; an answer to a question asked before one already used is dropped.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { localeVersion, subscribeLocale } from "@/lib/i18n";
import { api } from "@/state/store";
import { parseUpgradeState } from "../../shared/upgrade-contract.mjs";
import { initialContext, reduce, selectPoll, selectReclaim, selectStrip, type MachineContext, type MachineEvent } from "../../shared/upgrade-machine.mjs";
import { detailView, stripView, type StripView } from "./memory-integrity-view";
import { onMemoryWake, requestMemoryWake, type WakeKind } from "./memory-integrity-wake";

export interface FeedDeps {
  /** One look at /api/health; rejects when the server cannot be reached. */
  read: () => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  hidden?: () => boolean;
}

/** What a listener cares about: when it does not change, nobody is told. */
function fingerprint(ctx: MachineContext): string {
  return JSON.stringify([selectStrip(ctx), ctx.mode, ctx.held, ctx.capture, ctx.recall, ctx.storedMode, selectReclaim(ctx)]);
}

/** The waits between looks that failed after a wake: 2 s, doubling to a minute. */
const RETRY_FIRST_MS = 2000, RETRY_MAX_MS = 60_000;

export function createIntegrityFeed(deps: FeedDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const listeners = new Set<(ctx: MachineContext) => void>();
  let ctx = initialContext("app");
  let shown = fingerprint(ctx);
  let timer: unknown = null;
  let inflight = false;
  let stopped = false;
  let wakeAgain = false;
  let asked = 0, applied = 0;
  // after a wake the poller does not rest until a fresh good reading has settled the current server: a failed or unreadable look is tried again, with growing waits
  let settling = false, retries = 0;

  const dispatch = (event: MachineEvent) => {
    ctx = reduce(ctx, event);
    const next = fingerprint(ctx);
    if (next !== shown) { shown = next; for (const listener of listeners) listener(ctx); }
  };
  const schedule = (ms: number) => { if (timer !== null) clearTimer(timer); timer = setTimer(() => { timer = null; void poll(); }, ms); };

  async function poll(): Promise<void> {
    if (inflight || listeners.size === 0) return;
    inflight = true;
    const ticket = ++asked;
    let body: unknown = null, failed = false;
    try { body = await deps.read(); } catch { failed = true; } finally { inflight = false; }
    if (listeners.size === 0) return;
    // an answer to a question asked before one already used is older news
    if (ticket < applied) { if (!stopped) schedule(selectPoll(ctx, { hidden: hidden() }).intervalMs); return; }
    applied = ticket;
    const at = now();
    let good = false;
    if (failed || body === null || typeof body !== "object") dispatch({ type: "READ_FAILED", at });
    else if ((body as { upgrade?: unknown }).upgrade === undefined) {
      // a server that predates the contract: its old fields say only whether work is pending, which is enough for an indeterminate strip
      const old = ((body as { memoryIntegrity?: unknown }).memoryIntegrity ?? body) as { pending?: unknown; integrityPending?: unknown };
      dispatch({ type: "MALFORMED", at, reason: "legacy", pending: old.pending === true || old.integrityPending === true });
      good = true;
    } else {
      const parsed = parseUpgradeState((body as { upgrade?: unknown }).upgrade);
      if (parsed.ok) { dispatch({ type: "READING", at, state: parsed.state }); good = true; }
      else dispatch({ type: "MALFORMED", at, reason: parsed.reason });
    }
    if (good) { settling = false; retries = 0; }
    // the "finished" notice goes by itself after its time
    dispatch({ type: "TICK", at });
    if (ctx.pollNow) dispatch({ type: "POLL_STARTED" });
    const plan = selectPoll(ctx, { hidden: hidden() });
    if (wakeAgain) { wakeAgain = false; stopped = false; schedule(0); return; }
    if (!plan.active && settling) { stopped = false; schedule(Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(retries++, 6))); return; }
    if (!plan.active) { stopped = true; return; }
    stopped = false;
    schedule(plan.intervalMs);
  }

  /** Looks again now, whatever the reducer last said about polling (a lifecycle notice, a reconnect, the window coming back, a new listener). One timer at most. */
  const wake = (kind: WakeKind = "VISIBLE") => {
    if (listeners.size === 0) return;
    dispatch({ type: kind, at: now() });
    settling = true; retries = 0;
    if (inflight) { wakeAgain = true; return; }
    stopped = false;
    dispatch({ type: "POLL_STARTED" });
    schedule(0);
  };
  const subscribe = (listener: (ctx: MachineContext) => void): (() => void) => {
    listeners.add(listener);
    wake("VISIBLE");
    return () => { listeners.delete(listener); if (listeners.size === 0 && timer !== null) { clearTimer(timer); timer = null; } };
  };
  return {
    subscribe, wake, poll,
    context: () => ctx,
    /** For tests: where the feed stands. */
    state: () => ({ inflight, stopped, timer: timer !== null, listeners: listeners.size, launch: ctx.launch, mode: ctx.mode }),
  };
}

const feed = createIntegrityFeed({ read: () => api("/api/health") });
onMemoryWake(kind => feed.wake(kind));
if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", () => { if (document.visibilityState === "visible") requestMemoryWake("VISIBLE"); });
if (typeof window !== "undefined") {
  // the shell restarted (or restored) the server without reloading this page: look again, even if polling had stopped
  try { window.muragebox?.onServerLifecycle?.((state: { state: string }) => { if (state.state === "running" || state.state === "restarting") requestMemoryWake("LIFECYCLE"); }); } catch { /* no bridge: a browser or companion */ }
}

/** The reducer's context for the app, kept fresh while a component is mounted. */
export function useUpgradeContext(): MachineContext {
  const [ctx, setCtx] = useState<MachineContext>(feed.context());
  useEffect(() => feed.subscribe(setCtx), []);
  return ctx;
}
/** Moves when the app's language does: the words of a view are made again then, even though nothing about the upgrade changed. */
export function useLocaleVersion(): number { return useSyncExternalStore(subscribeLocale, localeVersion, localeVersion); }
/** The current strip view, or null when there is nothing to say. */
export function useMemoryIntegrity(): StripView | null {
  const ctx = useUpgradeContext();
  const language = useLocaleVersion();
  return useMemo(() => stripView(ctx), [ctx, language]);
}
/** The detail rows for Memory settings. */
export function useMemoryDetail(): StripView | null {
  const ctx = useUpgradeContext();
  const language = useLocaleVersion();
  return useMemo(() => detailView(ctx), [ctx, language]);
}
