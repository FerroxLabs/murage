// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loopNotice, loopNoticeDisplayName, loopNoticeName } from "./loop-notice.ts";

describe("loop notice keys", () => {
  it("round-trip, and any other activity name is not a loop notice", () => {
    expect(loopNotice(loopNoticeName("nudged"))).toEqual({ code: "nudged" });
    expect(loopNotice(loopNoticeName("repeat", 5, "Bash: npm test: x"))).toEqual({ code: "repeat", count: 5, call: "Bash: npm test: x" });
    expect(loopNotice("Read src/x.ts")).toBeUndefined();
    expect(loopNotice("loop-notice:other")).toBeUndefined();
    expect(loopNoticeDisplayName(loopNoticeName("nudged"))).toBe("Nudged after 5 identical failures");
    expect(loopNoticeDisplayName(loopNoticeName("repeat", 5, "Bash: ls"))).toBe("Same call repeated 5×: Bash: ls (it may be stuck)");
  });

  it("every shipped language pack spells both rows, keeping the placeholders", () => {
    const dir = join(import.meta.dirname, "..", "src", "locales");
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = JSON.parse(readFileSync(join(dir, `${code}.json`), "utf8")) as Record<string, string>;
      expect(pack["loopNotice.nudged"], code).toBeTruthy();
      expect(pack["loopNotice.repeat"], code).toContain("{n}");
      expect(pack["loopNotice.repeat"], code).toContain("{call}");
    }
  });
});
