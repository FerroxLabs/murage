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
