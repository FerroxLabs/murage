// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rules one notice lives by: limits, fixed lists, where images may come
// from, who sees it when, and the three bits of Markdown its body may use.
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_GRACE_MS,
  ANNOUNCEMENT_LIMITS,
  allowedImageUrl,
  checkAnnouncement,
  checkAnnouncementFeed,
  parseAnnouncementBody,
  versionInRange,
  visibleAnnouncements,
  type Announcement,
} from "./announcements.ts";

const base = { id: "flux-voice", kind: "info", title: "Voice calls through Flux", body: "Call any bot. **No extra keys.**" };
const IMAGE = "https://updates.ferroxlabs.com/murage/images/voice.webp";
const item = (extra: Record<string, unknown> = {}): Announcement => {
  const checked = checkAnnouncement({ ...base, ...extra });
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  return checked.value;
};
const feed = (items: unknown[], issuedAt = "2026-09-25T10:00:00Z") => JSON.stringify({ version: 1, issuedAt, items });

describe("one notice", () => {
  it("accepts the smallest notice and fills in the defaults", () => {
    expect(item()).toEqual({ ...base, layout: "spotlight", accent: "orange" });
    expect(item({ image: IMAGE, imageAlt: "An orb" }).layout).toBe("hero");
  });

  it("enforces the length limits", () => {
    expect(checkAnnouncement({ ...base, title: "x".repeat(ANNOUNCEMENT_LIMITS.title) }).ok).toBe(true);
    expect(checkAnnouncement({ ...base, title: "x".repeat(ANNOUNCEMENT_LIMITS.title + 1) }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, body: "x".repeat(ANNOUNCEMENT_LIMITS.body + 1) }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, id: "Has Spaces" }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, kind: "urgent" }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, link: { label: "x".repeat(31), url: "https://ferroxlabs.com" } }).ok).toBe(false);
  });

  it("only takes images from our host, over https, in our folder", () => {
    expect(allowedImageUrl(IMAGE)).toBe(true);
    for (const bad of [
      "http://updates.ferroxlabs.com/murage/images/voice.webp",
      "https://evil.example/murage/images/voice.webp",
      "https://updates.ferroxlabs.com.evil.example/murage/images/voice.webp",
      "https://updates.ferroxlabs.com/murage/other/voice.webp",
      "https://updates.ferroxlabs.com/murage/images/../voice.webp",
      "https://updates.ferroxlabs.com/murage/images/voice.svg",
      "https://updates.ferroxlabs.com/murage/images/voice.webp?x=1",
      "https://user@updates.ferroxlabs.com/murage/images/voice.webp",
    ]) {
      expect(allowedImageUrl(bad), bad).toBe(false);
      expect(checkAnnouncement({ ...base, image: bad, imageAlt: "x" }).ok, bad).toBe(false);
    }
    expect(checkAnnouncement({ ...base, image: IMAGE }).ok).toBe(false); // no alt text
  });

  it("allows only https links and in-app actions from the fixed list", () => {
    expect(item({ link: { label: "Read more", url: "https://ferroxlabs.com/status" } }).link?.url).toBe("https://ferroxlabs.com/status");
    expect(checkAnnouncement({ ...base, link: { label: "Read", url: "http://ferroxlabs.com" } }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, link: { label: "Read", url: "javascript:alert(1)" } }).ok).toBe(false);
    expect(item({ action: { label: "Check now", target: "check-for-updates" } }).action?.target).toBe("check-for-updates");
    expect(checkAnnouncement({ ...base, action: { label: "Go", target: "open-anything" } }).ok).toBe(false);
    expect(checkAnnouncement({ ...base, link: { label: "a", url: "https://a.b" }, action: { label: "b", target: "settings-general" } }).ok).toBe(false);
  });

  it("falls back on unknown layouts in the app, and refuses them in the lint", () => {
    const lenient = checkAnnouncement({ ...base, layout: "carousel", accent: "neon" });
    expect(lenient.ok && [lenient.value.layout, lenient.value.accent]).toEqual(["spotlight", "orange"]);
    const strict = checkAnnouncement({ ...base, layout: "carousel", accent: "neon", extra: 1 }, { strict: true });
    expect(strict.ok).toBe(false);
    expect(!strict.ok && strict.errors.join("\n")).toMatch(/layout[\s\S]*accent|unknown field/);
  });

  it("holds published copy to the copy rules", () => {
    for (const body of ["It is safe now.", "Faster — and calmer.", "Connect with Composio.", "<b>hi</b>", "# Heading", "- a list", "`code`", "[read](http://x.y)"]) {
      expect(checkAnnouncement({ ...base, body }, { strict: true }).ok, body).toBe(false);
    }
    expect(checkAnnouncement({ ...base, body: "Plain words, **bold** and a [link](https://ferroxlabs.com)." }, { strict: true }).ok).toBe(true);
  });
});

