// Producer: fuigo-trust-reply.ts. Consumer: the ACP driver's withheld-configuration activity row.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { recordActivity } from '../../folder-trust-activity.ts';
import { automaticFolderChoice, automaticRejectReason } from './fuigo-trust-reply.ts';

const key = '/fixture/workspace';
const authority = { generation: 'g1', owner: true, level: 'unlimited' as const, revision: 'r1' };
const gate = (over: Record<string, unknown> = {}) => ({ key, noCardPickKeys: [key], upstreamReadable: true, upstreamDeclined: false, seedComplete: true, rejects: [], ...over });
const input = (over: { gate?: Record<string, unknown>; turn?: Record<string, unknown>; key?: unknown; scope?: unknown; processReply?: boolean; live?: boolean; launchAuthority?: typeof authority | null } = {}) => ({
  turn: { noLimits: true, folderTrustAuthorityNow: () => authority, ...over.turn } as never, gate: gate(over.gate) as never,
  key: over.key ?? key, scope: over.scope ?? 'configAndCommands', realCwd: key, processReply: over.processReply ?? true, live: over.live ?? true,
  launchAuthority: over.launchAuthority === undefined ? authority : over.launchAuthority,
});

describe('automaticRejectReason (K15 §6, M-T30)', () => {
  it('control: a fully eligible launch trusts and has no reject reason', () => {
    expect(automaticFolderChoice(input()).outcome).toBe('trust');
    expect(automaticRejectReason(input())).toBe('none');
  });
  const cases: Array<[string, ReturnType<typeof input>, string]> = [
    ['authority lookup fails', input({ turn: { folderTrustAuthorityNow: () => { throw new Error('gone'); } } }), 'authority-unavailable'],
    ['authority revision moved', input({ launchAuthority: { ...authority, revision: 'r0' } }), 'authority-unavailable'],
    ['engine too old for a process reply', input({ processReply: false }), 'version-unsupported'],
    ['unsupported scope', input({ scope: 'config' }), 'unsupported-scope'],
    ['unsafe key', input({ key: 'relative/key' }), 'unsafe-key'],
    ['upstream store unreadable', input({ gate: { upstreamReadable: false } }), 'store-unreadable'],
    ['not picked', input({ gate: { noCardPickKeys: [] } }), 'not-picked'],
    ['upstream declined', input({ gate: { upstreamDeclined: true } }), 'saved-decline'],
    ['saved decision rejects', input({ gate: { decision: 'reject' } }), 'saved-decline'],
    ['stored no pick', input({ gate: { storedNoPick: true } }), 'saved-decline'],
    ['declined child', input({ gate: { rejects: [{ key: key + '/child', folder: key + '/child' }] } }), 'saved-decline'],
    ['exact saved decline', input({ gate: { rejects: [{ key, folder: key }] } }), 'saved-decline'],
    ['seed not durable', input({ gate: { seedComplete: false } }), 'seed-not-durable'],
    ['inactive turn', input({ live: false }), 'inactive-turn'],
  ];
  for (const [name, value, reason] of cases) {
    it(`${name} is withheld with reason ${reason}`, () => {
      expect(automaticFolderChoice(value).outcome).toBe('reject');
      expect(automaticRejectReason(value)).toBe(reason);
    });
    // the driver records this reason on the thread's activity row; an unknown reason throws there and loses the row
    it(`${name}: the activity row records reason ${reason}`, () => {
      const db = new DatabaseSync(':memory:');
      expect(recordActivity('fixture-thread', 'configuration-withheld', 'r1', 'a'.repeat(64), 'configuration-withheld', automaticRejectReason(value), db)).toBe(true);
      expect(db.prepare('SELECT reason FROM thread_folder_trust_activity').all()).toEqual([{ reason }]);
      db.close();
    });
  }
});
