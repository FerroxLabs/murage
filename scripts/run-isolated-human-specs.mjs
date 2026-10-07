// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The human specs that need a harness of their own, each file in its own
// Playwright run with its own config.
//
// playwright.config.ts seeds one shared workspace, and these specs cannot
// ride it (they never passed there in CI):
//   - first-run-*: a first run is only ever an empty, never-used workspace
//     (playwright.first-run.config.ts, no seeding). One harness per run, so
//     two files in one run share it: a file that picks "Help me run my
//     business" leaves a crew behind and the next opens on a workspace that
//     is no longer new (first-run-machine-states failed after
//     first-run-flux-path in the 0.1.61 CI lane, and passed alone).
//   - setup-first-run, setup-blocked: the engine must be set to fail before
//     the harness binds (their configs' webServer).
//
//   node scripts/run-isolated-human-specs.mjs [--shard=N/M]
//   node scripts/run-isolated-human-specs.mjs --shared <spec paths...>
//   node scripts/run-isolated-human-specs.mjs <spec paths...> [-- <playwright args>]
//
// With --shard the files are dealt round-robin, so CI's human shards share them.
// With spec paths (a scoped confirmation) only the isolated ones among them
// run; --shared prints the rest, one per line, for the seeded config.
// Each file writes its evidence to <MURAGE_E2E_DATA_DIR>/isolated-results/<name>,
// so one run never wipes another's (Playwright empties its output dir).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

/** The config a spec file must run under, or null when the shared human config serves it. */
export function isolatedConfigFor(file) {
  if (/^first-run-.*\.human\.spec\.ts$/.test(file)) return "playwright.first-run.config.ts";
  if (file === "setup-first-run.human.spec.ts") return "src/e2e/setup-first-run.config.ts";
  if (file === "setup-blocked.human.spec.ts") return "src/e2e/setup-blocked.config.ts";
  return null;
}

/** The isolated files this shard runs, sorted, dealt round-robin. */
export function isolatedSpecsForShard(files, shard) {
  const sorted = files.filter(name => isolatedConfigFor(name) !== null).sort();
  if (!shard) return sorted;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error("--shard must be N/M with 1 <= N <= M");
  const index = Number(match[1]) - 1, total = Number(match[2]);
  return sorted.filter((_, position) => position % total === index);
}

/** Split hand-picked spec paths into those the seeded config runs and the
 * isolated basenames. Only files directly in src/e2e exist to either runner. */
export function splitSelectedSpecs(paths) {
  const shared = [], isolated = [];
  for (const file of paths) {
    const match = /^src\/e2e\/([^/\\]+\.human\.spec\.ts)$/.exec(file);
    if (!match) throw new Error(`${file}: a human spec is a file directly in src/e2e`);
    if (isolatedConfigFor(match[1])) isolated.push(match[1]);
    else shared.push(file);
  }
  return { shared, isolated: isolated.sort() };
}

/** The pnpm arguments that run one isolated file, its evidence kept apart. */
export function isolatedRunArgs(file, scratch, extra = []) {
  const args = ["exec", "playwright", "test", "--config", isolatedConfigFor(file), `src/e2e/${file}`];
  if (scratch) args.push("--output", path.join(scratch, "isolated-results", file.replace(/\.human\.spec\.ts$/, "")));
  return [...args, ...extra];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = process.argv.slice(2);
  const cut = all.indexOf("--");
  const args = cut < 0 ? all : all.slice(0, cut), extra = cut < 0 ? [] : all.slice(cut + 1);
  const shardArg = args.find(arg => arg.startsWith("--shard="));
  const printShared = args.includes("--shared");
  const paths = args.filter(arg => arg !== shardArg && arg !== "--shared");
  if (shardArg && paths.length) throw new Error("usage: run-isolated-human-specs.mjs [--shard=N/M] | [--shared] <spec paths...>");
  if (printShared) {
    for (const file of splitSelectedSpecs(paths).shared) console.log(file);
    process.exit(0);
  }
  const files = paths.length ? splitSelectedSpecs(paths).isolated
    : isolatedSpecsForShard(readdirSync(path.join(repository, "src", "e2e")), shardArg?.slice("--shard=".length));
  const failed = [];
  for (const file of files) {
    const result = spawnSync("pnpm", isolatedRunArgs(file, process.env.MURAGE_E2E_DATA_DIR, extra),
      { cwd: repository, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) failed.push(file);
  }
  if (failed.length) { console.error(`isolated human specs failed: ${failed.join(", ")}`); process.exit(1); }
  console.log(files.length ? `isolated human specs passed: ${files.length} file(s)` : "no isolated human specs selected");
}
