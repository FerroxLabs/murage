// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it.each(['C:\\fixture space\\git-gate.mjs', 'D:\\fixture#percent%\\git-gate.mjs'])(
  'restore fixture passes an ESM file URL for %s', preload => {
    // Evaluate the actual spawn argument, with Node's Windows URL rules. A raw
    // drive path is an ESM scheme, even though it works as --import on Linux.
    const source = readFileSync('server/project-restore-admission.test.ts', 'utf8');
    const argument = source.match(/"--import", (.*?), fileURLToPath/)[1];
    const specifier = runInNewContext(argument, { preload, pathToFileURL: value => pathToFileURL(value, { windows: true }) });
    expect(new URL(specifier).protocol).toBe('file:');
    expect(specifier).toBe(pathToFileURL(preload, { windows: true }).href);
  },
);
