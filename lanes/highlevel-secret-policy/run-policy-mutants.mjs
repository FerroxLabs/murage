// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const file = "server/highlevel/scope-policy.ts", original = readFileSync(file, "utf8");
const mutations = [
  ["M-SCOPE-CUSTOMFIELD-ID-SKIP", "Array.isArray(args.customFields) && args.customFields.length > 0", "Array.isArray(args.customFields) && args.customFields.some(field => field.name)", "custom-field IDs"],
  ["M-SCOPE-SKIP-READ-PERMISSION", "requiredScopes.filter(scope => !passive.scopes.includes(scope))", "requiredScopes.filter(scope => scope === descriptor.endpointScope && !passive.scopes.includes(scope))", "removal of any required scope"],
  // The evaluator has no I/O dependency to reorder. Inject the forbidden first
  // read before refusal, under the zero-I/O test's fake fetch. Host owns the
  // actual ownership-hook reorder mutant; this pins the policy boundary itself.
  ["M-SCOPE-AFTER-FIRST-READ", 'if (missing.length > 0) return refuse("missing_scope", missing);', 'if (missing.length > 0) { globalThis.fetch("https://fixture.example.test/first-read"); return refuse("missing_scope", missing); }', "removal of any required scope"],
  ["M-SCOPE-PIT-ALL-WRITES", "if (missing.length > 0)", "if (false && missing.length > 0)", "PIT location proof"],
];
const results = [];
try {
  for (const [name, from, to, pattern] of mutations) {
    if (!original.includes(from)) throw Error(`mutant anchor absent: ${name}`);
    writeFileSync(file, original.replace(from, to));
    const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/highlevel/scope-policy.test.ts", "-t", pattern], { encoding: "utf8" });
    const output = `${run.stdout}${run.stderr}`;
    writeFileSync(`lanes/highlevel-secret-policy/${name}.log`, output);
    const killed = run.status !== 0 && /AssertionError/u.test(output) && !/Unhandled Rejection|Unhandled Error/u.test(output);
    results.push({ name, killed, status: run.status });
    if (!killed) throw Error(`mutant survived or failed outside assertions: ${name}`);
  }
} finally { writeFileSync(file, original); writeFileSync("lanes/highlevel-secret-policy/policy-mutants.json", JSON.stringify(results, null, 2) + "\n"); }
