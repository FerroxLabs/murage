// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// meetgreet 1.0.19 item 3: a separate-profile Murage that is quit by someone else says so; every quit names its cause.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { quitAnnouncement } from "./quit-notice.mjs";

describe("quitAnnouncement", () => {
  it("a separate-profile copy quit by another app, the system or automation shows why; the owner's own quit is silent", () => {
    for (const cause of ["unclassified", "system", "automatic", undefined]) {
      const { log, notice } = quitAnnouncement({ cause, customProfile: true });
      expect(log).toBe(`desktop quit cause=${cause ?? "unclassified"} profile=separate`);
      expect(notice?.title).toBe("Murage (separate profile) is closing");
      expect(notice?.body).toMatch(/Your chats are saved\. Open it again with the same launcher\.$/);
    }
    expect(quitAnnouncement({ cause: "unclassified", customProfile: true }).notice?.body).toMatch(/^Another app asked Murage to quit/);
    expect(quitAnnouncement({ cause: "owner", customProfile: true })).toEqual({ log: "desktop quit cause=owner profile=separate", notice: null });
  });

  it("the default profile logs its cause and shows nothing; a malformed cause is never copied", () => {
    expect(quitAnnouncement({ cause: "unclassified", customProfile: false })).toEqual({ log: "desktop quit cause=unclassified profile=default", notice: null });
    expect(quitAnnouncement({ cause: "x\nsecret path elsewhere", customProfile: false }).log).toBe("desktop quit cause=unclassified profile=default");
  });

  it("main.mjs announces every quit once, in before-quit, with the custom-profile test the updater uses", () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const hook = main.indexOf('app.on("before-quit", (e) => {');
    expect(hook).toBeGreaterThan(-1);
    const body = main.slice(hook, main.indexOf("\n});", hook));
    expect(body).toMatch(/announceQuit\(shutdownCause\)/);
    expect(main).toMatch(/quitAnnouncement\(\{ cause, customProfile: hasCustomUpdaterProfile\(process\.env\) \}\)/);
  });
});
