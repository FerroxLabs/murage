// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function compareGate(manifest, reports) {
  const sides = {};
  for (const side of ['base', 'head']) {
    const files = new Set(), failures = [], occurrences = new Map();
    let tests = 0, passed = 0;
    for (const { sha, report } of reports[side]) {
      if (sha !== manifest[side]) throw new Error(`${side}: wrong SHA ${sha}`);
      for (const file of report.testResults) {
        const name = manifest.files.find(name => file.name === name || file.name.endsWith('/' + name));
        if (!name || files.has(name)) throw new Error(`${side}: unexpected or duplicate file ${file.name}`);
        files.add(name);
        let failed = false;
        for (const assertion of file.assertionResults ?? []) {
          tests++; passed += Number(assertion.status === 'passed');
          const prefix = `${name} :: ${assertion.fullName}`;
          const count = (occurrences.get(prefix) ?? 0) + 1; occurrences.set(prefix, count);
          if (assertion.status === 'failed') {
            failed = true;
            failures.push({ key: `${prefix} #${count}`, error: (assertion.failureMessages ?? [''])[0].split('\n')[0] });
          }
        }
        if (file.status === 'failed' && !failed) failures.push({ key: `${name} :: COLLECTION_OR_HOOK`, error: file.message ?? '' });
      }
    }
    const missing = manifest.files.filter(name => !files.has(name));
    if (missing.length) throw new Error(`${side}: missing reports for ${missing.join(', ')}`);
    sides[side] = { sha: manifest[side], files: files.size, tests, passed, failures: failures.sort((a, b) => a.key.localeCompare(b.key)) };
  }
  const base = new Set(sides.base.failures.map(f => f.key)), head = new Set(sides.head.failures.map(f => f.key));
  const headOnlyFailures = [...head].filter(key => !base.has(key));
  return { ...sides, headOnlyFailures, resolvedFailures: [...base].filter(key => !head.has(key)), admissible: headOnlyFailures.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = compareGate(input.manifest, input.reports);
    writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ admissible: result.admissible, baseFailures: result.base.failures.length, headFailures: result.head.failures.length, headOnlyFailures: result.headOnlyFailures }));
    process.exitCode = result.admissible ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
