// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 10: the copy lint over every ux.l1.* string and
// the server lines this lane writes: no em dash, never the banned
// reassurance word, every key under its lane prefix; every why-line key the
// server can return has its English here; the F16 transcript line matches
// its catalogue entry.
import { describe, expect, it } from "vitest";

import l1 from "../src/locales/en-ux/l1.json" with { type: "json" };
import { recipientsNotNotedLine } from "./stop-line-state.ts";
import { stoppedWaiting, RUN_ENDED } from "./grant-choke.ts";
import { routineCardRefusal } from "./approval-grant-routes.ts";
import { ROUTINE_PAY_NOT_REMEMBERED } from "./approval-grant-request.ts";

const DASH = /—|\s[–−]\s/u;
const BANNED = /(?<![\p{L}])(safe|safely|safety|unsafe)(?![\p{L}])/iu;
const WHY_KEYS = [
  "messageNew", "messageNewAsk", "messageSeveral", "messagePublic", "deleteOutside", "deleteOn", "pay", "payRoutine", "askOwner", "askRoutine",
  "webhook", "channel", "channelUnnamed", "unattended", "alwaysAsk", "sensitiveGuard", "unreadCall", "destructiveGuard", "promptGuard",
];

describe("ux.l1 copy", () => {
  const entries = Object.entries(l1 as Record<string, string>);
  const server = [recipientsNotNotedLine(["Dana"]), stoppedWaiting("Nova"), RUN_ENDED, routineCardRefusal("Morning brief"), ROUTINE_PAY_NOT_REMEMBERED];

  it("every key is the lane's own", () => {
    for (const [key] of entries) expect(key.startsWith("ux.l1."), key).toBe(true);
  });

  it("no em dash and never the banned word, in the catalogue or the server lines", () => {
    for (const [key, text] of entries) {
      expect(DASH.test(text), key).toBe(false);
      expect(BANNED.test(text), key).toBe(false);
    }
    for (const text of server) {
      expect(DASH.test(text), text).toBe(false);
      expect(BANNED.test(text), text).toBe(false);
    }
  });

  it("every why-line key the server returns has its English", () => {
    for (const key of WHY_KEYS) expect((l1 as Record<string, string>)[`ux.l1.why.${key}`], key).toBeTruthy();
  });

  it("the F16 transcript line is the catalogue's", () => {
    expect(recipientsNotNotedLine(["Dana"])).toBe((l1 as Record<string, string>)["ux.l1.why.recipientNotNoted"]!.replaceAll("{name}", "Dana"));
  });

  it("no why-line points to a higher level as the way out", () => {
    for (const [key, text] of entries.filter(([key]) => key.startsWith("ux.l1.why."))) {
      expect(/\b(switch|turn on|use|choose|pick|set)\b[^.]{0,40}\b(Full access|No limits)/i.test(text), key).toBe(false);
    }
  });
});
