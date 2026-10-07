// The launcher's screens and their words (spec §3.1, §7; first run:
// 2026-09-27-mobile-first-run-design.md). Pure: main.ts decides which screen,
// render.ts draws the View.
import shot from "./assets/desktop-phone-shot.json";
import shotDark from "./assets/desktop-phone-dark.webp";
import shotLight from "./assets/desktop-phone-light.webp";
import { COPY } from "./invitation";
import { TAILSCALE_UNKNOWN, type Closed, type SavedWorkspace, type ShellState, type TailscaleState } from "./shell-types";

export type Screen =
  /** With no saved computers, first run's welcome; otherwise the way to add another computer. */
  | { kind: "welcome"; error?: string }
  /** First run's "Not yet": Murage isn't running on the computer yet. */
  | { kind: "notYet" }
  /** Before the camera: where the code is on the computer, with a picture of it (Android's scanner covers everything). */
  | { kind: "getCode" }
  /** Behind the camera, and where closing it lands: the hint, and typing instead. */
  | { kind: "scan"; error?: string }
  | { kind: "type"; origin?: string; error?: string }
  | { kind: "list"; managing: boolean; error?: string }
  | { kind: "connecting"; origin: string }
  | { kind: "updateRequired"; origin: string }
  | { kind: "unreachable"; origin: string; error?: string }
  /** A pairing (scanned or typed) that couldn't reach its computer; what to fix depends on Tailscale. */
  | { kind: "pairUnreachable"; origin: string; error?: string }
  | { kind: "insecure"; origin: string }
  | { kind: "accessoff"; origin: string }
  | { kind: "hosterror"; origin: string }
  | { kind: "repair"; origin: string; error?: string }
  /** The saved list can't be read (a locked phone, P14): never shown as empty. */
  | { kind: "unreadable" }
  /** state() failed some other way. */
  | { kind: "startFailed" }
  /** `error`: a scan that wasn't a pairing code, said where the scan started. */
  | { kind: "scanner"; problem: ScannerProblem; origin?: string; error?: string };

/**
 * gettingReady: Android's `unavailable`, while Google's scanner module downloads.
 * cameraDenied: iOS `camera_denied`; the plugin has no call into Settings.
 * notAvailable: Android's `unavailable` again, right after gettingReady: stop promising.
 * noCamera: iOS `unavailable`, or a code the launcher doesn't know.
 */
export type ScannerProblem = "gettingReady" | "notAvailable" | "cameraDenied" | "noCamera";

export type ActionId =
  | "scan"
  | "type"
  | "connect"
  | "back"
  | "open"
  | "remove"
  | "manage"
  | "add"
  | "retry"
  | "tailscale"
  | "choose"
  | "reload"
  | "notYet"
  | "ready"
  /** Welcome's "Yes, let's connect": Get your code ready, before the camera. */
  | "getCode"
  /** "I don't have Tailscale yet": openTailscale() too, but its failure names the store. */
  | "store";

export interface Action {
  id: ActionId;
  label: string;
  primary?: boolean;
  danger?: boolean;
  origin?: string;
}

export interface Row {
  origin: string;
  name: string;
  detail: string;
  actions: Action[];
}

/** The scanner's hint: under the iPhone's camera (QRScannerViewController.swift), and behind Android's. */
export const SCAN_HINT = "On your computer, open Murage, then Settings, then Phone and other devices. Point your camera at the code.";

/** Get your code ready: the page's name is the desktop's (CompanionSection.tsx; desktop-shot.test.ts checks). */
export const GET_CODE_BODY = "On your computer, open Murage, then Settings, then Phone and other devices. Turn it on and a code appears.";
/** What the picture shows, for a screen reader. */
export const GET_CODE_ALT =
  "Murage on a computer, at Settings, then Phone and other devices. The Turn on switch is on and circled at the top. Below it, the Sign in on another device card shows a QR code and a six-digit code, circled too.";

export interface ViewImage {
  light: string;
  dark: string;
  alt: string;
  width: number;
  height: number;
}

