import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COPY } from "./invitation";
import { CLOSE_REASONS, SHELL_ERRORS, TAILSCALE_UNKNOWN, errorCode, readTailscale, type SavedWorkspace, type ShellState, type TailscaleState } from "./shell-types";
import {
  firstScreen,
  lastConnectedText,
  present,
  screenForClose,
  screenForOpenError,
  screenForRemoveError,
  screenForScanError,
  screenForStateError,
  screenForTailscaleError,
  GET_CODE_ALT,
  GET_CODE_BODY,
  SCAN_HINT,
  waitsForTailscale,
  type Screen,
} from "./screens";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MAC: SavedWorkspace = { origin: "https://mac.tailnet123.ts.net", name: "Sean's Mac", lastConnected: NOW - 7 * 60_000 };
const SERVER: SavedWorkspace = { origin: "https://server.tailnet123.ts.net", name: "server", lastConnected: NOW - 3 * 3_600_000 };
const state = (over: Partial<ShellState> = {}): ShellState => ({ workspaces: [], active: null, closed: null, platform: "ios", tailscale: TAILSCALE_UNKNOWN, ...over });
const OFF: TailscaleState = { installed: true, connected: false };
const ON: TailscaleState = { installed: true, connected: true };
const MISSING: TailscaleState = { installed: false, connected: false };
/** iOS can't tell a missing Tailscale from one without a URL scheme: installed stays unknown. */
const IOS_OFF: TailscaleState = { installed: null, connected: false };
const TAILSCALE_STATES: TailscaleState[] = [TAILSCALE_UNKNOWN, OFF, ON, MISSING, IOS_OFF];

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const IOS_PLUGIN = read("../ios/App/App/ShellPlugin.swift");
const IOS_COORDINATOR = read("../ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
const ANDROID_PLUGIN = read("../android/app/src/main/java/com/murage/mobile/ShellPlugin.java");
const ANDROID_SHELL = read("../android/app/src/main/java/com/murage/mobile/Shell.java");
const ANDROID_SCANNER = read("../android/app/src/main/java/com/murage/mobile/QrScanner.java");
const IOS_SCANNER = read("../ios/App/MurageShell/Sources/MurageShell/QRScannerViewController.swift");
const ANDROID_VERDICT = read("../android/app/src/main/java/com/murage/mobile/shell/ProbeVerdict.java");

const COPY_SAFE = /\b(?:un)?saf(?:e|ely|ety|er|est)\b/i;
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);

/** Every code a Swift failure enum carries: `case a, b` and `case aB = "a_b"`. */
function swiftEnum(source: string, name: string): string[] {
  const body = new RegExp(`enum ${name}[^{]*\\{([^}]*)\\}`).exec(source)?.[1] ?? "";
  return body.split("\n").flatMap((line) => {
    const cases = /^\s*case (.+)$/.exec(line)?.[1];
    if (!cases) return [];
    const raw = /= "(\w+)"/.exec(cases);
    return raw ? [raw[1]!] : cases.split(",").map((c) => c.trim());
  });
}

