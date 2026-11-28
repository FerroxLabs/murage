// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmClearsAppChoices, clearedChoicesLine, confirmClearsCopy } from "@/components/settings/ConfirmClearsAppChoices";
import { archiveReviewed, archiveReviewedList } from "./archive-review";

const ava = { id: "ava", name: "Ava", accessRevision: 2, savedChoices: ["Mail", "Calendar"] };
const ben = { id: "ben", name: "Ben", accessRevision: 1, savedChoices: [] };
const cal = { id: "cal", name: "Cal", accessRevision: 4, savedChoices: ["Docs"] };
const conflict = () => Object.assign(new Error("changed"), { status: 409 });

describe("archiveReviewed", () => {
  it("sends the reviewed accessRevision with the archive", async () => {
    const sent: Array<[string, unknown]> = [];
    const result = await archiveReviewed(ava, async (path, init) => (sent.push([path, JSON.parse(init.body)]), { bot: {} }));
    expect(result.outcome).toBe("archived");
    expect(sent).toEqual([["/api/bots/ava", { hidden: true, accessRevision: 2 }]]);
  });
  it("reports a 409 as conflict and rethrows anything else", async () => {
    expect(await archiveReviewed(ava, async () => { throw conflict(); })).toEqual({ outcome: "conflict" });
    await expect(archiveReviewed(ava, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  });
});

describe("archiveReviewedList (bulk Archive)", () => {
  it("one bot changed after review: only that bot is not archived, and it is named", async () => {
    const result = await archiveReviewedList([ava, ben, cal], async (path) => {
      if (path.endsWith("/ben")) throw conflict();
      return {};
    });
    expect(result.archived.map((bot) => bot.id)).toEqual(["ava", "cal"]);
    expect(result.changed.map((bot) => bot.name)).toEqual(["Ben"]);
    expect(result.failed).toEqual([]);
  });
  it("a failure that is not a conflict is reported per bot and does not stop the rest", async () => {
    const result = await archiveReviewedList([ava, cal], async (path) => {
      if (path.endsWith("/ava")) throw new Error("offline");
      return {};
    });
    expect(result.archived.map((bot) => bot.id)).toEqual(["cal"]);
    expect(result.failed).toEqual([{ bot: ava, message: "offline" }]);
  });
});

describe("ConfirmClearsAppChoices", () => {
  it("single form names the bot and its apps, and says what is kept", () => {
    expect(clearedChoicesLine(ava)).toBe("Ava: Mail, Calendar");
    const html = renderToStaticMarkup(createElement(ConfirmClearsAppChoices, { bots: [ava], action: "archive", onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("Archive Ava?");
    expect(html).toContain("Ava: Mail, Calendar");
    expect(html).toContain("Chats, memory and skills are kept");
    expect(html).not.toMatch(/reversible/i);
  });
  it("list form shows every bot, including one with saved choices and no apps", () => {
    const html = renderToStaticMarkup(createElement(ConfirmClearsAppChoices, { bots: [ava, ben, cal], action: "archive", onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("Archive 3 bots?");
    for (const line of ["Ava: Mail, Calendar", "Ben: saved choices with no apps chosen", "Cal: Docs"]) expect(html).toContain(line);
  });
  it("team delete wording names both choices", () => {
    expect(confirmClearsCopy([ava], "deleteTeamKeep").lead).toContain("Both choices clear these saved app choices");
    expect(confirmClearsCopy([ava], "deleteTeamArchive").confirm).toBe("Delete team and archive bots");
  });
});
