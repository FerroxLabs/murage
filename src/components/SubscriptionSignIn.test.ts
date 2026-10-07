// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SubscriptionSignIn, { ProviderRow, errorLine } from "./SubscriptionSignIn";
import { signInPickerNote } from "@/lib/model-signin-picker";
import en from "@/locales/en.json";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import type { SignInProviderStatus } from "../../shared/model-signin";

const noop = () => {};
const row = (status: Partial<SignInProviderStatus> & Pick<SignInProviderStatus, "provider">, connection?: Partial<PublicProviderConnection>) =>
  renderToStaticMarkup(createElement(ProviderRow, { status: { enabled: true, state: "signed-out", acceptsCode: false, ...status }, connection: connection as PublicProviderConnection | undefined, busy: false, onStart: noop, onSignOut: noop, onCancel: noop })).replaceAll("&#x27;", "'");

describe("plan sign-in card", () => {
  it("on a phone or browser, says where to finish sign-in", () => {
    const html = renderToStaticMarkup(createElement(SubscriptionSignIn, { connections: [], onChanged: noop }));
    expect(html).toContain(en["modelSignIn.heading"]);
    expect(html).toContain(en["modelSignIn.remote"]);
  });

  it("shows each state: signed out, waiting, signed in, ended, and a plan-limit pause", () => {
    expect(row({ provider: "chatgpt" })).toContain("Continue with ChatGPT");
    expect(row({ provider: "chatgpt", state: "waiting" })).toContain(en["modelSignIn.waiting"]);
    const connected = row({ provider: "chatgpt", state: "connected", email: "o@example.com", plan: "plus" }, { id: "signin-chatgpt", signIn: { provider: "chatgpt", state: "connected", unofficial: false, pausedUntil: Date.now() + 60_000 } });
    expect(connected).toContain("Signed in as o@example.com");
    expect(connected).toContain("Plus plan");
    expect(connected).toContain("Sign out");
    expect(connected).toContain("Plan limit reached");
    const ended = row({ provider: "chatgpt", state: "needs-sign-in" });
    expect(ended).toContain(en["modelSignIn.chatgpt.ended"]);
    expect(ended).toContain("Sign in again");
  });

  it("labels Grok unofficial and says the user's own CLI logins are left alone", () => {
    const grok = row({ provider: "supergrok" });
    expect(grok).toContain("Continue with Grok");
    expect(grok).toContain(en["modelSignIn.grok.unofficial"]);
    expect(grok).toContain(en["modelSignIn.grok.note"]);
    expect(row({ provider: "chatgpt" })).toContain("leaves your Codex CLI login alone");
  });

  it("maps every error to a line, with provider wording for a refused account", () => {
    expect(errorLine("supergrok", "unauthorized")).toBe(en["modelSignIn.grok.unauthorized"]);
    expect(errorLine("chatgpt", "headless")).toBe(en["modelSignIn.error.headless"]);
  });

  it("keeps the copy rules: no em dashes, no Composio, no safe words, no prices", () => {
    const copy = Object.entries(en).filter(([key]) => key.startsWith("modelSignIn.") || key.startsWith("modelPicker.signIn.")).map(([, value]) => value).join("\n");
    expect(copy).not.toMatch(/—/);
    expect(copy).not.toMatch(/composio/i);
    expect(copy).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
    expect(copy).not.toMatch(/\$|\bprice|\bcost|\bfree\b|\bcheap/i);
  });
});

describe("model picker line for engines that cannot use a plan", () => {
  const signIn = { id: "signin-chatgpt", enabled: true, signIn: { provider: "chatgpt", state: "connected", unofficial: false } } as PublicProviderConnection;
  it("names Claude Code plainly, and says nothing where the plan is listed", () => {
    expect(signInPickerNote("claudeAgent", [signIn])).toBe(en["modelPicker.signIn.claude"]);
    expect(signInPickerNote("piAgent", [signIn])).toBe(en["modelPicker.signIn.noConnections"]);
    expect(signInPickerNote("fuigoAgent", [signIn])).toBe("");
    expect(signInPickerNote("codex", [signIn])).toBe("");
    expect(signInPickerNote("claudeAgent", [])).toBe("");
    const paused = { ...signIn, label: "ChatGPT plan", signIn: { provider: "chatgpt", state: "connected", unofficial: false, pausedUntil: 5_000 } } as PublicProviderConnection;
    expect(signInPickerNote("fuigoAgent", [paused], "signin-chatgpt", 1_000)).toMatch(/^ChatGPT plan: plan limit reached/);
    expect(signInPickerNote("fuigoAgent", [paused], "signin-chatgpt", 9_000)).toBe("");
  });
});