/** Every reject code both native plugins can answer, read from their source. */
const IOS_CODES = new Set([
  ...all(IOS_PLUGIN, /reject\("(\w+)"/g),
  ...swiftEnum(IOS_COORDINATOR, "OpenFailure"),
  ...swiftEnum(IOS_COORDINATOR, "ScanFailure"),
]);
const ANDROID_CODES = new Set([
  ...all(ANDROID_PLUGIN, /reject\("(\w+)"/g),
  ...all(ANDROID_SHELL, /failed\("(\w+)"\)/g),
  ...all(ANDROID_SHELL, /return "(\w+)";/g),
  ...all(ANDROID_SCANNER, /failed\("(\w+)"\)/g),
  // Shell.finishOpen rejects with verdict.mode() for these two.
  ...(/enum Kind \{([^}]*)\}/.exec(ANDROID_VERDICT)?.[1] ?? "").split(",").map((k) => k.trim().toLowerCase()).filter((k) => k !== "full" && k !== "basic"),
]);
const NATIVE_CODES = [...new Set([...IOS_CODES, ...ANDROID_CODES])].sort();

describe("which screen the launcher opens on", () => {
  it("shows a screen native is waiting to show first", () => {
    expect(firstScreen(state({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } }))).toEqual({ kind: "unreachable", origin: MAC.origin });
  });

  it("lists saved computers, or welcomes a new person", () => {
    expect(firstScreen(state({ workspaces: [MAC] }))).toEqual({ kind: "list", managing: false });
    expect(firstScreen(state())).toEqual({ kind: "welcome" });
  });

  it("asks to unlock the phone when the saved computers can't be read, never a welcome", () => {
    expect(screenForStateError("unreadable")).toEqual({ kind: "unreadable" });
    const view = present({ kind: "unreadable" }, [], NOW);
    expect(view.title).toBe("Unlock your phone and try again");
    expect(view.actions).toEqual([{ id: "reload", label: "Try again", primary: true }]);
  });

  it("offers Try again when state() fails any other way", () => {
    expect(screenForStateError("unavailable")).toEqual({ kind: "startFailed" });
    expect(screenForStateError(undefined)).toEqual({ kind: "startFailed" });
    expect(present({ kind: "startFailed" }, [], NOW).actions.map((a) => a.id)).toEqual(["reload"]);
  });

  it("maps every way a workspace closes", () => {
    expect(screenForClose({ origin: MAC.origin, reason: "unreachable" }, [MAC])).toEqual({ kind: "unreachable", origin: MAC.origin });
    expect(screenForClose({ origin: MAC.origin, reason: "insecure" }, [MAC])).toEqual({ kind: "insecure", origin: MAC.origin });
    expect(screenForClose({ origin: MAC.origin, reason: "signedOut" }, [MAC])).toEqual({ kind: "repair", origin: MAC.origin });
    expect(screenForClose({ origin: MAC.origin, reason: "signOut" }, [SERVER])).toEqual({ kind: "list", managing: false });
    expect(screenForClose({ origin: MAC.origin, reason: "signOut" }, [])).toEqual({ kind: "welcome" });
    expect(screenForClose({ origin: MAC.origin, reason: "launcher" }, [MAC])).toEqual({ kind: "list", managing: false });
  });

  it("maps every way opening can fail", () => {
    expect(screenForOpenError("unreachable", MAC.origin, false)).toEqual({ kind: "unreachable", origin: MAC.origin });
    expect(screenForOpenError("insecure", MAC.origin, true)).toEqual({ kind: "insecure", origin: MAC.origin });
    expect(screenForOpenError("bad_credential", MAC.origin, true)).toMatchObject({ kind: "type", origin: MAC.origin });
    expect(screenForOpenError(undefined, MAC.origin, false)).toMatchObject({ kind: "list" });
    expect(screenForOpenError("unreadable", MAC.origin, true)).toEqual({ kind: "unreadable" });
    expect(screenForOpenError("unreadable", MAC.origin, false)).toEqual({ kind: "unreadable" });
    expect(screenForOpenError("bad_origin", MAC.origin, true)).toEqual({ kind: "type", origin: MAC.origin, error: COPY.badAddress });
  });

  it("ignores busy: another open is already on its way, so nothing changes", () => {
    expect(screenForOpenError("busy", MAC.origin, false)).toBeNull();
    expect(screenForOpenError("busy", MAC.origin, true)).toBeNull();
  });

  it("asks to unlock when removing can't update the saved list", () => {
    expect(screenForRemoveError("unreadable")).toEqual({ kind: "unreadable" });
    expect(screenForRemoveError("unavailable")).toMatchObject({ kind: "list", managing: false, error: expect.any(String) });
  });

  it("says when Tailscale would not open, and stays on the can't-reach screen", () => {
    const from: Screen = { kind: "unreachable", origin: MAC.origin };
    expect(screenForTailscaleError(from, OFF, "ios")).toEqual({
      kind: "unreachable",
      origin: MAC.origin,
      error: "Murage couldn't open Tailscale. Open it from your home screen, then try again.",
    });
    expect(screenForTailscaleError(from, TAILSCALE_UNKNOWN, "android").error).toBe("Murage couldn't open Tailscale. Open it from your home screen, then try again.");
  });

  it("when Tailscale is missing and its store page won't open, names the store, on the screen the tap came from", () => {
    expect(screenForTailscaleError({ kind: "unreachable", origin: MAC.origin }, MISSING, "ios")).toEqual({
      kind: "unreachable",
      origin: MAC.origin,
      error: "Murage couldn't open the App Store. Get Tailscale there, then try again.",
    });
    expect(screenForTailscaleError({ kind: "welcome" }, MISSING, "android")).toEqual({
      kind: "welcome",
      error: "Murage couldn't open Google Play. Get Tailscale there, then try again.",
    });
  });
});

