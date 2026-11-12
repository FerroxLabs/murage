import { writerSites, type WriterSite } from './testing/botcreate-writers.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const path = new URL('./testing/botcreate-spec/sites.sh', import.meta.url);
it('T17s pins every grant sink, its enclosing route/function and one-level callers; new hits require classification', () => {
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe('513f6bcc6cd69a1cc437b87ac776172e5e0d2c27c2f5a547a61f17adcee138bb');
  const actual = writerSites();
  const classified = JSON.parse(readFileSync(new URL('./testing/botcreate-spec/writers.json', import.meta.url), 'utf8')) as Array<{ site: WriterSite; classification: string; reason: string }>;
  expect(actual, 'classify this writer').toEqual(classified.map(row => row.site));
  for (const row of classified) { expect(row.classification).toMatch(/^(owner-answer|owner-settings|boot|narrowing|read|staged-bot|settle-only|disabled-proposal|runtime-bookkeeping|definition)$/); expect(row.reason.length).toBeGreaterThan(15); }
});
