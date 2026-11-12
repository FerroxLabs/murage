import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cloudSignInPlan } from "@/lib/signed-out-engines";
import { ChatSignInGate, gateChoices, switchBotEngine } from "./BotSignInOffer";
import { InboxEngineSignInView, botForSignIn, type CloudEnv } from "./InboxEngineSignIn";
import type { HomeBot } from "@/lib/cloud-signin-status";

const BANNED = /terminal|Run this|\b(?:safe|unsafe|safety)\b|[–—]/i;
const browser: CloudEnv = { cloud: true, homePage: true, bridge: false };
const window_: CloudEnv = { cloud: true, homePage: false, bridge: true };
const local: CloudEnv = { cloud: false, homePage: false, bridge: false };
const noop = () => {};
const view = (row: { id: string; name: string; driverKind?: string }, env: CloudEnv, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(InboxEngineSignInView, { row, env, busy: false, error: "", choices: null, onSignIn: noop, onChoose: noop, onCancel: noop, ...over } as never));

describe("the Inbox row on a Cloud home", () => {
  it("every browser engine is one button, with no command and no word terminal, in a browser and in the Cloud window", () => {
    for (const [driverKind, name] of [["claudeAgent", "Claude"], ["codex", "Codex"], ["grokAgent", "Grok"], ["kimiAgent", "Kimi"]] as const) {
      for (const env of [browser, window_]) {
        const out = view({ id: driverKind, name, driverKind }, env);
        expect(out).toContain(`Sign in to ${name}`);
        expect(out).not.toMatch(BANNED);
      }
    }
  });
  it("a custom instance id still finds its engine through the driver kind", () => {
    expect(cloudSignInPlan({ id: "claude-work", name: "Claude Code", driverKind: "claudeAgent" }, browser)).toEqual({ kind: "button" });
  });
  it("an engine with no browser route gets plain words and no button, never a command", () => {
    const opencode = view({ id: "opencode", name: "OpenCode", driverKind: "opencodeGo" }, browser);
    expect(opencode).toContain("cannot be signed in from here yet");
    expect(opencode).toContain("turn it off");
    expect(opencode).not.toContain("<button");
    expect(opencode).not.toMatch(BANNED);
    expect(view({ id: "agy", name: "Antigravity", driverKind: "antigravityAgent" }, browser)).toContain("sign in there");
    // the Cloud window can sign OpenCode in through its bridge
    expect(cloudSignInPlan({ id: "opencode", name: "OpenCode", driverKind: "opencodeGo" }, window_)).toEqual({ kind: "button" });
  });
  it("the desktop's own install is unchanged: no plan at all, so the Inbox keeps its command", () => {
    expect(cloudSignInPlan({ id: "codex", name: "Codex", driverKind: "codex" }, local)).toBeNull();
    expect(view({ id: "codex", name: "Codex", driverKind: "codex" }, local)).toBe("");
  });
  it("one bot is used without asking, several get the picker, none says so", () => {
    const one = [{ id: "a", name: "Atlas" }], many = [...one, { id: "b", name: "Bea" }];
    expect(botForSignIn("grokAgent", one)).toEqual(one[0]);
    expect(botForSignIn("grokAgent", many)).toBe("choose");
    expect(botForSignIn("codex", many)).toBe("choose");
    expect(botForSignIn("claudeAgent", many)).toEqual(many[0]); // Claude is the home's own
    expect(botForSignIn("codex", [])).toBeNull();
    const picker = view({ id: "grokAgent", name: "Grok" }, browser, { choices: many });
    expect(picker).toContain("Atlas"); expect(picker).toContain("Bea"); expect(picker).toContain("Choose which bot");
  });
});

describe("the chat gate offers every engine", () => {
  const grok = (signedIn: boolean): HomeBot[] => [{ id: "e", name: "Ember", signIn: { engine: "grokAgent", label: "Grok", signedIn, uses: null } }];
  const gate = () => renderToStaticMarkup(createElement(ChatSignInGate, { bot: { id: "e", name: "Ember" }, lines: grok(false), onSignIn: noop, children: createElement("div", null, "COMPOSER") }));
  it("a bot signed out of Grok gets Grok first and Claude and Codex beside it, in the owner's words", () => {
    const out = gate();
    expect(out).toContain("Sign Ember in to Grok");
    expect(out).toContain("Sign Ember in to Claude");
    expect(out).toContain("Sign Ember in to Codex");
    expect(out).not.toContain("COMPOSER");
    expect(out).not.toMatch(BANNED);
    expect(gateChoices("grokAgent").map((c) => c.engine)).toEqual(["claudeAgent", "codex"]);
  });
  it("picking another engine moves the bot onto it with the same PATCH the model picker sends, and nothing else", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const call = async (path: string, init?: RequestInit) => { calls.push({ path, init }); return path === "/api/instances" ? { instances: [{ instanceId: "claudeAgent", driverKind: "claudeAgent", enabled: true, snapshot: { state: "available" }, models: { default: "sonnet" } }] } : {}; };
    expect(await switchBotEngine("e", "claudeAgent", call)).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/api/instances", "/api/bots/e"]);
    expect(calls[1]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ modelSelection: { instanceId: "claudeAgent", model: "sonnet" }, settingsScope: "defaults" });
    expect(await switchBotEngine("e", "codex", call)).toBe(false); // no such engine ready: nothing is sent
    expect(calls).toHaveLength(3);
  });
});

describe("a bot never sees a sign-in code or a sign-in button", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("the sign-in code only ever goes to the vendor CLI and the choices are UI, never text sent to a bot", () => {
    for (const file of ["./BotSignInOffer.tsx", "./InboxEngineSignIn.tsx", "../EngineSignInGuide.tsx", "../../lib/engine-login-view.ts", "../../lib/signin-tab.ts"]) {
      const source = read(file);
      // nothing in the sign-in path sends a chat message, writes a message row or builds a prompt
      expect(source, file).not.toMatch(/\/messages|sendMessage|type:\s*"send"|appendMessage/);
    }
    // the code leaves the terminal component only through the session's bridge input, never through the store or the api
    const terminal = read("../EngineLoginTerminal.tsx");
    expect(terminal).not.toMatch(/dispatch\(|api\(|useStore/);
    // the gate is a component in the owner's composer slot: the bot's turn text is built elsewhere and never imports it
    expect(read("../ChatView.tsx")).toMatch(/ChatComposerGate/);
    expect(read("../../../server/index.ts")).not.toMatch(/BotSignInOffer|EngineSignInGuide|engine-login-view/);
  });
});
