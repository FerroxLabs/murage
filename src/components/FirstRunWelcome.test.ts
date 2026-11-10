// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// THE WELCOME, RENDERED (C6 to C10). The setup view is faked and the real Ember avatar is swapped for a stub that
// records how it was asked to stand and how often it blinked; everything else (the lockup, the focus, the timers,
// the skin) is the real thing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, installDOMHarness, mount, press, settle } from "../testing/dom-harness";
import { WORDMARK_PATH } from "../../shared/murage-lockup.mjs";
import { forgetWelcomeSeen, welcomeSeen } from "@/lib/first-run-welcome";
import { LOCKUP_TIMING } from "./MurageLockup";
import { FirstRunWelcome } from "./FirstRunWelcome";

const fx = vi.hoisted(() => ({ view: null as unknown, blinks: 0, props: [] as Array<Record<string, unknown>> }));

vi.mock("@/components/FirstRunChrome", () => ({ useSetupView: () => ({ view: fx.view, refresh: () => {} }) }));
vi.mock("./Avatar", async () => {
  const react = await import("react");
  return {
    EmberAvatar: react.forwardRef(function Stub(props: Record<string, unknown>, ref: React.Ref<{ blink: () => void }>) {
      if (props.label === undefined) fx.props.push(props); // the lockup's Ember; the starter-team faces carry a label
      react.useImperativeHandle(ref, () => ({ blink: () => { fx.blinks += 1; } }));
      return react.createElement("span", { "data-ember": "stub" });
    }),
  };
});

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const firstRunView = () => ({
  firstRun: true,
  ownerName: "",
  conversationLive: true,
  steps: [{ id: "hello", status: "open" }, { id: "detect", status: "open" }],
});