export interface View {
  title: string;
  lines: string[];
  actions: Action[];
  rows: Row[];
  form?: { origin?: string };
  error?: string;
  busy?: boolean;
  /** The Murage mark above the title (first run's welcome). */
  mark?: boolean;
  /** A picture under the lines (Get your code ready): light and dark, bundled with the launcher. */
  image?: ViewImage;
  /** firstRun: the text in the upper middle, the buttons at the bottom within thumb reach. */
  layout?: "firstRun";
  /** First run's progress, of 4: welcome 1, get your code ready 2, scan 3, connecting and what follows 4. */
  step?: 1 | 2 | 3 | 4;
}

const home = (workspaces: SavedWorkspace[]): Screen => (workspaces.length ? { kind: "list", managing: false } : { kind: "welcome" });

export function firstScreen(state: ShellState): Screen {
  return state.closed ? screenForClose(state.closed, state.workspaces) : home(state.workspaces);
}

export function screenForClose(closed: Closed, workspaces: SavedWorkspace[]): Screen {
  switch (closed.reason) {
    case "accessoff":
    case "hosterror":
      return { kind: closed.reason, origin: closed.origin };
    case "unreachable":
      return { kind: "unreachable", origin: closed.origin };
    case "insecure":
      return { kind: "insecure", origin: closed.origin };
    case "updateRequired":
      return { kind: "updateRequired", origin: closed.origin };
    case "signedOut":
      return { kind: "repair", origin: closed.origin };
    default:
      return home(workspaces);
  }
}

/** null: `busy`, another open is already on its way, so nothing changes. */
export function screenForOpenError(code: string | undefined, origin: string, pairing: boolean): Screen | null {
  if (code === "busy") return null;
  if (code === "accessoff" || code === "hosterror") return { kind: code, origin };
  if (code === "unreachable") return pairing ? { kind: "pairUnreachable", origin } : { kind: "unreachable", origin };
  if (code === "insecure") return { kind: "insecure", origin };
  if (code === "bad_credential") return { kind: "type", origin, error: COPY.badCode };
  if (code === "unreadable") return { kind: "unreadable" };
  if (code === "bad_origin" && pairing) return { kind: "type", origin, error: COPY.badAddress };
  if (pairing) return { kind: "type", origin, error: "Murage couldn't open that. Try again." };
  return { kind: "list", managing: false, error: "Murage couldn't open that computer. Try again." };
}

/** For state() failing: at boot, or the Try again on these same screens. */
export function screenForStateError(code: string | undefined): Screen {
  return code === "unreadable" ? { kind: "unreadable" } : { kind: "startFailed" };
}

/**
 * null: `cancelled`, the person closed the scanner, so the screen stays as it was.
 * `current` is the screen the scan was started from: a second Android
 * `unavailable` in a row (Try again on "getting ready") says it isn't available.
 */
export function screenForScanError(code: string | undefined, platform: ShellState["platform"], origin?: string, current?: Screen): Screen | null {
  if (code === "cancelled") return null;
  const again = current?.kind === "scanner" && (current.problem === "gettingReady" || current.problem === "notAvailable");
  const problem: ScannerProblem =
    code === "camera_denied" ? "cameraDenied" : code === "unavailable" && platform === "android" ? (again ? "notAvailable" : "gettingReady") : "noCamera";
  return origin ? { kind: "scanner", problem, origin } : { kind: "scanner", problem };
}

/** remove() only runs from the list, which has at least the computer being removed. */
export function screenForRemoveError(code: string | undefined): Screen {
  if (code === "unreadable") return { kind: "unreadable" };
  return { kind: "list", managing: false, error: "Murage couldn't remove that computer. Try again." };
}

/** Tailscale isn't on this phone (TailscaleState.installed). */
const missing = (tailscale: TailscaleState) => tailscale.connected !== true && tailscale.installed === false;
/** Installed, or unknown, and plainly off: no Tailscale address on the phone. */
const off = (tailscale: TailscaleState) => !missing(tailscale) && tailscale.connected === false;

/**
 * What a pairing that couldn't reach its computer asks for. null: Tailscale
 * unknown, so the can't-reach screen's general wording.
 */
export function isTailnetOrigin(origin: string): boolean {
  try { return new URL(origin).hostname.toLowerCase().endsWith(".ts.net"); }
  catch { return false; }
}

function tailscaleStep(tailscale: TailscaleState): "get" | "turnOn" | "cantSee" | null {
  if (missing(tailscale)) return "get";
  if (tailscale.connected === false) return "turnOn";
  if (tailscale.connected === true) return "cantSee";
  return null;
}

