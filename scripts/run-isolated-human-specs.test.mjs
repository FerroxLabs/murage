// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isolatedConfigFor, isolatedRunArgs, isolatedSpecsForShard, splitSelectedSpecs } from "./run-isolated-human-specs.mjs";

const e2e = readdirSync(new URL("../src/e2e/", import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("human specs that need a harness of their own run on it", () => {
  it("deals every isolated file to exactly one of six shards, each with a config that exists", () => {
    const all = isolatedSpecsForShard(e2e);
    expect(all).toEqual(expect.arrayContaining(["setup-blocked.human.spec.ts", "setup-first-run.human.spec.ts", "first-run-every-path.human.spec.ts"]));
    for (const file of all) expect(existsSync(new URL(`../${isolatedConfigFor(file)}`, import.meta.url)), file).toBe(true);
    const dealt = [1, 2, 3, 4, 5, 6].flatMap(n => isolatedSpecsForShard(e2e, `${n}/6`));
    expect(dealt.sort()).toEqual(all);
    expect(() => isolatedSpecsForShard(e2e, "7/6")).toThrow("--shard");
    expect(isolatedConfigFor("intake.human.spec.ts")).toBeNull();
  });

  it("every spec config that boots its own harness is one of them", () => {
    for (const config of readdirSync(new URL("../src/e2e/", import.meta.url)).filter(name => name.endsWith(".config.ts"))) {
      const text = read(`src/e2e/${config}`);
      if (!text.includes("webServer")) continue;
      const match = /testMatch:\s*"([^"]+)"/.exec(text);
      expect(match && isolatedConfigFor(match[1]), config).toBe(`src/e2e/${config}`);
    }
  });

  it("the seeded human config never runs them, and CI runs them with their own configs", () => {
    const config = read("playwright.config.ts");
    for (const pattern of ['"**/first-run-*.human.spec.ts"', '"**/setup-first-run.human.spec.ts"', '"**/setup-blocked.human.spec.ts"']) expect(config).toContain(pattern);
    const ci = parse(read(".github/workflows/ci.yml"));
    const steps = ci.jobs.human.steps.map(step => step.run ?? "").join("\n");
    expect(steps).toContain('node scripts/run-isolated-human-specs.mjs --shard="$HUMAN_SHARD"');
  });

  // A scoped confirmation names files by hand: the isolated ones must still
  // run on their own configs, or the shared config's testIgnore drops them
  // and the job passes without them.
  it("splits a hand-picked selection into shared and isolated files, and refuses what neither runs", () => {
    expect(splitSelectedSpecs(["src/e2e/media-player.human.spec.ts", "src/e2e/setup-blocked.human.spec.ts", "src/e2e/first-run-every-path.human.spec.ts"])).toEqual({
      shared: ["src/e2e/media-player.human.spec.ts"],
      isolated: ["first-run-every-path.human.spec.ts", "setup-blocked.human.spec.ts"],
    });
    expect(() => splitSelectedSpecs(["src/e2e/nested/first-run-x.human.spec.ts"])).toThrow("src/e2e");
    const confirm = parse(read(".github/workflows/ci.yml")).jobs["human-confirmation"].steps.map(step => step.run ?? "").join("\n");
    expect(confirm).toContain("scripts/run-isolated-human-specs.mjs");
  });

  it("no human spec hides in a folder that neither runner walks", () => {
    const nested = readdirSync(new URL("../src/e2e/", import.meta.url), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".human.spec.ts") && !entry.parentPath.replace(/[\\/]+$/, "").endsWith("e2e"));
    expect(nested.map(entry => entry.name)).toEqual([]);
  });

  // The seeded step's failure evidence sits in the same scratch root: an
  // isolated run must neither wipe it (its harness data dir is a subfolder)
  // nor wipe the previous isolated file's evidence (one output dir per file),
  // and CI uploads both.
  it("keeps every run's evidence: own data dir, own output per file, both uploaded", () => {
    expect(read("playwright.first-run.config.ts")).toMatch(/join\(SCRATCH_DATA_DIR, "first-run-data"\)/);
    expect(isolatedRunArgs("setup-blocked.human.spec.ts", "/scratch")).toEqual([
      "exec", "playwright", "test", "--config", "src/e2e/setup-blocked.config.ts", "src/e2e/setup-blocked.human.spec.ts", "--output", join("/scratch", "isolated-results", "setup-blocked"),
    ]);
    const ci = parse(read(".github/workflows/ci.yml"));
    for (const job of ["human", "human-confirmation"]) {
      const upload = ci.jobs[job].steps.find(step => String(step.uses ?? "").startsWith("actions/upload-artifact"));
      expect(upload.with.path, job).toContain("murage-e2e-scratch/isolated-results");
      expect(upload.with.path, job).toContain("murage-e2e-scratch/human-results");
    }
  });
});
