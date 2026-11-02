// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The desktop sign-in: the button on each surface, each kind of sign-in, and a window with no bridge. The bridge is a mock.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalEngineLoginBridge, LocalLoginState } from "@/lib/local-engine-login";
import { LOCAL_LOGIN_START } from "@/lib/local-engine-login";
import type { InstanceInfo } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { instances }, dispatch: vi.fn(), refreshInstances: vi.fn() }) }));

const claude = { instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", enabled: true, snapshot: { state: "available", authenticated: false }, install: { signInCommand: "claude auth login", command: {} } } as unknown as InstanceInfo;
const instances: InstanceInfo[] = [claude];

const { EngineSignInButton } = await import("./EngineSignInButton");
const { EngineSignInBody } = await import("./EngineSignInDialog");
const { EngineSetup } = await import("./EngineSetup");
const { NoEngines } = await import("./NoEngines");

const bridge = {} as LocalEngineLoginBridge;
const actions = { open: async () => {}, openTerminal: async () => {}, retry: () => {} };
const COMMAND = "claude auth login";
const state = (over: Partial<LocalLoginState>): LocalLoginState => ({ ...LOCAL_LOGIN_START, phase: "ready", kind: "headless", label: "Claude", accountRoot: "/Users/fixture/.claude", ...over });
const body = (over: Partial<LocalLoginState>, command: string | undefined = COMMAND) => renderToStaticMarkup(createElement(EngineSignInBody, { state: state(over), name: "Claude", command, actions }));
const button = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(EngineSignInButton, { instanceId: "claude", name: "Claude", command: COMMAND, bridge, ...props }));
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const BANNED = /\b(?:safe|unsafe|safety)\b|[–—]/i;

afterEach(() => vi.unstubAllGlobals());

describe("the button", () => {
  it("is one button that names the engine, with no command text", () => {
    const out = button();
    expect(out).toContain("Sign in to Claude");
    expect(out).toContain("data-engine-signin-button");
    expect(out).not.toContain(COMMAND);
    expect(out).not.toContain("Terminal");
  });
  it("with no bridge it is the plain line and no button", () => {
    const out = button({ bridge: null });
    expect(out).toContain("Finish sign-in on the computer running Murage.");
    expect(out).not.toContain("<button");
    expect(out).not.toContain(COMMAND);
  });
});

describe("each surface carries the button", () => {
  const signedOut = (over: Record<string, unknown> = {}) => { vi.stubGlobal("window", { muragebox: { localEngineLogin: bridge }, addEventListener() {}, removeEventListener() {} }); return { instance: claude, ...over }; };
  it("EngineSetup, on the sign-in path: no Terminal words and no command", () => {
    const out = renderToStaticMarkup(createElement(EngineSetup, signedOut()));
    expect(out).toContain("data-engine-signin-button");
    expect(out).toContain("Sign in once, then check again below.");
    expect(out).not.toContain(COMMAND);
    expect(out).not.toContain("in Terminal");
  });
  it("EngineSetup, on a failed turn asking for a sign-in", () => {
    const ready = { ...claude, snapshot: { state: "available", authenticated: true } } as unknown as InstanceInfo;
    const out = renderToStaticMarkup(createElement(EngineSetup, signedOut({ instance: ready, authRequired: true })));
    expect(out).toContain("data-engine-signin-button");
    expect(out).not.toContain(COMMAND);
  });
  it("EngineSetup keeps the Flux card for Fuigo, and an inject card keeps skipping sign-in", () => {
    const fuigo = { ...claude, driverKind: "fuigoAgent" } as unknown as InstanceInfo;
    expect(renderToStaticMarkup(createElement(EngineSetup, signedOut({ instance: fuigo })))).not.toContain("data-engine-signin-button");
    expect(renderToStaticMarkup(createElement(EngineSetup, signedOut({ intent: "inject" })))).not.toContain("data-engine-signin-button");
  });
  it("NoEngines", () => {
    vi.stubGlobal("window", { muragebox: { localEngineLogin: bridge }, addEventListener() {}, removeEventListener() {} });
    const out = renderToStaticMarkup(createElement(NoEngines));
    expect(out).toContain("data-engine-signin-button");
    expect(out).not.toContain(COMMAND);
  });
  it("Inbox and the first-run card use it, and neither shows a command itself", () => {
    const inbox = source("./Inbox.tsx");
    expect(inbox).toContain("<EngineSignInButton");
    expect(inbox).not.toContain("Run this in a terminal");
    expect(inbox).not.toContain("{engine.signInCommand}</code>");
    const firstRun = source("./FirstRunCard.tsx");
    expect(firstRun).toContain("<EngineSignInButton");
    expect(firstRun).not.toContain("{row.command}</code>");
  });
  it("the failed turn reaches the sign-in through EngineSetup", () => {
    expect(source("./ChatView.tsx")).toMatch(/<EngineSetup instance=\{setupInstance\} authRequired=\{forceSignIn\}/);
  });
});

