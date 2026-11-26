// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// PARITYFIX E1 + S2 from the real switch. With ONE paired home "Cloud home" opens that home directly and skips the Connect
// panel, so an owner whose home has a signed-out engine never saw a sign-in. Now the home's engine inventory (S1, via
// cloud-home:list-engines) opens the panel beside the window, on the engines the home has. The Cloud window's setup card (S2)
// reaches the same row with an engine name only.
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import type { CloudHomeBridge } from "../../lib/cloud-workspace";
import { WorkspaceSwitch } from "./WorkspaceSwitch";

vi.mock("../EngineLoginTerminal", () => ({
  // Stands in for the xterm relay only; "Close" is the terminal's own close after the vendor sign-in finished.
  EngineLoginTerminal: ({ engine, action, bot, onClose }: { engine: string; action: string; bot: { id: string } | null; onClose(): void }) =>
    createElement("div", null, createElement("p", { "data-terminal": "" }, `${engine}:${action}:${bot?.id ?? "home"}`),
      createElement("button", { type: "button", onClick: () => onClose() }, "Close")),
}));

const HOME = "home-a";
type Engines = { engine: string; installed: boolean; signedIn: boolean }[] | null;

function bridgeFor(engines: Engines) {
  let signInListener: ((request: { homeId: string; bot?: string; engine: string }) => void) | null = null;
  const bridge = {
    state: vi.fn(async () => ({ enabled: true, cpSignedIn: true, paired: [{ homeId: HOME, origin: "https://home-a.example" }] })),
    open: vi.fn(async () => ({ opened: true })),
    connectStatus: vi.fn(async () => ({ open: true, pending: false, paired: true })),
    listBots: vi.fn(async () => [{ id: "bot-1", name: "Helper" }]),
    listEngines: vi.fn(async () => engines),
    onSignInRequested: (callback: typeof signInListener) => { signInListener = callback; return () => { signInListener = null; }; },
  };
  return { bridge: bridge as unknown as CloudHomeBridge, raw: bridge, request: (r: { homeId: string; bot?: string; engine: string }) => act(() => signInListener?.(r)) };
}

const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
const press = (label: string) => {
  const target = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!target) throw new Error(`no button named ${label}; have ${buttons().join(" | ")}`);
  act(() => { target.click(); });
};
const terminal = () => document.querySelector("[data-terminal]")?.textContent ?? null;
/** Lets the lazy Connect panel and the bridge answers land (a dynamic import needs real turns of the event loop). */
async function flush() { for (let i = 0; i < 20; i += 1) { await settle(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); }); } }

let restore: () => void;
// The Connect panel is a lazy chunk: load it once up front so the first test does not wait on its first transform.
beforeAll(async () => { restore = installDOMHarness(); await import("./ConnectHome"); await import("../EngineLoginTerminal"); });
afterAll(() => restore());
afterEach(() => cleanup());

const claudeOut: Engines = [
  { engine: "claudeAgent", installed: true, signedIn: false },
  { engine: "codex", installed: false, signedIn: false },
  { engine: "kimiAgent", installed: true, signedIn: true },
];

describe("E1 one paired home: Cloud home opens the home and its engine sign-in; rows follow what the home has", () => {
  it("shows Sign in to Claude beside the opened home when the home says Claude is installed and signed out, and it opens the home's Claude sign-in", async () => {
    const w = bridgeFor(claudeOut);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    press("Cloud home");
    await flush();
    expect(w.raw.open).toHaveBeenCalledWith(HOME, true);
    expect(buttons()).toContain("Sign in to Claude");
    press("Sign in to Claude");
    await flush();
    expect(terminal()).toBe("claudeAgent:login:home");
  });

  it("after the sign-in finishes the terminal closes and the panel reads the home's engines again", async () => {
    const w = bridgeFor(claudeOut);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.request({ homeId: HOME, engine: "claudeAgent" });
    await flush();
    press("Sign in to Claude");
    await flush();
    const before = w.raw.listEngines.mock.calls.length;
    const opened = terminal();
    press("Close");
    await flush();
    expect([opened, terminal(), w.raw.listEngines.mock.calls.length > before]).toEqual(["claudeAgent:login:home", null, true]);
  });

  it("offers no sign-in for an engine the home does not have (panel reached through the Cloud window's request)", async () => {
    const w = bridgeFor(claudeOut);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.request({ homeId: HOME, engine: "claudeAgent" });
    await flush();
    expect([buttons().includes("Sign in to Claude"), buttons().filter((label) => /Codex/.test(label))]).toEqual([true, []]);
  });

  it("a signed-in Claude offers Sign out of Claude; a per-bot engine keeps its sign-in for the other bots", async () => {
    const w = bridgeFor([{ engine: "claudeAgent", installed: true, signedIn: true }, { engine: "kimiAgent", installed: true, signedIn: true }]);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.request({ homeId: HOME, engine: "claudeAgent" });
    await flush();
    expect(buttons().filter((label) => /Claude|Kimi/.test(label))).toEqual(["Sign out of Claude", "Sign in to Kimi"]);
  });

  it("opens nothing extra when every engine the home has is signed in", async () => {
    const w = bridgeFor([{ engine: "claudeAgent", installed: true, signedIn: true }]);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    press("Cloud home");
    await flush();
    expect(w.raw.open).toHaveBeenCalledWith(HOME, true);
    expect(buttons()).toEqual(["This computer", "Cloud home"]);
  });
});

describe("S2 the Cloud window asks for an engine's sign-in (no bot)", () => {
  it("opens the Connect panel on that engine's sign-in; a per-bot engine first asks which bot", async () => {
    const w = bridgeFor(null);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.request({ homeId: HOME, engine: "claudeAgent" });
    await flush();
    const claude = terminal();
    cleanup();
    const v = bridgeFor(null);
    mount(createElement(WorkspaceSwitch, { bridge: v.bridge }));
    await flush();
    v.request({ homeId: HOME, engine: "codex" });
    await flush();
    expect([claude, terminal(), buttons().includes("Helper")]).toEqual(["claudeAgent:login:home", null, true]);
  });

  it("a home that cannot say what it has still offers every sign-in, as before", async () => {
    const w = bridgeFor(null);
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.request({ homeId: HOME, engine: "claudeAgent" });
    await flush();
    expect(buttons().filter((label) => /^Sign in to /.test(label))).toEqual(["Sign in to Claude", "Sign in to Codex", "Sign in to Grok", "Sign in to Kimi", "Sign in to Antigravity", "Sign in to OpenCode"]);
  });
});
