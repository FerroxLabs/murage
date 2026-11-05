// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import * as service from "./browser-extension-service.ts";

// SABLE-LIVE: an open from a blank tab (origin "null") is logged under the
// site it goes to, so the activity list and the end-of-task offer never show "null".
it("SABLE-LIVE: a blank tab's open names its destination site", () => {
  const activitySite = (service as Record<string, unknown>).activitySite as undefined | ((d: { url: string; origin: string }, to?: unknown) => string);
  expect(typeof activitySite).toBe("function");
  const blank = { url: "about:blank", origin: "null" };
  expect(activitySite!(blank, "https://www.google.com/search?q=x")).toBe("www.google.com");
  expect(activitySite!(blank, "http://intranet:8080/")).toBe("intranet:8080");
  // No usable destination: the line keeps what the tab says.
  expect(activitySite!(blank, "javascript:alert(1)")).toBe("null");
  expect(activitySite!(blank)).toBe("null");
  // A real page keeps its own site, whatever it opens next.
  expect(activitySite!({ url: "https://mail.example.com/inbox", origin: "https://mail.example.com" }, "https://other.example")).toBe("mail.example.com");
});
