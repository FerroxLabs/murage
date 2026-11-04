// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOwnerPrefs, writeOwnerPrefs } from "./owner-prefs.ts";

describe("owner prefs (APPROVE-ALL-1016 section 4)", () => {
  it("the caution shows until the owner dismisses it, and shows again once reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "aab-owner-prefs-"));
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    expect(writeOwnerPrefs(dir, { approveAllCautionDismissed: true }).approveAllCautionDismissed).toBe(true);
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(true);
    expect(writeOwnerPrefs(dir, { approveAllCautionDismissed: false }).approveAllCautionDismissed).toBe(false);
  });
  it("a malformed file reads as the defaults, and a write keeps other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aab-owner-prefs-"));
    writeFileSync(join(dir, "owner-prefs.json"), "not json");
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    writeFileSync(join(dir, "owner-prefs.json"), JSON.stringify({ approveAllCautionDismissed: "yes", other: 1 }));
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    writeOwnerPrefs(dir, { approveAllCautionDismissed: true });
    expect(JSON.parse(readFileSync(join(dir, "owner-prefs.json"), "utf8"))).toEqual({ approveAllCautionDismissed: true, other: 1 });
  });
});
