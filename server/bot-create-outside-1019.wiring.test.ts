import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
it('opens the settle ledger on both capability admissions and observes every mark source', () => {
  expect(index.match(/botOutsideWrites\.ledger\.open\(/g)).toHaveLength(2);
  expect(index).toContain('observeOutsideMarks(');
});
it('settles using the provider-to-generation binding before releasing the turn', () => {
  expect(index).toContain('botOutsideWrites.settle(');
  expect(index).toContain('botOutsideWrites.ledger.bind(');
});
it('commits engine creates through the authority decision and staged birth', () => {
  const create = index.slice(index.indexOf('const createdBody = (finalBot'), index.indexOf('path === "/api/internal/request-browser-connection"'));
  expect(create).toContain("kind: 'bot'"); expect(create).toContain('staged:'); expect(create).toContain('botOutsideWrites.record(');
});
it('serves owner review through the digest-bound service', () => {
  expect(index).toContain('botOutsideWrites.review('); expect(index).toContain('botOutsideWrites.apply(');
});
it('D4 files a card suggestion and cannot grant directly from the internal route', () => {
  const route = index.slice(index.indexOf('if (path === "/api/internal/stop-line-allowance"'), index.indexOf('if (path === "/api/internal/image-models"'));
  expect(route).not.toContain('taskAllowances.grant('); expect(route).toContain('taskAllowanceSuggestions');
});
