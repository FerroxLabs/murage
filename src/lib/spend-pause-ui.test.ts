// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { SpendPauseStatus } from "../../shared/spend-pause";

const fixture = vi.hoisted(() => ({ pause: null as SpendPauseStatus | null }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("@/components/today/MonthCard", () => ({
  useMonthReading: () => ({ show: true, pause: fixture.pause, total: { state: "pending" }, state: { limitUsd: 100 }, refresh() {} }),
  monthLine: () => "Spending pending",
}));
vi.mock("@/components/today/MonthCardView", () => ({ asOfLine: () => "" }));
import { ownerSpendPause } from "../../server/spend-pause";
import { SpendPauseCard } from "../components/SpendPauseCard";
import { SpendLimitCard } from "../components/SpendLimitCard";

const status = (held: SpendPauseStatus["held"]): SpendPauseStatus => ({ capability: "on", limitUsd: 100, figure: null, held, headsUpOnlyNotice: false });
const render = (pause: SpendPauseStatus) => renderToStaticMarkup(createElement(SpendPauseCard, { status: pause, onOpenUsage() {}, onRefresh() {} }));

it("several held credentials offer one primary action while keeping each reason visible", () => {
  const html = render(status([
    { credentialId: "account", holds: [{ kind: "unknown" }] },
    { credentialId: "bank:other", holds: [{ kind: "flux", limit: "monthly_tokens" }] },
  ]));
  expect(html).toContain("cannot read Flux Router");
  expect(html).toContain("monthly usage limit");
  expect(html.match(/class="[^"]*bg-accent[^"]*"/g)).toHaveLength(1);
});

it("an email-only hold explains its scope without claiming all Flux work waits", () => {
  const html = render(status([{ credentialId: "bot:b", botName: "Sam", emailOnly: true, holds: [{ kind: "flux", limit: "bot_monthly_spend" }] }]));
  expect(html).toContain("email waits");
  expect(html).not.toContain("New work on Flux Router waits");
});

it("the active account meter does not claim it counts chat only", () => {
  fixture.pause = status([]);
  expect(renderToStaticMarkup(createElement(SpendLimitCard))).not.toContain("Counts chat use");
  fixture.pause = { ...status([]), capability: "off" };
  expect(renderToStaticMarkup(createElement(SpendLimitCard))).toContain("Counts chat use");
});

it("several email-only holds never claim that unrelated Flux work waits", () => {
  const held: SpendPauseStatus["held"] = [
    { credentialId: "bot:one", holds: [{ kind: "flux", limit: "bot_monthly_spend" }] },
    { credentialId: "bot:two", holds: [{ kind: "flux", limit: "monthly_tokens" }] },
  ];
  const projected = ownerSpendPause({ status: () => status(held) } as Parameters<typeof ownerSpendPause>[0], id => id === "one" ? "Sam" : "Alex");
  const html = render(projected);
  expect(html.match(/email waits/g)).toHaveLength(2);
  expect(html).not.toContain("New work on Flux Router waits");
});