let reduced = false;
const mediaListeners = new Set<() => void>();
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  forgetWelcomeSeen();
  fx.view = firstRunView();
  fx.blinks = 0;
  fx.props.length = 0;
  reduced = false;
  mediaListeners.clear();
  document.documentElement.dataset.skin = "dark";
  window.matchMedia = ((query: string) => ({
    get matches() { return /reduce/.test(query) ? reduced : false; },
    media: query,
    addEventListener: (_type: string, fn: () => void) => { mediaListeners.add(fn); },
    removeEventListener: (_type: string, fn: () => void) => { mediaListeners.delete(fn); },
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.useRealTimers();
  document.body.replaceChildren();
  delete document.documentElement.dataset.skin;
});

const welcome = () => document.querySelector<HTMLElement>(".first-run-welcome");
const startButton = () => document.querySelector<HTMLButtonElement>(".first-run-welcome-start")!;
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("C6 Get started is focused on arrival and Enter presses it", () => {
  it("focuses Get started the moment the welcome paints", async () => {
    mount(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()).not.toBeNull();
    expect(document.activeElement).toBe(startButton());
    expect(startButton().textContent).toContain("Get started");
  });
  it("Enter presses it: the welcome fades out and is gone, and it stays gone this session", async () => {
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    press("Enter", startButton());
    expect(welcome()?.dataset.leaving).toBe("true");
    advance(300);
    expect(welcome()).toBeNull();
    expect(welcomeSeen()).toBe(true);
  });
  it("Space presses it too; Escape and other keys do nothing", async () => {
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    press("Escape", startButton());
    press("a", startButton());
    advance(1000);
    expect(welcome()?.dataset.leaving).toBe("false");
    press(" ", startButton());
    advance(300);
    expect(welcome()).toBeNull();
  });
  it("shows two plain lines and the running version on the foot", async () => {
    mount(createElement(FirstRunWelcome));
    await settle();
    const text = welcome()!.textContent ?? "";
    expect(text).toContain("Your own team of bots,");
    expect(text).toContain("doing real work on your computer.");
    expect(text).toMatch(/Murage \d+\.\d+\.\d+/);
  });
  it("is not drawn for a returning user", async () => {
    fx.view = { ...firstRunView(), firstRun: false };
    mount(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()).toBeNull();
  });
});

describe("C7 reduced motion renders the finished lockup with no animation and no blink", () => {
  it("Ember is in place, nothing is animated, nothing blinks", async () => {
    reduced = true;
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    const ember = document.querySelector<HTMLElement>(".murage-lockup-ember")!;
    expect(ember).not.toBeNull();
    expect(ember.dataset.pop).toBe("false");
    expect(ember.style.animation).toBe("");
    expect(welcome()!.style.animation).toBe("");
    advance(5000);
    expect(fx.blinks).toBe(0);
  });
  it("Get started removes it at once, with no fade", async () => {
    reduced = true;
    mount(createElement(FirstRunWelcome));
    await settle();
    press("Enter", startButton());
    expect(welcome()).toBeNull();
  });
  it("the sheet also switches the keyframes off under the media query", () => {
    const css = here("../styles.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[\s\S]*?\.first-run-welcome,\s*\.murage-lockup-ember \{ animation: none !important; \}/);
  });
});

describe("C8 Ember pop timing: animation starts at 100 ms, ends by 600 ms, blink at 950 ms, nothing after 1500 ms", () => {
  it("the animation is 500 ms after a 100 ms delay, one pass", async () => {
    mount(createElement(FirstRunWelcome));
    await settle();
    const animation = document.querySelector<HTMLElement>(".murage-lockup-ember")!.style.animation;
    expect(animation).toMatch(/^murage-lockup-pop 500ms /);
    expect(animation).toMatch(/ 100ms /);
    expect(animation).not.toMatch(/infinite|alternate/);
    expect(LOCKUP_TIMING.popDelayMs).toBe(100);
    expect(LOCKUP_TIMING.popDelayMs + LOCKUP_TIMING.popMs).toBeLessThanOrEqual(600);
    expect(LOCKUP_TIMING.blinkAtMs).toBe(950);
    expect(LOCKUP_TIMING.doneMs).toBeLessThanOrEqual(1500);
  });
  it("blinks exactly once, at 950 ms, and never again", async () => {
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    advance(949);
    expect(fx.blinks).toBe(0);
    advance(1);
    expect(fx.blinks).toBe(1);
    advance(60_000);
    expect(fx.blinks).toBe(1);
  });
  it("Ember is asked to stand still: one pinned face, body held, no pointer, no looking around", async () => {
    mount(createElement(FirstRunWelcome));
    await settle();
    const last = fx.props.at(-1)!;
    expect(last.bodyMotion).toBe(0);
    expect(last.expression).toBeTypeOf("number");
    expect(last.trackPointer).toBe(false);
    expect(last.lookAround).toBe(0);
  });
  it("the keyframes run once and the logo itself has no animation", async () => {
    const css = here("../styles.css");
    expect(css).toMatch(/@keyframes murage-lockup-pop/);
    mount(createElement(FirstRunWelcome));
    await settle();
    const svg = document.querySelector(".murage-lockup svg")!;
    expect(svg.outerHTML).not.toMatch(/animat/i);
    expect((svg as unknown as HTMLElement).style.animation ?? "").toBe("");
  });
});

describe("C9 no audio element and no AudioContext anywhere in the welcome", () => {
  it("renders no audio and constructs no audio object", async () => {
    const made: string[] = [];
    const g = globalThis as Record<string, unknown>;
    for (const name of ["AudioContext", "webkitAudioContext", "Audio"]) {
      g[name] = function Forbidden() { made.push(name); };
    }
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    advance(3000);
    press("Enter", startButton());
    advance(400);
    expect(document.querySelector("audio, video, embed, object")).toBeNull();
    expect(made).toEqual([]);
    for (const name of ["AudioContext", "webkitAudioContext", "Audio"]) delete g[name];
  });
  it("none of the welcome's sources mention one", () => {
    for (const file of ["./FirstRunWelcome.tsx", "./MurageLockup.tsx", "../lib/first-run-welcome.ts", "../../shared/murage-lockup.mjs"]) {
      expect(here(file), file).not.toMatch(/<audio|AudioContext|new Audio\(|HTMLAudioElement|\.play\(|\.mp3|\.wav|\.ogg/);
    }
  });
});

describe("C10 light and dark render with the right background and wordmark ink", () => {
  const wordmark = () => [...document.querySelectorAll("svg path")].find((node) => node.getAttribute("d") === WORDMARK_PATH)!;
  it("dark: near-black ground, white wordmark", async () => {
    document.documentElement.dataset.skin = "dark";
    mount(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()!.style.background).toBe("rgb(17, 17, 17)");
    expect(wordmark().getAttribute("fill")).toBe("#ffffff");
  });
  it("light: #f7f7f8 ground, near-black wordmark", async () => {
    document.documentElement.dataset.skin = "light";
    mount(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()!.style.background).toBe("rgb(247, 247, 248)");
    expect(wordmark().getAttribute("fill")).toBe("#111111");
  });
  it("follows the skin if it changes while the welcome is open", async () => {
    document.documentElement.dataset.skin = "dark";
    mount(createElement(FirstRunWelcome));
    await settle();
    await act(async () => { document.documentElement.dataset.skin = "light"; await Promise.resolve(); });
    await settle();
    expect(wordmark().getAttribute("fill")).toBe("#111111");
  });
});

describe("the welcome follows the world it is in", () => {
  it("goes when the view stops being a first run, or hello is answered", async () => {
    const view = mount(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()).not.toBeNull();
    fx.view = { ...firstRunView(), steps: [{ id: "hello", status: "done" }] };
    view.rerender(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()).toBeNull();
    fx.view = { ...firstRunView(), firstRun: false };
    view.rerender(createElement(FirstRunWelcome));
    await settle();
    expect(welcome()).toBeNull();
  });
  it("turning reduced motion on before the blink cancels the blink and stills Ember", async () => {
    vi.useFakeTimers();
    mount(createElement(FirstRunWelcome));
    await settle();
    advance(400);
    reduced = true;
    act(() => { mediaListeners.forEach((fn) => fn()); });
    advance(5000);
    expect(fx.blinks).toBe(0);
    expect(document.querySelector<HTMLElement>(".murage-lockup-ember")!.style.animation).toBe("");
    expect(fx.props.at(-1)!.animated).toBe(false);
  });
  it("Tab stays on Get started, and Escape stops at the welcome", async () => {
    mount(createElement(FirstRunWelcome));
    await settle();
    const tab = press("Tab", startButton());
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(startButton());
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    press("Escape", startButton());
    document.removeEventListener("keydown", heard);
    expect(heard).not.toHaveBeenCalled();
    expect(welcome()?.dataset.leaving).toBe("false");
  });
});
