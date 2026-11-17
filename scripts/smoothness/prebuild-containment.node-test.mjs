// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./prebuild-index.mjs", import.meta.url));
const snapshots = ["messages.pre-memory-v2.db", "messages.pre-memory-v3.db", "messages.pre-memory-v4.db"];
const cases = [
  { name: "database symlink", link: "messages.db" },
  { name: "database directory symlink", directory: true },
  { name: "ancestor directory symlink", ancestor: true },
  ...["messages.db", ...snapshots.flatMap(name => [name, `${name}.partial`])].flatMap(name =>
    ["", "-wal", "-shm", "-journal"].filter(suffix => name !== "messages.db" || suffix).flatMap(suffix =>
      [false, true].map(dangling => ({ name: `${name}${suffix} ${dangling ? "dangling" : "existing"} escape`, link: `${name}${suffix}`, dangling })))),
  { name: "snapshot parent traversal", snapshot: "../outside/snapshot.db" },
  { name: "snapshot absolute path", absolute: true },
  { name: "snapshot absolute path inside database directory", absoluteInside: true },
  { name: "snapshot nested directory", snapshot: "nested/snapshot.db" },
  { name: "partial suffix traversal", partial: "/../../outside/partial.db" },
];

for (const scenario of cases) test(`containment refuses ${scenario.name} before open`, () => {
  const root = mkdtempSync(join(tmpdir(), "rigpre4-containment-"));
  try {
    const dir = join(root, "data"), outside = join(root, "outside"), product = join(root, "product");
    for (const path of [dir, outside, join(product, "server/memory")]) mkdirSync(path, { recursive: true });
    const victim = join(outside, "untouched");
    writeFileSync(victim, "outside sentinel");
    // Minimal registry only: containment must refuse before opening this
    // deliberately non-SQLite file or calling a product migration.
    writeFileSync(join(product, "server/memory/optional-index.ts"), "export const OPTIONAL_INDEXES = [];");
    writeFileSync(join(product, "server/memory/schema.ts"), `
      export const MEMORY_PRE_V2_SNAPSHOT = ${JSON.stringify(scenario.absoluteInside ? join(dir, "snapshot.db") : scenario.absolute ? join(outside, "snapshot.db") : scenario.snapshot ?? snapshots[0])};
      export const MEMORY_PRE_V3_SNAPSHOT = ${JSON.stringify(snapshots[1])};
      export const MEMORY_PRE_V4_SNAPSHOT = ${JSON.stringify(snapshots[2])};
      export const MEMORY_SNAPSHOT_PARTIAL_SUFFIX = ${JSON.stringify(scenario.partial ?? ".partial")};
    `);
    let file = join(dir, "messages.db");
    if (scenario.link !== "messages.db") writeFileSync(file, "fixture sentinel");
    if (scenario.link) symlinkSync(scenario.dangling ? join(outside, "absent") : victim, join(dir, scenario.link));
    if (scenario.directory || scenario.ancestor) {
      const alias = join(root, "alias");
      symlinkSync(scenario.ancestor ? root : dir, alias);
      file = scenario.ancestor ? join(alias, "data/messages.db") : join(alias, "messages.db");
    }
    const entries = readdirSync(dir).sort();
    for (const mode of ["--build", "--verify"]) {
      const result = spawnSync(process.execPath, [cli, mode, product, file], {
        encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: root, MURAGE_DATA_DIR: dir },
      });
      assert.equal(result.status, 4, `${result.error ?? ""}\n${result.stderr}`);
      assert.match(result.stderr, /PREBUILD FAILED: (database .*symlink|snapshot or sidecar)/);
      assert.equal(readFileSync(victim, "utf8"), "outside sentinel");
      if (scenario.link !== "messages.db") assert.equal(readFileSync(join(dir, "messages.db"), "utf8"), "fixture sentinel");
      assert.deepEqual(readdirSync(outside), ["untouched"]);
      assert.deepEqual(readdirSync(dir).sort(), entries);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
