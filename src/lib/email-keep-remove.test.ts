// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 Settings email Keep/Remove: the words and the rules, against the final restore-park r3.4b contract.
import { describe, expect, it } from "vitest";
import {
  KEEP_REFUSAL_CODES, LOOK_AGAIN_LINE, RECONFIRM_KEPT_LINE, REMOVE_REFUSAL_CODES, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE,
  keptSummary, refusalLine,
} from "./email-keep-remove";

const ctx = (over: Partial<Parameters<typeof refusalLine>[1]> = {}) => ({ action: "keep" as const, untokenedBotKeep: false, ...over });

describe("the spec's exact lines", () => {
  it("are the constants of the restore spec, word for word", () => {
    expect(RESTORE_FINISHING_LINE).toBe("A restore is finishing. Try again in a minute.");
    expect(RESTORE_FAILED_LINE).toBe("That restore did not finish. Nothing changed. You can try again.");
    expect(RECONFIRM_KEPT_LINE).toBe("Choose Keep or Remove again for this bot's email.");
    expect(LOOK_AGAIN_LINE).toBe("This bot's email changed since you looked. Look again, then choose.");
  });
});

describe("refusal copy", () => {
  it("names the refusal codes of each decision; skipped_in_use is not one of them", () => {
    expect([...KEEP_REFUSAL_CODES]).toEqual(["removal_sending", "keep_pending", "confirm_expired", "inbox_gone", "bot_present", "restore_finishing"]);
    expect([...REMOVE_REFUSAL_CODES]).toEqual(["keep_pending", "confirm_expired", "bot_present", "restore_finishing"]);
    expect([...KEEP_REFUSAL_CODES, ...REMOVE_REFUSAL_CODES]).not.toContain("skipped_in_use");
  });
  it("the server's line, exactly as given, wins for every code and action (never trimmed or rewritten)", () => {
    const line = `  A server line <b>as given</b> & more.  `;
    for (const code of ["removal_sending", "keep_pending", "confirm_expired", "inbox_gone", "bot_present", "restore_failed", "restore_finishing", "something_new"]) {
      for (const action of ["keep", "remove", "try_again_now", "confirm_inventory"] as const) expect(refusalLine({ code, error: line }, ctx({ action }))).toBe(line);
    }
  });
  it("Astra 2: a distinct server error is returned for restore_finishing and for a restore_failed alike (no window logic overrides it)", () => {
    for (const action of ["keep", "remove"] as const) {
      expect(refusalLine({ code: "restore_failed", error: RESTORE_FAILED_LINE }, ctx({ action }))).toBe(RESTORE_FAILED_LINE);
      expect(refusalLine({ code: "restore_finishing", error: "distinct" }, ctx({ action }))).toBe("distinct");
    }
  });
  it("Astra 2: an empty error and a whitespace-only error are strings and are kept exactly", () => {
    for (const action of ["keep", "remove"] as const) {
      expect(refusalLine({ code: "keep_pending", error: "" }, ctx({ action }))).toBe("");
      expect(refusalLine({ code: "confirm_expired", error: " \t " }, ctx({ action, untokenedBotKeep: true }))).toBe(" \t ");
    }
  });
  it("fallback copy is used only when no string was supplied (null or absent)", () => {
    expect(refusalLine({ code: "confirm_expired", error: null }, ctx({ untokenedBotKeep: true }))).toBe(LOOK_AGAIN_LINE);
    expect(refusalLine({ code: "restore_finishing" }, ctx())).toBe(RESTORE_FINISHING_LINE);
  });
  it("has fallback copy for every Keep and Remove code when the server sent no line", () => {
    for (const code of KEEP_REFUSAL_CODES) {
      const line = refusalLine({ code, error: null }, ctx());
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toContain(code);
    }
    for (const code of REMOVE_REFUSAL_CODES) expect(refusalLine({ code }, ctx({ action: "remove" })).length).toBeGreaterThan(10);
  });
  it("fallback copy follows the copy rules: plain, no fixed or issue, no dashes, says what happens next", () => {
    for (const action of ["keep", "remove", "try_again_now", "confirm_inventory"] as const) {
      for (const code of ["removal_sending", "keep_pending", "confirm_expired", "inbox_gone", "bot_present", "restore_finishing", "weird"] as const) {
        const line = refusalLine({ code }, ctx({ action, untokenedBotKeep: action === "keep" }));
        expect(line).not.toMatch(/\b(fixed|issue|regression|problem)s?\b/i);
        expect(line).not.toMatch(/[—–]/);
        expect(line).not.toMatch(/token|code|error/i);
      }
    }
  });
  it("LOOK_AGAIN_LINE is the fallback of the untokened bot-row Keep refused confirm_expired, and nothing else", () => {
    expect(refusalLine({ code: "confirm_expired" }, ctx({ action: "keep", untokenedBotKeep: true }))).toBe(LOOK_AGAIN_LINE);
    expect(refusalLine({ code: "confirm_expired" }, ctx({ action: "keep", untokenedBotKeep: false }))).not.toBe(LOOK_AGAIN_LINE);
    expect(refusalLine({ code: "confirm_expired" }, ctx({ action: "remove", untokenedBotKeep: false }))).not.toBe(LOOK_AGAIN_LINE);
    expect(refusalLine({ code: "confirm_expired" }, ctx({ action: "remove", untokenedBotKeep: true }))).not.toBe(LOOK_AGAIN_LINE);
    for (const code of ["keep_pending", "removal_sending", "inbox_gone", "bot_present", "weird"]) {
      expect(refusalLine({ code }, ctx({ untokenedBotKeep: true }))).not.toBe(LOOK_AGAIN_LINE);
    }
  });
  it("an unknown code still gets a plain line that says nothing changed", () => {
    expect(refusalLine({ code: "something_new" }, ctx())).toMatch(/Nothing changed/);
  });
});

describe("emailKept summary", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `kept${i + 1}@example.test`);
  it.each([[0, 0, null], [1, 1, null], [5, 5, null], [6, 5, "and 1 more"], [20, 5, "and 15 more"]] as const)("%i addresses show %i then %s", (n, shown, more) => {
    const out = keptSummary(list(n));
    expect(out.shown).toEqual(list(n).slice(0, 5));
    expect(out.shown).toHaveLength(shown);
    expect(out.more).toBe(more);
  });
});
