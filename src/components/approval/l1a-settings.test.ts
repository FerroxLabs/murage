// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 13 (client): Settings › {bot} › Level lists
// "Things you said yes to for good" (bot keys and a group per routine, each
// with Take back), never a payment, and the 12-hour line with Clear; the
// phone lists bot-level ones read-only. Plus 3.1, 3.2 and 3.4: the chip's
// header line, the example table from LEVEL_EXAMPLES and the phone sheet.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ native: false }));
vi.mock("@/lib/native-shell", () => ({ inNativeShell: () => surface.native }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const store = {
    state: {
      bots: [], instances: [],
      routines: [
        { id: "r1", botId: "b1", name: "Morning brief", alwaysAllow: ["app-action:GMAIL_FETCH_EMAILS", "stop:pay:stripe:Brightline"] },
        { id: "r2", botId: "other", name: "Not this bot", alwaysAllow: ["Read"] },
      ],
    },
    dispatch: () => undefined,
  };
  return { ...actual, useStore: () => store, useStoreIfAny: () => store };
});

import { RememberedApprovals, listedGrants } from "@/components/RememberedApprovals";
import { PermissionModeMenu } from "@/components/PermissionModeMenu";
import { LevelExamples } from "./LevelExamples";
import { OWNER_ROWS } from "../../../shared/level-examples";

const BOT = {
  id: "b1", name: "Nova", taskAllowanceCount: 3,
  alwaysAllow: ["Bash:git", "stop:public:github:ferrox/murage", "stop:pay:stripe:Brightline"],
};
const settings = (desktop: boolean) => renderToStaticMarkup(createElement(RememberedApprovals, { bot: BOT, desktop }));

describe("2.5: Things you said yes to for good", () => {
  beforeEach(() => { surface.native = false; });
  it("lists the bot's keys and its routines' keys with Take back, and never a payment", () => {
    const html = settings(true);
    expect(html).toContain("Things you said yes to for good");
    expect(html).toContain("Any git command");
    expect(html).toContain("Posting publicly on github:ferrox/murage");
    expect(html).toContain("For this routine: Morning brief");
    expect(html).toContain("Gmail: fetch emails");
    expect(html).not.toContain("Brightline");
    expect(html).not.toContain("Not this bot");
    expect(html.match(/>Take back</g)?.length).toBe(3);
    expect(html).toContain('aria-label="Take back: Any git command"');
  });
  it("shows the 12-hour line with Clear", () => {
    const html = settings(true);
    expect(html).toContain("Allowed for the next 12 hours in open conversations: 3");
    expect(html).toMatch(/>Clear</);
  });
  it("on the phone app lists bot-level ones read-only and keeps routine and 12-hour take back", () => {
    surface.native = true;
    const html = settings(false);
    expect(html).toContain("Take back on your computer");
    expect(html.match(/>Take back</g)?.length).toBe(1);
    expect(html).toMatch(/>Clear</);
  });
  it("drops payments from any list", () => {
    expect(listedGrants(["stop:pay:a:b", "Read"])).toEqual(["Read"]);
  });
});

describe("3.1, 3.2 and 3.4: the level menu", () => {
  const menu = (desktop: boolean) => renderToStaticMarkup(createElement(PermissionModeMenu, {
    botName: "Nova", current: "auto", botDefault: "ask", desktop, scope: {}, onPick: () => undefined,
  }));
  it("the chip's header names this conversation, routines and the default", () => {
    expect(menu(true)).toContain("Changes this conversation only. Routines keep their own level. Nova&#x27;s default for new conversations is Ask, under Nova › Level.");
  });
  it("describes Auto and Full access by what still asks", () => {
    const html = menu(true);
    expect(html).toContain("Asks before paying, emailing someone new, posting in public, or deleting outside its folder.");
    expect(html).toContain("Still asks before paying, emailing someone new, posting in public, deleting outside its folder, or reading your keys and passwords.");
  });
  it("renders the table from LEVEL_EXAMPLES with the line under it", () => {
    const html = renderToStaticMarkup(createElement(LevelExamples, { current: "auto" }));
    expect(html.match(/data-level-row=/g)?.length).toBe(OWNER_ROWS.length);
    expect(html).toContain("What each level does, for a turn with nothing you said yes to before");
    expect(html).toContain("Routines keep their own level and never run above this one.");
    // keys and wipe commands ask at every level: never "Never"
    expect(html).not.toContain("Never");
    const pay = html.slice(html.indexOf('data-level-row="pay"'));
    expect(pay.slice(0, pay.indexOf("</tr>")).match(/data-cell="asks"/g)?.length).toBe(3);
  });
  it("on the phone greys Full access and No limits with the lock line", () => {
    const html = menu(false);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-level-option="full"/);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-level-option="unlimited"/);
    expect(html).not.toMatch(/aria-disabled="true"[^>]*data-level-option="auto"/);
    expect(html).toContain("Set this on your computer.");
    expect(html).toContain("Full access and No limits are set on your computer, where you can see what they change.");
  });
});
