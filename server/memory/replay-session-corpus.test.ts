// SPDX-License-Identifier: AGPL-3.0-or-later
// Baseline recorder and exactness test owner: new3-g5.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setReplayShadowForTest } from "./replay-walk.ts";
import { corpusHeader, recordSeed } from "./testing/replay-session-corpus.ts";

const path = "server/memory/fixtures/replay-session-corpus.v1.json";
afterEach(() => closeDatabase());
it("T6/T7 replays the recorded corpus with byte-identical captures and receipt outcomes", () => {
  setReplayShadowForTest(true);
  const seeds = Array.from({ length: 6 }, (_, i) => {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    return recordSeed(i + 1);
  });
  if (process.env.RECORD_REPLAY_CORPUS === "1") {
    writeFileSync(path, JSON.stringify({ header: corpusHeader(), seeds }));
    return;
  }
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  expect(recorded.header.source).toBe("b8f51043227526ec63aad2b6d70943d2b87bbf27");
  let conservative = 0;
  for (let i = 0; i < seeds.length; i++) {
    const actual = seeds[i]!, old = recorded.seeds[i];
    for (let j = 0; j < actual.steps.length; j++) {
      const a = actual.steps[j] as any, b = old.steps[j];
      expect(JSON.stringify(a.captures), `seed ${i + 1} step ${j} T6`).toBe(JSON.stringify(b.captures));
      expect(a.outcome, `seed ${i + 1} step ${j} write`).toEqual(b.outcome);
      for (let k = 0; k < a.currency.length; k++) {
        if (a.currency[k].current !== b.currency[k].current) {
          expect(b.currency[k].current, `seed ${i + 1} step ${j} session ${k}`).toBe(true);
          expect(a.currency[k].current).toBe(false);
          expect(["R1", "R2"]).toContain(a.currency[k].reason);
          conservative++;
        }
      }
    }
  }
  console.log(`REPLAY_CORPUS conservative=${conservative} steps=1800`);
}, 120_000);
