import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('T-NO-AUTOMATIC-PUBLISH: runtime publication is an explicit external operator step', () => {
  expect(existsSync(new URL('./publish-signal-runtime-inputs.mjs', import.meta.url))).toBe(false);
  expect(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).not.toContain('publish-signal-runtime-inputs');
});
