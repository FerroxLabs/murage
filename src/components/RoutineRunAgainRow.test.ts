// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A card answered after its routine run had ended used to leave a dead end
// ("Couldn't deliver that answer — the request is no longer open"). The row
// now says what happened and offers Run again.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoutineRunAgainRow } from "./RoutineRunAgainRow";

describe("a late answer in a routine's conversation", () => {
  it("says the run ended and offers Run again", () => {
    const markup = renderToStaticMarkup(createElement(RoutineRunAgainRow, {
      text: "This run of Log tick ended before you answered, so nothing was run.",
      onRunAgain: () => {},
    }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("This run of Log tick ended before you answered, so nothing was run.");
    expect(markup).toMatch(/<button[^>]*>[\s\S]*Run again<\/button>/);
    expect(markup).not.toMatch(/—/);
  });
});
