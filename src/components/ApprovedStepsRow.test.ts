// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovedStepsRow, isApprovedStepsLine } from "./ApprovedStepsRow";
import type { Message } from "@/state/store";

const line = (steps: string[], stepCount = steps.length): Message => ({
  id: "m", role: "bot", kind: "activity", at: 1,
  tool: { name: `Approved ${stepCount} steps (Full access)`, ok: true, steps, stepCount },
});

describe("Full access approvals as one line", () => {
  it("shows the count and lists every step when opened", () => {
    const markup = renderToStaticMarkup(createElement(ApprovedStepsRow, { message: line(["shell: npm test", "edit: src/a.ts"]) }));
    expect(markup).toContain("Approved 2 steps (Full access)");
    expect(markup).toContain("<details");
    expect(markup).toContain("shell: npm test");
    expect(markup).toContain("edit: src/a.ts");
  });

  it("says how many earlier steps fell off the list", () => {
    const markup = renderToStaticMarkup(createElement(ApprovedStepsRow, { message: line(["shell: ls"], 201) }));
    expect(markup).toContain("200 earlier steps not listed");
  });

  it("is told apart from an ordinary tool chip", () => {
    expect(isApprovedStepsLine(line(["x"]))).toBe(true);
    expect(isApprovedStepsLine({ id: "c", role: "bot", kind: "activity", at: 1, tool: { name: "Bash", ok: true } })).toBe(false);
  });
});