describe("the scanner", () => {
  it("leaves the screen alone when the person closes the scanner", () => {
    expect(screenForScanError("cancelled", "ios")).toBeNull();
    expect(screenForScanError("cancelled", "android", MAC.origin)).toBeNull();
  });

  it("on Android, unavailable means Google's scanner is still downloading: try again soon, or type", () => {
    expect(screenForScanError("unavailable", "android")).toEqual({ kind: "scanner", problem: "gettingReady" });
    const view = present({ kind: "scanner", problem: "gettingReady", origin: MAC.origin }, [MAC], NOW);
    expect(view.lines).toEqual(["Try again in a moment, or type the address and code from your computer instead."]);
    // The title already says it is getting ready; the body doesn't repeat it (fix round 1).
    for (const line of view.lines) expect(line).not.toContain(view.title);
    expect(view.actions.map((a) => a.id)).toEqual(["scan", "type", "back"]);
    expect(view.actions.find((a) => a.id === "type")?.origin).toBe(MAC.origin);
  });

  it("on Android, a second unavailable in a row stops promising: the scanner isn't available, type instead", () => {
    const first = screenForScanError("unavailable", "android", MAC.origin);
    expect(first).toEqual({ kind: "scanner", problem: "gettingReady", origin: MAC.origin });
    const second = screenForScanError("unavailable", "android", MAC.origin, first!);
    expect(second).toEqual({ kind: "scanner", problem: "notAvailable", origin: MAC.origin });
    const view = present(second!, [MAC], NOW);
    expect(view.lines).toContain("The scanner isn't available. Type the address instead.");
    expect(view.actions.map((a) => [a.id, a.primary ?? false])).toEqual([["type", true], ["back", false]]);
    // Still not available on the third tap; a scan from anywhere else starts over.
    expect(screenForScanError("unavailable", "android", MAC.origin, second!)).toEqual(second);
    expect(screenForScanError("unavailable", "android", undefined, { kind: "welcome" })).toEqual({ kind: "scanner", problem: "gettingReady" });
  });

  it("on iPhone, a denied camera says where to allow it, since the plugin has no Settings call", () => {
    expect(screenForScanError("camera_denied", "ios", MAC.origin)).toEqual({ kind: "scanner", problem: "cameraDenied", origin: MAC.origin });
    const view = present({ kind: "scanner", problem: "cameraDenied" }, [], NOW);
    expect(view.lines.join(" ")).toMatch(/open the Settings app, then Murage, and turn on Camera/);
    expect(view.actions.map((a) => a.id)).toEqual(["scan", "type", "back"]);
  });

  it("with no camera, offers typing the address", () => {
    expect(screenForScanError("unavailable", "ios")).toEqual({ kind: "scanner", problem: "noCamera" });
    expect(screenForScanError(undefined, "android")).toEqual({ kind: "scanner", problem: "noCamera" });
    expect(present({ kind: "scanner", problem: "noCamera" }, [], NOW).actions.map((a) => a.id)).toEqual(["type", "back"]);
  });

  it("shows a scan that wasn't a pairing code on the scanner's own screen", () => {
    expect(present({ kind: "scanner", problem: "gettingReady", error: COPY.notACode }, [], NOW).error).toBe(COPY.notACode);
  });
});

describe("every code native can reject with", () => {
  it("is found in both plugins' source, and the launcher knows exactly those", () => {
    expect(NATIVE_CODES).toEqual([...SHELL_ERRORS].sort());
    // Android's scanner needs no camera permission, so only iOS says camera_denied.
    expect([...ANDROID_CODES].sort()).toEqual([...IOS_CODES].filter((c) => c !== "camera_denied").sort());
  });

  it("reads the code off Capacitor's error, and nothing else", () => {
    for (const code of NATIVE_CODES) expect(errorCode(Object.assign(new Error(code), { code }))).toBe(code);
    expect(errorCode(Object.assign(new Error("x"), { code: "UNIMPLEMENTED" }))).toBeUndefined();
    expect(errorCode(new Error("unreachable"))).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });

  it.each(NATIVE_CODES)("%s has a screen for every call, never the welcome by accident", (code) => {
    const screens: (Screen | null)[] = [
      screenForStateError(code),
      screenForOpenError(code, MAC.origin, true),
      screenForOpenError(code, MAC.origin, false),
      screenForScanError(code, "ios"),
      screenForScanError(code, "android", MAC.origin),
      screenForRemoveError(code),
    ];
    for (const screen of screens) {
      if (screen === null) {
        expect(["busy", "cancelled"]).toContain(code);
        continue;
      }
      expect(screen.kind).not.toBe("welcome");
      const view = present(screen, [MAC], NOW);
      expect(view.title).not.toBe("");
    }
    // state(), open() and remove() are the calls that can answer unreadable; scan() never does.
    if (code === "unreadable") for (const screen of [screens[0], screens[1], screens[2], screens[5]]) expect(screen).toEqual({ kind: "unreadable" });
  });
});

