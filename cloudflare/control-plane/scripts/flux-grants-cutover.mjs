#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Stub-era cutover for credit grants (design b4/GRANTS-DESIGN.md r9 section 7). NOT a D1 migration. DRY RUN unless --apply.
//   node --experimental-strip-types scripts/flux-grants-cutover.mjs --db <d1 database name> [--env staging] [--apply --quiesced]
// FLUX_B4_CONFIG (optional, the plan catalogue) must be the value the deployed Worker uses; unset means the catalogue defaults.
// --quiesced asserts step (a): the CP build with D1-D3 is deployed with FLUX_CLOUD_GRANTS_TOKEN ABSENT and one sweep has passed.
// Runs the same code the fixture test exercises (src/flux-grants-cutover.ts) through `wrangler d1 execute --remote`. Resumable: rerun after
// any interruption. Exit codes: 0 verified (apply) or a clean dry run, 2 apply not verified, 3 rows need review, 64 usage. Never prints a secret.
import { runStubCutover } from "../src/flux-grants-cutover.ts";

const WRANGLER_VERSION = "4.149.0";
const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" && Number.isFinite(v) ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const inline = (sql, binds) => { let i = 0; const out = sql.replace(/\?/g, () => lit(binds[i++])); if (i !== binds.length) throw new Error("bind_count_mismatch"); return out; };

/** A D1Database-shaped adapter over `wrangler d1 execute --remote --json`. A prepared statement runs BOUND (.bind(...).all/first/run) or
 *  UNBOUND (.all/first/run directly), as D1's own API allows. `exec(cmd, args, opts)` returns wrangler's stdout (sync or a promise). */
export function d1Adapter(database, wranglerEnv, exec) {
  const run = async (sql) => {
    const args = ["--yes", `wrangler@${WRANGLER_VERSION}`, "d1", "execute", database, "--remote", "--json", "--command", sql, ...(wranglerEnv ? ["--env", wranglerEnv] : [])];
    const out = JSON.parse(await exec("npx", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const r = Array.isArray(out) ? out[0] : out;
    if (!r || r.success === false) throw new Error("d1_execute_failed");
    return r;
  };
  const statement = (sql, binds) => {
    const text = () => inline(sql, binds);
    return {
      bind: (...more) => statement(sql, [...binds, ...more]),
      all: async () => { const r = await run(text()); return { results: r.results ?? [], success: true, meta: r.meta ?? {} }; },
      first: async (column) => { const row = ((await run(text())).results ?? [])[0] ?? null; return column === undefined || row === null ? row : row[column] ?? null; },
      run: async () => { const r = await run(text()); return { results: r.results ?? [], success: true, meta: { ...(r.meta ?? {}), changes: r.meta?.changes ?? 0 } }; },
    };
  };
  return { prepare: (sql) => statement(sql, []) };
}

/** The CLI. `deps.exec` defaults to child_process.execFileSync; `deps.log` to console.log. Returns the exit code. */
export async function main(argv, deps = {}) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const db = opt("--db");
  if (!db) { (deps.error ?? console.error)("usage: --db <database> [--env <name>] [--apply --quiesced]"); return 64; }
  const exec = deps.exec ?? (await import("node:child_process")).execFileSync;
  const env = deps.env ?? process.env;
  const report = await runStubCutover({ DB: d1Adapter(db, opt("--env"), exec), FLUX_B4_CONFIG: env.FLUX_B4_CONFIG },
    { apply: argv.includes("--apply"), quiesced: argv.includes("--quiesced"), now: deps.now ?? Date.now() });
  (deps.log ?? console.log)(JSON.stringify(report, null, 2));
  if (report.apply && !report.verified) return 2;
  if (report.rows.some((r) => r.action === "pending_review" || r.action === "would_flag" || r.action === "skipped_changed")) return 3;
  return 0;
}
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
}
