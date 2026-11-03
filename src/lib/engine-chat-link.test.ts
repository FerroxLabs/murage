// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// ENGINE-SIGNIN-SIMPLE-1014: the exact chat link shapes, what a press shows, and a link from outside the app doing nothing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ENGINE_CHAT_LINK_DRIVERS, PLAN_SIGNIN_ANCHOR, engineChatLinkStep, parseEngineChatLink } from "./engine-chat-link";
// @ts-expect-error plain ESM from Electron main, no declaration file
import { doorLinkFromCommandLine, doorLinkFromDeepLink, doorLinkKind } from "../../electron/cloud-door-link.mjs";

const instance = (over: { id?: string; driver?: string; state?: string; authenticated?: boolean; enabled?: boolean } = {}) =>
  ({ instanceId: over.id ?? "claude", driverKind: over.driver ?? "claudeAgent", enabled: over.enabled ?? true, snapshot: { state: over.state ?? "available", authenticated: over.authenticated } }) as never;
const signIn = parseEngineChatLink("murage://engine/sign-in?engine=claude")!;
const setUp = parseEngineChatLink("murage://engine/set-up?engine=claude")!;

export const REFUSED = [
  "javascript:alert(1)", "murage://engine/sign-in", "murage://engine/sign-in?engine=", "murage://engine/sign-in?engine=claude&x=1",
  "murage://engine/sign-in?x=1&engine=claude", "murage://engine/sign-in?engine=claude#x", "murage://engine/sign-in?engine=hermes",
  "murage://engine/sign-in?engine=constructor", "murage://engine/sign-in?engine=Claude", "MURAGE://engine/sign-in?engine=claude",
  "murage://Engine/sign-in?engine=claude", "murage://engine/Sign-In?engine=claude", "murage://engine/start?engine=claude",
  "murage://engine/sign-in/?engine=claude", "murage://plan/claude", "murage://plan/ChatGPT", "murage://plan/chatgpt?x=1", "murage://plan/chatgpt/",
  " murage://plan/chatgpt", "murage://plan/chatgpt\n", "https://murage.ai/plan/chatgpt", "murage://door?h=1", "murage://connect-cloud",
];

describe("parseEngineChatLink", () => {
  it("takes exactly the four shapes, through the fixed word table", () => {
    expect([...ENGINE_CHAT_LINK_DRIVERS]).toEqual([["claude", "claudeAgent"], ["codex", "codex"], ["grok", "grokAgent"], ["kimi", "kimiAgent"], ["cursor", "cursorAgent"]]);
    for (const [word, driverKind] of ENGINE_CHAT_LINK_DRIVERS) {
      expect(parseEngineChatLink(`murage://engine/sign-in?engine=${word}`)).toEqual({ kind: "sign-in", driverKind });
      expect(parseEngineChatLink(`murage://engine/set-up?engine=${word}`)).toEqual({ kind: "set-up", driverKind });
    }
    expect(parseEngineChatLink("murage://plan/chatgpt")).toEqual({ kind: "plan", provider: "chatgpt" });
    expect(parseEngineChatLink("murage://plan/supergrok")).toEqual({ kind: "plan", provider: "supergrok" });
  });

  it("refuses everything else", () => {
    for (const href of REFUSED) expect(parseEngineChatLink(href), href).toBeNull();
    expect(parseEngineChatLink(undefined)).toBeNull();
  });

  it("names drivers the sign-in table really has", () => {
    const recipe = readFileSync(new URL("../../server/engine-signin-recipe.ts", import.meta.url), "utf8");
    for (const driver of ENGINE_CHAT_LINK_DRIVERS.values()) expect(recipe, driver).toMatch(new RegExp(`^  ${driver}: `, "m"));
  });
});

describe("what a press shows", () => {
  it("sign-in: the dialog when signed out, the line when already signed in", () => {
    expect(engineChatLinkStep(signIn, [instance({ authenticated: false })])).toEqual({ show: "sign-in", instanceId: "claude" });
    expect(engineChatLinkStep(signIn, [instance({ authenticated: true })])).toEqual({ show: "signed-in", instanceId: "claude" });
  });

  it("never says signed in on an unknown answer, and sends a missing CLI to the card", () => {
    expect(engineChatLinkStep(signIn, [instance()]).show).toBe("sign-in");
    expect(engineChatLinkStep(signIn, [instance({ state: "unavailable" })])).toEqual({ show: "set-up", instanceId: "claude" });
  });

  it("set-up: the card, whatever the state", () => {
    for (const authenticated of [true, false]) expect(engineChatLinkStep(setUp, [instance({ authenticated })])).toEqual({ show: "set-up", instanceId: "claude" });
  });

  it("several instances, or none usable: Settings at Engines", () => {
    const engines = { show: "settings", section: "engines" };
    const two = [instance({ authenticated: false }), instance({ id: "claude-2", authenticated: false })];
    expect(engineChatLinkStep(signIn, two)).toEqual(engines);
    expect(engineChatLinkStep(setUp, two)).toEqual(engines);
    expect(engineChatLinkStep(signIn, [])).toEqual(engines);
    expect(engineChatLinkStep(signIn, [instance({ driver: "codex" })])).toEqual(engines);
    expect(engineChatLinkStep(signIn, [instance({ enabled: false })])).toEqual(engines);
  });

  it("does not count a turned-off instance as a second one", () => {
    expect(engineChatLinkStep(signIn, [instance({ authenticated: false }), instance({ id: "old", enabled: false })]).show).toBe("sign-in");
  });

  it("plan: Settings at Use a plan you already have, a heading that exists", () => {
    expect(engineChatLinkStep(parseEngineChatLink("murage://plan/supergrok")!, [])).toEqual({ show: "settings", section: "models", anchor: PLAN_SIGNIN_ANCHOR });
    expect(readFileSync(new URL("../components/SubscriptionSignIn.tsx", import.meta.url), "utf8")).toContain(`id="${PLAN_SIGNIN_ANCHOR}"`);
  });
});

describe("a link from outside the app", () => {
  const links = [...ENGINE_CHAT_LINK_DRIVERS.keys()].flatMap((word) => [`murage://engine/sign-in?engine=${word}`, `murage://engine/set-up?engine=${word}`]).concat("murage://plan/chatgpt", "murage://plan/supergrok");

  it("is not taken by main's murage:// handler", () => {
    for (const link of links) {
      expect(doorLinkKind(link), link).toBeNull();
      expect(doorLinkFromDeepLink(link), link).toBeNull();
      expect(doorLinkFromCommandLine(["murage", link]), link).toBeNull();
    }
  });

  it("main's handlers do nothing for a link that is not a Cloud link", () => {
    const main = readFileSync(new URL("../../electron/main.mjs", import.meta.url), "utf8");
    expect(main).toContain("if (queueCloudLink(url)) { event.preventDefault(); return; }");
    expect(main).toContain("const link = typeof rawLink === \"string\" ? doorLinkFromDeepLink(rawLink) : rawLink;\n  if (!link) return false;");
    expect(main).not.toMatch(/engine\/sign-in|engine\/set-up|murage:\/\/plan/);
  });
});
