import { threadHumanPrincipal } from "../human-principals.ts";
import { clearInternalAuthorityFixtures } from './internal-authority-fixture.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { InternalCapabilities } from '../internal-capabilities.ts';
import * as decision from '../decision/index.ts';
import { consumingFixture } from './consuming-fixture.ts';
import { internalDispatchAuthorityFixture } from './internal-dispatch-fixture.ts';

const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(async () => { await clearInternalAuthorityFixtures(); for (const f of fixtures.splice(0)) f.close(); });

it.each([false, true])('SFX-CUSTODY persists a dispatch seed in the fixture database (template=%s)', async internalSchema => {
  const f = consumingFixture(undefined, { empty: true, internalSchema }); fixtures.push(f);
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  const capabilities = new InternalCapabilities();
  capabilities.begin(botId, threadId, generation, threadHumanPrincipal(threadId, f.f.db));
  const message = { role: 'bot', kind: 'text', text: 'Fixture reply' } as const;
  const id = 'fixture-reply';
  const stored = internalDispatchAuthorityFixture(f, capabilities, { messages: [{ threadId, id, message }] }).then(() =>
    f.f.db.prepare("SELECT json_extract(json, '$.text') AS text FROM messages WHERE thread_id=? AND id=?").get(threadId, id));
  expect(await stored.catch((error: unknown) => error), `dispatch fixture template=${internalSchema}`).toEqual({ text: message.text });
});

it.each(['owner', 'unknown', 'guest', 'stale'] as const)('SFX-SETUP genuine capability with %s provenance retains its own authority', async origin => {
  const f = consumingFixture(undefined, { empty: true, botId: 'setup-bot', threadId: 'setup-thread' }); fixtures.push(f);
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  const capabilities = new InternalCapabilities(); capabilities.begin(botId, threadId, generation, threadHumanPrincipal(threadId,f.f.db));
  const token = capabilities.mint({ botId, threadId, generation, kind: 'agents', depth: 0, humanPrincipal: threadHumanPrincipal(threadId,f.f.db), skillAuthoring: false });
  const proof = capabilities.resolve(`Bearer ${token}`)!;
  const setup = await internalDispatchAuthorityFixture(f, capabilities, {
    provenance: origin !== 'unknown', initiator: { k: origin === 'guest' ? 'guest' : 'owner-typed' },
    generation: origin === 'stale' ? 'retired-generation' : generation,
  });
  await setup.dispatchAuthoritySetup.run(async () => {
    expect(capabilities.isActive(proof)).toBe(true);
    const policy = decision.readTurnPolicy({ threadId, generation });
    expect(policy).toMatchObject({ level: origin === 'owner' ? 'unlimited' : 'ask' });
    expect(setup.ownLaneTurn(botId, threadId, generation)).toBe(origin === 'owner');
    if (origin === 'unknown' || origin === 'stale') {
      await expect(setup.issueDecisionAuthority(proof)).rejects.toThrow('unproven-continuation');
    } else {
      const authority = await setup.issueDecisionAuthority(proof);
      expect(authority.identity).toEqual({ threadId, generation });
      expect(decision.readContinuation(authority.proof)).toMatchObject({
        actor: origin === 'owner' ? 'owner' : 'other', level: origin === 'owner' ? 'unlimited' : 'ask',
      });
    }
    expect(f.f.db.prepare('SELECT count(*) AS n FROM decision_continuations').get()!.n)
      .toBe(origin === 'owner' || origin === 'guest' ? 1 : 0);
    // Structural copies never pass the production claim verifier.
    await expect(setup.issueDecisionAuthority({ ...proof })).rejects.toThrow('decision-service-unverified');
  });
});

