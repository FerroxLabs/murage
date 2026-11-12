// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The chat composer gate clears after the sign-in, with no reload (design CLOUD-SIGNIN-UNKNOWN, test e and M1). There is no DOM here,
// so a small hook runtime stands in for React: state and callbacks by call order, effects after each render when their deps change,
// and a re-render whenever state moved. It drives the real useChatSignIn, useHomeSignInLines, ChatComposerGate and BotChatSignInGate.
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserSignInDialog, ChatComposerGate, useChatSignIn } from "./BotSignInOffer";

type Effect = { deps?: readonly unknown[]; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  effects: [] as Effect[],
  pending: [] as Array<{ at: number; run: () => void | (() => void); deps?: readonly unknown[] }>,
  cursor: 0, effectCursor: 0, dirty: false,
}));
const api = vi.hoisted(() => vi.fn());
vi.mock("react", async (original) => {
  const React = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    ...React,
    useState: (initial: unknown) => {
      const at = rt.cursor++;
      if (!(at in rt.slots)) rt.slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(rt.slots[at]) : next;
        if (!Object.is(value, rt.slots[at])) { rt.slots[at] = value; rt.dirty = true; }
      };
      return [rt.slots[at], set];
    },
    useCallback: (fn: unknown, deps?: readonly unknown[]) => {
      const at = rt.cursor++;
      const prev = rt.slots[at] as { fn: unknown; deps?: readonly unknown[] } | undefined;
      if (prev && same(prev.deps, deps)) return prev.fn;
      rt.slots[at] = { fn, deps };
      return fn;
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const at = rt.effectCursor++;
      const prev = rt.effects[at];
      if (!prev || !same(prev.deps, deps)) rt.pending.push({ at, run, deps });
    },
  };
});
vi.mock("@/state/store", () => ({ api }));
vi.mock("@/lib/cloud-workspace", () => ({ isCloudHome: () => true }));
// An owner's browser on the home: Codex signs in right here, through the dialog.
vi.mock("@/lib/owner-code", () => ({ onCloudHomePage: () => true }));
vi.mock("@/lib/signin-tab", () => ({ reserveSignInTab: vi.fn(), releaseSignInTab: vi.fn() }));

type Host = { type: string; props: Record<string, any> };
type Shown = { text: string; hosts: Host[]; dialogs: Array<{ onClose(): void }> };
function walk(node: unknown, out: Shown): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return; }
  if (typeof node === "string" || typeof node === "number") { out.text += String(node); return; }
  const { type, props } = node as { type: unknown; props: Record<string, any> };
  if (type === BrowserSignInDialog) { out.dialogs.push(props as { onClose(): void }); return; }
  if (typeof type === "function") { walk((type as (p: unknown) => unknown)(props), out); return; }
  if (typeof type === "string") out.hosts.push({ type, props });
  walk(props?.children, out);
}
function renderOnce(root: () => ReactNode): Shown {
  rt.cursor = 0; rt.effectCursor = 0; rt.dirty = false;
  const out: Shown = { text: "", hosts: [], dialogs: [] };
  walk(root(), out);
  const due = rt.pending.splice(0);
  for (const effect of due) {
    const prev = rt.effects[effect.at];
    if (typeof prev?.cleanup === "function") prev.cleanup();
    rt.effects[effect.at] = { deps: effect.deps, cleanup: effect.run() };
  }
  return out;
}
/** Render, then let answers land and re-render until nothing moves. */
async function settle(root: () => ReactNode): Promise<Shown> {
  let shown = renderOnce(root);
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (!rt.dirty) return shown;
    shown = renderOnce(root);
  }
  return shown;
}
const gated = (shown: Shown) => shown.hosts.some((host) => host.props["data-testid"] === "chat-signin-gate");

