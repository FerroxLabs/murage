// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { offerOrigin } from "./BrowserApprovedSites";

it("SABLE-LIVE: a blank tab's null site never becomes an Allow always offer", () => {
  expect(offerOrigin("null")).toBeNull();
  expect(offerOrigin("https://null")).toBeNull();
  expect(offerOrigin("")).toBeNull();
  expect(offerOrigin("www.google.com")).toBe("https://www.google.com");
  expect(offerOrigin("https://www.google.com")).toBe("https://www.google.com");
});

it("SABLE-LIVE: the null filter keeps IPv6 and one-word intranet hosts", () => {
  expect(offerOrigin("[::1]:8443")).toBe("https://[::1]:8443");
  expect(offerOrigin("http://[2001:db8::1]")).toBe("http://[2001:db8::1]");
  expect(offerOrigin("intranet")).toBe("https://intranet");
  expect(offerOrigin("wiki:8080")).toBe("https://wiki:8080");
  expect(offerOrigin("localhost")).toBe("https://localhost");
  expect(offerOrigin("  ")).toBeNull();
});