describe("the words on each screen", () => {
  it("can't reach: Tailscale, asleep, when it last worked, and the way back (spec §3.1)", () => {
    const view = present({ kind: "unreachable", origin: MAC.origin }, [MAC], NOW);
    expect(view.title).toBe("Can't reach Sean's Mac");
    expect(view.lines.join(" ")).toMatch(/Tailscale/);
    expect(view.lines.join(" ")).toMatch(/asleep/);
    expect(view.lines).toContain("Last connected 7 min ago");
    expect(view.actions.map((a) => a.id)).toEqual(["retry", "tailscale", "choose"]);
  });

  it("can't reach with Tailscale off on this phone: says so, and Open Tailscale leads", () => {
    for (const tailscale of [OFF, IOS_OFF]) {
      const view = present({ kind: "unreachable", origin: MAC.origin }, [MAC], NOW, tailscale);
      expect(view.title).toBe("Can't reach Sean's Mac");
      expect(view.lines).toEqual(["Tailscale is off on this phone. Turn it on, then try again.", "Last connected 7 min ago"]);
      expect(view.actions).toEqual([
        { id: "tailscale", label: "Open Tailscale", primary: true },
        { id: "retry", label: "Try again", origin: MAC.origin },
        { id: "choose", label: "Your computers" },
      ]);
    }
  });

  it("can't reach without Tailscale on this phone: install it, with Get Tailscale", () => {
    const view = present({ kind: "unreachable", origin: MAC.origin }, [MAC], NOW, MISSING);
    expect(view.lines).toEqual(["This phone needs Tailscale to reach your computer. Install it, then try again.", "Last connected 7 min ago"]);
    expect(view.actions).toEqual([
      { id: "tailscale", label: "Get Tailscale", primary: true },
      { id: "retry", label: "Try again", origin: MAC.origin },
      { id: "choose", label: "Your computers" },
    ]);
  });

  it("can't reach with Tailscale on, or unknown: Tailscale may be off or the computer asleep, as before", () => {
    const before = present({ kind: "unreachable", origin: MAC.origin }, [MAC], NOW);
    for (const tailscale of [ON, TAILSCALE_UNKNOWN, { installed: null, connected: null }, { installed: false, connected: true }]) {
      expect(present({ kind: "unreachable", origin: MAC.origin }, [MAC], NOW, tailscale)).toEqual(before);
    }
    expect(before.lines).toEqual([
      "Check that Tailscale is on and signed in to the same account on your phone and computer.",
      "Your computer may be asleep. Wake it, then try again.",
      "Last connected 7 min ago",
    ]);
  });

  it("first run mentions Tailscale only when it is missing, and the copy uses straight apostrophes", () => {
    const missing = present({ kind: "welcome" }, [], NOW, MISSING);
    expect(missing.lines.join(" ")).toContain("If your computer uses Tailscale, get it on this phone first.");
    expect(present({ kind: "welcome" }, [], NOW, ON).lines.join(" ")).not.toContain("Tailscale");
    const host = present({ kind: "hosterror", origin: MAC.origin }, [MAC], NOW);
    expect(host.lines.join(" ")).toContain("Murage on your computer isn't answering yet.");
    expect(host.lines.join(" ")).not.toContain("address answered");
    expect(present({ kind: "insecure", origin: MAC.origin }, [MAC], NOW).title).toBe("Check this computer's HTTPS connection");
  });
  it("adding a computer waits for its origin before offering network advice", () => {
    const plain = present({ kind: "welcome" }, [MAC], NOW);
    expect(plain.actions.map((a) => a.label)).toEqual(["Scan the code", "Type the address instead"]);
    const view = present({ kind: "welcome" }, [MAC], NOW, MISSING);
    expect(view.lines).toEqual(plain.lines);
    expect(view.actions).toEqual(plain.actions);
    for (const tailscale of [OFF, ON, TAILSCALE_UNKNOWN, IOS_OFF]) expect(present({ kind: "welcome" }, [MAC], NOW, tailscale)).toEqual(plain);
  });

  it("re-pair: scan again in this app, never the Camera app (spec §3.1)", () => {
    const view = present({ kind: "repair", origin: MAC.origin }, [MAC], NOW);
    expect(view.title).toBe("Scan the code on your computer again");
    expect(JSON.stringify(view)).not.toMatch(/Camera app/i);
    expect(view.actions.map((a) => a.id)).toEqual(["scan", "type", "remove"]);
  });

  it("insecure says what to fix on the computer (spec §7)", () => {
    const view = present({ kind: "insecure", origin: MAC.origin }, [MAC], NOW);
    expect(view.title).toBe("Check this computer's HTTPS connection");
    expect(view.lines.join(" ")).toMatch(/open Murage, then Settings, then Phone and other devices/);
  });

  it("lists computers with when each last worked, and removes only in edit mode", () => {
    const list = present({ kind: "list", managing: false }, [MAC, SERVER], NOW);
    expect(list.rows.map((r) => [r.name, r.detail])).toEqual([["Sean's Mac", "Last connected 7 min ago"], ["server", "Last connected 3 h ago"]]);
    expect(list.rows[0]!.actions.map((a) => a.id)).toEqual(["open"]);
    const editing = present({ kind: "list", managing: true }, [MAC], NOW);
    expect(editing.rows[0]!.actions.map((a) => a.id)).toEqual(["remove"]);
  });

  it("has exactly one primary action wherever there is one", () => {
    const screens: Screen[] = [
      { kind: "welcome" },
      { kind: "type" },
      { kind: "unreachable", origin: MAC.origin },
      { kind: "insecure", origin: MAC.origin },
      { kind: "repair", origin: MAC.origin },
      { kind: "unreadable" },
      { kind: "startFailed" },
      { kind: "scanner", problem: "gettingReady" },
      { kind: "scanner", problem: "cameraDenied" },
      { kind: "scanner", problem: "noCamera" },
      { kind: "scanner", problem: "notAvailable" },
      { kind: "notYet" },
      { kind: "getCode" },
      { kind: "scan" },
      { kind: "pairUnreachable", origin: MAC.origin },
    ];
    for (const screen of screens) {
      for (const tailscale of TAILSCALE_STATES) {
        for (const workspaces of [[MAC], []]) expect(present(screen, workspaces, NOW, tailscale).actions.filter((a) => a.primary)).toHaveLength(1);
      }
    }
  });

  it("the copy rule catches unsafe and safer too", () => {
    for (const bad of ["unsafe", "Safer", "safest", "safely", "safety"]) expect(bad).toMatch(COPY_SAFE);
  });

  it("follows the copy rules: no em dash, no safe or safety, no price talk", () => {
    const screens: Screen[] = [
      { kind: "welcome", error: "x" },
      { kind: "type", origin: MAC.origin },
      { kind: "list", managing: false },
      { kind: "list", managing: true },
      { kind: "connecting", origin: MAC.origin },
      { kind: "unreachable", origin: MAC.origin },
      { kind: "insecure", origin: MAC.origin },
      { kind: "repair", origin: MAC.origin },
      { kind: "unreadable" },
      { kind: "startFailed" },
      { kind: "scanner", problem: "gettingReady" },
      { kind: "scanner", problem: "cameraDenied" },
      { kind: "scanner", problem: "noCamera" },
      { kind: "scanner", problem: "notAvailable" },
      ...TAILSCALE_STATES.flatMap((t) => (["ios", "android"] as const).flatMap((p) => [screenForTailscaleError({ kind: "unreachable", origin: MAC.origin }, t, p), screenForTailscaleError({ kind: "welcome" }, t, p)])),
      screenForRemoveError("unavailable"),
      ...NATIVE_CODES.flatMap((code) => [screenForOpenError(code, MAC.origin, true), screenForOpenError(code, MAC.origin, false)]),
      screenForOpenError(undefined, MAC.origin, true)!,
      { kind: "notYet" },
      { kind: "getCode" },
      { kind: "scan", error: "x" },
      { kind: "pairUnreachable", origin: MAC.origin },
      ...TAILSCALE_STATES.flatMap((t) => (["ios", "android"] as const).flatMap((p) => [true, false].map((store) => screenForTailscaleError({ kind: "pairUnreachable", origin: MAC.origin }, t, p, store)))),
    ].filter((s): s is Screen => s !== null);
    // First run: no saved computers, so the welcome and connecting say it their own way.
    const views = screens.flatMap((s) => TAILSCALE_STATES.flatMap((t) => [present(s, [MAC, SERVER], NOW, t), present(s, [], NOW, t)]));
    expect(views.map((v) => v.title)).toEqual(expect.arrayContaining(["Murage on your phone", "Get your code ready", "Connecting to your computer…", "Turn on Tailscale", "Get Tailscale", "Your phone can't see your computer"]));
    const words = [...Object.values(COPY), ...views.map((v) => JSON.stringify(v))].join("\n");
    expect(words).not.toMatch(/—/);
    expect(words).not.toMatch(COPY_SAFE);
    expect(words).not.toMatch(/\b(?:charges?|charged|pricing|price|prices|fees?|billing|cost|costs|paid|pay|subscription|free)\b/i);
  });
});