/** Get Tailscale and Turn on Tailscale: the launcher watches for it to come on, then pairs again by itself. */
export function waitsForTailscale(tailscale: TailscaleState): boolean {
  const step = tailscaleStep(tailscale);
  return step === "get" || step === "turnOn";
}

/**
 * openTailscale() only rejects `unavailable`; the screen the tap came from
 * (can't-reach or welcome) stays, with a sentence. When Tailscale is missing
 * the tap went to the store, so the sentence names the store.
 */
export function screenForTailscaleError<S extends Screen>(from: S, tailscale: TailscaleState, platform: ShellState["platform"], store = false): S {
  const error = store || missing(tailscale)
    ? `Murage couldn't open ${platform === "ios" ? "the App Store" : "Google Play"}. Get Tailscale there, then try again.`
    : "Murage couldn't open Tailscale. Open it from your home screen, then try again.";
  return { ...from, error };
}

export function lastConnectedText(now: number, then: number | undefined): string {
  if (!then) return "Never connected from this phone";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "Last connected just now";
  if (minutes < 60) return `Last connected ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Last connected ${hours} h ago`;
  return `Last connected ${Math.floor(hours / 24)} days ago`;
}

export function nameOf(origin: string, workspaces: SavedWorkspace[]): string {
  const saved = workspaces.find((w) => w.origin === origin);
  if (saved) return saved.name;
  try {
    return new URL(origin).hostname.split(".")[0] || origin;
  } catch {
    return origin;
  }
}

