// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A local, synthetic ELD probe through the shipped replay helper and rig scorer. No remote rig or real data.
import { mkdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "../../server/config.ts";
import { database, closeDatabase } from "../../server/database.ts";
import { turnReplayInputs } from "../../server/memory/turn-replay-inputs.ts";
import { measuredEld, judge } from "./smooth-config.mjs";
import { stats } from "../scale/stats.mjs";

afterEach(() => closeDatabase());
it("ALL.eld250: six expensive transcript preparations meet the unchanged rig ELD budgets", { tags: ["perf-budget"], timeout: 30_000 }, async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const messages = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: "x" }));
  // Schema creation belongs to fixture setup, before the measured turn window.
  database();
  const logs = [];
  let last = performance.now(), peak = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    peak = Math.max(peak, now - last - 10); last = now;
  }, 10);
  const sample = setInterval(() => { logs.push(`[eld] t=${Date.now()} p50=0 p99=0 max=${peak}`); peak = 0; }, 1000);
  const from = Date.now();
  try {
    for (let i = 0; i < 6; i++) {
      await turnReplayInputs({
        store: { activeTextLines: (_t, limit) => ({ messages: messages.slice(-limit), hasMore: messages.length > limit, exact: true }) },
        threadId: "chat", botId: "bot", routeHasTools: true, externalUpdates: [], projectCardRun: false,
        skip: new Set(), replayOptions: { maxBytes: 192 * 1024 }, cooperative: true,
        // Deterministic CPU cost stands in for a costly privacy lookup: 40 rows take ~32 ms; a whole window takes >250 ms.
        floor: batch => { const end = performance.now() + batch.length * 0.8; while (performance.now() < end) { /* fixture CPU */ } return undefined; },
      });
      await pause(150);
    }
    await pause(1050);
  } finally { clearInterval(heartbeat); clearInterval(sample); }
  const eld = measuredEld(logs.join("\n"), from, Date.now(), stats, [], { head: true });
  const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
  const rows = budgets.rows.filter(row => ["ALL.eld", "ALL.eld250"].includes(row.id));
  const verdict = judge({ ...budgets, rows }, { all: { eld } }, {});
  console.log("transcript-preparation ELD", JSON.stringify({ eld, rows: verdict.rows }));
  expect(logs.length).toBeGreaterThanOrEqual(6);
  expect(eld.max).toBeLessThan(250);
  expect(verdict.rows).toHaveLength(2);
  expect(verdict.pass).toBe(true);
});
