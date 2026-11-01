// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// ENGINE-SIGNIN-SIMPLE-1014: a reply's engine link draws a button and never an href, a press only shows something, and a
// window with no bridge gets the plain line.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";
import type { InstanceInfo } from "@/state/store";
import en from "@/locales/en.json";
import { REFUSED } from "@/lib/engine-chat-link.test";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { instances: [] }, dispatch: vi.fn(), refreshInstances: vi.fn() }) }));

const { ChatMarkdown } = await import("./ChatMarkdown");
const { EngineChatLink, EngineChatLinkDialog } = await import("./EngineChatLink");

const bridge = {} as LocalEngineLoginBridge;
const claude = { instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", enabled: true, snapshot: { state: "available", authenticated: true }, install: { signInCommand: "claude auth login" } } as unknown as InstanceInfo;
const markdown = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
const desktop = () => vi.stubGlobal("window", { muragebox: { localEngineLogin: bridge } });
afterEach(() => vi.unstubAllGlobals());

describe("in a reply", () => {
  it("draws a button with the bot's words, never an href, for each shape", () => {
    desktop();
    for (const [href, kind] of [["murage://engine/sign-in?engine=claude", "sign-in"], ["murage://engine/set-up?engine=kimi", "set-up"], ["murage://plan/chatgpt", "plan"], ["murage://plan/supergrok", "plan"]]) {
      const html = markdown(`[Go on](${href})`);
      expect(html, href).toContain(`data-engine-chat-link="${kind}"`);
      expect(html, href).toContain("Go on");
      expect(html, href).not.toContain("<a");
      expect(html, href).not.toContain("murage://");
    }
  });

  it("marks the Grok plan button Unofficial, and only that one", () => {
    desktop();
    expect(markdown("[Grok](murage://plan/supergrok)")).toContain(en["modelSignIn.grok.unofficial"]);
    expect(markdown("[ChatGPT](murage://plan/chatgpt)")).not.toContain(en["modelSignIn.grok.unofficial"]);
  });

  it("draws no button and keeps no murage:// for any other link", () => {
    desktop();
    for (const href of REFUSED) {
      if (/\s/.test(href)) continue;
      const html = markdown(`[x](${href})`);
      expect(html, href).not.toContain("data-engine-chat-link");
      expect(html.toLowerCase(), href).not.toContain('href="murage:');
      expect(html.toLowerCase(), href).not.toContain('href="javascript:');
    }
  });

  it("keeps an image source refused", () => {
    desktop();
    expect(markdown("![x](murage://plan/chatgpt)")).not.toContain("murage://");
  });

  it("gives a window with no bridge the existing plain line", () => {
    const html = markdown("[Sign in to Claude](murage://engine/sign-in?engine=claude)");
    expect(html).toContain(en["engineSignIn.elsewhere"]);
    expect(html).not.toContain("<button");
  });
});

describe("the press", () => {
  it("hands the link over and starts nothing: the only press target is the event", () => {
    const code = readFileSync(new URL("./EngineChatLink.tsx", import.meta.url), "utf8");
    expect(code).toContain("window.dispatchEvent(new CustomEvent(OPEN_ENGINE_CHAT_LINK_EVENT, { detail: href }))");
    expect(code).not.toMatch(/startLocalLogin|bridge\.start|\.start\(|api\(/);
  });

  it("is hosted once in App, so a replaced bubble cannot close the dialog", () => {
    expect(readFileSync(new URL("../App.tsx", import.meta.url), "utf8").match(/<EngineChatLinkHost \/>/g)).toHaveLength(1);
  });

  it("uses the same page and anchor reach as every other opener", () => {
    expect(readFileSync(new URL("./EngineChatLink.tsx", import.meta.url), "utf8")).toContain('dispatch({ type: "toggleAppSettings", open: true, section: step.section');
  });

  it("says so when already signed in, in the plain dialog frame", () => {
    const html = renderToStaticMarkup(createElement(EngineChatLinkDialog, { show: "signed-in", instance: claude, bridge, onClose: () => {} }));
    expect(html).toContain("Claude is already signed in.");
    expect(html).toContain("data-engine-chat-link-dialog");
  });

  it("renders no button a static reply could press into a sign-in", () => {
    const html = renderToStaticMarkup(createElement(EngineChatLink, { href: "javascript:alert(1)", bridge }));
    expect(html).toBe("");
  });
});
