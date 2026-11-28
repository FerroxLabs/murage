// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { StripView } from "@/lib/memory-integrity-view";
import { MemoryIntegrityStripView } from "./MemoryIntegrityStrip";

const view: StripView = { kind: "working", role: "status", text: "You can chat as usual. Checking earlier memory, 99%. Bots pick up their earlier replies again when this is done.", percent: 99, phaseLabel: null, left: null } as StripView;
const occurrences = (html: string) => html.split("Checking earlier memory").length - 1;
it("the first reading puts the banner sentence on the page once", () => {
  expect(occurrences(renderToStaticMarkup(h(MemoryIntegrityStripView, { view })))).toBe(1);
  expect(occurrences(renderToStaticMarkup(h(MemoryIntegrityStripView, { view, announced: view.text })))).toBe(1);
});
it("a lagging spoken line is still announced", () => {
  const html = renderToStaticMarkup(h(MemoryIntegrityStripView, { view, announced: "Checking earlier memory, 90%" }));
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("90%");
});
