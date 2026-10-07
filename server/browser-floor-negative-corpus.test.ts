// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { classifyFloor } from "./browser-floor.ts";

// Near misses exercise word boundaries and benign long labels without length exemptions.
it.each(["Payroll", "Repay now", "Payment settings", "Purchase history", "Order history", "Track order",
  "Continue shopping", "Open menu", "I do not agree", "Reject all", "Add to cart",
  "A description of our woodland project ".repeat(8), "We donated trees to the national forest ".repeat(8),
  "搜尋 Search", "検索 Search", "पासवर्ड सहायता"])("keeps the negative corpus clear: %s", name => {
  expect(classifyFloor({ operation: "click", tag: "a", role: "link", name }).floor).toBeNull();
});
