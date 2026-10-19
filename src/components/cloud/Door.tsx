// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud home door. Wraps the app on a Cloud home (the server tells the page it is one with a murage-home-id meta tag):
// a browser that holds this home's device key signs in with it; "/enter#t=" spends a one-time link made for that key; a browser
// with no sign-in goes back to murage.ai, which mints a link for its key. No sign-in form exists, so there is nothing here to type a password into.
import { useEffect, useState, type ReactNode } from "react";
import { StorageBlocked, StorageRefused, bindOf, bounceUrl, doorCopy, enterWithTicket, ensureDevice, homeMeta, refreshSession, reportDoorProblem, ticketFromHash, type EnterResult, type StoredDevice } from "@/lib/cloud-door";

export type DoorState = { kind: "working"; text: string } | { kind: "app" } | { kind: "message"; text: string } | { kind: "openFromSite"; button: boolean }
  /** Another tab of this home holds the key store; "Try again" runs the door once more. */
  | { kind: "blocked" };

const ENTER_TEXT: Record<Exclude<EnterResult, "signed-in">, string> = {
  expired: doorCopy.expired, "too-many": doorCopy.tooManyBrowsers, hold: doorCopy.computerConnected, failed: doorCopy.badLink,
};
// A site origin the bounce would accept, judged without a key (the key's hash is only known after ensureDevice).
const PLACEHOLDER_BIND = "0".repeat(64);

/** What the door reads and does. The component passes the real page and the real cloud-door functions; tests pass fakes. */
export interface DoorEnv {
  meta: { homeId: string | null; siteOrigin: string | null };
  pathname: string;
  hash: string;
  replaceHistory(path: string): void;
  /** Leaves the page for the site (location.replace). */
  bounce(url: string): void;
  enterWithTicket(ticket: string): Promise<EnterResult>;
  ensureDevice(): Promise<Pick<StoredDevice, "deviceId" | "publicKey">>;
  bindOf(device: Pick<StoredDevice, "publicKey">): Promise<string>;
  refreshSession(): Promise<boolean>;
  report: typeof reportDoorProblem;
}

/**
 * One pass of the door. Returns the screen to show, or null after it bounced to the site.
 * Only "/enter" (the path every Open Murage press uses) ever leaves the origin by itself; any other path offers the way back.
 */
export async function runDoor(env: DoorEnv): Promise<DoorState | null> {
  try { return await runDoorSteps(env); } catch (error) {
    const storage = storageState(error);
    if (storage) return storage;
    throw error;
  }
}
/** The screen for a key store that would not open or answer (already reported by cloud-door), or null for any other error. */
function storageState(error: unknown): DoorState | null {
  if (error instanceof StorageBlocked) return { kind: "blocked" };
  if (error instanceof StorageRefused) return { kind: "message", text: doorCopy.storage };
  return null;
}
async function runDoorSteps(env: DoorEnv): Promise<DoorState | null> {
  // A key store that does not open is the storage screen (rethrown to runDoor), not a failed refresh.
  const refreshed = () => env.refreshSession().catch((error: unknown) => { if (error instanceof StorageRefused) throw error; env.report("refresh", error); return false; });
  if (env.pathname === "/enter") {
    const ticket = ticketFromHash(env.hash);
    const hadFragment = env.hash.length > 0;
    // The ticket leaves the address bar before anything else happens.
    env.replaceHistory("/enter");
    if (ticket) {
      let result: EnterResult;
      try { result = await env.enterWithTicket(ticket); } catch (error) {
        const storage = storageState(error);
        if (storage) return storage;
        env.report("unexpected", error); result = "failed";
      }
      if (result === "signed-in") { env.replaceHistory("/"); return { kind: "app" }; }
      return { kind: "message", text: ENTER_TEXT[result] };
    }
    if (hadFragment) { env.report("no_ticket"); return { kind: "message", text: doorCopy.badLink }; }
    let device;
    try { device = await env.ensureDevice(); } catch (error) {
      const storage = storageState(error);
      if (storage) return storage;
      env.report("unexpected", error); return { kind: "message", text: doorCopy.badLink };
    }
    if (device.deviceId && await refreshed()) return { kind: "app" };
    const target = bounceUrl(env.meta.siteOrigin, env.meta.homeId, await env.bindOf(device));
    if (!target) { env.report("bounce"); return { kind: "openFromSite", button: false }; }
    env.bounce(target);
    return null;
  }
  // Any other path: never leave the origin on our own; a browser without a sign-in is offered the way back.
  if (await refreshed()) return { kind: "app" };
  return { kind: "openFromSite", button: bounceUrl(env.meta.siteOrigin, env.meta.homeId, PLACEHOLDER_BIND) !== null };
}

/** The door's own screen (everything but the app). */
export function CloudDoorView({ state, onGo, onRetry }: { state: Exclude<DoorState, { kind: "app" }>; onGo(): void; onRetry?(): void }) {
  const text = state.kind === "openFromSite" ? doorCopy.openFromSite : state.kind === "blocked" ? doorCopy.tabOpen : state.text;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center text-ink" aria-live="polite" data-murage-door={state.kind === "openFromSite" ? "continue" : state.kind}>
      <p className="text-[15px]">{text}</p>
      {state.kind === "openFromSite" && state.button ? <button type="button" className="rounded-md bg-control px-4 py-2 text-[14px] font-medium hover:bg-inset" onClick={onGo}>{doorCopy.goButton}</button> : null}
      {state.kind === "blocked" ? <button type="button" className="rounded-md bg-control px-4 py-2 text-[14px] font-medium hover:bg-inset" onClick={onRetry}>{doorCopy.tryAgain}</button> : null}
    </main>
  );
}

export function CloudDoor({ children }: { children: ReactNode }) {
  const meta = homeMeta(document);
  const [state, setState] = useState<DoorState>({ kind: "working", text: doorCopy.opening });
  // Bumped by "Try again": the door runs once more from the start.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // A stable mark that the bundle loaded and React mounted; the home's own render check keys on it.
    document.documentElement.dataset.murageMounted = "1";
    let alive = true;
    const set = (next: DoorState | null) => { if (alive && next) setState(next); };
    runDoor({
      meta, pathname: location.pathname, hash: location.hash,
      replaceHistory: (path) => history.replaceState(null, "", path),
      bounce: (url) => location.replace(url),
      enterWithTicket, ensureDevice, bindOf, refreshSession, report: reportDoorProblem,
    }).then(set, (error: unknown) => { reportDoorProblem("unexpected", error); set({ kind: "message", text: doorCopy.badLink }); });
    return () => { alive = false; };
  }, [attempt]);
  useEffect(() => {
    const refreshed = () => refreshSession().catch((error: unknown) => { reportDoorProblem("refresh", error); return false; });
    // The cookie lasts 15 minutes; this device key renews it while the page is open.
    const timer = setInterval(() => { void refreshed(); }, 12 * 60_000);
    return () => { clearInterval(timer); };
  }, []);
  if (state.kind === "app") return <>{children}</>;
  const goToSite = async () => {
    try {
      const target = bounceUrl(meta.siteOrigin, meta.homeId, await bindOf(await ensureDevice()));
      if (target) location.assign(target); else reportDoorProblem("bounce");
    } catch (error) {
      const storage = storageState(error);
      if (storage) return setState(storage);
      reportDoorProblem("unexpected", error);
    }
  };
  const retry = () => { setState({ kind: "working", text: doorCopy.opening }); setAttempt(n => n + 1); };
  return <CloudDoorView state={state} onGo={() => { void goToSite(); }} onRetry={retry} />;
}