describe("the dialog, by state", () => {
  it("before main answers it says it is getting ready, and offers nothing to press", () => {
    const out = renderToStaticMarkup(createElement(EngineSignInBody, { state: LOCAL_LOGIN_START, name: "Claude", actions }));
    expect(out).toContain("Getting your Claude sign-in ready");
    expect(out).not.toContain("<button");
  });
  it("ready: names the engine and folder, one press reading Open sign-in, no command", () => {
    const out = body({});
    expect(out).toContain("/Users/fixture/.claude");
    expect(out).toContain("signs Claude in");
    expect(out).toContain("data-engine-signin-open");
    expect(out).toContain(">Open sign-in<");
    expect(out).not.toContain(COMMAND);
    expect(out.match(/<button/g)).toHaveLength(1);
  });
  it("waiting: the browser line, and Terminal only after the 45 seconds", () => {
    expect(body({ phase: "waiting" })).toContain("Waiting for you in the browser");
    expect(body({ phase: "waiting" })).not.toContain("data-engine-signin-terminal");
    expect(body({ phase: "waiting", slow: true })).toContain("Didn&#x27;t open? Use Terminal");
  });
  it("finishing", () => { expect(body({ phase: "finishing" })).toContain("Finishing"); });
  it("signed in says so and offers nothing else", () => {
    const out = body({ phase: "closed", result: "signed-in" });
    expect(out).toContain("Signed in to Claude.");
    expect(out).not.toContain("<button");
  });
  it("not finished keeps Terminal as a choice, and an engine's own line comes first", () => {
    expect(body({ phase: "closed", result: "not-finished" })).toContain("The sign-in did not finish.");
    expect(body({ phase: "closed", result: "not-finished" })).toContain("data-engine-signin-terminal");
    expect(body({ phase: "closed", result: "not-finished", message: "You've hit your plan limit." })).toContain("plan limit");
  });
  it("stopped offers nothing", () => { expect(body({ phase: "closed", result: "stopped" })).not.toContain("<button"); });
  it("terminal kind: one press, opened line after", () => {
    expect(body({ kind: "terminal" })).toContain("Open sign-in in Terminal");
    expect(body({ kind: "terminal", phase: "waiting", terminal: "opened" })).toContain("Terminal is open.");
  });
  it("none: the plain line and the command", () => {
    const out = body({ kind: "none" });
    expect(out).toContain("Murage cannot start this sign-in");
    expect(out).toContain(COMMAND);
  });
  it("refused: main's line and Try again", () => {
    const out = body({ phase: "refused", message: "Another sign-in is already open." });
    expect(out).toContain("Another sign-in is already open.");
    expect(out).toContain("data-engine-signin-retry");
  });
  it("no word in the dialog breaks the copy rules, and nothing of a code or paste box is left", () => {
    const text = source("./EngineSignInButton.tsx") + source("./EngineSignInDialog.tsx");
    for (const word of ["PasteBox", "copyCode", "openLink", "WaitingForBots", "stopBots", "sendPaste"]) expect(text).not.toContain(word);
    for (const over of [{}, { phase: "waiting" as const, slow: true }, { phase: "finishing" as const }, { phase: "closed" as const, result: "not-finished" as const }]) expect(body(over).replace(/<[^>]+>/g, " ")).not.toMatch(BANNED);
  });
});
