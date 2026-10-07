// The launcher's decisions (spec §3.1): which screen follows each tap, each
// plugin answer and each workspace close. No DOM here: main.ts hands in the
// real plugin and render(), launcher.test.ts a fake of each.
import type { PluginListenerHandle } from "@capacitor/core";

import { parseInvitation, parseTypedPairing, type Pairing } from "./invitation";
import { hostCapabilityOk } from "./host-version";
import { noticeText, showNotice } from "./notice";
import type { FormValues } from "./render";
import {
  firstScreen,
  present,
  screenForClose,
  screenForOpenError,
  screenForRemoveError,
  screenForScanError,
  screenForStateError,
  screenForTailscaleError,
  waitsForTailscale,
  isTailnetOrigin,
  type Action,
  type ActionId,
  type Screen,
  type View,
} from "./screens";
import { TAILSCALE_UNKNOWN, errorCode, readTailscale, type Closed, type MurageShellPlugin, type ShellState, type TailscaleState } from "./shell-types";

/** What a redrawn form keeps of what was typed: the address, never the code. */
export interface Draft {
  address: string;
}

export type Act = (action: Action, form?: FormValues) => void;
/** `keep`: the same screen redrawn in place (resume), so focus and scroll stay where they are. */
export type Draw = (view: View, act: Act, draft?: Draft, keep?: boolean) => void;

export interface Launcher {
  boot(): Promise<void>;
  act(action: Action, form?: FormValues): Promise<void>;
  /**
   * The app came back (from Tailscale, or the store): read state() again and
   * redraw, so what the screen says about Tailscale is current. Nothing while
   * a scan or an open is on its way, and nothing if the read fails. On Get or
   * Turn on Tailscale, with the pairing's credential held, Tailscale coming on
   * pairs again by itself (also every WATCH_MS while that screen shows).
   * A saved unreachable workspace retries once per foreground/network edge.
   */
  resume(): Promise<void>;
  /** Stops listening for closes (the page is going). */
  dispose(): Promise<void>;
  readonly screen: Screen | null;
}

/** Taps that start a scan or an open: ignored while one is on its way (native would answer busy). */
const STARTS: ReadonlySet<ActionId> = new Set(["scan", "connect", "open", "retry"]);
/** Taps that stay in a failed pairing's flow, so Try again still has its credential. */
const IN_FLOW: ReadonlySet<ActionId> = new Set(["retry", "tailscale", "store"]);

/** How often Get and Turn on Tailscale read state() while they show (first-run spec). */
export const WATCH_MS = 2000;

/** The scan's error on the screen it started from; the scan only starts from these. */
function withError(from: Screen | null, error: string): Screen {
  switch (from?.kind) {
    case "welcome":
    case "scan":
    case "pairUnreachable":
    case "type":
    case "list":
    case "unreachable":
    case "repair":
    case "scanner":
      return { ...from, error };
    default:
      return { kind: "type", error };
  }
}

