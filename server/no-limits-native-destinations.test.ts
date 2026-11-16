// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { finalizeNoLimits, noLimitsFacts, type AutoContext } from './auto-approve.ts';
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { fullAccessOrigin: 'owner', ownerStarted: true, commandCwd: '/w', outsideRead: null };

describe('BLOCK 2: complete native edit destination evidence', () => {
  for (const destination of ['/etc/murage-review-file', '/w/.claude/settings.json']) {
    it.each([64, 65, 128, 129])('keeps array destination %i: ' + destination, count => {
      const paths = [...Array.from({ length: count - 1 }, (_, i) => `/w/file-${i}`), destination];
      const context: AutoContext = { ...owner, call: { engine: 'claude', toolKind: 'edit', toolCall: { name: 'Edit', input: { paths } } } };
      const verdict = finalizeNoLimits(bot, 'Edit', 'incomplete edit', context, { approve: null, source: 'unread-call' });
      expect(verdict).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
      expect(noLimitsFacts(verdict)).toEqual({ initiator: 'owner', n2: false });
    });
    it.each([128, 129])('keeps accumulated destination %i: ' + destination, count => {
      const realPaths = Array.from({ length: count - 1 }, (_, i) => `/w/file-${i}`);
      const context: AutoContext = { ...owner, realPaths, call: { engine: 'claude', toolKind: 'edit', toolCall: { name: 'Edit', input: { path: destination } } } };
      const verdict = finalizeNoLimits(bot, 'Edit', 'incomplete edit', context, { approve: null, source: 'unread-call' });
      expect(verdict).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
      expect(noLimitsFacts(verdict)).toEqual({ initiator: 'owner', n2: false });
    });
  }
  it('still releases a large ordinary edit', () => {
    const paths = Array.from({ length: 256 }, (_, i) => `/w/file-${i}`);
    const context: AutoContext = { ...owner, call: { engine: 'claude', toolKind: 'edit', toolCall: { name: 'Edit', input: { paths } } } };
    expect(finalizeNoLimits(bot, 'Edit', 'incomplete edit', context, { approve: null, source: 'unread-call' })).toMatchObject({ source: 'no-limits', approve: expect.any(String) });
  });
});
