// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { publishFailureOf, readPublishCard } from "./publish-card.ts";
import { readPublishedSites } from "./published-sites.ts";

const card = (publish: unknown) => ({ kind: "publish", publish });
const ok = { action: "publish", host: "netlify", url: "https://shop.netlify.app", siteName: "shop", files: [{ path: "index.html", size: 12 }], totalBytes: 12 };

it("reads a well-formed publish card and refuses anything else", () => {
  expect(readPublishCard(card(ok))).toEqual(ok);
  for (const bad of [null, {}, { kind: "other", publish: ok }, card(null), card({ ...ok, host: "vercel" }), card({ ...ok, url: "http://shop.netlify.app" }),
    card({ ...ok, files: [{ path: "a", size: -1 }] }), card({ ...ok, progress: { step: "done" } }), card({ ...ok, action: "rm" })]) expect(readPublishCard(bad)).toBeNull();
});

it("maps server error codes to the owner-facing failure", () => {
  expect(publishFailureOf("reconnect")).toBe("reconnect");
  expect(publishFailureOf("rate-limited")).toBe("wait");
  expect(publishFailureOf("host-down")).toBe("wait");
  expect(publishFailureOf("too-large")).toBe("too-big");
  expect(publishFailureOf("too-many-files")).toBe("too-big");
  expect(publishFailureOf("anything-else")).toBe("other");
});

it("keeps only well-formed site records, one per site", () => {
  const site = { siteId: "abc-1", name: "shop", url: "https://shop.netlify.app", lastPublishedAt: 5, lastFileCount: 3, origin: "created" };
  expect(readPublishedSites([site, { ...site, lastFileCount: 9 }, { ...site, siteId: "../x" }, { ...site, url: "http://x" }, null, "x"])).toEqual([{ ...site, lastFileCount: 9 }]);
  expect(readPublishedSites("nope")).toEqual([]);
});