// M1: Ember's own engine is Claude and signed in; this chat runs on Codex, which Ember is not signed in to.
const ember = { id: "e", name: "Ember", modelSelection: { instanceId: "codex" } };
const instances = [{ instanceId: "claude", driverKind: "claudeAgent" }, { instanceId: "codex", driverKind: "codex" }];
const lineWith = (engines: string[]): { bots: Array<{ id: string; name: string; instanceId: string } & Record<string, unknown>> } => ({
  bots: [{ id: "e", name: "Ember", instanceId: "claude", engine: "claudeAgent", label: "Claude", signedIn: true, uses: "home", signedInEngines: engines }],
});
function Chat() {
  // The same wiring ChatView has: one useChatSignIn, its result into ChatComposerGate.
  const signIn = useChatSignIn(ember, instances);
  return createElement(ChatComposerGate, { bot: { ...ember }, signIn, children: createElement("textarea", { id: "composer" }, "COMPOSER") });
}
const root = () => createElement(Chat);
const signInCalls = () => api.mock.calls.filter(([path]) => path === "/api/cloud/engine-signins").length;

describe("the chat gate clears after the sign-in, no reload (e, M1)", () => {
  beforeEach(() => {
    rt.slots = []; rt.effects = []; rt.pending = []; rt.dirty = false;
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    });
    api.mockReset();
  });
  afterEach(() => {
    for (const effect of rt.effects) if (typeof effect?.cleanup === "function") effect.cleanup();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("a Codex chat on a bot signed in to Claude only: gated, then the 5 s poll sees Codex signed in and the composer is back", async () => {
    let signedIn = ["claudeAgent"];
    api.mockImplementation(async (path: string) => (path === "/api/cloud/engine-signins" ? lineWith(signedIn) : {}));
    let shown = await settle(root);
    expect(gated(shown)).toBe(true);
    expect(shown.text).not.toContain("COMPOSER");
    expect(shown.text).toContain("Codex");
    // The owner signs Codex in somewhere else (the Connect panel, another tab): the poll must still be running for THIS engine.
    signedIn = ["claudeAgent", "codex"];
    vi.advanceTimersByTime(5000);
    shown = await settle(root);
    expect(signInCalls()).toBeGreaterThanOrEqual(2);
    expect(gated(shown)).toBe(false);
    expect(shown.text).toContain("COMPOSER");
  });

  it("closing the sign-in dialog asks the home again at once, with no timer", async () => {
    let signedIn = ["claudeAgent"];
    api.mockImplementation(async (path: string) => (path === "/api/cloud/engine-signins" ? lineWith(signedIn) : {}));
    let shown = await settle(root);
    expect(gated(shown)).toBe(true);
    const signInButton = shown.hosts.find((host) => host.type === "button" && String(host.props.children).includes("Sign Ember in to Codex"));
    expect(signInButton).toBeDefined();
    signInButton!.props.onClick();
    shown = await settle(root);
    expect(shown.dialogs).toHaveLength(1);
    const beforeClose = signInCalls();
    signedIn = ["claudeAgent", "codex"];
    shown.dialogs[0]!.onClose();
    shown = await settle(root);
    expect(signInCalls()).toBe(beforeClose + 1);
    expect(shown.dialogs).toHaveLength(0);
    expect(gated(shown)).toBe(false);
    expect(shown.text).toContain("COMPOSER");
  });

  it("ChatView mounts ChatComposerGate on the one useChatSignIn it also reads its lines from", () => {
    const view = readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");
    expect(view).toContain("const chatSignIn = useChatSignIn(bot, state.instances);");
    expect(view).toContain("const signInLines = chatSignIn.lines;");
    expect(view).toContain("<ChatComposerGate bot={bot} signIn={chatSignIn} fuigoPending={fuigoPendingHere({ cloud: isCloudHome(), fluxReady: fluxReadyOf(state.config), inUseEngine: chatSignIn.inUseEngine })}>");
    expect(view).not.toMatch(/useHomeSignInLines\(|<BotChatSignInGate/);
  });
});
