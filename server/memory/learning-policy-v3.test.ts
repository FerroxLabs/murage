// 1.0.3 I0 (SETTINGS-LANES.md): learning settings v3, the conversions and the current-month seed.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import {
  DEFAULT_MEMORY_LEARNING_V1, DEFAULT_MEMORY_LEARNING_V2, DEFAULT_MEMORY_LEARNING_V3, downgradeMemoryLearningV3, learningInputReserve,
  learningSpendSeed, memoryLearningV2Schema, memoryLearningV3Schema, retrySkippedRequestSchema, learningCeilingSchema, seedLearningSpend,
  seedRowInMonth, toMemoryLearningV3, upgradeMemoryLearningV3,
} from "./learning-policy.ts";
import { CALL_OVERHEAD_ALLOWANCE, DEFAULT_LEARNING_CEILING } from "../../shared/memory-learning-contract.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const custom = memoryLearningV2Schema.parse({
  version: 2, automaticFacts: false, automaticProcedures: true, reviewMode: true,
  perCallOutputTokens: { extraction: 1500, grounding: 32, reflection: 4000 }, dailyInputTokens: 123_456, dailyOutputTokens: 7_890,
  callsPerMinute: 4, learnFrom: { chats: false, channels: true }, botsPaused: ["bot-a", "bot-b"],
});

describe("v2 -> v3 -> v2", () => {
  it("v2-v3-roundtrip: every field but the daily caps comes back as it was", () => {
    const v3 = upgradeMemoryLearningV3(custom);
    expect(v3).toEqual({ version: 3, automaticFacts: false, automaticProcedures: true, reviewMode: true, perCallOutputTokens: { extraction: 1500, grounding: 32, reflection: 4000 },
      ceiling: { ...DEFAULT_LEARNING_CEILING }, callsPerMinute: 4, learnFrom: { chats: false, channels: true }, botsPaused: ["bot-a", "bot-b"] });
    const back = downgradeMemoryLearningV3(v3);
    const { dailyInputTokens, dailyOutputTokens, ...rest } = back, { dailyInputTokens: _i, dailyOutputTokens: _o, ...was } = custom;
    expect(rest).toEqual(was);
    expect({ dailyInputTokens, dailyOutputTokens }).toEqual({ dailyInputTokens: DEFAULT_MEMORY_LEARNING_V2.dailyInputTokens, dailyOutputTokens: DEFAULT_MEMORY_LEARNING_V2.dailyOutputTokens });
    expect(upgradeMemoryLearningV3(back)).toEqual(v3);
  });

  it("zero-cap-upgrade: a zero daily cap on either side stays disabled, both ways", () => {
    for (const caps of [{ dailyInputTokens: 0, dailyOutputTokens: 60_000 }, { dailyInputTokens: 400_000, dailyOutputTokens: 0 }, { dailyInputTokens: 0, dailyOutputTokens: 0 }]) {
      const v3 = upgradeMemoryLearningV3({ ...custom, ...caps });
      expect(v3.ceiling).toEqual({ input: 0, output: 0 });
      expect(downgradeMemoryLearningV3(v3)).toMatchObject({ dailyInputTokens: 0, dailyOutputTokens: 0 });
    }
    expect(downgradeMemoryLearningV3({ ...DEFAULT_MEMORY_LEARNING_V3, ceiling: { input: 5, output: 0 } })).toMatchObject({ dailyInputTokens: 0, dailyOutputTokens: 0 });
  });

  it("chains v1 and v2 into v3, and passes v3 through", () => {
    const fromV1 = toMemoryLearningV3({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: true }, 3);
    expect(fromV1).toMatchObject({ version: 3, reviewMode: true, ceiling: DEFAULT_LEARNING_CEILING });
    expect(toMemoryLearningV3({ ...DEFAULT_MEMORY_LEARNING_V1, outputLimit: 0 }, 3).ceiling).toEqual({ input: 0, output: 0 });
    expect(toMemoryLearningV3(custom, 7)).toEqual(upgradeMemoryLearningV3(custom));
    expect(toMemoryLearningV3(DEFAULT_MEMORY_LEARNING_V3, 0)).toEqual(DEFAULT_MEMORY_LEARNING_V3);
    expect(() => toMemoryLearningV3({ version: 3, ceiling: {} }, 0)).toThrow();
  });

  it("the v3 shape is strict and the defaults are the interim floor", () => {
    expect(memoryLearningV3Schema.parse(DEFAULT_MEMORY_LEARNING_V3).ceiling).toEqual({ input: 100_000_000, output: 15_000_000 });
    expect(memoryLearningV3Schema.safeParse({ ...DEFAULT_MEMORY_LEARNING_V3, dailyInputTokens: 1 }).success).toBe(false);
    expect(learningCeilingSchema.safeParse({ input: -1, output: 0 }).success).toBe(false);
    expect(retrySkippedRequestSchema.parse({ action: "retry-skipped", sourceId: "s", cursor: 16384 })).toEqual({ action: "retry-skipped", sourceId: "s", cursor: 16384 });
    expect(retrySkippedRequestSchema.safeParse({ action: "retry-skipped", sourceId: "s", cursor: -1 }).success).toBe(false);
  });

  it("reserves one token per serialised byte plus the provider allowance", () => {
    const messages = [{ role: "user", content: "héllo" }];
    expect(learningInputReserve(messages)).toBe(Buffer.byteLength(JSON.stringify(messages)) + CALL_OVERHEAD_ALLOWANCE);
  });
});