it.each([false, true])('SFX-SETUP real consuming registration retains HTTP fence; revoked=%s', async revoked => {
  const { internalDispatchFixture } = await import('./internal-dispatch-fixture.ts');
  const { consumingResponseRecorder } = await import('./consuming-fixture.ts');
  const { LEDGER_REFUSAL_LINE } = await import('../ledger-refusal.ts');
  const f = consumingFixture(); fixtures.push(f);
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  const principal = threadHumanPrincipal(threadId, f.f.db);
  const capabilities = new InternalCapabilities(); capabilities.begin(botId, threadId, generation, principal);
  const token = capabilities.mint({ botId, threadId, generation, kind: 'agents', depth: 0, humanPrincipal: principal, skillAuthoring: false });
  const setup = await internalDispatchAuthorityFixture(f, capabilities);
  if (revoked) f.flip();
  const sink = consumingResponseRecorder();
  const dispatch = await internalDispatchFixture(true);
  await dispatch({ ...setup.scope, internalCapabilities: capabilities, method: 'GET', path: '/api/internal/agents',
    req: { headers: { authorization: `Bearer ${token}` } }, res: sink.raw });
  if (revoked) {
    expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    expect(f.refusals).toBeGreaterThan(0);
  } else {
    expect(sink.output.at(-1)?.status).toBe(200);
    expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ bots: [], organizationRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }
});

it('SFX-SETUP response registration rejects a different dispatch generation', async () => {
  const { indexCallbackFixture } = await import('./internal-dispatch-fixture.ts');
  const f = consumingFixture(); fixtures.push(f);
  const retain = await indexCallbackFixture('retainInternalResponseBinding', {});
  expect(() => retain('another-generation', f.binding)).toThrow('MEMORY_CONTEXT_REVOKED');
  expect(f.refusals).toBeGreaterThan(0);
});

// Producer owner: sc-safety fixture I/O; human-principals owns registration and validation.
// Consumer owner: sc-safety genuine-person dispatch and nested fixture callers.
it('SFX-SETUP a registered channel person survives assembly and nested request I/O scopes', async () => {
  const f = consumingFixture(undefined, { empty: true, internalSchema: true, botId: 'person-bot', threadId: 'person-thread' }); fixtures.push(f);
  const databaseApi = await import('../database.ts');
  const humans = await import('../human-principals.ts');
  const { ownerMemoryTicket } = await import('../memory/authority.ts');
  const db = vi.spyOn(databaseApi, 'database').mockReturnValue(f.f.db);
  const tx = vi.spyOn(databaseApi, 'transaction').mockImplementation(work => work(f.f.db));
  try {
    const bindingId = humans.observeVerifiedHuman({ platform: 'slack', connectionId: 'fixture-connection', authorityId: 'fixture-team', userId: 'fixture-person' });
    humans.linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: 'person' });
    humans.bindHumanThread(f.turn.threadId, humans.resolveHumanBinding(bindingId));
    const principal = humans.threadHumanPrincipal(f.turn.threadId);
    expect(humans.isWorkspaceOwner(principal)).toBe(false);
    const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, generation, principal);
    const token = caps.mint({ botId, threadId, generation, kind: 'connectors', depth: 0, humanPrincipal: principal, skillAuthoring: false });
    const proof = caps.resolve(`Bearer ${token}`)!;
    const setup = await internalDispatchAuthorityFixture(f, caps, { roomOwnerOnly: false, initiator: { k: 'other-human' } });
    expect(databaseApi.database()).toBe(f.f.db);
    await setup.dispatchAuthoritySetup.run(async () => {
      expect(humans.threadHumanPrincipal(threadId)).toEqual(principal);
      expect(caps.resolve(`Bearer ${token}`)).toBe(proof);
      const authority = await setup.issueDecisionAuthority(proof);
      expect(decision.readContinuation(authority.proof)).toMatchObject({ actor: 'other', level: 'ask' });
    });
    expect(databaseApi.database()).toBe(f.f.db);
    expect(humans.threadHumanPrincipal(threadId)).toEqual(principal);
  } finally { tx.mockRestore(); db.mockRestore(); }
});
