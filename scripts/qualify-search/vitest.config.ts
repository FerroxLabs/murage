// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: process.env.MURAGE_QUAL_BASELINE === '1' ? ['scripts/qualify-search/baseline.qual.test.ts'] : ['scripts/qualify-search/review.qual.test.ts', 'scripts/qualify-search/search-index.qual.test.ts', 'scripts/qualify-search/search-index-copy.qual.test.ts', 'scripts/qualify-search/rig.qual.test.ts'],
  setupFiles: ['scripts/qualify-search/setup.ts'],
  sequence: { setupFiles: 'list' }, fileParallelism: false, maxWorkers: 1,
  testTimeout: 8_100_000, hookTimeout: 30_000,
  tags: [{ name: 'qual', description: 'Explicit search release qualification; never selected by the default config.' }],
} });
