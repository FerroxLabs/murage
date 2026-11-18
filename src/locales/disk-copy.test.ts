// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance F1 (docs/designs/boot-tolerance/ACCEPTANCE.md): the disk copy promises only what exists. The keys exist in all 8 locales, the English
// read-only line, the one notice and the read-only 503 body are the owner's words, and no English disk string promises later, automatic or queued work.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISK_FLOOR_OWNER_COPY, DatabaseBusyError, DiskFloorRefusal, READ_ONLY_OWNER_COPY } from "../../server/db-busy";
import { en } from "@/locales";

const OWNER_COPY = "Your disk is almost full. Chats are read-only. Free some space, then restart Murage.";
const LOCALES = ["de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
const KEYS = ["ux.l2b.disk.section", "ux.l2b.disk.readOnly", "ux.l2b.disk.refusing", "ux.l2b.disk.restart", "ux.l2b.disk.restartFallback"] as const;
const FORBIDDEN = /later|automatic|continue|queued|saved for|resume|try again|moment/i;
const DIR = fileURLToPath(new URL(".", import.meta.url));
const CODES = readdirSync(DIR).filter(file => file.endsWith(".json") && file !== "en.json" && file !== "source-hashes.json").map(file => file.slice(0, -5)).sort();
const pack = (code: string) => JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
const PROMISES = /later|automatic|continue|queued|saved for|resume|try again|moment/i;
const read = (code: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./${code}.json`, import.meta.url)), "utf8")) as Record<string, string>;

describe("disk copy", () => {
  it("has every key in all 8 locales", () => {
    for (const key of KEYS) expect(en[key], `en ${key}`).toBeTruthy();
    for (const code of LOCALES) {
      const words = read(code);
      for (const key of KEYS) expect(words[key]?.trim(), `${code} ${key}`).toBeTruthy();
    }
  });

  it("the English read-only line, the notice body and the read-only 503 body are the owner copy", () => {
    expect(en["ux.l2b.disk.readOnly"]).toBe(OWNER_COPY);
    expect(READ_ONLY_OWNER_COPY).toBe(OWNER_COPY);
    expect(new DiskFloorRefusal("read-only-start").message).toBe(OWNER_COPY);
    // the notice frame (server/index.ts sendDiskNotice) takes its body from the same constant
    const source = readFileSync(fileURLToPath(new URL("../../server/index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/id: "disk\.read-only-start", title: "Murage", body: READ_ONLY_OWNER_COPY/);
    expect(source).toMatch(/op === "read-only-start" \? \{ error: READ_ONLY_OWNER_COPY/);
  });

  it("promises only what exists: no English disk string says later, automatic, continue, queued, saved for, resume, try again or moment", () => {
    const strings = [...KEYS.map(key => en[key]), READ_ONLY_OWNER_COPY, DISK_FLOOR_OWNER_COPY, new DiskFloorRefusal("read-only-start").message, new DiskFloorRefusal("disk-floor").message, new DiskFloorRefusal("start-migration").message];
    for (const text of strings) expect(text, text).not.toMatch(FORBIDDEN);
    // db-busy's own lock wording is for a lock, never shown for a full disk
    expect(new DatabaseBusyError("x", 0).message).toMatch(/moment/);
    expect(new DiskFloorRefusal("disk-floor").message).not.toBe(new DatabaseBusyError("x", 0).message);
  });

  it("the other locale packs, the notice frame and the runtime floor copy are the owner copy", () => {
    expect(CODES).toEqual(["de", "es", "fr", "hi", "ja", "pt-br", "zh"]);
    for (const code of CODES) for (const key of KEYS) expect(pack(code)[key], `${code} ${key}`).toBeTypeOf("string");
    for (const key of KEYS) expect(en[key], `en ${key}`).toBeTypeOf("string");
    // the owner copy, exact: the Inbox line, the notice body and the read-only refusal's `error`
    expect(en["ux.l2b.disk.readOnly"]).toBe(OWNER_COPY);
    expect(READ_ONLY_OWNER_COPY).toBe(OWNER_COPY);
    expect(new DiskFloorRefusal("read-only-start").message).toBe(OWNER_COPY);
    expect(new DiskFloorRefusal("start-migration").message).toBe(OWNER_COPY);
    const index = readFileSync(join(DIR, "..", "..", "server", "index.ts"), "utf8");
    expect(index).toContain('body: READ_ONLY_OWNER_COPY } })');
    expect(index).toContain('{ error: READ_ONLY_OWNER_COPY, code: "DATABASE_BUSY", reason: op, retryable: false }');
    // the runtime floor says what is true: space returns by itself, nothing is queued
    expect(en["ux.l2b.disk.refusing"]).toBe(DISK_FLOOR_OWNER_COPY);
    for (const text of [...KEYS.map(key => en[key]), OWNER_COPY, READ_ONLY_OWNER_COPY, DISK_FLOOR_OWNER_COPY, new DiskFloorRefusal("read-only-start").message, new DiskFloorRefusal("disk-floor").message])
      expect(text, text).not.toMatch(PROMISES);
  });
});
