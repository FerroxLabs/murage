// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 B2-page: the bot's Archive or delete block. Archive is drawn before Delete, an archive of a bot with
// saved app choices goes through roster's review (with the reviewed accessRevision), a bot with none archives in one click.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (orig) => ({
  ...(await orig<typeof import("@/state/store")>()),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

import { openArchiveReview, readArchiveReviewBot } from "@/lib/archive-review";
import { ArchiveOrDeleteRow, archiveFromProfile, defaultArchiveSteps } from "./BotArchiveRow";

const ava = { id: "ava", name: "Ava", accessRevision: 2, savedChoices: ["Mail", "Calendar"] };
const kit = { id: "kit", name: "Kit", accessRevision: 0, savedChoices: [] as string[] };

describe("Archive or delete block (B2-page)", () => {
  const html = renderToStaticMarkup(createElement(ArchiveOrDeleteRow, { bot: { id: "ava", name: "Ava" } as never }));
  it("draws Archive before Delete, each with its own consequence line", () => {
    expect(html.indexOf("Archive Ava")).toBeGreaterThan(-1);
    expect(html.indexOf("Archive Ava")).toBeLessThan(html.indexOf("Delete Ava"));
    expect(html).toContain("Its saved app choices are not kept");
    expect(html).toContain("A backup is the only way back");
  });
  it("is the identity page's bot.identity.archive row", () => {
    expect(html).toContain('data-setting="bot.identity.archive"');
  });
});

describe("default steps", () => {
  it("the real review step is roster's openArchiveReview, not a direct archive", () => {
    expect(defaultArchiveSteps.review).not.toBe(defaultArchiveSteps.archive);
    expect(String(defaultArchiveSteps.review)).toContain("openArchiveReview");
    expect(typeof openArchiveReview).toBe("function");
  });
});

describe("archiveFromProfile", () => {
  it("a bot with saved choices opens the review, and only a confirmed review archives", async () => {
    const calls: string[] = [];
    const out = await archiveFromProfile({ id: "ava", name: "Ava" }, {
      read: async () => ava,
      review: async (bot) => (calls.push(`review:${bot.accessRevision}`), "archived"),
      archive: async () => (calls.push("direct"), { outcome: "archived" as const }),
    });
    expect(calls).toEqual(["review:2"]);
    expect(out).toBe("archived");
  });
  it("a bot with nothing saved archives in one click, with its revision, and never opens the review", async () => {
    const calls: string[] = [];
    const out = await archiveFromProfile({ id: "kit", name: "Kit" }, {
      read: async () => kit,
      review: async () => (calls.push("review"), "archived"),
      archive: async (bot) => (calls.push(`direct:${bot.accessRevision}`), { outcome: "archived" as const }),
    });
    expect(calls).toEqual(["direct:0"]);
    expect(out).toBe("archived");
  });
  it("a changed bot (409) reports conflict and nothing else happens", async () => {
    const out = await archiveFromProfile({ id: "kit", name: "Kit" }, { read: async () => kit, review: async () => "archived", archive: async () => ({ outcome: "conflict" as const }) });
    expect(out).toBe("conflict");
  });
});

describe("archiveFromProfile with a saved policy that names no apps (Astra High)", () => {
  const readPolicy = (policy: object) => (bot: { id: string; name: string }) => readArchiveReviewBot(bot, async () => ({ policy }));
  const run = async (policy: object) => {
    const calls: string[] = [];
    await archiveFromProfile({ id: "kit", name: "Kit" }, {
      read: readPolicy(policy),
      review: async (bot) => (calls.push(`review:${bot.accessRevision}`), "cancelled"),
      archive: async () => (calls.push("direct"), { outcome: "archived" as const }),
    });
    return calls;
  };
  it("restricted with zero grants, revision 3, opens the review and never archives in one click", async () => {
    expect(await run({ revision: 3, mode: "restricted", allowWrites: false, grants: [] })).toEqual(["review:3"]);
  });
  it("a saved revision with the default-looking shape still opens the review", async () => {
    expect(await run({ revision: 1, mode: "unrestricted", allowWrites: true, grants: [] })).toEqual(["review:1"]);
  });
  it("the untouched default policy still archives in one click", async () => {
    expect(await run({ revision: 0, mode: "unrestricted", allowWrites: true, grants: [] })).toEqual(["direct"]);
  });
});
