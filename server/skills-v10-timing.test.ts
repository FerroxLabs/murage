// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 K9: the query route answers fast on a generated library, facets included (they are part of every answer).
// p95 150 ms at 2,262 skills and 400 ms at 10,000, on the real harness through the real route. The index is built by a
// first request that is not timed: the gate is the answer the Skills page waits for while the owner types.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { FIXTURE_TOTAL, FIXTURE_BUILTIN, FIXTURE_YOURS, writeSkillsFixture } from "./testing/skills-fixture.ts";

/** What the page asks while the owner types, filters and pages: bare, search, category, category + search, newest, a later page. */
const REQUESTS = ["", "q=report", "q=invoice+meeting", "category=Writing", "category=Finance&q=plan", "sort=newest", "status=clean", "show=new"];
const RUNS = 8;

export function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

async function measure(libraryCount: number): Promise<{ samples: number[]; total: number; facets: number; facetSum: number }> {
  const root = mkdtempSync(join(tmpdir(), "murage-sv10-timing-"));
  writeSkillsFixture(root, libraryCount);
  const env = { MURAGE_COMPANION_TOKEN: process.env.MURAGE_TEST_DOOR_TOKEN, MURAGE_SKILL_LIBRARY: root, MURAGE_APP_VERSION: "1.0.22" };
  const fixture = await launchVerificationServer(process.env, undefined, { env });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const get = async (params: string) => {
      const started = performance.now();
      const res = await fetch(`${fixture.info.url}/api/skills/query?${params}`, { headers });
      const body = await res.json() as { total: number; facets: Array<{ count: number }>; rows: unknown[] };
      expect(res.status).toBe(200);
      return { ms: performance.now() - started, body };
    };
    const first = await get("");
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) for (const params of REQUESTS) samples.push((await get(params)).ms);
    return { samples, total: first.body.total, facets: first.body.facets.length, facetSum: first.body.facets.reduce((sum, facet) => sum + facet.count, 0) };
  } finally {
    await fixture.close();
    await removeTempDir(root);
  }
}

describe("K9 timing (generated library, facets included)", () => {
  it("answers within 150 ms at p95 at 2,262 skills", async () => {
    const result = await measure(FIXTURE_TOTAL - FIXTURE_BUILTIN - FIXTURE_YOURS);
    expect(result.facets).toBeGreaterThan(5);
    expect(result.facetSum).toBe(result.total);
    console.log(`K9 p95 ${p95(result.samples).toFixed(1)} ms over ${result.samples.length} requests, ${result.total} skills`);
    expect(result.total).toBeGreaterThanOrEqual(2_247);
    expect(p95(result.samples)).toBeLessThanOrEqual(150);
  }, 180_000);

  it("answers within 400 ms at p95 at 10,000 skills", async () => {
    const result = await measure(10_000);
    expect(result.facets).toBeGreaterThan(5);
    expect(result.facetSum).toBe(result.total);
    console.log(`K9 p95 ${p95(result.samples).toFixed(1)} ms over ${result.samples.length} requests, ${result.total} skills`);
    expect(result.total).toBeGreaterThanOrEqual(10_000);
    expect(p95(result.samples)).toBeLessThanOrEqual(400);
  }, 300_000);
});