describe("the feed envelope", () => {
  it("drops a bad notice but keeps the rest", () => {
    const checked = checkAnnouncementFeed(feed([base, { ...base, id: "bad", kind: "nope" }, { ...base }]));
    expect(checked.ok && checked.value.items.map((entry) => entry.id)).toEqual(["flux-voice"]);
    expect(checked.ok && checked.warnings.length).toBe(2);
  });

  it("rejects an oversized, malformed or unversioned feed", () => {
    expect(checkAnnouncementFeed("x".repeat(ANNOUNCEMENT_LIMITS.feedBytes + 1)).ok).toBe(false);
    expect(checkAnnouncementFeed("{not json").ok).toBe(false);
    expect(checkAnnouncementFeed(JSON.stringify({ version: 2, issuedAt: "2026-09-25T10:00:00Z", items: [] })).ok).toBe(false);
    expect(checkAnnouncementFeed(JSON.stringify({ version: 1, issuedAt: "yesterday", items: [] })).ok).toBe(false);
    expect(checkAnnouncementFeed(feed(Array.from({ length: ANNOUNCEMENT_LIMITS.items + 1 }, (_, n) => ({ ...base, id: `n${n}` })))).ok).toBe(false);
  });
});

describe("who sees what", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const audience = { version: "0.1.60", platform: "mac" as const, now, dismissed: new Set<string>(), showOptional: true };
  const ids = (items: Announcement[], extra: Partial<typeof audience> = {}) => visibleAnnouncements(items, { ...audience, ...extra }).map((entry) => entry.id);

  it("matches version ranges", () => {
    expect(versionInRange("0.1.60", ">=0.1.60 <0.2.0")).toBe(true);
    expect(versionInRange("0.1.59", ">=0.1.60 <0.2.0")).toBe(false);
    expect(versionInRange("0.2.0", ">=0.1.60 <0.2.0")).toBe(false);
    expect(versionInRange("0.1.58", "0.1.58 || >=0.1.61")).toBe(true);
    expect(versionInRange("0.1.60-beta.1", "<0.1.60")).toBe(true);
    expect(versionInRange("0.1.60", "*")).toBe(true);
    expect(checkAnnouncement({ ...base, appVersions: "^0.1" }).ok).toBe(false);
  });

  it("filters on version, platform, window with grace, and dismissal", () => {
    const items = [
      item({ id: "for-old", appVersions: "<0.1.60" }),
      item({ id: "for-windows", platforms: ["windows"] }),
      item({ id: "for-mac", platforms: ["mac", "linux"] }),
      item({ id: "later", startsAt: new Date(now + ANNOUNCEMENT_GRACE_MS + 60_000).toISOString() }),
      item({ id: "almost-started", startsAt: new Date(now + ANNOUNCEMENT_GRACE_MS - 60_000).toISOString() }),
      item({ id: "over", endsAt: new Date(now - ANNOUNCEMENT_GRACE_MS - 60_000).toISOString() }),
      item({ id: "just-over", endsAt: new Date(now - ANNOUNCEMENT_GRACE_MS + 60_000).toISOString() }),
      item({ id: "dismissed" }),
    ];
    expect(ids(items, { dismissed: new Set(["dismissed"]) })).toEqual(["almost-started", "for-mac", "just-over"]);
    expect(ids(items, { platform: null, dismissed: new Set(["dismissed"]) })).not.toContain("for-mac");
  });

  it("puts security first, then important, then newest; the switch never hides security", () => {
    const items = [
      item({ id: "info-old", startsAt: "2026-09-20T00:00:00Z" }),
      item({ id: "info-new", startsAt: "2026-09-24T00:00:00Z" }),
      item({ id: "important", kind: "important" }),
      item({ id: "security", kind: "security" }),
    ];
    expect(ids(items)).toEqual(["security", "important", "info-new", "info-old"]);
    expect(ids(items, { showOptional: false })).toEqual(["security"]);
  });
});

describe("the body's Markdown subset", () => {
  it("makes paragraphs, bold and https links, and nothing else", () => {
    expect(parseAnnouncementBody("Hello **there**.\nSame paragraph.\n\nRead [the notes](https://ferroxlabs.com/n).")).toEqual([
      [{ type: "text", text: "Hello " }, { type: "bold", text: "there" }, { type: "text", text: ". Same paragraph." }],
      [{ type: "text", text: "Read " }, { type: "link", text: "the notes", href: "https://ferroxlabs.com/n" }, { type: "text", text: "." }],
    ]);
  });

  it("keeps anything else as literal text", () => {
    expect(parseAnnouncementBody("[x](javascript:alert(1)) <img src=x onerror=y> # no heading")).toEqual([
      [{ type: "text", text: "[x](javascript:alert(1)) <img src=x onerror=y> # no heading" }],
    ]);
    expect(parseAnnouncementBody("[plain](http://ferroxlabs.com) and *one star*")).toEqual([[{ type: "text", text: "plain and *one star*" }]]);
  });
});
