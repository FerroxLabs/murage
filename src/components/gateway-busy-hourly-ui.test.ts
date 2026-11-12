// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// FLUX-BURN-COPY-1018: the one card for Flux's hourly spend gate says the hourly limit is reached, names the reset time only
// when the server carried one, and offers no Add credit (more credit does not lift an hourly cap).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GatewayBusyCard, gatewayBusyOffersCredit, gatewayBusyReason, gatewayBusyResetTime } from "./GatewayBusyCard";

const AT = Date.UTC(2026, 10, 7, 15, 30);

it("the hourly reason is a card reason, and the card says the Flux hourly limit is reached, with no time", () => {
  expect(gatewayBusyReason("hourly")).toBe("hourly");
  const html = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "hourly" }));
  expect(html).toContain("You&#x27;ve reached your Flux hourly limit. Your message is kept.");
  expect(html).not.toContain("resets");
  expect(html).not.toContain("data-gateway-credit");
  expect(gatewayBusyOffersCredit("hourly", true)).toBe(false);
});

it("with a reset time from the server the card names it", () => {
  const html = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "hourly", resetsAt: AT }));
  expect(html).toContain(`You&#x27;ve reached your Flux hourly limit. It resets at about ${gatewayBusyResetTime(AT)}. Your message is kept.`);
  expect(gatewayBusyResetTime(AT)).toMatch(/\d/);
});

it("a reset time on any other reason, or a bad one, names no time", () => {
  expect(renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "busy", resetsAt: AT }))).not.toContain("resets");
  expect(renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "hourly", resetsAt: Number.NaN }))).not.toContain("resets");
});

it("repeated refusals show one plain card with retry, model choice and help", () => {
  const html = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "repeated", shortReason: "capacity unavailable", onRetry() {}, onChooseAI() {}, onGetHelp() {} }));
  expect(html).toContain("Fuigo keeps rejecting this request. Your message is saved. Try again or use another AI.");
  expect(html).toContain("capacity unavailable");
  for (const label of ["Try again", "Use another AI", "Get help"]) expect(html).toContain(label);
  expect(html.match(/<section/g)).toHaveLength(1);
  expect(html).not.toContain("busy right now");
  expect(html).not.toContain("data-gateway-credit");
});

it("free cap offers a plan upgrade, as Flux specifies", () => {
  const html = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: "Fuigo", reason: "freeCap", onRetry() {} }));
  expect(html).toContain("this month&#x27;s free Flux allowance");
  expect(html).toContain("data-gateway-plan");
  expect(html).not.toContain("busy right now");
});

it('A2.1 cause cards keep free allowance, token budget and unknown refusals distinct', () => {
  for (const reason of ['keyTokens', 'botBudget', 'keyAccess', 'keyRefused', 'fluxStop', 'unknownLimit'] as const) {
    expect(gatewayBusyReason(reason)).toBe(reason);
    const html = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: 'Flux', reason, onRetry() {} }));
    expect(html).toContain(`data-gateway-busy="${reason}"`);
    expect(html).not.toContain('data-gateway-credit');
  }
  const cap = renderToStaticMarkup(createElement(GatewayBusyCard, { engine: 'Flux', reason: 'freeCap', onRetry() {} }));
  expect(cap).toContain('Upgrade your Flux plan');
  expect(cap).not.toContain('Add credit');
});