describe("seed-from-daily-ledger", () => {
  const tz = process.env.TZ;
  afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

  it("UTC+7 (Bangkok): the UTC rows 09-30 and 10-31 overlap October and count whole; 11-01 does not", () => {
    process.env.TZ = "Asia/Bangkok";
    expect(seedRowInMonth("extract-budget:2026-09-30", "2026-10")).toBe(true);
    expect(seedRowInMonth("extract-budget:2026-10-01", "2026-10")).toBe(true);
    expect(seedRowInMonth("extract-budget:2026-10-31", "2026-10")).toBe(true);
    expect(seedRowInMonth("extract-budget:2026-11-01", "2026-10")).toBe(false);
    expect(seedRowInMonth("extract-budget:2026-09-29", "2026-10")).toBe(false);
  });

  it("UTC-7 (Los Angeles in October): 09-30 ends before October, 10-01 counts, and 11-01 overlaps the last evening", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(seedRowInMonth("extract-budget:2026-09-30", "2026-10")).toBe(false);
    expect(seedRowInMonth("extract-budget:2026-10-01", "2026-10")).toBe(true);
    expect(seedRowInMonth("extract-budget:2026-11-01", "2026-10")).toBe(true);
    expect(seedRowInMonth("extract-budget:2026-11-02", "2026-10")).toBe(false);
  });

  it("Continuity rows are local days, counted when the day is in the month; other ids never", () => {
    expect(seedRowInMonth("continuity-budget:bot-1:2026-10-05", "2026-10")).toBe(true);
    expect(seedRowInMonth("continuity-budget:bot-1:2026-09-30", "2026-10")).toBe(false);
    expect(seedRowInMonth("continuity-budget:bot:with:colons:2026-10-31", "2026-10")).toBe(true);
    expect(seedRowInMonth("learning-spend:2026-10", "2026-10")).toBe(false);
    expect(seedRowInMonth("extract-budget:garbage", "2026-10")).toBe(false);
  });

  describe("against the bindings table", () => {
    beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
    afterEach(() => closeDatabase());
    const put = (id: string, subject: string, intent: object) => {
      const db = database(); db.exec("PRAGMA foreign_keys=OFF");
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(id, "scope-1", subject, JSON.stringify(intent));
    };

    it("sums the overlapping UTC days and the local Continuity days, and writes the month once", () => {
      process.env.TZ = "Asia/Bangkok";
      put("extract-budget:2026-09-30", "extract-budget", { input: 100, output: 10, minute: 1, calls: 1 });
      put("extract-budget:2026-10-01", "extract-budget", { input: 200, output: 20, minute: 1, calls: 1 });
      put("extract-budget:2026-09-15", "extract-budget", { input: 999, output: 99 });
      put("continuity-budget:bot-1:2026-10-02", "continuity-budget", { input: 40, output: 4, bytes: 10 });
      put("continuity-budget:bot-2:2026-09-30", "continuity-budget", { input: 7, output: 7 });
      put("extract-budget:2026-10-03", "extract-budget", { input: "bad" });
      const db = database();
      expect(learningSpendSeed(db, "2026-10")).toEqual({ input: 340, output: 34 });
      expect(seedLearningSpend(db, "2026-10", "scope-1")).toBe(true);
      const row = db.prepare("SELECT subject_type,subject_id,intent FROM memory_scope_bindings WHERE id='learning-spend:2026-10'").get()!;
      expect({ type: row.subject_type, subject: row.subject_id, intent: JSON.parse(String(row.intent)) }).toEqual({ type: "system", subject: "learning-spend", intent: { input: 340, output: 34 } });
      expect(seedLearningSpend(db, "2026-10", "scope-1")).toBe(false); // present: never re-seeded over live spend
      // the day rows stay
      expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','continuity-budget')").get()!.n)).toBe(6);
    });

    it("UTC-7 counts only 10-01 of the edge pair", () => {
      process.env.TZ = "America/Los_Angeles";
      put("extract-budget:2026-09-30", "extract-budget", { input: 100, output: 10 });
      put("extract-budget:2026-10-01", "extract-budget", { input: 200, output: 20 });
      expect(learningSpendSeed(database(), "2026-10")).toEqual({ input: 200, output: 20 });
    });

    it("v10-v11-fresh-install: no day rows, nothing written, the ledger reads 0", () => {
      const db = database();
      expect(learningSpendSeed(db, "2026-10")).toEqual({ input: 0, output: 0 });
      expect(seedLearningSpend(db, "2026-10", "scope-1")).toBe(false);
      expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='learning-spend:2026-10'").get()).toBeUndefined();
    });
  });
});
