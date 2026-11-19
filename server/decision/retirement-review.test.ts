import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { IndependentThreadRuns } from '../independent-thread-runs.ts';
import { turnSucceeded } from '../turn-outcome.ts';
import { completeDecisionGeneration } from './generation-retirement.ts';
import { fixture, d, card, baseCard } from './fixture.ts';

// Execute the server's lifecycle wiring against the real isolated decision host.
// No native request is opened: ingress cannot hide a bad host release here.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
function select(predicate: (node: ts.Node) => boolean, root: ts.Node = ast): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(root); if (!found) throw new Error('missing lifecycle wiring'); return found;
}
function evaluate(code: string, ports: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(ports), js)(...Object.values(ports));
}
const named = (name: string) => select(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const calls = (name: string, root: ts.Node) => select(n => ts.isCallExpression(n) && n.expression.getText(ast) === name, root);
const noop = () => {};
function lifecyclePorts() {
  const pending: Promise<void>[] = [];
  const release = evaluate(named('releaseDecisionProvenance').getText(ast) + '; return releaseDecisionProvenance;', {
    completeDecisionGeneration, cancelRequests: d.cancelRequests, decisionSharedSaves: new Map(),
    decisionAuthorities: new Map(), decisionRequestTargets: new Map(), decisionQueuePorts: new Map(),
    decisionProvenance: new Map(), deleteContinuation: d.deleteContinuation,
  });
  return { pending, releaseDecisionProvenance: (...args: unknown[]) => { const work = release(...args); pending.push(work); return work; } };
}
function queued(f: ReturnType<typeof fixture>) {
  const epoch = 'e', call = f.serviceCall();
  const ref = card(d.decide(d.openRequest({ kind: 'service', service: 'email', claim: f.claim, call }), baseCard));
  return { call, ref, item: { kind: 'email' as const, ref: 'q', approvalId: ref.approvalId, epoch, proof: 'trusted', call: call as d.PendingQueueApproval['call'], view: { title: 'Queued', subtitle: 'Fixture' } } };
}

for (const path of ['direct', 'room'] as const) for (const end of ['success', 'failure', 'stop', 'setup'] as const) {
  it(`H1 service-only ${path} ${end} retires with the actual result`, async () => {
    const f = fixture(), q = queued(f), ports = lifecyclePorts();
    let pending = [q.item];
    const cancel = vi.fn(async () => { pending = []; }), respond = vi.fn(async () => ({ state: 'accepted' as const }));
    const dispose = d.installQueueSources([{ kind: 'email', pendingApprovals: () => pending, reopen: () => ({ kind: 'service', service: 'email', claim: f.claim, call: q.call }), base: baseCard, respond, cancel, renew: async () => pending[0]! }]);
    try {
      d.attachQueue(q.ref, { kind: 'email', ref: 'q', call: q.call }); await d.presentApproval(q.ref, q.item.view);
      const event = { ok: end !== 'failure', ...(end === 'stop' ? { stopReason: 'cancelled' } : {}) };
      if (path === 'direct') {
        const runs = new IndependentThreadRuns<object>(), run = runs.admit('b', 't', {});
        // The callback is the production callback; the run's random id is mapped
        // to this fixture's authenticated generation at its decision boundary.
        const successfulDecisionGenerations = new Set<string>();
        const callback = select(n => ts.isBinaryExpression(n) && n.left.getText(ast) === 'directRuns.onReleased');
        evaluate(callback.getText(ast) + ';', {
          directRuns: runs, successfulDecisionGenerations, retireInternalTurn: noop, discardDirectTurnCancellationProofsForGeneration: noop, releaseDecisionProvenance: (t: string, _g: string, ok: boolean) => ports.releaseDecisionProvenance(t, 'g', ok),
          browserExecutions: { forget: noop }, botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(),
          ownerStartedRuns: new Map(), highlevelProvenRuns: new Set(), highlevelDesktopRuns: new Set(), highlevelOwnerStartedAt: new Map(), sharedThreadFreed: noop, sharedBotFreed: noop,
        });
        if (end === 'setup') runs.release(run);
        else {
          if (end === 'stop') runs.cancel(run);
          const releaseDirect = select(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'releaseDirect');
          const release = calls('directRuns.release', releaseDirect);
          const releaseBlock = select(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'directRun', releaseDirect);
          expect(releaseBlock.getText(ast)).toContain(release.getText(ast));
          evaluate(releaseBlock.getText(ast), { directRuns: runs, directRun: run, event, turnSucceeded, stoppedTurn: end === 'stop', successfulDecisionGenerations, replySpeakerTurns: { ended: noop }, finishDirectAttemptEffects: noop });
        }
      } else {
        const revoke = evaluate(named('revokeInternalGeneration').getText(ast) + '; return revokeInternalGeneration;', {
          ...ports, retireAttention: noop, retireInternalTurn: noop, recallWaits: new Map(), refusedLeases: new Set(), botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(), callSpeech: { invalidate: noop },
          internalResponseBindings: new Map(), revokeGatewayTurnCredentials: noop, phoneDispatchFacts: new Map(), phoneAuthorities: { revokeGeneration: noop }, phoneJobs: { turnEnded: noop }, highlevelCalls: { turnEnded: noop },
          abandonProjectUsageTurn: noop, turnRequestByGeneration: new Map(), hostComputerThreads: new Map(), projectTurnLeases: { abandon: noop }, internalCapabilities: { revokeGeneration: noop }, internalTurnOwners: new Map(), turnOutputRoots: new Map(), replyState: { invalidateGeneration: noop },
        });
        const room = named('runGroupMemberTurnDispatch');
        const assignments: string[] = [];
        const visit = (n: ts.Node) => { if (ts.isBinaryExpression(n) && n.left.getText(ast) === 'decisionCompleted') assignments.push(n.getText(ast) + ';'); ts.forEachChild(n, visit); }; visit(room);
        // Run the terminal success assignment only when a terminal event exists;
        // setup exits must keep the default false through the unconditional finally.
        const finalCall = source.slice(source.indexOf('memoryCause = "unknown"; // terminal success')).match(/revokeInternalGeneration\([^;]+;/)![0];
        evaluate(`let decisionCompleted = false; ${end === 'setup' ? '' : assignments.join('\n')} ${finalCall}`, { threadId: 't', internalGeneration: 'g', revokeInternalGeneration: revoke, e: event, turnSucceeded, done: false, isCancelled: () => false });
      }
      await Promise.all(ports.pending);
      expect(d.readApproval(q.ref.approvalId)?.state).toBe(end === 'success' ? 'open' : 'cancelled');
      expect(pending).toHaveLength(end === 'success' ? 1 : 0);
      expect(cancel).toHaveBeenCalledTimes(end === 'success' ? 0 : 1); expect(respond).not.toHaveBeenCalled();
    } finally { dispose(); f.dispose(); }
  });
}


// The two lifecycle steps the H1 rows above bind as no-ops are pinned here on the production code itself:
// a direct release discards that generation's cancellation proofs before it releases the decision provenance,
// and revocation aborts the generation's pending recall wait with a setup cancellation.
it('H1 retirement wiring: discard before release on a direct run; revocation aborts the pending recall wait', async () => {
  const f = fixture();
  try {
    const runs = new IndependentThreadRuns<object>(), run = runs.admit('b', 't', {});
    const order: string[] = [];
    const callback = select(n => ts.isBinaryExpression(n) && n.left.getText(ast) === 'directRuns.onReleased');
    evaluate(callback.getText(ast) + ';', {
      directRuns: runs, successfulDecisionGenerations: new Set<string>(), retireInternalTurn: noop,
      discardDirectTurnCancellationProofsForGeneration: (g: string) => { order.push('discard:' + g); },
      releaseDecisionProvenance: async (_t: string, g: string) => { order.push('release:' + g); },
      browserExecutions: { forget: noop }, botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(),
      ownerStartedRuns: new Map(), highlevelProvenRuns: new Set(), highlevelDesktopRuns: new Set(), highlevelOwnerStartedAt: new Map(), sharedThreadFreed: noop, sharedBotFreed: noop,
    });
    runs.release(run);
    expect(order).toEqual(['discard:' + run.generation, 'release:' + run.generation]);
    class DirectTurnSetupCancelled extends Error {}
    const recallWait = new AbortController(), other = new AbortController(), ports = lifecyclePorts();
    const revoke = evaluate(named('revokeInternalGeneration').getText(ast) + '; return revokeInternalGeneration;', {
      ...ports, retireAttention: noop, retireInternalTurn: noop, recallWaits: new Map([['g', recallWait], ['other', other]]), DirectTurnSetupCancelled, refusedLeases: new Set(), botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(), callSpeech: { invalidate: noop },
      internalResponseBindings: new Map(), revokeGatewayTurnCredentials: noop, phoneDispatchFacts: new Map(), phoneAuthorities: { revokeGeneration: noop }, phoneJobs: { turnEnded: noop }, highlevelCalls: { turnEnded: noop },
      abandonProjectUsageTurn: noop, turnRequestByGeneration: new Map(), hostComputerThreads: new Map(), projectTurnLeases: { abandon: noop }, internalCapabilities: { revokeGeneration: noop }, internalTurnOwners: new Map(), turnOutputRoots: new Map(), replyState: { invalidateGeneration: noop },
    });
    revoke('t', 'g', true);
    await Promise.all(ports.pending);
    expect(recallWait.signal.aborted).toBe(true);
    expect(recallWait.signal.reason).toBeInstanceOf(DirectTurnSetupCancelled);
    expect(other.signal.aborted).toBe(false);
  } finally { f.dispose(); }
});
