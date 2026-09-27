// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A delegation waiting on a busy teammate could not be stopped from anywhere
// (0.1.60 Linux re-test 4, L4-1). Its line now offers Stop.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationWaitRow } from "./DelegationWaitRow";

describe("a delegation waiting on a busy teammate", () => {
  it("says who it waits on and offers Stop", () => {
    const markup = renderToStaticMarkup(createElement(DelegationWaitRow, {
      text: "Delegation to @Maple waiting: they're busy (retry 1/3 when they finish)",
      onStop: () => {},
    }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Delegation to @Maple waiting");
    expect(markup).toMatch(/<button[^>]*>[\s\S]*Stop<\/button>/);
    expect(markup).not.toMatch(/—/);
  });

  it("is offered in a bot's chat and in a channel, before the Tool calls filter", () => {
    for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const row = source.indexOf("<DelegationWaitRow");
      expect(row, file).toBeGreaterThan(0);
      expect(source.slice(row, row + 300), file).toContain('type: "stopDelegation"');
    }
  });
});
