// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 T1/B2 (hunt-turnerr): a reply Murage itself could not start (server/index.ts MURAGE_NOT_STARTED_LINE, written for a raw internal
// code such as wipe-guard-invalid-turn or instance_not_attached) reads as Murage's own plain line with Retry. It never sends the owner to
// Models and never says "pick another model"; the code stays under Technical details.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeErrorCard } from "./RuntimeErrorCard";

const render = (message: string, details?: string) => renderToStaticMarkup(createElement(RuntimeErrorCard,
  { message, details, botName: "Sable", onRetry: () => {}, onOpenProviderSettings: () => {} }));

describe("1.0.20 T1/B2: Murage's own setup failure card", () => {
  it("shows the Murage line and Retry, no Models button and no 'pick another model'; the code only under Technical details", () => {
    const [visible, details] = render("Murage couldn't start this reply. Send it again.", "wipe-guard-invalid-turn").split("<details");
    expect(visible).toContain("Murage couldn&#x27;t start this reply. Send it again.");
    expect(visible).toContain("Retry");
    expect(visible).not.toContain("Models");
    expect(visible).not.toContain("pick another model");
    expect(visible).not.toContain("wipe-guard");
    expect(details).toContain("wipe-guard-invalid-turn");
  });
  it("renders the blocked memory check with one reason and one Retry button", () => {
    const markup = render("Murage couldn’t check memory, so your message was not sent.");
    expect(markup.match(/Murage couldn’t check memory, so your message was not sent\./g)).toHaveLength(1);
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("<details");
  });
  it.each(["invalid_api_key", "usage_limit_reached", "rate_limit_exceeded", "model_not_found"])("an engine's own bare code %s keeps its card: Models offered, not Murage's line", code => {
    const [visible, details] = render(code, code).split("<details");
    expect(visible).toContain("Models");
    expect(visible).not.toContain("Murage couldn");
    expect(visible + details).toContain(code);
  });
  it("an engine's own error still offers Models (control)", () => {
    expect(render("The engine process exited unexpectedly").split("<details")[0]).toContain("Models");
  });
});
