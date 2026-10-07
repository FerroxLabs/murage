// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createCardStartBoundary } from "./project-card-start.ts";
it("captures provider rate-limit details before an empty terminal", () => {
  const boundary = createCardStartBoundary();
  boundary.observe({ type: "runtime.error", message: "Try again", details: "429 too many requests" });
  expect(boundary.failure()?.message).toContain("429"); expect(boundary.worked()).toBe(false);
});
it.each(["content.delta", "plan.updated", "item.started", "item.completed", "request.opened"])("never retries after %s even if a later error says 429", type => {
  const boundary = createCardStartBoundary(); boundary.observe({ type });
  boundary.observe({ type: "runtime.error", message: "429" }); expect(boundary.worked()).toBe(true);
});
