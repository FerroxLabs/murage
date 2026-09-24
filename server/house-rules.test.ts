// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOUSE_RULES,
  HOUSE_RULES_MAX_BYTES,
  handleHouseRulesApi,
  houseRulesPrompt,
  readHouseRules,
  resetHouseRules,
  saveHouseRules,
} from "./house-rules.ts";
import { voiceHostPrompt, type VoiceHostState } from "./voice/voice-host.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-house-rules-"));
});

describe("house rules storage", () => {
  it("embeds exactly the shipped default.md", () => {
    expect(DEFAULT_HOUSE_RULES).toBe(readFileSync(join(import.meta.dirname, "house-rules", "default.md"), "utf8"));
  });

  it("keeps the shipped text free of em dashes and the word safe", () => {
    expect(DEFAULT_HOUSE_RULES).not.toMatch(/[—–]/);
    expect(DEFAULT_HOUSE_RULES).not.toMatch(/\bsafe/i);
    expect(DEFAULT_HOUSE_RULES.trim().split(/\s+/).length).toBeLessThan(700);
  });

  it("is on with the shipped default when nothing is saved", () => {
    const state = readHouseRules(dir);
    expect(state).toMatchObject({ text: DEFAULT_HOUSE_RULES, enabled: true, isDefault: true, defaultText: DEFAULT_HOUSE_RULES });
    expect(state.words).toBeGreaterThan(100);
    expect(houseRulesPrompt(dir)).toBe(`<house-rules>\n${DEFAULT_HOUSE_RULES.trim()}\n</house-rules>\n\n`);
  });

  it("saves the owner's text owner-only and uses it on the next prompt", () => {
    houseRulesPrompt(dir); // prime the cache: a save must still show up
    const state = saveHouseRules({ text: "Always answer in French." }, dir);
    expect(state).toMatchObject({ text: "Always answer in French.", isDefault: false, enabled: true, words: 4 });
    expect(houseRulesPrompt(dir)).toBe("<house-rules>\nAlways answer in French.\n</house-rules>\n\n");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "house-rules.md")).mode & 0o777).toBe(0o600);
      saveHouseRules({ enabled: false }, dir);
      expect(statSync(join(dir, "house-rules.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("picks up a hand edit of the file on the next prompt", () => {
    saveHouseRules({ text: "One." }, dir);
    expect(houseRulesPrompt(dir)).toContain("One.");
    writeFileSync(join(dir, "house-rules.md"), "Two, and longer.");
    expect(houseRulesPrompt(dir)).toContain("Two, and longer.");
  });

  it("injects nothing when switched off, and the text survives the switch", () => {
    saveHouseRules({ text: "Keep it short." }, dir);
    expect(saveHouseRules({ enabled: false }, dir)).toMatchObject({ enabled: false, text: "Keep it short." });
    expect(houseRulesPrompt(dir)).toBe("");
    saveHouseRules({ enabled: true }, dir);
    expect(houseRulesPrompt(dir)).toContain("Keep it short.");
  });

  it("injects nothing for empty rules", () => {
    saveHouseRules({ text: "   \n" }, dir);
    expect(houseRulesPrompt(dir)).toBe("");
  });

  it("reset restores the shipped text and keeps the switch", () => {
    saveHouseRules({ text: "Mine.", enabled: false }, dir);
    const state = resetHouseRules(dir);
    expect(state).toMatchObject({ text: DEFAULT_HOUSE_RULES, isDefault: true, enabled: false });
    expect(existsSync(join(dir, "house-rules.md"))).toBe(false);
    expect(resetHouseRules(dir).isDefault).toBe(true); // resetting twice is fine
  });

  it("refuses over 20 KB with a plain message and keeps the old text", () => {
    saveHouseRules({ text: "Old." }, dir);
    expect(() => saveHouseRules({ text: "x".repeat(HOUSE_RULES_MAX_BYTES) }, dir)).not.toThrow();
    saveHouseRules({ text: "Old." }, dir);
    expect(() => saveHouseRules({ text: "x".repeat(23 * 1024) }, dir)).toThrow(
      "House rules can be up to 20 KB. Yours are 23 KB. Shorten them and save again.",
    );
    // Bytes, not characters: 7,000 three-byte characters are 21 KB.
    expect(() => saveHouseRules({ text: "€".repeat(7000) }, dir)).toThrow(/Yours are 21 KB/);
    expect(readHouseRules(dir).text).toBe("Old.");
  });
});

describe("house rules API handler", () => {
  const call = (method: string, path: string, body?: unknown) =>
    handleHouseRulesApi({ method, path, readBody: async () => body }, dir);

  it("answers GET, PUT and reset with the same shape", async () => {
    const got = await call("GET", "/api/house-rules");
    expect(got?.status).toBe(200);
    expect(Object.keys(got!.body as object).sort()).toEqual(["defaultText", "enabled", "isDefault", "text", "words"]);
    expect(await call("PUT", "/api/house-rules", { text: "Be brief.", enabled: false })).toMatchObject({ status: 200, body: { text: "Be brief.", enabled: false, isDefault: false } });
    expect(await call("POST", "/api/house-rules/reset")).toMatchObject({ status: 200, body: { isDefault: true, enabled: false } });
  });

  it("validates the body", async () => {
    expect(await call("PUT", "/api/house-rules", { text: 5 })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/house-rules", { enabled: "yes" })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/house-rules", {})).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/house-rules", { text: "a", extra: 1 })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/house-rules", [])).toMatchObject({ status: 400 });
    expect(await call("PUT", "/api/house-rules", { text: "x".repeat(23 * 1024) })).toMatchObject({
      status: 413,
      body: { error: "House rules can be up to 20 KB. Yours are 23 KB. Shorten them and save again." },
    });
    expect(await call("DELETE", "/api/house-rules")).toMatchObject({ status: 405 });
    expect(await call("GET", "/api/house-rulesx")).toBeNull();
  });
});

describe("voice host brief", () => {
  const state: VoiceHostState = {
    botName: "Moss",
    now: 0,
    task: { title: "", busy: false, activity: [] },
    recent: [],
    otherTasks: [],
    needsYou: [],
  };

  it("opens with the house rules when they are on, and without them when off", () => {
    const withRules = voiceHostPrompt({ ...state, houseRules: "<house-rules>\nBe brief.\n</house-rules>\n\n" });
    expect(withRules.startsWith("<house-rules>\nBe brief.\n</house-rules>\n")).toBe(true);
    expect(voiceHostPrompt({ ...state, houseRules: "" }).startsWith("You are Moss")).toBe(true);
  });
});
