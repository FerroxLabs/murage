// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// CLOUD-NOKEY-FALLBACK: on a Cloud home, a bot not yet on Fuigo while the home's Flux credit is on its way never sees another
// engine's sign-in bar. It sees "Getting Fuigo ready", the slow line after 10 minutes, and other engines only as one line that
// points at Settings. Off a home (the desktop) the gate is exactly as before.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatSignInGate, FuigoReadyView } from "./BotSignInOffer";
import { FUIGO_READY_COPY, FUIGO_SLOW_AFTER_MS, fluxReadyOf, fuigoPendingHere, fuigoReadyLines, type HomeBot } from "@/lib/cloud-signin-status";

const bot = { id: "b1", name: "Ember", modelSelection: { instanceId: "claude-1" } };
const needsClaude: HomeBot[] = [{ id: "b1", name: "Ember", instanceId: "claude-1", signIn: { engine: "claudeAgent", label: "Claude", signedIn: false, uses: null } }];
const gate = (over: Partial<Parameters<typeof ChatSignInGate>[0]>) =>
  renderToStaticMarkup(createElement(ChatSignInGate, { bot, lines: needsClaude, inUseEngine: "claudeAgent", onSignIn: () => {}, children: createElement("textarea", { id: "box" }), ...over }));

describe("fuigoPendingHere", () => {
  it("is true only on a Cloud home, Flux not ready (or unknown), and a chat not on Fuigo", () => {
    expect(fuigoPendingHere({ cloud: true, fluxReady: false, inUseEngine: "claudeAgent" })).toBe(true);
    expect(fuigoPendingHere({ cloud: true, fluxReady: undefined, inUseEngine: "codex" })).toBe(true);
    expect(fuigoPendingHere({ cloud: true, fluxReady: false, inUseEngine: undefined })).toBe(true);
    expect(fuigoPendingHere({ cloud: true, fluxReady: true, inUseEngine: "claudeAgent" })).toBe(false);
    expect(fuigoPendingHere({ cloud: true, fluxReady: false, inUseEngine: "fuigoAgent" })).toBe(false);
    // the desktop never takes this path
    expect(fuigoPendingHere({ cloud: false, fluxReady: false, inUseEngine: "claudeAgent" })).toBe(false);
  });
  it("reads the config's Flux status as ready, not ready or unknown", () => {
    expect(fluxReadyOf(null)).toBeUndefined();
    expect(fluxReadyOf({})).toBe(false);
    expect(fluxReadyOf({ flux: { configured: false } })).toBe(false);
    expect(fluxReadyOf({ flux: { configured: true, keyState: "refused" } })).toBe(false);
    expect(fluxReadyOf({ flux: { configured: true } })).toBe(true);
    expect(fluxReadyOf({ flux: { configured: true, keyState: "ok" } })).toBe(true);
  });
});

describe("the approved words", () => {
  it("are exactly the approved copy", () => {
    expect(FUIGO_READY_COPY).toEqual({
      title: "Getting Fuigo ready",
      line: "Your bots run on Fuigo with your Flux credit. This takes a minute or two. You can keep looking around.",
      slow: "Fuigo is taking longer than usual. We're on it. Need help? Email support@murage.ai.",
      others: "Prefer your own Claude, ChatGPT or Grok sign-in? Add it in Settings.",
    });
  });
  it("switch to the slow line at 10 minutes, not before", () => {
    expect(FUIGO_SLOW_AFTER_MS).toBe(600_000);
    expect(fuigoReadyLines(0).line).toBe(FUIGO_READY_COPY.line);
    expect(fuigoReadyLines(FUIGO_SLOW_AFTER_MS - 1).line).toBe(FUIGO_READY_COPY.line);
    expect(fuigoReadyLines(FUIGO_SLOW_AFTER_MS).line).toBe(FUIGO_READY_COPY.slow);
    expect(fuigoReadyLines(FUIGO_SLOW_AFTER_MS).title).toBe("Getting Fuigo ready");
  });
  it("the card shows the title, the line and the one Settings line, with no button", () => {
    const html = renderToStaticMarkup(createElement(FuigoReadyView, { lines: fuigoReadyLines(FUIGO_SLOW_AFTER_MS) }));
    expect(html).toContain("Getting Fuigo ready");
    expect(html).toContain("Fuigo is taking longer than usual. We&#x27;re on it. Need help? Email support@murage.ai.");
    expect(html).toContain("Prefer your own Claude, ChatGPT or Grok sign-in? Add it in Settings.");
    expect(html).not.toContain("<button");
  });
});

describe("ChatSignInGate with Flux pending", () => {
  it("shows Getting Fuigo ready in place of the other engine's sign-in bar, and keeps the text box", () => {
    const html = gate({ fuigoPending: true });
    expect(html).toContain('data-testid="chat-fuigo-pending"');
    expect(html).toContain("Getting Fuigo ready");
    expect(html).toContain("Your bots run on Fuigo with your Flux credit. This takes a minute or two. You can keep looking around.");
    expect(html).not.toContain('data-testid="chat-signin-gate"');
    expect(html).not.toContain("<button");
    expect(html).toContain('id="box"');
  });
  it("covers a bot with no engine yet (an empty birth selection) too", () => {
    const html = gate({ fuigoPending: true, bot: { ...bot, modelSelection: { instanceId: "" } }, lines: [{ id: "b1", name: "Ember" }], inUseEngine: undefined });
    expect(html).toContain("Getting Fuigo ready");
  });
  it("leaves a signed-in chat alone: nothing to replace", () => {
    const signedIn: HomeBot[] = [{ ...needsClaude[0]!, signIn: { ...needsClaude[0]!.signIn!, signedIn: true } }];
    const html = gate({ fuigoPending: true, lines: signedIn });
    expect(html).not.toContain("Getting Fuigo ready");
    expect(html).toContain('id="box"');
  });
  it("without Flux pending (the desktop, or Flux ready) the gate is unchanged: the sign-in bar, no Fuigo card", () => {
    for (const html of [gate({}), gate({ fuigoPending: false })]) {
      expect(html).not.toContain("Getting Fuigo ready");
      expect(html).toContain('data-testid="chat-signin-gate"');
    }
  });
  it("ChatView feeds the gate from the Cloud home, the Flux status and the chat's engine", () => {
    const view = readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");
    expect(view).toContain("fuigoPending={fuigoPendingHere({ cloud: isCloudHome(), fluxReady: fluxReadyOf(state.config), inUseEngine: chatSignIn.inUseEngine })}");
  });
});
