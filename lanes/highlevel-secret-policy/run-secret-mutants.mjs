// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const file = "electron/highlevel-credentials.mjs";
const original = readFileSync(file, "utf8");
const mutations = [
  ["M-SECRET-ACTIVATE-BEFORE-COMMIT", "await updateDocument(document => {", 'await request("commit", { commitId: proposal.commitId, bank }, commitCredential);\n          await updateDocument(document => {'],
  ["M-OAUTH-REFRESH-TO-HOME", "exact(value, grantKeys)", "(record(value) && grantKeys.every(key => Object.hasOwn(value, key)))"],
];
const results = [];
try {
  for (const [name, from, to] of mutations) {
    if (!original.includes(from)) throw Error(`mutant anchor absent: ${name}`);
    writeFileSync(file, original.replace(from, to));
    const run = spawnSync(process.execPath, ["--test", "electron/highlevel-credentials.node-test.mjs"], { encoding: "utf8" });
    const output = `${run.stdout}${run.stderr}`;
    writeFileSync(`lanes/highlevel-secret-policy/${name}.log`, output);
    const killed = run.status !== 0 && /ERR_ASSERTION|AssertionError/u.test(output);
    results.push({ name, killed, status: run.status });
    if (!killed) throw Error(`mutant survived or failed outside assertions: ${name}`);
  }
} finally { writeFileSync(file, original); writeFileSync("lanes/highlevel-secret-policy/secret-mutants.json", JSON.stringify(results, null, 2) + "\n"); }