export function present(screen: Screen, workspaces: SavedWorkspace[], now: number, tailscale: TailscaleState = TAILSCALE_UNKNOWN): View {
  const view: View = { title: "", lines: [], actions: [], rows: [] };
  /** First run's layout; the step only while there are no saved computers (adding another isn't first run). */
  const firstRun = (step: 1 | 2 | 3 | 4): Pick<View, "layout" | "step"> => (workspaces.length ? { layout: "firstRun" } : { layout: "firstRun", step });
  switch (screen.kind) {
    case "updateRequired":
      return {
        ...view,
        title: "Update Murage on your computer",
        lines: ["Update Murage on your computer to use the phone app. On your computer, open Murage and choose Murage > Check for updates."],
        actions: [{ id: "retry", label: "Try again", primary: true, origin: screen.origin }],
      };
    case "welcome": {
      if (!workspaces.length) {
        return {
          ...view,
          title: "Murage on your phone",
          lines: [
            "Talk to your team from anywhere. First, is Murage running on your computer?",
            ...(missing(tailscale) ? ["If your computer uses Tailscale, get it on this phone first."] : []),
          ],
          actions: [
            { id: "getCode", label: "Yes, let's connect", primary: true },
            { id: "notYet", label: "Not yet" },
          ],
          error: screen.error,
          mark: true,
          ...firstRun(1),
        };
      }
      return {
        ...view,
        title: "Murage on your phone",
        lines: [
          "Use the Murage on your computer from here. Your team keeps working on the computer; this phone is the remote control.",
          "On your computer, open Murage, then Settings, then Phone and other devices to show the pairing code.",
        ],
        actions: [
          { id: "scan", label: "Scan the code", primary: true },
          { id: "type", label: "Type the address instead" },
        ],
        error: screen.error,
      };
    }
    case "notYet":
      return {
        ...view,
        title: "Set up Murage on your computer first",
        lines: ["When it's running, come back here."],
        actions: [{ id: "ready", label: "It's running now", primary: true }],
        ...firstRun(1),
      };
    case "getCode":
      return {
        ...view,
        title: "Get your code ready",
        lines: [GET_CODE_BODY],
        image: { light: shotLight, dark: shotDark, alt: GET_CODE_ALT, width: shot.width, height: shot.height },
        actions: [
          { id: "scan", label: "I see the code, scan it", primary: true },
          { id: "type", label: "Type the code instead" },
        ],
        error: undefined,
        ...firstRun(2),
      };
    case "scan":
      return {
        ...view,
        title: "Scan the code on your computer",
        lines: [SCAN_HINT],
        actions: [
          { id: "scan", label: "Scan the code", primary: true },
          { id: "type", label: "Type the code instead" },
          { id: "back", label: "Back" },
        ],
        error: screen.error,
        ...firstRun(3),
      };
    case "type":
      return {
        ...view,
        title: "Type the address and code",
        lines: ["Both are on your computer: open Murage, then Settings, then Phone and other devices."],
        form: { origin: screen.origin },
        actions: [
          { id: "connect", label: "Connect", primary: true },
          { id: "back", label: "Back" },
        ],
        error: screen.error,
      };
    case "list":
      return {
        ...view,
        title: "Your computers",
        rows: workspaces.map((w) => ({
          origin: w.origin,
          name: w.name,
          detail: lastConnectedText(now, w.lastConnected),
          actions: screen.managing
            ? [{ id: "remove", label: "Remove", danger: true, origin: w.origin }]
            : [{ id: "open", label: `Open ${w.name}`, origin: w.origin }],
        })),
        actions: [
          { id: "add", label: "Add another computer" },
          { id: "manage", label: screen.managing ? "Done" : "Edit" },
        ],
        error: screen.error,
      };
    case "connecting": {
      const saved = workspaces.some((w) => w.origin === screen.origin);
      if (saved) return { ...view, title: `Connecting to ${nameOf(screen.origin, workspaces)}…`, busy: true };
      return { ...view, title: "Connecting to your computer…", busy: true, ...firstRun(4) };
    }
    case "pairUnreachable": {
      const error = screen.error;
      const scanAgain: Action = { id: "scan", label: "Scan again" };
      switch (isTailnetOrigin(screen.origin) ? tailscaleStep(tailscale) : null) {
        case "get":
          return {
            ...view,
            title: "Get Tailscale",
            lines: ["Your phone needs Tailscale to reach your computer. Get it, sign in with the same account as your computer, then come back."],
            actions: [{ id: "tailscale", label: "Get Tailscale", primary: true }, scanAgain],
            error,
            ...firstRun(4),
          };
        case "turnOn":
          return {
            ...view,
            title: "Turn on Tailscale",
            lines: ["Your phone reaches your computer through Tailscale."],
            actions: [
              { id: "tailscale", label: "Open Tailscale", primary: true },
              // iPhone can't tell a missing Tailscale from one that's off; openTailscale() goes to the App Store when it can't open it.
              ...(tailscale.installed === null ? [{ id: "store" as const, label: "I don't have Tailscale yet" }] : []),
              scanAgain,
            ],
            error,
            ...firstRun(4),
          };
        case "cantSee":
          return {
            ...view,
            title: "Your phone can't see your computer",
            lines: [
              "Check that Tailscale on your phone is signed in to the same account as your computer (it's shown on your computer under Settings, then Phone and other devices), and that your computer is awake.",
            ],
            actions: [
              { id: "retry", label: "Try again", primary: true, origin: screen.origin },
              scanAgain,
            ],
            error,
            ...firstRun(4),
          };
        case null: {
          const plain = present({ kind: "unreachable", origin: screen.origin, ...(error ? { error } : {}) }, workspaces, now, tailscale);
          // First run has no computers to go back to: Scan again instead of Your computers.
          return workspaces.length ? plain : { ...plain, actions: plain.actions.map((a) => (a.id === "choose" ? scanAgain : a)) };
        }
      }
    }
    case "unreachable": {
      const saved = workspaces.find((w) => w.origin === screen.origin);
      const title = `Can't reach ${nameOf(screen.origin, workspaces)}`;
      const last = lastConnectedText(now, saved?.lastConnected);
      const retry: Action = { id: "retry", label: "Try again", origin: screen.origin };
      const choose: Action = { id: "choose", label: "Your computers" };
      // Known to be missing or off: say which, and lead with the way to fix it.
      if (isTailnetOrigin(screen.origin) && (missing(tailscale) || off(tailscale))) {
        return {
          ...view,
          title,
          lines: [
            missing(tailscale)
              ? "This phone needs Tailscale to reach your computer. Install it, then try again."
              : "Tailscale is off on this phone. Turn it on, then try again.",
            last,
          ],
          actions: [{ id: "tailscale", label: missing(tailscale) ? "Get Tailscale" : "Open Tailscale", primary: true }, retry, choose],
          error: screen.error,
        };
      }
      return {
        ...view,
        title,
        lines: [
          ...(isTailnetOrigin(screen.origin) ? ["Check that Tailscale is on and signed in to the same account on your phone and computer."] : ["Connect your phone and computer to the network that serves this address, then try again."]),
          "Your computer may be asleep. Wake it, then try again.",
          last,
        ],
        actions: [{ ...retry, primary: true }, ...(isTailnetOrigin(screen.origin) ? [{ id: "tailscale" as const, label: "Open Tailscale" }] : []), choose],
        error: screen.error,
      };
    }
    case "accessoff":
      return {
        ...view,
        title: "Turn on phone access",
        lines: ["Your computer answered. On your computer, open Murage, then Settings, then Phone and other devices, and choose Turn on. Then try again."],
        actions: [{ id: "retry", label: "Try again", primary: true, origin: screen.origin }, { id: "choose", label: "Your computers" }],
      };
    case "hosterror":
      return {
        ...view,
        title: "Open Murage on your computer",
        lines: ["Murage on your computer isn't answering yet. Wake your computer, open Murage and check Phone and other devices in Settings. Then try again."],
        actions: [{ id: "retry", label: "Try again", primary: true, origin: screen.origin }, { id: "choose", label: "Your computers" }],
      };
    case "insecure":
      return {
        ...view,
        title: "Check this computer's HTTPS connection",
        lines: [
          "Murage uses HTTPS with a verified certificate to connect to your computer. Check that the certificate for this address is current and trusted by your phone.",
          "On your computer, open Murage, then Settings, then Phone and other devices, and follow the steps to turn on HTTPS. Then try again.",
        ],
        actions: [
          { id: "retry", label: "Try again", primary: true, origin: screen.origin },
          { id: "choose", label: "Back" },
        ],
      };
    case "repair":
      return {
        ...view,
        title: "Scan the code on your computer again",
        lines: [
          `This phone was signed out of ${nameOf(screen.origin, workspaces)}.`,
          "On your computer, open Murage, then Settings, then Phone and other devices. Then scan the code with the button below.",
        ],
        actions: [
          { id: "scan", label: "Scan the code", primary: true },
          { id: "type", label: "Type the code instead", origin: screen.origin },
          { id: "remove", label: "Remove this computer", danger: true, origin: screen.origin },
        ],
        error: screen.error,
      };
    case "unreadable":
      return {
        ...view,
        title: "Unlock your phone and try again",
        lines: [
          "Murage keeps your computers in this phone's protected storage, and can't read it while the phone is locked.",
          "Unlock your phone, then tap Try again.",
        ],
        actions: [{ id: "reload", label: "Try again", primary: true }],
      };
    case "startFailed":
      return {
        ...view,
        title: "Murage couldn't load your computers",
        lines: ["Try again. If it keeps happening, close Murage and open it again."],
        actions: [{ id: "reload", label: "Try again", primary: true }],
      };
    case "scanner":
      return { ...view, ...scannerWords(screen.problem, screen.origin), error: screen.error };
  }
}

