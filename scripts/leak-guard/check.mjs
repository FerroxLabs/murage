#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The environment override transports the unchanged shared pair into isolated CI.
export const sharedDirectory = process.env.PUBLIC_LEAK_GUARD_SHARED_DIR || '/root/fuigo-builds/shared';
export const defaultBase = '0bcda6c9e';

export function main(args = process.argv.slice(2)) {
  try {
    let root = process.cwd(), base = defaultBase;
    for (let i = 0; i < args.length; i += 2) {
      const value = args[i + 1];
      if (!value) throw new Error();
      if (args[i] === '--root') root = resolve(value);
      else if (args[i] === '--base') base = value;
      else throw new Error();
    }
    const script = join(sharedDirectory, 'leak-guard.sh');
    accessSync(script, constants.R_OK);
    accessSync(join(sharedDirectory, 'public-leak-patterns.txt'), constants.R_OK);
    if (existsSync(join(root, '.leak-guard-exclude'))) throw new Error();
    // The shared shell script does not fail closed on invalid Git references.
    for (const ref of ['HEAD', base]) {
      const check = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' });
      if (check.status !== 0) throw new Error();
    }
    const result = spawnSync('bash', [script, root, base], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status) || result.stderr) throw new Error();
    // Never relay the shared script's matched source lines (or Git diagnostics).
    // Counting its output does not introduce another matcher or pattern list.
    let section, tree = 0, added = 0, verdict;
    for (const line of result.stdout.trimEnd().split('\n')) {
      if (line.startsWith('== whole tree (')) section = 'tree';
      else if (line.startsWith('== added lines ')) section = 'added';
      else if (line === 'LEAK_GUARD: PASS' || line === 'LEAK_GUARD: FAIL') verdict = line;
      else if (section === 'tree' && /^HEAD:.*:\d+:/.test(line)) tree++;
      else if (section === 'added' && /^\d+:\+/.test(line)) added++;
      else throw new Error();
    }
    if (section !== 'added' || verdict !== (result.status === 0 ? 'LEAK_GUARD: PASS' : 'LEAK_GUARD: FAIL')) throw new Error();
    console.log(`shared leak-guard: whole-tree ${tree} hit(s); added-lines ${added} hit(s); exit ${result.status}`);
    return result.status;
  } catch {
    console.error('shared leak-guard: scan/configuration error (requires shared script, shared patterns, valid tree and base; --root DIR --base REF)');
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