/** `visible`: whether the app is on screen; the Tailscale watch reads nothing while it isn't. */
export function createLauncher(shell: MurageShellPlugin, draw: Draw, now: () => number = Date.now, visible: () => boolean = () => true): Launcher {
  let state: ShellState = { workspaces: [], active: null, closed: null, platform: "ios", tailscale: TAILSCALE_UNKNOWN };
  let screen: Screen | null = null;
  /** Counts paints: an answer that arrives after something else painted doesn't paint over it. */
  let painted = 0;
  /** One scan or open at a time. */
  let inFlight = false;
  /**
   * A failed pairing's credential, for Try again on can't-reach and insecure.
   * Memory only: never in a Screen, a View, the DOM, a log or storage.
   */
  let pending: Pairing | null = null;
  /** A close not yet shown, because the saved list couldn't be read when it came. */
  let unshown: Closed | null = null;
  let closes = 0;
  let listener: PluginListenerHandle | null = null;
  let disposed = false;
  /** A resume() read is on its way; taps still go through (the paint checks guard it). */
  let resuming = false;
  /** What is on screen, to tell whether a resume has anything new to draw. */
  let shown = "";
  /** The Tailscale watch's interval: only while waiting() holds for what is on screen. */
  let watch: ReturnType<typeof setInterval> | null = null;
  /**
   * The Tailscale the diagnosis (pairUnreachable) is drawn from. It only turns
   * to "on" through a real attempt (connect's failure), so the screen never
   * becomes "can't see your computer" without one: a read that sees Tailscale
   * on while Get or Turn on shows pairs again instead (review A2).
   */
  let diagnosed: TailscaleState = TAILSCALE_UNKNOWN;

  /** The Tailscale a screen is drawn with. */
  const drawnWith = (on: Screen): TailscaleState => (on.kind === "pairUnreachable" ? diagnosed : state.tailscale);
  const viewOf = (on: Screen): View => present(on, state.workspaces, now(), drawnWith(on));

  /** Get or Turn on Tailscale is showing for the pairing whose credential is held. */
  const waiting = (on: Screen | null, tailscale: TailscaleState): boolean =>
    on?.kind === "pairUnreachable" && pending?.origin === on.origin && isTailnetOrigin(on.origin) && waitsForTailscale(tailscale);

  function stopWatching(): void {
    if (watch !== null) clearInterval(watch);
    watch = null;
  }

  function show(next: Screen, draft?: Draft, keep = false): void {
    screen = next;
    painted += 1;
    const view = viewOf(next);
    shown = JSON.stringify(view);
    // Every new screen starts the watch afresh, or ends it.
    stopWatching();
    if (!disposed && waiting(next, drawnWith(next))) {
      watch = setInterval(() => {
        if (visible()) void resume();
      }, WATCH_MS);
    }
    draw(view, (action, form) => void act(action, form), draft, keep);
  }

  const home = (): Screen => (state.workspaces.length ? { kind: "list", managing: false } : { kind: "welcome" });

  /** null when state() answered; otherwise the screen for its failure (screenForStateError). */
  async function refresh(): Promise<Screen | null> {
    try {
      const next = await shell.state();
      state = { ...next, tailscale: readTailscale(next.tailscale) };
      return null;
    } catch (error) {
      return screenForStateError(errorCode(error));
    }
  }

  async function onClose(closed: Closed): Promise<void> {
    pending = null;
    unshown = closed;
    const seq = ++closes;
    const failed = await refresh();
    if (seq !== closes) return; // a newer close decides
    if (failed) return show(failed);
    unshown = null;
    show(screenForClose(closed, state.workspaces));
  }

  async function listen(): Promise<void> {
    if (listener || disposed) return;
    const handle = await shell.addListener("workspaceClosed", (closed) => void onClose(closed));
    if (disposed) await handle.remove();
    else listener = handle;
    void shell.addListener("notice", ({ code }) => {
      const text = noticeText(code);
      if (text) showNotice(document.body, text);
    });
  }

  /** Boot, and Try again on the unlock and start-failed screens. */
  async function start(): Promise<void> {
    const mark = painted;
    try {
      // First, so a close native retained for this page is not missed.
      await listen();
    } catch (error) {
      if (painted === mark) show(screenForStateError(errorCode(error)));
      return;
    }
    const failed = await refresh();
    if (painted !== mark) return; // a close came in meanwhile and is showing
    if (failed) return show(failed);
    show(unshown ? screenForClose(unshown, state.workspaces) : firstScreen(state));
    unshown = null;
  }

  async function connect(origin: string, credential?: string): Promise<void> {
    const from = screen;
    const kept = pending;
    inFlight = true;
    pending = credential !== undefined ? { origin, credential } : null;
    show({ kind: "connecting", origin });
    const mark = painted;
    try {
      const result = await shell.open(credential !== undefined ? { origin, credential } : { origin });
      if (!hostCapabilityOk(result.hostCapability)) {
        if (painted === mark) show({ kind: "updateRequired", origin });
        return;
      }
      pending = null;
      // The workspace now covers this page; a close decides what shows here next.
      const failed = await refresh();
      if (painted === mark) show(failed ?? home());
    } catch (error) {
      const next = screenForOpenError(errorCode(error), origin, credential !== undefined);
      if (next === null) {
        // busy: another open is on its way, so the tap changes nothing.
        pending = kept;
        if (painted === mark && from) show(from);
        return;
      }
      if (next.kind !== "accessoff" && next.kind !== "hosterror" && next.kind !== "unreachable" && next.kind !== "insecure" && next.kind !== "pairUnreachable") pending = null;
      // Best effort, for "Last connected"; a failure here must not hide the open's error.
      await refresh();
      if (painted === mark) {
        if (next.kind === "pairUnreachable") diagnosed = state.tailscale; // a real attempt failed with this Tailscale
        show(next);
      }
    } finally {
      inFlight = false;
    }
  }

  async function scan(): Promise<void> {
    // First run (from Get your code ready), and Scan again: the hint and Type the code instead wait behind the camera.
    if (screen?.kind === "getCode" || screen?.kind === "pairUnreachable" || screen?.kind === "scan") show({ kind: "scan" });
    const from = screen;
    const origin = from?.kind === "repair" || from?.kind === "scanner" ? from.origin : undefined;
    inFlight = true;
    let text: string;
    try {
      ({ text } = await shell.scan());
    } catch (error) {
      inFlight = false;
      const next = screenForScanError(errorCode(error), state.platform, origin, from ?? undefined);
      if (next && screen === from) show(next);
      return;
    }
    inFlight = false;
    // Native only answers with a pairing link; if one slips through anyway, say so where the scan began.
    const pairing = parseInvitation(text);
    if ("error" in pairing) return show(withError(from, pairing.error));
    return connect(pairing.origin, pairing.credential);
  }

  async function act(action: Action, form?: FormValues): Promise<void> {
    if (inFlight && STARTS.has(action.id)) return;
    if (!IN_FLOW.has(action.id)) pending = null;
    switch (action.id) {
      case "scan":
        return scan();
      case "type":
        return show({ kind: "type", origin: action.origin });
      case "connect": {
        const pairing = parseTypedPairing(form?.address ?? "", form?.code ?? "");
        if ("error" in pairing) {
          const origin = screen?.kind === "type" ? screen.origin : undefined;
          // Up to any "#": a pasted pairing link's secret never comes back into the field.
          return show({ kind: "type", origin, error: pairing.error }, { address: (form?.address ?? "").split("#")[0]! });
        }
        return connect(pairing.origin, pairing.credential);
      }
      case "open":
        if (action.origin) return connect(action.origin);
        return;
      case "retry": {
        if (!action.origin) return;
        const credential = pending?.origin === action.origin ? pending.credential : undefined;
        return connect(action.origin, credential);
      }
      case "remove": {
        if (!action.origin) return;
        const managing = screen?.kind === "list" && screen.managing;
        try {
          await shell.remove({ origin: action.origin });
        } catch (error) {
          const next = screenForRemoveError(errorCode(error));
          // A list that can't be read now is not shown as a list with an error.
          return show((await refresh()) ?? next);
        }
        const failed = await refresh();
        return show(failed ?? (state.workspaces.length ? { kind: "list", managing } : { kind: "welcome" }));
      }
      case "manage":
        return show({ kind: "list", managing: !(screen?.kind === "list" && screen.managing) });
      case "add":
        return show({ kind: "welcome" });
      case "tailscale":
      case "store": {
        const from = screen;
        try {
          await shell.openTailscale();
        } catch {
          if ((from?.kind === "unreachable" || from?.kind === "pairUnreachable" || from?.kind === "welcome") && screen === from) {
            show(screenForTailscaleError(from, drawnWith(from), state.platform, action.id === "store"));
          }
        }
        return;
      }
      case "getCode":
        return show({ kind: "getCode" });
      case "notYet":
        return show({ kind: "notYet" });
      case "ready":
        return show({ kind: "welcome" });
      case "reload":
        return start();
      case "choose":
      case "back":
        return show(home());
    }
  }

  /** Screens that say something about Tailscale, when a computer last worked, or that Murage was not answering. */
  const REDRAWN: ReadonlySet<Screen["kind"]> = new Set(["welcome", "list", "unreachable", "hosterror", "pairUnreachable"]);

  async function resume(): Promise<void> {
    if (inFlight || resuming || disposed || !visible() || !screen || !REDRAWN.has(screen.kind)) return;
    const from = screen;
    const mark = painted;
    resuming = true;
    try {
      if (await refresh()) return; // a failed read changes nothing here
    } finally {
      resuming = false;
    }
    // state() hands a waiting close over once: never dropped.
    if (disposed || !visible()) return;
    const closed = state.closed;
    if (painted !== mark || screen !== from) {
      // Something newer is showing; the close waits for the next start.
      if (closed) unshown = closed;
      return;
    }
    if (closed) return show(screenForClose(closed, state.workspaces));
    // A saved workspace gets one attempt for this recovery event. No polling.
    if (!inFlight && (from.kind === "unreachable" || from.kind === "hosterror") && state.workspaces.some((w) => w.origin === from.origin)) return connect(from.origin);
    // Tailscale came on while Get or Turn on Tailscale showed: pair again, once, with the held credential.
    if (!inFlight && pending && waiting(from, diagnosed) && state.tailscale.connected === true) return connect(pending.origin, pending.credential);
    // Get Tailscale turning into Turn on (installed, still off) redraws; "on" only ever comes from an attempt.
    if (from.kind === "pairUnreachable" && !(state.tailscale.connected === true && waitsForTailscale(diagnosed))) diagnosed = state.tailscale;
    const next = sameKind(from);
    if (JSON.stringify(viewOf(next)) === shown) {
      screen = next; // nothing new: no redraw, so focus and scroll stay put
      return;
    }
    show(next, undefined, next.kind === from.kind);
  }

  /** The screen resume() redraws: the same one, with its error sentence, unless the list emptied or filled. */
  function sameKind(from: Screen): Screen {
    if (from.kind === "unreachable" || from.kind === "pairUnreachable") return { kind: from.kind, origin: from.origin, ...(from.error ? { error: from.error } : {}) };
    if (state.workspaces.length) {
      return from.kind === "list" ? { kind: "list", managing: from.managing, ...(from.error ? { error: from.error } : {}) } : { kind: "list", managing: false };
    }
    return from.kind === "welcome" && from.error ? { kind: "welcome", error: from.error } : { kind: "welcome" };
  }

  return {
    boot: start,
    act,
    resume,
    async dispose() {
      disposed = true;
      stopWatching();
      const handle = listener;
      listener = null;
      await handle?.remove();
    },
    get screen() {
      return screen;
    },
  };
}
