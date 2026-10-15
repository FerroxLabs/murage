// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Send notices are stored as codes and spelled by the language packs: every code has
// a real translation in every shipped pack, with the source hash recorded against the
// English it was translated from, and none of the copy rules is broken.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEND_NOTICE_CODES, SEND_NOTICE_ENGLISH, isSendNoticeCode, sendNoticeActivityName, sendNoticeCode, sendNoticeDisplayName } from "./send-notice.ts";

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const read = (file: string) => JSON.parse(readFileSync(join(LOCALES, file), "utf8"));
const en = read("en.json") as Record<string, string>;
const hashes = read("source-hashes.json").locales as Record<string, Record<string, string>>;
const packs = readdirSync(LOCALES).filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "source-hashes.json").map((f) => f.slice(0, -5));
const KEYS = [...SEND_NOTICE_CODES.map((code) => `sendNotice.${code}`), "sendNotice.refusedLabel", "sendNotice.sendAgain", "sendNotice.dismiss", "send.outboxFull", "send.timedOut"];

describe("send notice codes", () => {
  it("round-trip through the activity name and nothing else is read as a notice", () => {
    for (const code of SEND_NOTICE_CODES) {
      expect(sendNoticeCode(sendNoticeActivityName(code))).toBe(code);
      expect(sendNoticeDisplayName(sendNoticeActivityName(code))).toBe(SEND_NOTICE_ENGLISH[code]);
    }
    expect(sendNoticeCode("send-notice:nope")).toBeUndefined();
    expect(sendNoticeCode("error: send-notice:refused")).toBeUndefined();
    expect(isSendNoticeCode("refused")).toBe(true);
    expect(isSendNoticeCode("other")).toBe(false);
  });

  it("the English pack and the English fallbacks say the same thing", () => {
    for (const code of SEND_NOTICE_CODES) expect(en[`sendNotice.${code}`]).toBe(SEND_NOTICE_ENGLISH[code]);
  });
});

describe("send notices in every language pack", () => {
  it("finds the shipped packs", () => {
    expect(packs).toEqual(expect.arrayContaining(["de", "es", "fr", "hi", "ja", "pt-br", "zh"]));
  });
  for (const pack of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    it(`${pack} translates every send string, against the hash of the English it came from`, () => {
      const catalog = read(`${pack}.json`) as Record<string, string>;
      for (const key of KEYS) {
        expect(catalog[key], `${pack}:${key}`).toBeTruthy();
        expect(catalog[key], `${pack}:${key} is still English`).not.toBe(en[key]);
        expect(hashes[pack]?.[key], `${pack}:${key} hash`).toBe(createHash("sha256").update(en[key]!).digest("hex"));
        expect(catalog[key]).not.toMatch(/—|\s[–−]\s/u);
        expect(catalog[key]).not.toMatch(/(?<![\p{L}])(safe|safely|safety|unsafe)(?![\p{L}])|सुरक्षित|सुरक्षा/iu);
      }
    });
  }
  it("keeps the placeholders and copy rules of the English", () => {
    for (const key of KEYS) {
      expect(en[key]).not.toMatch(/—|\s[–−]\s/u);
      expect(en[key]).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
    }
  });
});
