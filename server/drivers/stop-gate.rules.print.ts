// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Authoring aid for stop-gate.rules.config.ts (not a test): from the repo root,
//   node server/drivers/stop-gate.rules.print.ts <engine-id | all> [--all] [--keys]
// prints, per function key, the exempt-site rows the checker asks for, as JSON FnRule drafts with reason "TODO". Read every row, classify the
// function (turn, not-turn, close, reap), give each row a real reason and put it in the config: the test refuses an empty reason, and a
// row that matches nothing. The listing is computed against the config's current kinds (rows are ignored), so classify first, run again, and
// the call rows (a turn-path function calling a not-turn or reap function) show up. `--all` also lists the compliant items, `--keys` every
// function key.
import path from "node:path";
import { computeKeys, createRulesProgram, listItems, rowField } from "./stop-gate.rules.checker.ts";
import { ENGINES } from "./stop-gate.rules.config.ts";
import type { FnRule } from "./stop-gate.rules.config.ts";

const repoRoot = process.cwd();
const id = process.argv[2];
const all = process.argv.includes("--all");
const wantKeys = process.argv.includes("--keys");
const engines = ENGINES.filter((e) => id === "all" || e.id === id);
if (engines.length === 0) throw new Error(`unknown engine ${id}`);
const t0 = Date.now();
const ctx = createRulesProgram(repoRoot, engines.map((e) => e.file));
console.error(`Program built in ${Date.now() - t0} ms`);
for (const engine of engines) {
  const kindsOnly: FnRule[] = engine.fns.map((f) => ({ key: f.key, kind: f.kind, reason: f.reason }));
  const items = listItems(ctx, engine.file, { ...engine, fns: kindsOnly });
  if (wantKeys) {
    const sf = ctx.program.getSourceFile(path.resolve(repoRoot, engine.file));
    if (sf) for (const k of computeKeys(sf, engine.id).nodeOf.keys()) console.log(`KEY ${k}`);
  }
  const byKey = new Map<string, FnRule>();
  for (const it of items) {
    if (!it.violation && !all) continue;
    let r = byKey.get(it.key);
    if (!r) { r = { key: it.key, kind: engine.fns.find((f) => f.key === it.key)?.kind ?? "turn", reason: "TODO" }; byKey.set(it.key, r); }
    (r[rowField(it.kind)] ??= []).push([it.ordinal, it.text, it.violation ? "TODO" : "compliant"]);
  }
  console.log(`// ===== ${engine.id}: ${byKey.size} functions with rows`);
  for (const r of byKey.values()) console.log(JSON.stringify(r));
}
console.error(`total ${Date.now() - t0} ms`);
