// D25-V3 W10/W10b: the owner's "give the creator's apps" block. The preview comes from the server's copyFrom, the press sends exactly
// {action, revision, sourceDigest}, and any failure (409, 500) loads the server's view again and shows its message.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONNECTED_APP_TOOLS } from "../../shared/bot-access";
import { accessViews, BotAccessSettings, CopyFromBlock, pressCopyFromCreator, type AccessView } from "./BotAccessSettings";

const catalog = CONNECTED_APP_TOOLS.map((entry) => ({ ...entry }));
const accounts = [{ toolkit: "gmail", accountId: "ca_fixture_a", label: "Work mail" }];
const policy = { revision: 3, roleBinding: "x", mode: "unrestricted" as const, allowWrites: true, grants: [], requests: [] };
const view = (copyFrom?: AccessView["copyFrom"], enabled = false): AccessView => ({ enabled, policy, catalog, accounts, pending: [], ...(copyFrom ? { copyFrom } : {}) });
const offer = (extra: object = {}) => ({ creatorId: "c1", creatorName: "Creator", replaces: false, available: true as const, sourceDigest: "digest-1", unrestricted: false, allowWrites: false, grants: [{ toolkit: "gmail", accountId: "ca_fixture_a", tools: ["GMAIL_FETCH_EMAILS"] }], noLimits: false, draftOnly: false, ...extra });
const html = (v: AccessView, given = false) => renderToStaticMarkup(createElement(CopyFromBlock, { copy: v.copyFrom!, view: v, busy: false, given, onPress: () => {} }));

describe("W10 the preview", () => {
  it("shows the creator's apps, accounts and whether changes are allowed, and the one-off note", () => {
    const out = html(view(offer()));
    expect(out).toContain("Give this bot Creator&#x27;s connected apps");
    expect(out).toContain("Gmail (Work mail)");
    expect(out).toContain("Read only");
    expect(out).toContain("Give these apps");
    expect(out).toContain("Later changes to Creator&#x27;s apps do not change this bot&#x27;s");
    expect(out).not.toContain("replaces");
  });
  it("an unrestricted creator and a No limits bot both show the unrestricted line, never a narrower list", () => {
    expect(html(view(offer({ unrestricted: true, allowWrites: true, grants: [] })))).toContain("All connected apps, can send and change data");
    const noLimits = html(view(offer({ noLimits: true })));
    expect(noLimits).toContain("All connected apps, can send and change data (this bot is on No limits)");
    expect(noLimits).not.toContain("Read only");
  });
  it("a bot that already has apps says the press replaces them and reads Give again", () => {
    const out = html(view(offer({ replaces: true }), true), true);
    expect(out).toContain("This replaces this bot&#x27;s current app settings.");
    expect(out).toContain("Give again");
    expect(out).toContain("Given Creator&#x27;s apps");
  });
  it("an unavailable creator shows the plain line and no button", () => {
    const out = html(view({ creatorId: "c1", creatorName: "Creator", replaces: false, available: false, reason: "unavailable" }));
    expect(out).toContain("can&#x27;t share apps right now");
    expect(out).not.toContain("<button");
  });
  it("the collapsed summary names the offer while apps are off, and keeps its old line otherwise", () => {
    const summary = (v: AccessView | undefined, id: string) => { if (v) accessViews.set(id, v); return renderToStaticMarkup(createElement(BotAccessSettings, { botId: id })); };
    expect(summary(view(offer()), "bot-offered")).toContain("Apps are off. You can give it Creator&#x27;s apps.");
    expect(summary(view(offer({ replaces: true }), true), "bot-copied")).toContain("No pending approvals");
    expect(summary(view(), "bot-plain")).toContain("No pending approvals");
  });
  it("the press sends exactly action, revision and sourceDigest", async () => {
    const sent: unknown[] = [];
    const result = await pressCopyFromCreator({ view: view(offer()), apply: () => {}, request: async (init) => { sent.push(init); return view(offer({ replaces: true }), true); } });
    expect(result).toEqual({});
    expect(sent).toHaveLength(1);
    const call = sent[0] as { method: string; body: string };
    expect(call.method).toBe("PUT");
    expect(JSON.parse(call.body)).toEqual({ action: "copy-from-creator", revision: 3, sourceDigest: "digest-1" });
  });
});

describe("W10b a failed press loads the server's view again", () => {
  for (const [status, message] of [[409, "Creator's apps changed. Review the new list before giving them."], [500, "Murage could not record this change."]] as const) {
    it(`${status}: the new view is applied and the server's message is shown`, async () => {
      const applied: AccessView[] = [];
      const fresh = view(offer({ sourceDigest: "digest-2", replaces: true }), true);
      let calls = 0;
      const result = await pressCopyFromCreator({ view: view(offer()), apply: (next) => applied.push(next), request: async (init) => { calls++; if (init) throw Object.assign(new Error(message), { status }); return fresh; } });
      expect(calls).toBe(2);
      expect(applied).toEqual([fresh]);
      expect(result).toEqual({ error: message });
    });
  }
});
