// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { d, fixture } from './decision/fixture.ts';
import { source, wiring } from './decision-wiring/fixture.ts';
import { isWorkspaceOwner, threadHumanPrincipal } from './human-principals.ts';
import { noLimitsAppliesTo } from './no-limits-origin.ts';
import { applyRoutinePermissionMode } from './routine-permissions.ts';
import { serviceNoLimits, serviceThreadNoLimits, serviceThreadNoLimitsPolicy } from './service-no-limits.ts';

const settings = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };

it('ownPermissionFacts refuses a requested generation with no policy before consulting saved levels', () => {
  const f = fixture();
  const savedLevel = vi.fn(() => 'unlimited');
  const { ownPermissionFacts } = wiring(['ownPermissionFacts'], {
    peerContactSettings: () => settings,
    decisionProvenance: new Map([['old', {}], ['g', {}]]),
    readTurnPolicy: d.readTurnPolicy, decisionNoLimitsOrigin: () => 'owner',
    decisionLiveLevel: savedLevel, applyRoutinePermissionMode,
  });
  try {
    expect(d.readTurnPolicy({ threadId: 't', generation: 'old' })).toBeUndefined();
    expect.soft(noLimitsAppliesTo('owner', ownPermissionFacts('b', 't', 'old').bot)).toBe(false);
    expect.soft(savedLevel).not.toHaveBeenCalled();
    expect(noLimitsAppliesTo('owner', ownPermissionFacts('b', 't', 'g').bot)).toBe(true);
    f.setOwner(false);
    expect(noLimitsAppliesTo('owner', ownPermissionFacts('b', 't', 'g').bot)).toBe(false);
  } finally { f.dispose(); }
});

function appChildPolicy() {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const statement = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'wireAppChildGuard');
  if (!statement) throw new Error('Missing production app child guard');
  let guard!: { noLimits: (run: { threadId: string; botId: string; generation?: string }) => boolean };
  const js = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  runInNewContext(js, {
    wireAppChildGuard: (value: typeof guard) => { guard = value; },
    isWorkspaceOwner, threadHumanPrincipal, serviceNoLimits, serviceThreadNoLimits, serviceThreadNoLimitsPolicy,
    readTurnPolicy: d.readTurnPolicy, peerContactSettings: () => settings, noLimitsAppliesTo,
  });
  return guard.noLimits;
}

it('app child policy refuses a requested generation with no policy and retains owner controls', () => {
  const f = fixture();
  try {
    const noLimits = appChildPolicy();
    expect(d.readTurnPolicy({ threadId: 't', generation: 'old' })).toBeUndefined();
    expect.soft(noLimits({ threadId: 't', botId: 'b', generation: 'old' })).toBe(false);
    expect(noLimits({ threadId: 't', botId: 'b', generation: 'g' })).toBe(true);
    f.setOwner(false);
    expect(noLimits({ threadId: 't', botId: 'b', generation: 'g' })).toBe(false);
    expect.soft(noLimits({ threadId: 't', botId: 'b' })).toBe(false);
    // Durable scheduling may read saved settings only when the turn is absent.
    d.installProvenanceReader({ turnGenerationFor: () => undefined, provenance: () => undefined, live: () => undefined });
    expect(noLimits({ threadId: 't', botId: 'b' })).toBe(true);
  } finally { f.dispose(); }
});
