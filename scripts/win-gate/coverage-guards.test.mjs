// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { windowsExclusions } from './coverage-guards.mjs';

it.each([
  `import {describe} from 'vitest'; describe.skipIf(process.platform === 'win32')('api',()=>{});`,
  `import {describe as group} from 'vitest'; const windows = process.platform === 'win32'; const posix = group.skipIf(windows); posix('api',()=>{});`,
  `import {it} from 'vitest'; const windows = 'win32' === process.platform; it.skipIf(windows)('api',()=>{});`,
  `import {it as row} from 'vitest'; const platform = process.platform; const posix = platform !== 'win32'; row.runIf(posix)('api',()=>{});`,
  `import {test} from 'vitest'; const posix = test.skipIf(process.platform === 'win32'); const alias = posix; alias.each([1,2])('api %s',()=>{});`,
  `import {describe} from 'vitest'; describe.skip('api',()=>{});`,
])('detects Windows coverage exclusion: %s', source => {
  expect(windowsExclusions(source)).toHaveLength(1);
});
it.each([
  `import {it} from 'vitest'; it('api',()=>{});`,
  `import {it} from 'vitest'; it.skipIf(process.platform !== 'win32')('api',()=>{});`,
  `import {it} from 'vitest'; it.runIf(process.platform === 'win32')('api',()=>{});`,
  `import {it} from 'vitest'; it.skipIf(!mergedSha)('api',()=>{});`,
  `// describe.skipIf(process.platform === 'win32')\nimport {it} from 'vitest'; it('api',()=>{});`,
])('allows collected tests and unrelated qualification guards: %s', source => {
  expect(windowsExclusions(source)).toEqual([]);
});
