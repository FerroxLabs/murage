// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { highLevelHarness, scriptCrm } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { noLimitsAppliesTo, permissionsForNoLimitsOrigin } from '../no-limits-origin.ts';
import { permissionsForOrigin, installPermissionInheritance } from '../permission-inheritance.ts';
import { applyRoutinePermissionMode, applyResolvedRoutineCeilings, botPermissionMode } from '../routine-permissions.ts';
import { accessRoleBinding } from '../bot-access-role.ts';
import { defaultHighLevelFamilies } from '../../shared/highlevel.ts';
import { createHighLevelRuntime } from './runtime.ts';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
// Exercise the production turn resolver, including its real origin and inheritance guards.
// Routine dependencies are absent for these direct task turns.
const resolverBody = source.match(/function decisionLiveLevel\([^\n]+\{([\s\S]*?)\n\}/)?.[1];
if (!resolverBody) throw new Error('Production decisionLiveLevel moved');
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['malformed-deny', 'empty-operations'] as const)('H1 %s mounting uses the resolved task/turn level, never stored profile flags', async restriction => {
  const h = highLevelHarness(); cleanups.push(h.stop); scriptCrm(h.api);
  h.bot.highlevelAccess = {
    revision: 1, roleBinding: accessRoleBinding(h.bot), grantsVersion: 2,
    denyRules: restriction === 'malformed-deny' ? ['not-a-rule'] : [],
    grants: [{ ...h.grant(), families: Object.fromEntries(Object.keys(defaultHighLevelFamilies()).map(family => [family, family === 'contacts' ? 'change' : 'off'])),
      ...(restriction === 'empty-operations' ? { operations: { contacts: [] } } : {}) }],
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'gnl-turn-mount-')); cleanups.push(() => removeTempDir(dataDir));
  const rt = createHighLevelRuntime({ dataDir, capabilities: h.capabilities, signals: h.signals,
    bot: () => h.bot, leases: h.leases, fetch: h.api.fetch, threadMarkState: () => 'marked' });
  cleanups.push(rt.close);
  cleanups.push(installPermissionInheritance(() => false));
  const resolve = new Function('store', 'decisionNoLimitsOrigin', 'permissionsForNoLimitsOrigin', 'hasNoLimits',
    'noLimitsAppliesTo', 'permissionsForOrigin', 'botPermissionMode', 'routineRunLevel',
    'routineConversationMode', 'admittedRoutineCeilings', 'applyResolvedRoutineCeilings',
    'return function(provenance, settings) {' + resolverBody + '}')(
      { bot: () => h.bot }, (p: { origin: string }) => p.origin, permissionsForNoLimitsOrigin,
      (bot: any) => bot?.autoApprove === true && bot.fullAccess === true && bot.noLimits === true,
      noLimitsAppliesTo, permissionsForOrigin, botPermissionMode, () => null,
      () => null, new Map(), applyResolvedRoutineCeilings);
  const cases = [
    { stored: 'ask', task: 'unlimited', origin: 'owner', expected: 'unlimited', mounts: true },
    { stored: 'unlimited', task: 'ask', origin: 'owner', expected: 'ask', mounts: false },
    { stored: 'unlimited', task: 'unlimited', origin: 'guest', expected: 'ask', mounts: false },
    { stored: 'unlimited', task: 'unlimited', origin: 'other-human', expected: 'ask', mounts: false },
    { stored: 'unlimited', task: 'unlimited', origin: 'other-human', recoveredLevel: 'unlimited', expected: 'ask', mounts: false },
  ] as const;
  for (const row of cases) {
    Object.assign(h.bot, applyRoutinePermissionMode(h.bot, row.stored));
    const task = applyRoutinePermissionMode(h.bot, row.task);
    const effectiveLevel = resolve({ origin: row.origin, initiator: {}, ...('recoveredLevel' in row ? {recoveredLevel: row.recoveredLevel} : {}) }, task);
    expect(effectiveLevel, JSON.stringify(row)).toBe(row.expected);
    expect(await rt.mountsFor(h.bot.id, effectiveLevel), JSON.stringify(row)).toBe(row.mounts);
  }
  expect(h.api.requests).toHaveLength(0);
});
