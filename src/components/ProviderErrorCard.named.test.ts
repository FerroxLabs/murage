// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ERRORS-NAME-THE-SERVICE (1.0.18). Sean's card read "AI SERVICE · Payment or account access needed" for a 402 from his own Grok
// account, while Murage knew the engine was the Grok CLI. Every engine x error kind now names who said it, whose account it is,
// and leads with one fix; Retry stays secondary and the technical details stay collapsed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderErrorCard, providerErrorLead } from "./ProviderErrorCard";
import type { FuigoWall } from "./engine/SignInWall";
import { setLocale } from "../lib/i18n";
import { localeChoices } from "../locales";
import { allLocalePacks } from "../locales/testing";
import { serviceIdentity } from "../../shared/provider-service";
import type { ProviderErrorInfo } from "../../shared/provider-error";

const locales = await allLocalePacks();
afterEach(() => setLocale("en"));

const wall: FuigoWall = {
  bot: { id: "b1", threadId: "t1", engineRev: 3, modelSelection: { instanceId: "other-1", model: "m" } } as FuigoWall["bot"],
  instances: [{ instanceId: "fuigo-1", driverKind: "fuigoAgent", displayName: "Fuigo", enabled: true, snapshot: { state: "available" }, models: { default: "flux/auto", options: [] } }] as unknown as FuigoWall["instances"],
};
const STATUS = { payment: 402, credits: 402, "spend-cap": 402, authentication: 401, permission: 403, "rate-limit": 429, unavailable: 503 } as const;
const info = (kind: keyof typeof STATUS, stamp: Partial<ProviderErrorInfo> = {}): ProviderErrorInfo => ({ kind, httpStatus: STATUS[kind], ...stamp });
const render = (value: ProviderErrorInfo, withWall = true) => renderToStaticMarkup(createElement(ProviderErrorCard, {
  info: value, onRetry: () => {}, onOpenProviderSettings: () => {}, ...(withWall ? { fuigoWall: wall, botName: "Sable" } : {}),
}));
/** The element carrying data-provider-primary, as markup. */
const primaryOf = (html: string) => /<(a|button)[^>]*data-provider-primary[^>]*>.*?<\/\1>/.exec(html)?.[0] ?? "";
const titleOf = (html: string) => /<h3[^>]*>(.*?)<\/h3>/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "";

