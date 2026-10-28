// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { AskRevocations } from "./ask-revocations.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "murage-ask-rev-"));
afterAll(() => removeTempDirSync(SCRATCH));

describe("AskRevocations", () => {
  it("refuses a generation at or below through, accepts above it, and knows nothing of other devices", () => {
    const r = new AskRevocations(new DatabaseSync(":memory:"));
    expect(r.refuses("dev", 0)).toBe(false);
    r.apply("dev", 5);
    expect(r.refuses("dev", 4)).toBe(true);
    expect(r.refuses("dev", 5)).toBe(true);
    expect(r.refuses("dev", 6)).toBe(false);
    expect(r.refuses("other", 1)).toBe(false);
  });
  it("through 0 refuses generation 0 only", () => {
    const r = new AskRevocations(new DatabaseSync(":memory:"));
    r.apply("dev", 0);
    expect(r.refuses("dev", 0)).toBe(true);
    expect(r.refuses("dev", 1)).toBe(false);
  });
  it("apply never lowers through", () => {
    const r = new AskRevocations(new DatabaseSync(":memory:"));
    r.apply("dev", 9);
    r.apply("dev", 3);
    r.apply("dev", 9);
    expect(r.refuses("dev", 9)).toBe(true);
    expect(r.refuses("dev", 10)).toBe(false);
    r.apply("dev", 12);
    expect(r.refuses("dev", 12)).toBe(true);
  });
  it("refuses a through that is not a non-negative safe integer", () => {
    const r = new AskRevocations(new DatabaseSync(":memory:"));
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => r.apply("dev", bad)).toThrow();
    expect(r.refuses("dev", 0)).toBe(false);
  });
  it("survives a restart on the same messages.db file", () => {
    const file = join(SCRATCH, "messages.db");
    new AskRevocations(new DatabaseSync(file)).apply("dev", 7);
    const again = new AskRevocations(new DatabaseSync(file));
    expect(again.refuses("dev", 7)).toBe(true);
    expect(again.refuses("dev", 8)).toBe(false);
  });
  it("creates only its own table", () => {
    const db = new DatabaseSync(":memory:");
    new AskRevocations(db);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(["phone_ask_revocations"]);
  });
  it("is synchronous and sets no timer", () => {
    const source = readFileSync(join(import.meta.dirname, "ask-revocations.ts"), "utf8");
    expect(source).not.toMatch(/\bawait\b|\basync\b/);
  });
});
