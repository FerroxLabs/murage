// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP completion owner: basefix-ci; consuming fence owner: response boundary.
// Mutation record (committed suite = this test + http-request-completion.test.ts, 3 tests; every result below was run over
// both files together, per-test verbose logs kept with the lane evidence; patches and the child fatal stack are
// double-mutant.patch, mutant-l1-only.patch, mutant-l2-only.patch, mutant-l1-module.patch, double-mutant-child-fatal-stack.txt):
//   both layers reverted (completeHttpRequest wrap from 6e71d56b45 + the handleRequest final-reply catch): this test RED
//     (child dies on unhandledRejection MEMORY_CONTEXT_REVOKED at localJson/handleRequest, fence checking/not-built); 1 of 3 RED
//     [double-mutant-suite-red.log]
//   handleRequest final-reply catch removed alone: this test RED via the handler-settled witness ('rejected'); 1 of 3 RED
//     [mutant-l2-only-suite.log]
//   completeHttpRequest body reverted to return work: http-request-completion.test.ts RED; 1 of 3 RED
//     [mutant-l1-module-suite.log]
//   completeHttpRequest wrap removed from the server callback alone: survives by design (the inner catch contains it); 0 of 3 RED
//     [mutant-l1-only-suite.log]
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import { LEDGER_REFUSAL_LINE } from './ledger-refusal.ts';

it('the process survives a checking/not-built refusal from the final error reply', async () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      const { registerHooks } = await import('node:module');
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { WritetimeFixture, MEMBER } = await import(${moduleUrl('./memory/testing/writetime-fixture.ts')});
      const { openTurnLineage } = await import(${moduleUrl('./memory/lineage-write.ts')});
      const { prepareRetainedFence } = await import(${moduleUrl('./memory/send-fence.ts')});
      const { bindConsumingTurn } = await import(${moduleUrl('./consuming-turn-response.ts')});
      const f = new WritetimeFixture();
      const turn = openTurnLineage(f.db, { threadId: 'fixture-thread', turnId: 'fixture-turn' });
      prepareRetainedFence(turn, MEMBER, () => {}, f.db);
      let current = true;
      const binding = bindConsumingTurn({
        identity: { botId: 'fixture-bot', threadId: turn.threadId, dispatchGeneration: turn.turnId,
          lineageTurnIds: [turn.turnId], adapterLeaseId: turn.turnId },
        turn, db: f.db, isCurrent: () => current,
        onLedgerRefused: verdict => {
          writeFileSync(join(process.env.MURAGE_DATA_DIR, 'final-refusal.json'), JSON.stringify({ verdict, stack: new Error().stack }));
          // Child-side acknowledgement: setImmediate runs only after this turn's microtasks and rejection reports have drained.
          setImmediate(() => writeFileSync(join(process.env.MURAGE_DATA_DIR, 'loop-turned.json'), '{}'));
        },
      });
      current = false;
      globalThis[Symbol.for('fixture.final-refusal')] = binding;
      // Witness for the inner layer: record how the handleRequest promise settles before completeHttpRequest sees it.
      // The returned promise still rejects with the same error, so no outer containment is hidden from the child.
      globalThis[Symbol.for('fixture.observe')] = (url, work) => work.then(
        value => { if (url === '/api/internal/fixture-final-refusal') writeFileSync(join(process.env.MURAGE_DATA_DIR, 'handler-settled.txt'), 'fulfilled'); return value; },
        error => { if (url === '/api/internal/fixture-final-refusal') writeFileSync(join(process.env.MURAGE_DATA_DIR, 'handler-settled.txt'), 'rejected'); throw error; });
      // Inject only the stale admission and route failure; execute the production catch and HTTP callback unchanged.
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (url !== ${moduleUrl('./index.ts')}) return result;
        let source = String(result.source);
        const admission = 'const requestBinding = requestClaim ?';
        const route = 'await gateWriteRequest(method);';
        const handler = 'withClientCapabilities(req.headers, () => ioBudget.withSource(source, () => heldStep(source, () => handleRequest(req, res))))';
        if (!source.includes(admission) || !source.includes(route) || !source.includes(handler)) throw new Error('final refusal seam missing');
        source = source.replace(admission, "const requestBinding = path === '/api/internal/fixture-final-refusal' ? globalThis[Symbol.for('fixture.final-refusal')] : requestClaim ?");
        source = source.replace(route, route + " if (path === '/api/internal/fixture-final-refusal') throw new Error('fixture route failure');");
        source = source.replace(handler, "globalThis[Symbol.for('fixture.observe')](req.url, " + handler + ")");
        return { ...result, source };
      }});
    `,
  });
  try {
    const response = await fetch(fixture.info.url + '/api/internal/fixture-final-refusal');
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(LEDGER_REFUSAL_LINE);
    const refusal = JSON.parse(readFileSync(new URL('final-refusal.json', 'file://' + fixture.info.dataDir + '/'), 'utf8'));
    expect(refusal.verdict).toEqual({ state: 'checking', reason: 'not-built' });
    expect(refusal.stack).toContain('localJson');
    expect(refusal.stack).toContain('handleRequest');
    // The single-threaded child serves this request only after its loop turned past the refusal, so no timing is involved.
    expect((await fetch(fixture.info.url + '/api/health')).status).toBe(200);
    // handleRequest's own final-reply catch consumes the refusal, so its promise fulfils (the outer layer is not what saved it).
    expect(readFileSync(fixture.info.dataDir + '/handler-settled.txt', 'utf8')).toBe('fulfilled');
    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    expect(existsSync(fixture.info.dataDir + '/loop-turned.json')).toBe(true);
  } finally {
    await fixture.close();
  }
});