type Row = { name: string; info: ProviderErrorInfo; title: string; lead: "billing" | "settings" | "fuigo"; href?: string; primary: string; account?: string };
const ROWS: Row[] = [
  // Sean's card: the Grok CLI, his own xAI sign-in, HTTP 402.
  { name: "Grok CLI payment", info: info("payment", { engine: "grokAgent" }), title: "Grok (xAI) needs payment", lead: "billing", href: "https://console.x.ai/", primary: "Open Grok (xAI) billing", account: "your own Grok (xAI) sign-in" },
  { name: "Grok CLI sign-in refused", info: info("authentication", { engine: "grokAgent" }), title: "Grok (xAI) needs you to sign in again", lead: "settings", primary: "Models &amp; engines" },
  { name: "Grok CLI request limit", info: info("rate-limit", { engine: "grokAgent" }), title: "Grok (xAI) request limit reached", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Claude payment", info: info("payment", { engine: "claudeAgent" }), title: "Claude needs payment", lead: "billing", href: "https://claude.ai/settings/billing", primary: "Open Claude billing" },
  { name: "Claude sign-in refused", info: info("authentication", { engine: "claudeAgent" }), title: "Claude needs you to sign in again", lead: "settings", primary: "Models &amp; engines" },
  { name: "Claude model access", info: info("permission", { engine: "claudeAgent" }), title: "Claude denied access", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Codex payment (no billing page)", info: info("payment", { engine: "codex" }), title: "Codex needs payment", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Codex sign-in refused", info: info("authentication", { engine: "codex" }), title: "Codex needs you to sign in again", lead: "settings", primary: "Models &amp; engines" },
  { name: "Gemini request limit", info: info("rate-limit", { engine: "geminiAgent" }), title: "Gemini request limit reached", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Gemini model access", info: info("permission", { engine: "geminiAgent" }), title: "Gemini denied access", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Copilot payment", info: info("payment", { engine: "copilotAgent" }), title: "Copilot needs payment", lead: "billing", href: "https://github.com/settings/copilot", primary: "Open Copilot billing" },
  { name: "OpenClaw busy", info: info("unavailable", { engine: "openclawAgent" }), title: "OpenClaw is temporarily unavailable", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "Kimi sign-in refused", info: info("authentication", { engine: "kimiAgent" }), title: "Kimi needs you to sign in again", lead: "settings", primary: "Models &amp; engines" },
  { name: "OpenAI key refused", info: info("authentication", { engine: "openai-compat", connection: { preset: "openai" } }), title: "Your OpenAI key was refused", lead: "settings", primary: "Models &amp; engines", account: "your own OpenAI key" },
  { name: "OpenAI key payment", info: info("payment", { engine: "openai-compat", connection: { preset: "openai" } }), title: "OpenAI needs payment", lead: "billing", href: "https://platform.openai.com/settings/organization/billing", primary: "Open OpenAI billing" },
  { name: "Anthropic key out of credit", info: info("credits", { engine: "claudeAgent", connection: { preset: "anthropic" } }), title: "Anthropic needs credits", lead: "billing", href: "https://console.anthropic.com/settings/billing", primary: "Open Anthropic billing" },
  { name: "xAI key payment", info: info("payment", { engine: "grok", connection: { preset: "xai" } }), title: "xAI needs payment", lead: "billing", href: "https://console.x.ai/", primary: "Open xAI billing" },
  { name: "OpenRouter key request limit", info: info("rate-limit", { engine: "openai-compat", connection: { preset: "openrouter" } }), title: "OpenRouter request limit reached", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  { name: "ChatGPT plan sign-in refused", info: info("authentication", { engine: "codex", connection: { preset: "chatgpt", signIn: true } }), title: "ChatGPT needs you to sign in again", lead: "settings", primary: "Models &amp; engines", account: "your own ChatGPT sign-in" },
  { name: "SuperGrok plan payment", info: info("payment", { engine: "grokAgent", connection: { preset: "supergrok", signIn: true } }), title: "SuperGrok needs payment", lead: "fuigo", primary: "Switch Sable to Fuigo" },
  // Flux: worded as the Flux plan or credit, through the existing Add Flux credits action.
  { name: "Fuigo on Flux, out of credit", info: info("credits", { engine: "fuigoAgent", provider: "flux-router" }), title: "Flux Router needs credits", lead: "billing", href: "https://fluxrouter.ai/auth/sign-in?return_to=%2Fhome%2Fbilling", primary: "Add Flux credits", account: "your Flux plan" },
  { name: "Fuigo on Flux, 402", info: info("payment", { engine: "fuigoAgent", connection: { preset: "flux" } }), title: "Check your Flux plan or credit", lead: "billing", href: "https://fluxrouter.ai/auth/sign-in?return_to=%2Fhome%2Fbilling", primary: "Add Flux credits", account: "your Flux plan" },
  { name: "Flux key refused", info: info("authentication", { engine: "openai-compat", connection: { preset: "flux" } }), title: "Flux Router did not accept the sign-in", lead: "settings", primary: "Models &amp; engines" },
  { name: "Flux spending limit (no way to buy past it)", info: info("spend-cap", { engine: "fuigoAgent", provider: "flux-router" }), title: "Flux Router has reached its monthly spending limit", lead: "settings", primary: "Models &amp; engines" },
];

describe("every engine and AI service error names who said it and leads with one fix", () => {
  for (const row of ROWS) it(row.name, async () => {
    await setLocale("en");
    const html = render(row.info);
    expect(titleOf(html)).toBe(row.title);
    expect(html).toContain(`data-provider-lead="${row.lead}"`);
    expect(html.match(/data-provider-primary/g)).toHaveLength(1);
    expect(primaryOf(html)).toContain(row.primary);
    if (row.href) expect(primaryOf(html)).toContain(`href="${row.href.replace(/&/g, "&amp;")}"`);
    else expect(html).not.toContain("<a ");
    if (row.account) expect(html).toContain(row.account);
    // Retry stays, and stays out of the lead; details stay collapsed.
    expect(html).toContain("Retry</button>");
    expect(primaryOf(html)).not.toContain("Retry");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain(">AI service</p>");
  });
});

describe("the lead", () => {
  it("a provider label alone never makes a payment action; a server stamp or a credits reply still leads to billing", () => {
    const label = info("payment", { provider: "flux-router" });
    expect(providerErrorLead(label, serviceIdentity(label), undefined, true)).toEqual({ kind: "settings" });
    const stamped = info("payment", { provider: "flux-router", engine: "fuigoAgent" });
    expect(providerErrorLead(stamped, serviceIdentity(stamped), undefined, true)).toMatchObject({ kind: "billing" });
    const credits = info("credits", { provider: "flux-router" });
    expect(providerErrorLead(credits, serviceIdentity(credits), undefined, true)).toMatchObject({ kind: "billing" });
  });
  it("never offers a billing page inside the phone app; Fuigo leads instead when it can answer", () => {
    const service = serviceIdentity(info("payment", { engine: "grokAgent" }));
    expect(providerErrorLead(info("payment", { engine: "grokAgent" }), service, wall, false)).toEqual({ kind: "fuigo" });
    expect(providerErrorLead(info("payment", { engine: "grokAgent" }), service, undefined, false)).toEqual({ kind: "settings" });
  });
  it("does not offer Fuigo to a bot already on Fuigo", () => {
    const onFuigo: FuigoWall = { ...wall, bot: { ...wall.bot, modelSelection: { instanceId: "fuigo-1", model: "m" } } as FuigoWall["bot"] };
    expect(providerErrorLead(info("rate-limit", { engine: "fuigoAgent" }), serviceIdentity(info("rate-limit", { engine: "fuigoAgent" })), onFuigo, true)).toEqual({ kind: "settings" });
  });
  it("a card with no bot to move offers no switch", () => {
    const html = render(info("rate-limit", { engine: "geminiAgent" }), false);
    expect(html).not.toContain("Switch");
    expect(html).toContain('data-provider-lead="settings"');
  });
});

describe("stamps Murage has no name for", () => {
  it("keep the generic card, never a made-up name", async () => {
    await setLocale("en");
    for (const engine of ["evilAgent", "__proto__", "constructor", "toString"]) {
      const html = render(info("payment", { engine }));
      expect(titleOf(html)).toBe("Payment or account access needed");
      expect(html).not.toContain("<a ");
    }
    expect(titleOf(render(info("payment", { connection: { preset: "hasOwnProperty" } })))).toBe("Payment or account access needed");
  });
  it("a message saved before this build keeps its copy", async () => {
    await setLocale("en");
    expect(titleOf(render(info("payment")))).toBe("Payment or account access needed");
    expect(titleOf(render(info("rate-limit")))).toBe("Your AI service request limit reached");
  });
});

it("every language names the service in the title, the summary and the lead, with no placeholder left", async () => {
  for (const { code } of localeChoices) {
    await setLocale(code);
    const pack = locales[code] as Record<string, string | undefined>;
    for (const key of ["providerError.named.payment.title", "providerError.named.signIn.title", "providerError.named.key.title", "providerError.openBilling", "providerError.switchToFuigo", "providerError.account.own-sign-in"]) expect(pack[key], `${code} ${key}`).toBeTruthy();
    for (const value of [info("payment", { engine: "grokAgent" }), info("authentication", { engine: "claudeAgent" }), info("authentication", { connection: { preset: "openai" } }), info("rate-limit", { engine: "codex" })]) {
      const html = render(value);
      expect(html, code).not.toMatch(/\{(service|bot|provider)\}/);
    }
    const grok = render(info("payment", { engine: "grokAgent" }));
    expect(titleOf(grok)).toContain("Grok (xAI)");
    expect(titleOf(grok)).toBe((pack["providerError.named.payment.title"] ?? "").replace("{service}", "Grok (xAI)"));
    expect(primaryOf(render(info("rate-limit", { engine: "codex" })))).toContain("Sable");
  }
});

it("the new copy keeps the house rules: no em dashes, never safe or free", () => {
  for (const { code } of localeChoices) for (const [key, value] of Object.entries(locales[code])) {
    if (!/^providerError\.(named|account|openBilling|switchToFuigo)/.test(key)) continue;
    expect(value, `${code} ${key}`).not.toMatch(/—|\bsafe\b|\bfree\b/i);
  }
});
