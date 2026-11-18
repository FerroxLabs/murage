import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as old102 from '../../testing/frozen/inventory-102.ts';
import * as old117 from '../../testing/frozen/inventory-117.ts';
for (const [name, digest] of [
  ['inventory-102.ts', '2c821fdb2ee612aea84ebaa8a056e2a36d32b26a1c149b968ba4f64819c8b056'],
  ['inventory-117.ts', '8149d77e24b2684bbcf1bfd1da94356c1c788e29961f9a573513ed6a587a5f4a'],
]) test(`RED27 frozen bytes ${name}`, () => expect(createHash('sha256').update(readFileSync(new URL(`../../testing/frozen/${name}`, import.meta.url))).digest('hex')).toBe(digest));
test('RUN frozen classifiers witness the physical need to park both components', () => {
  expect(old102.classifyDataDirEntry('signal')).toBeUndefined();
  // Frozen classifier returns undefined; the frozen snapshot caller excludes it.
  expect(old117.classifyDataDirEntry('signal')).toBeUndefined();
  for (const inventory of [old102, old117]) {
    expect(inventory.classifyDataDirEntry('channels')).toMatchObject({ backup: 'retained' });
    expect(inventory.classifyDataDirEntry('recovery-quarantine')).toMatchObject({ backup: 'excluded' });
  }
});
