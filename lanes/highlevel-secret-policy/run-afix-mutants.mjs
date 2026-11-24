// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const out = "lanes/highlevel-secret-policy/afix-evidence";
const node = ["--test", "electron/highlevel-credentials.node-test.mjs"];
const witnesses = ["--test", "lanes/highlevel-secret-policy/baseline-behavior.node-test.mjs"];
const mutations = [
  ["M-WINDOWS-READONLY-FLUSH", "electron/main.mjs", 'fs.openSync(CREDENTIALS_FILE, "r+")', 'fs.openSync(CREDENTIALS_FILE, "r")', node],
  ["M-BULK-UNSUPPORTED-SELECTOR", "server/highlevel/scope-policy.ts", 'id.length > 75', 'id.length > 128',
    ["node_modules/vitest/vitest.mjs", "run", "server/highlevel/scope-policy.test.ts", "-t", "bulk selector|500 distinct"]],
  ["M-BASELINE-UNSAFE-STORAGE", "electron/highlevel-credentials.mjs", 'if (platform === "linux") {', 'if (false && platform === "linux") {', witnesses],
  ["M-BASELINE-ROLLBACK-UNCERTAIN-BANK", "electron/highlevel-credentials.mjs", '        } catch { return fail("outcome_unknown"); }',
    '        } catch { await updateDocument(document => ({ ...document, highlevelBank: previous })); return fail("outcome_unknown"); }', witnesses],
  ["M-BASELINE-ENDPOINT-ONLY", "server/highlevel/scope-policy.ts", 'requiredScopes.filter(scope => !passive.scopes.includes(scope))',
    'requiredScopes.filter(scope => scope === descriptor.endpointScope && !passive.scopes.includes(scope))', witnesses],
];
const results = [];
for (const [name, file, from, to, args] of mutations) {
  const original = readFileSync(file, "utf8");
  try {
    if (!original.includes(from)) throw Error(`missing mutant anchor: ${name}`);
    writeFileSync(file, original.replace(from, to));
    const run = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, HL_WITNESS_MODE: "candidate" } });
    const output = `${run.stdout}${run.stderr}`;
    writeFileSync(`${out}/${name}.log`, output);
    const killed = run.status !== 0 && /ERR_ASSERTION|AssertionError/u.test(output)
      && !/ERR_MODULE_NOT_FOUND|Cannot find module|Unhandled Rejection|Unhandled Error/u.test(output);
    results.push({ name, killed, status: run.status });
    if (!killed) throw Error(`mutant survived or failed outside assertions: ${name}`);
  } finally {
    writeFileSync(file, original);
    writeFileSync(`${out}/mutants.json`, JSON.stringify(results, null, 2) + "\n");
  }
}