describe("first run (2026-09-27 first-run spec)", () => {
  const ANDROID_OFF = OFF;

  it("welcomes a new person with one question, and one way on", () => {
    expect(present({ kind: "welcome" }, [], NOW)).toEqual({
      title: "Murage on your phone",
      lines: ["Talk to your team from anywhere. First, is Murage running on your computer?"],
      actions: [
        { id: "getCode", label: "Yes, let's connect", primary: true },
        { id: "notYet", label: "Not yet" },
      ],
      rows: [],
      error: undefined,
      mark: true,
      layout: "firstRun",
      step: 1,
    });
    // Tailscale is worked out after the scan, never asked about here.
    for (const tailscale of TAILSCALE_STATES) expect(present({ kind: "welcome" }, [], NOW, tailscale).actions.map((a) => a.id)).toEqual(["getCode", "notYet"]);
  });

  it("Not yet: set up Murage first, and one button back", () => {
    expect(present({ kind: "notYet" }, [], NOW)).toMatchObject({
      title: "Set up Murage on your computer first",
      lines: ["When it's running, come back here."],
      actions: [{ id: "ready", label: "It's running now", primary: true }],
      layout: "firstRun",
      step: 1,
    });
  });

  it("Get your code ready: where the code is on the computer, a picture of it, then the camera", () => {
    expect(GET_CODE_BODY).toBe("On your computer, open Murage, then Settings, then Phone and other devices. Turn it on and a code appears.");
    const view = present({ kind: "getCode" }, [], NOW);
    expect(view).toEqual({
      title: "Get your code ready",
      lines: [GET_CODE_BODY],
      image: { light: expect.stringContaining("desktop-phone-light"), dark: expect.stringContaining("desktop-phone-dark"), alt: GET_CODE_ALT, width: expect.any(Number), height: expect.any(Number) },
      actions: [
        { id: "scan", label: "I see the code, scan it", primary: true },
        { id: "type", label: "Type the code instead" },
      ],
      rows: [],
      error: undefined,
      layout: "firstRun",
      step: 2,
    });
    expect(GET_CODE_ALT).toMatch(/Phone and other devices/);
    expect(GET_CODE_ALT).toMatch(/Turn on/);
    expect(GET_CODE_ALT).toMatch(/Sign in on another device/);
    // Adding another computer: the same screen, without the step.
    expect(present({ kind: "getCode" }, [MAC], NOW).step).toBeUndefined();
  });

  it("the steps count to four: welcome, get the code ready, scan, connecting", () => {
    expect([
      present({ kind: "welcome" }, [], NOW).step,
      present({ kind: "notYet" }, [], NOW).step,
      present({ kind: "getCode" }, [], NOW).step,
      present({ kind: "scan" }, [], NOW).step,
      present({ kind: "connecting", origin: MAC.origin }, [], NOW).step,
      ...TAILSCALE_STATES.map((t) => present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW, t).step),
    ]).toEqual([1, 1, 2, 3, 4, undefined, 4, 4, 4, 4]);
  });

  it("the scan hint says where the code is, and typing stays available", () => {
    expect(SCAN_HINT).toBe("On your computer, open Murage, then Settings, then Phone and other devices. Point your camera at the code.");
    const view = present({ kind: "scan" }, [], NOW);
    expect(view.lines).toEqual([SCAN_HINT]);
    expect(view.actions).toEqual([
      { id: "scan", label: "Scan the code", primary: true },
      { id: "type", label: "Type the code instead" },
      { id: "back", label: "Back" },
    ]);
    expect(view).toMatchObject({ layout: "firstRun", step: 3 });
    expect(present({ kind: "scan", error: COPY.notACode }, [], NOW).error).toBe(COPY.notACode);
    // The iPhone's own scanner shows the same hint over the camera.
    expect(IOS_SCANNER).toContain(`LoadingOverlay.label("${SCAN_HINT}"`);
  });

  it("connecting to a computer not yet saved says your computer", () => {
    expect(present({ kind: "connecting", origin: MAC.origin }, [], NOW)).toMatchObject({ title: "Connecting to your computer…", layout: "firstRun", step: 4 });
    // Adding a second computer: the same layout, no steps (it isn't first run).
    expect(present({ kind: "connecting", origin: MAC.origin }, [SERVER], NOW)).toMatchObject({ title: "Connecting to your computer…", layout: "firstRun" });
    expect(present({ kind: "connecting", origin: MAC.origin }, [SERVER], NOW).step).toBeUndefined();
    const saved = present({ kind: "connecting", origin: MAC.origin }, [MAC], NOW);
    expect(saved.title).toBe("Connecting to Sean's Mac…");
    expect([saved.layout, saved.step]).toEqual([undefined, undefined]);
  });

  it("a pairing that can't reach its computer gets the diagnosis; a saved computer keeps can't-reach", () => {
    expect(screenForOpenError("unreachable", MAC.origin, true)).toEqual({ kind: "pairUnreachable", origin: MAC.origin });
    expect(screenForOpenError("unreachable", MAC.origin, false)).toEqual({ kind: "unreachable", origin: MAC.origin });
  });

  it("Tailscale off: Turn on Tailscale, Open Tailscale", () => {
    expect(present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW, ANDROID_OFF)).toEqual({
      title: "Turn on Tailscale",
      lines: ["Your phone reaches your computer through Tailscale."],
      actions: [
        { id: "tailscale", label: "Open Tailscale", primary: true },
        { id: "scan", label: "Scan again" },
      ],
      rows: [],
      error: undefined,
      layout: "firstRun",
      step: 4,
    });
  });

  it("on iPhone (installed unknown, off): the same screen, plus I don't have Tailscale yet", () => {
    expect(present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW, IOS_OFF)).toMatchObject({
      title: "Turn on Tailscale",
      lines: ["Your phone reaches your computer through Tailscale."],
      actions: [
        { id: "tailscale", label: "Open Tailscale", primary: true },
        { id: "store", label: "I don't have Tailscale yet" },
        { id: "scan", label: "Scan again" },
      ],
    });
  });

  it("on Android without Tailscale: Get Tailscale", () => {
    expect(present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW, MISSING)).toMatchObject({
      title: "Get Tailscale",
      lines: ["Your phone needs Tailscale to reach your computer. Get it, sign in with the same account as your computer, then come back."],
      actions: [
        { id: "tailscale", label: "Get Tailscale", primary: true },
        { id: "scan", label: "Scan again" },
      ],
      layout: "firstRun",
      step: 4,
    });
  });

  it("Tailscale on: your phone can't see your computer, Try again or Scan again", () => {
    expect(present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW, ON)).toMatchObject({
      title: "Your phone can't see your computer",
      lines: [
        "Check that Tailscale on your phone is signed in to the same account as your computer (it's shown on your computer under Settings, then Phone and other devices), and that your computer is awake.",
      ],
      actions: [
        { id: "retry", label: "Try again", primary: true, origin: MAC.origin },
        { id: "scan", label: "Scan again" },
      ],
      layout: "firstRun",
      step: 4,
    });
  });

  it("Tailscale unknown: the can't-reach screen as before", () => {
    const screen: Screen = { kind: "pairUnreachable", origin: MAC.origin, error: "x" };
    expect(present(screen, [SERVER], NOW)).toEqual(present({ kind: "unreachable", origin: MAC.origin, error: "x" }, [SERVER], NOW));
  });

  it("Tailscale unknown on first run: no Your computers when there are none, Scan again instead (A4)", () => {
    const view = present({ kind: "pairUnreachable", origin: MAC.origin }, [], NOW);
    const plain = present({ kind: "unreachable", origin: MAC.origin }, [], NOW);
    expect(view.title).toBe(plain.title);
    expect(view.lines).toEqual(plain.lines);
    expect(view.actions.map((a) => a.label)).toEqual(["Try again", "Open Tailscale", "Scan again"]);
    expect(view.actions.at(-1)).toEqual({ id: "scan", label: "Scan again" });
  });

  it("the saved computers' screens keep their layout, with no steps", () => {
    for (const screen of [{ kind: "list", managing: false }, { kind: "unreachable", origin: MAC.origin }, { kind: "welcome" }, { kind: "type" }] as Screen[]) {
      const view = present(screen, [MAC], NOW);
      expect([view.layout, view.step, view.mark]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("a failed I don't have Tailscale yet names the App Store, not the home screen (A5)", () => {
    expect(screenForTailscaleError({ kind: "pairUnreachable", origin: MAC.origin } as Extract<Screen, { kind: "pairUnreachable" }>, IOS_OFF, "ios", true).error).toBe(
      "Murage couldn't open the App Store. Get Tailscale there, then try again.",
    );
    expect(screenForTailscaleError({ kind: "pairUnreachable", origin: MAC.origin } as Extract<Screen, { kind: "pairUnreachable" }>, IOS_OFF, "ios").error).toBe(
      "Murage couldn't open Tailscale. Open it from your home screen, then try again.",
    );
  });

  it("which Tailscale step a diagnosis waits on", () => {
    expect([OFF, IOS_OFF, MISSING, ON, TAILSCALE_UNKNOWN].map(waitsForTailscale)).toEqual([true, true, true, false, false]);
  });

  it("a Tailscale or store page that won't open says so on the diagnosis", () => {
    expect(screenForTailscaleError({ kind: "pairUnreachable", origin: MAC.origin }, MISSING, "android")).toEqual({
      kind: "pairUnreachable",
      origin: MAC.origin,
      error: "Murage couldn't open Google Play. Get Tailscale there, then try again.",
    });
  });
});

// Final review M10: the words native shows follow the same rules. Every
// string literal in the UIKit and Android shell sources (log lines aside),
// every Android string resource, and every Info.plist string a person sees.
// The debug-only E2E probe (its page CSS says safe-area) is not copy.
function nativeWords(): string[] {
  const words: string[] = [];
  const plist = read("../ios/App/App/Info.plist");
  for (const [, key, value] of plist.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    if (/UsageDescription$|^CFBundleDisplayName$|^UIApplicationShortcutItemTitle$/.test(key!)) words.push(value!);
  }
  expect(words.filter((w) => w.length > 20).length).toBeGreaterThanOrEqual(3); // camera, microphone, photo library
  for (const [, value] of read("../android/app/src/main/res/values/strings.xml").matchAll(/<string name="[^"]*">([^<]*)<\/string>/g)) words.push(value!);
  const sources: [string, RegExp][] = [
    ["../ios/App/MurageShell/Sources/MurageShell/", /\.swift$/],
    ["../ios/App/App/", /\.swift$/],
    ["../android/app/src/main/java/com/murage/mobile/", /\.java$/],
  ];
  for (const [dir, pattern] of sources) {
    for (const name of readdirSync(new URL(dir, import.meta.url)).filter((file) => pattern.test(file) && !["ShellLog.swift", "E2EProbe.swift"].includes(file))) {
      for (const line of read(dir + name).split("\n")) {
        if (/ShellLog\.|^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const [, literal] of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) words.push(literal!);
      }
    }
  }
  return words;
}

describe("one way of saying where things are", () => {
  it("every phone line says it with \", then\", never an arrow (a screen reader reads \"right arrow\")", () => {
    const screens: Screen[] = [
      { kind: "welcome" }, { kind: "notYet" }, { kind: "getCode" }, { kind: "scan" }, { kind: "type" },
      { kind: "insecure", origin: MAC.origin }, { kind: "repair", origin: MAC.origin },
      { kind: "scanner", problem: "gettingReady" }, { kind: "scanner", problem: "cameraDenied" },
      { kind: "scanner", problem: "noCamera" }, { kind: "scanner", problem: "notAvailable" },
      { kind: "pairUnreachable", origin: MAC.origin }, { kind: "unreachable", origin: MAC.origin },
    ];
    const words = [
      ...Object.values(COPY),
      ...screens.flatMap((screen) => TAILSCALE_STATES.flatMap((t) => [present(screen, [], NOW, t), present(screen, [MAC], NOW, t)]).map((v) => JSON.stringify(v))),
    ].join("\n");
    expect(words).not.toContain("→");
    expect(COPY.notACode).toBe("That isn't a Murage pairing code. On your computer, open Murage, then Settings, then Phone and other devices, and scan the code shown there.");
  });
});

describe("native copy", () => {
  it("follows the copy rules: no em dash, no safe or safety, no price talk", () => {
    const words = nativeWords();
    expect(words).toContain("Still connecting…");
    expect(words).toContain(SCAN_HINT);
    expect(words.join("\n")).toContain("saves photos and videos");
    for (const word of words) {
      expect(word).not.toMatch(/—/);
      expect(word).not.toMatch(COPY_SAFE);
      expect(word).not.toMatch(/\b(?:charges?|charged|pricing|price|prices|fees?|billing|cost|costs|paid|pay|subscription|free)\b/i);
    }
  });
});

describe("what native says about Tailscale", () => {
  it("reads each field as a boolean or unknown, never a guess", () => {
    expect(readTailscale({ installed: true, connected: false })).toEqual({ installed: true, connected: false });
    expect(readTailscale({ installed: null, connected: true })).toEqual({ installed: null, connected: true });
    expect(readTailscale(undefined)).toEqual(TAILSCALE_UNKNOWN);
    expect(readTailscale(null)).toEqual(TAILSCALE_UNKNOWN);
    expect(readTailscale({ installed: "false", connected: 0 })).toEqual(TAILSCALE_UNKNOWN);
    expect(TAILSCALE_UNKNOWN).toEqual({ installed: null, connected: null });
  });

  it("is in both native state() answers, the same shape", () => {
    expect(IOS_COORDINATOR).toContain('"tailscale": tailscaleStatus().wire');
    expect(ANDROID_SHELL).toContain('Json.put(state, "tailscale", tailscale().wire());');
  });
});

describe("when it last connected", () => {
  it.each([
    [undefined, "Never connected from this phone"],
    [NOW - 20_000, "Last connected just now"],
    [NOW - 59 * 60_000, "Last connected 59 min ago"],
    [NOW - 47 * 3_600_000, "Last connected 47 h ago"],
    [NOW - 3 * 86_400_000, "Last connected 3 days ago"],
  ])("%s → %s", (then, text) => {
    expect(lastConnectedText(NOW, then)).toBe(text);
  });
});

it("uses exactly the close reasons both native sides send", () => {
  const swift = read("../ios/App/MurageShell/Sources/MurageShellCore/LaunchPolicy.swift");
  const java = read("../android/app/src/main/java/com/murage/mobile/shell/CloseReason.java");
  const swiftCases = swift.match(/enum CloseReason[^{]*\{\s*case ([^\n]+)/)?.[1]!.trim().split(", ");
  const javaWires = [...java.matchAll(/\("(\w+)"\)/g)].map((m) => m[1]);
  expect(swiftCases).toEqual([...CLOSE_REASONS]);
  expect(javaWires).toEqual([...CLOSE_REASONS]);
});

it("keeps shell-types free of runtime imports, so Node loads it without Capacitor", () => {
  const source = read("./shell-types.ts");
  expect(source.match(/^import (?!type )/gm)).toBeNull();
});
