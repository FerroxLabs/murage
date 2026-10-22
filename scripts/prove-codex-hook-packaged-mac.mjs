#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 packaged macOS proof for the Codex hook launch, run on the GitHub macOS runner against the FINAL packaged app
// (never on a person's machine; it needs no Codex login). Counterpart of prove-codex-hook-packaged-win.ps1.
//   node scripts/prove-codex-hook-packaged-mac.mjs <path to Murage.app>
// The hook script is the one server/drivers/codex-hook.ts writes (CODEX_HOOK_SCRIPT), written by this step as murage-hook.mjs.
// Every run uses a throwaway HOME (and, for the app-shaped run, a throwaway --user-data-dir), stdin from /dev/null and a hard
// 20 s timeout; only pids this script started (or that appeared during its run carrying its own throwaway folder) are killed.
//   1. new shape: /usr/bin/env ELECTRON_RUN_AS_NODE=1 "<exe>" "<script>"  -> blocked with "Unexpected end of JSON input".
//      The script blocks a call whose hook event it could not read with a PreToolUse deny on stdout and exit 0 (Codex honours a
//      printed deny only on exit 0), and a SessionStart with exit 2; both are a block. Either is accepted, the reason must match.
//   2. guard (old shape, ELECTRON_RUN_AS_NODE unset): "<exe>" "<script>" -> exit 2 "hook started without node mode", no app window.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const TIMEOUT_MS = 20_000;
const SETTLE_MS = 3_000;
const app = resolve(process.argv[2] ?? "release/mac-arm64/Murage.app");
const exe = join(app, "Contents", "MacOS", "Murage");
if (!existsSync(exe)) { console.error(`FAIL no packaged binary at ${exe}`); process.exit(1); }

const root = realpathSync(mkdtempSync(join(tmpdir(), "murage-hook-proof-")));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const processes = () => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(m => ({ pid: Number(m[1]), command: m[2] }));
const exePids = () => new Set(processes().filter(p => p.command.startsWith(exe) && p.pid !== process.pid).map(p => p.pid));
const failures = [];
const fail = message => { failures.push(message); console.error(`FAIL ${message}`); };

async function script() {
  // generated the same way the driver ships it: the source's own export, bundled by the repo's esbuild
  const bundle = join(root, "codex-hook-bundle.mjs");
  const built = spawnSync("pnpm", ["exec", "esbuild", "server/drivers/codex-hook.ts", "--bundle", "--platform=node", "--format=esm", "--log-level=error", `--outfile=${bundle}`], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`could not bundle codex-hook.ts: ${(built.stderr || built.stdout).trim()}`);
  const { CODEX_HOOK_SCRIPT, HOOK_SCRIPT_FILE } = await import(pathToFileURL(bundle).href);
  const dir = join(root, "scope");
  spawnSync("mkdir", ["-p", dir]);
  const file = join(dir, HOOK_SCRIPT_FILE);
  writeFileSync(file, CODEX_HOOK_SCRIPT, { mode: 0o600 });
  return file;
}

/** One launch: throwaway HOME, ERAN unset in this process's own env, stdin /dev/null, 20 s hard timeout. */
async function launch(name, command, args) {
  const home = join(root, `home-${name}`);
  spawnSync("mkdir", ["-p", home]);
  const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home };
  const before = exePids();
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, TIMEOUT_MS);
  const code = await new Promise(done => { child.on("close", c => done(c)); child.on("error", () => done(null)); });
  clearTimeout(timer);
  await sleep(SETTLE_MS);
  const stray = [...exePids()].filter(pid => !before.has(pid));
  // kill only what appeared during this run AND carries this run's own throwaway folder
  const mine = new Set(processes().filter(p => stray.includes(p.pid) && p.command.includes(root)).map(p => p.pid));
  for (const pid of mine) { try { process.kill(pid, "SIGKILL"); } catch {} }
  console.log(`${name}: exit=${timedOut ? "TIMEOUT" : code} stray=${stray.length} stderr=${JSON.stringify(stderr.trim())}`);
  return { code, stdout, stderr, timedOut, stray };
}

try {
  const hook = await script();

  const fresh = await launch("new-shape", "/usr/bin/env", ["ELECTRON_RUN_AS_NODE=1", exe, hook]);
  const reason = "Murage blocked this call";
  const exit2 = fresh.code === 2;
  const printedDeny = fresh.code === 0 && fresh.stdout.includes('"permissionDecision":"deny"') && fresh.stdout.includes(reason);
  if (fresh.timedOut) fail("new shape timed out");
  else if (!exit2 && !printedDeny) fail(`new shape neither exit 2 nor exit 0 with a deny JSON on stdout containing "${reason}" (exit ${fresh.code})`);
  if (fresh.stray.length) fail(`new shape left Murage processes behind: ${fresh.stray.join(",")}`);

  const old = await launch("guard", exe, [hook, `--user-data-dir=${join(root, "user-data-guard")}`]);
  if (old.timedOut) fail("guard run hung (the guard is missing)");
  else if (old.code !== 2) fail(`guard run exited ${old.code}, wanted 2`);
  else if (!old.stderr.includes("Murage blocked this call: hook started without node mode")) fail('guard stderr lacks "hook started without node mode"');
  if (old.stray.length) fail(`guard run left a Murage process behind: ${old.stray.join(",")}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  safeWipeSync(root);
}
if (failures.length) { console.error(`FAIL (${failures.length})`); process.exit(1); }
console.log("PASS");