function scannerWords(problem: ScannerProblem, origin: string | undefined): Pick<View, "title" | "lines" | "actions"> {
  const type: Action = { id: "type", label: "Type the address instead", ...(origin ? { origin } : {}) };
  const back: Action = { id: "back", label: "Back" };
  switch (problem) {
    case "gettingReady":
      return {
        title: "The scanner is getting ready",
        lines: ["Try again in a moment, or type the address and code from your computer instead."],
        actions: [{ id: "scan", label: "Try again", primary: true }, type, back],
      };
    case "cameraDenied":
      return {
        title: "Murage can't use the camera",
        lines: ["To scan the code, open the Settings app, then Murage, and turn on Camera. Then try again.", "Or type the address and code from your computer instead."],
        actions: [{ id: "scan", label: "Try again", primary: true }, type, back],
      };
    case "notAvailable":
      return {
        title: "The scanner isn't available",
        lines: ["The scanner isn't available. Type the address instead.", "Both the address and the code are on your computer: open Murage, then Settings, then Phone and other devices."],
        actions: [{ ...type, primary: true }, back],
      };
    case "noCamera":
      return {
        title: "The camera isn't available",
        lines: ["Type the address and code from your computer instead. Both are in Murage, under Settings, then Phone and other devices."],
        actions: [{ ...type, primary: true }, back],
      };
  }
}
