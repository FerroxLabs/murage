// SPDX-License-Identifier: AGPL-3.0-or-later
// The `[sqlite] busy ... at=<caller>` attribution in the PACKAGED shape (rc13 real-data boot: `at=index.js:19949<index.js:19963`, which is
// waitCaller and witnessWait themselves). The packaged server is one esbuild bundle: no frame carries database.ts or io-budget.ts as its file,
// so the database layer's frames are skipped by function name, and the caller is named `function@index.js:line`.
//
// HEADLESS ONLY: a throwaway HOME and data folder for the bundled child; the bundle is written under node_modules/.cache.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, expect, it } from "vitest";
import { LAYER_FUNCTIONS, waitCaller } from "./io-budget.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const OUT = join(ROOT, "node_modules", ".cache", "wait-caller-bundle");
let home = "";
afterAll(async () => { if (home) await removeTempDir(home); });

it("names the caller from a stack of the bundled shape, never a frame of the database layer", () => {
  // what V8 prints for the bundled server: one file, the layer's functions renamed with digits by the bundler on a clash
  const stack = [
    "Error",
    "    at waitCaller (file:///app/server/index.js:19949:42)",
    "    at witnessWait (file:///app/server/index.js:19963:31)",
    "    at DatabaseSync.instrumentedExec [as exec] (file:///app/server/index.js:20101:9)",
    "    at transaction2 (file:///app/server/index.js:31012:12)",
    "    at dismissStalePeerCards (file:///app/server/index.js:88123:5)",
    "    at walk (file:///app/server/index.js:401234:20)",
  ].join("\n");
  expect(waitCaller(stack)).toBe("dismissStalePeerCards@index.js:88123<walk@index.js:401234");
  // the source shape is unchanged: file names, the layer's files skipped
  const source = [
    "Error",
    "    at waitCaller (/w/server/io-budget.ts:380:3)",
    "    at transaction (/w/server/database.ts:430:8)",
    "    at settleStaleCardPage (/w/server/peer-approval.ts:77:5)",
    "    at /w/server/index.ts:11250:7",
  ].join("\n");
  expect(waitCaller(source)).toBe("peer-approval.ts:77<index.ts:11250");
});

it("in an esbuild bundle of the database layer (the build:server options), the busy lines name the caller function", async () => {
  mkdirSync(OUT, { recursive: true });
  home = mkdtempSync(join(tmpdir(), "murage-wait-caller-"));
  const entry = join(OUT, "fixture-entry.mjs");
  const at = (file: string) => JSON.stringify(join(SERVER_DIR, file));
  writeFileSync(entry, `
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from ${at("config.ts")};
import { database, transaction, holdWritersForIndexBuild } from ${at("database.ts")};
import { setObserveSink } from ${at("observe.ts")};
const lines = [];
setObserveSink(line => lines.push(line));
const db = database();
const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
function sweepOfTheFixture() { try { transaction(() => 1, { op: "fixture" }); } catch {} }
function markOfTheFixture() {
  holdWritersForIndexBuild(true);
  try { db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('fixture', 1, 0, 0)").run(); } catch {}
  holdWritersForIndexBuild(false);
}
sweepOfTheFixture();
markOfTheFixture();
other.exec("ROLLBACK"); other.close();
process.stdout.write("LINES" + JSON.stringify(lines) + "\\n");
process.exit(0);
`);
  const outfile = join(OUT, "fixture.js");
  // the same options as scripts/bundle-server.mjs (one ESM file for node, Node built-ins through createRequire)
  await build({
    entryPoints: [entry], bundle: true, platform: "node", target: "node20", format: "esm", outfile, logLevel: "silent",
    banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
    external: ["@huggingface/transformers"], packages: "external",
  });
  const data = join(home, ".murage");
  mkdirSync(data, { recursive: true });
  const run = spawnSync(process.execPath, [outfile], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data } });
  const marker = /LINES(.*)\n/.exec(run.stdout ?? "");
  expect(marker, `${run.stdout}\n${run.stderr}`).not.toBeNull();
  const lines = JSON.parse(marker![1]!) as string[];
  const unbudgeted = lines.find(line => line.includes("budget=none"));
  expect(unbudgeted, lines.join("\n")).toMatch(/^\[sqlite\] busy op=BEGIN IMMEDIATE waited=\d+ holder=other-connection budget=none at=sweepOfTheFixture@fixture\.js:\d+/);
  const lowered = lines.find(line => line.startsWith("[sqlite] busy op=INSERT OR REPLACE INTO transcript_index_state"));
  expect(lowered, lines.join("\n")).toMatch(/holder=writer-hold budget=50 at=markOfTheFixture@fixture\.js:\d+/);
  for (const line of lines) expect(line).not.toMatch(/at=(?:waitCaller|witnessWait|transaction|instrumented)/);
}, 120_000);

// The full packaged bundle (pnpm build:server): every layer function the attribution skips by name is a named function there.
const DIST = join(ROOT, "dist-server", "index.js");
it.skipIf(!existsSync(DIST))("the packaged server bundle keeps the database layer's function names", () => {
  const bundle = readFileSync(DIST, "utf8");
  for (const name of LAYER_FUNCTIONS) expect(bundle, name).toMatch(new RegExp(`(?:\\bfunction ${name}\\d*\\(|\\bconst ${name}\\d* = )`));
});
