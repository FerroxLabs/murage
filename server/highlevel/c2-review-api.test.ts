// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';

// Real route/answer wiring on an isolated fixture. Instrument only the action source: no token, provider or live data.
const suite = describe.skipIf(process.platform === 'win32');
const evidenceDir = process.env.MURAGE_HIGHLEVEL_TEST_EVIDENCE_DIR;
function evidence(kind: string, value: unknown) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, 'requests.jsonl'), JSON.stringify({ kind, value }) + '\n');
}
const sentinel = 'C2 exact body sentinel \nsecond line ' + 'x'.repeat(4000);
let fixture: VerificationServer;
let desktop: Record<string, string>;
const doorToken = 'cd'.repeat(32);
const phone = { 'x-murage-companion': '1', 'x-murage-door-token': doorToken, 'x-murage-companion-token': doorToken,
  'x-murage-approval-device': '4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3', 'x-murage-approval-class': 'app', 'x-murage-approval-key': 'B'.repeat(87) };
async function request(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: response.status, headers: response.headers, body: await response.json() as any };
  evidence('http', { method, path, request: body, status: result.status, body: result.body });
  return result;
}
async function seed(rpc = false) {
  const created = await request('POST', '/api/bots', { name: 'HighLevel C2 fixture' });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const nonce = crypto.randomUUID();
  writeFileSync(join(fixture.info.dataDir, 'c2-seed.json'), JSON.stringify({ botId: bot.id, threadId: bot.threadId, body: sentinel, nonce, rpc }));
  let result: any;
  await expect.poll(() => { try { result = JSON.parse(readFileSync(join(fixture.info.dataDir, 'c2-review.json'), 'utf8')); return result.nonce; } catch { return ''; } }, { timeout: 10000 }).toBe(nonce);
  return { ...result, threadId: bot.threadId, requestId: `highlevel-${result.actionId}` };
}
suite('C2 real desktop review routes', () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: doorToken }, instrumentationSource: `
      const fs = await import('node:fs'); const path = await import('node:path');
      const { registerHooks } = await import('node:module');
      registerHooks({load(url, context, next) {
        if (!url.endsWith('/server/index.ts')) return next(url, context);
        let source = fs.readFileSync(new URL(url), 'utf8');
        const anchor = 'const highlevel = createHighLevelRuntime({';
        if (!source.includes(anchor)) throw Error('C2 authority fixture anchor moved');
        source = source.replace(anchor, \`globalThis.__highlevelC2Authority = async seed => {
          const provenance = makeDecisionProvenance(seed.botId, seed.threadId, seed.nonce, {k:'owner-typed'}, true);
          beginInternalTurn(provenance, seed.botId, seed.threadId, seed.nonce, 0, false, undefined, undefined, false, true, true);
          const token = internalToken(seed.botId, seed.threadId, seed.nonce, 'highlevel');
          const claim = internalCapabilities.resolve('Bearer '+token);
          await issueDecisionAuthority(claim);
          return claim;
        };\\n\` + anchor);
        return {format:'module-typescript', shortCircuit:true, source};
      }});

      const { HighLevelActions } = await import(${JSON.stringify(new URL('./actions.ts', import.meta.url).href)});
      const { HighLevelHost } = await import(${JSON.stringify(new URL('./host.ts', import.meta.url).href)});
      const { recoveryFixture } = await import(${JSON.stringify(new URL('./testing/c2-recovery-fixture.ts', import.meta.url).href)});
      const { accessRoleBinding } = await import(${JSON.stringify(new URL('../bot-access-role.ts', import.meta.url).href)});
      const { heldNoteDetail } = await import(${JSON.stringify(new URL('./testing/contract-fixture.ts', import.meta.url).href)});
      let actions;
      const recover = HighLevelActions.prototype.recover;
      HighLevelActions.prototype.recover = function(...args) { actions = this; return recover.apply(this, args); };
      const configure = HighLevelHost.prototype.configureReview;
      HighLevelHost.prototype.configureReview = function(hooks) {
        configure.call(this, hooks); let seen;
        setInterval(async () => {
          let seed; try { seed = JSON.parse(fs.readFileSync(path.join(process.env.MURAGE_DATA_DIR, 'c2-seed.json'), 'utf8')); } catch { return; }
          if (seed.nonce === seen) return; seen = seed.nonce;
          if (seed.rpc) {
            const dir = path.join(process.env.MURAGE_DATA_DIR, seed.nonce); fs.mkdirSync(dir);
            const f = recoveryFixture(dir, 'contacts.notes.update');
            f.bot.id = seed.botId;
            f.bot.highlevelAccess.roleBinding = accessRoleBinding(f.bot);
            f.bot.highlevelAccess.grants[0].botId = seed.botId;
            const claim = await globalThis.__highlevelC2Authority(seed);
            f.message.params.arguments.args.body = seed.body;
            f.api.always('PUT', /^\\/contacts\\/contact_1\\/notes\\/note_1$/, { status: 200, body: { note: { id: 'note_1', body: seed.body } } });
            const host = new HighLevelHost({ ...f.deps, actions, capabilities: { isActive: () => true },
              onReview: (claim, review) => {
                hooks.onReview(claim, review);
                fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'c2-review.json'), JSON.stringify({ nonce: seed.nonce, actionId: review.actionId }));
              }, onReviewClosed: hooks.onReviewClosed });
            void host.handle(claim, f.message).then(result => {
              fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'c2-rpc-result.json'), JSON.stringify({ nonce: seed.nonce, result, writes: f.api.calls('PUT').length }));
              f.stop();
            });
            return;
          }
          const context = { botId: seed.botId, threadId: seed.threadId, turnGeneration: seed.nonce, connectionId: 'hl_fixture1', connectionEpoch: 1,
            locationId: 'loc_fixture', companyId: 'co_fixture', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'fixture', basis: 'owner_exact_review' };
          const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', { contactId: 'contact_1', body: seed.body }, heldNoteDetail('loc_fixture', seed.body));
          hooks.onReview(await globalThis.__highlevelC2Authority(seed), review);
          fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'c2-review.json'), JSON.stringify({ nonce: seed.nonce, actionId: review.actionId }));
        }, 30).unref();
      };
    ` });
    evidence('fixture', fixture.info);
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  }, 90000);
  afterAll(async () => {
    await fixture?.close();
    if (fixture && evidenceDir) writeFileSync(join(evidenceDir, 'server.log'), readFileSync(fixture.info.logPath));
  });

  it('T2/T6 real GET is no-store, wrong digest sends nothing, exact desktop Allow settles without values in history', async () => {
    const review = await seed();
    const values = await request('GET', `/api/highlevel/reviews/${review.actionId}`);
    expect(values.status).toBe(200); expect(values.headers.get('cache-control')).toBe('no-store');
    expect(values.body.values.body).toBe(sentinel);
    for (const reviewDigest of [undefined, 'wrong']) {
      const answer = await request('POST', `/api/threads/${review.threadId}/respond`, { requestId: review.requestId, behavior: 'allow', reviewDigest });
      expect(answer.status).toBe(200); expect(answer.body.outcome).toBe('unavailable');
      expect((await request('GET', `/api/highlevel/reviews/${review.actionId}`)).status).toBe(200);
    }
    const answer = await request('POST', `/api/threads/${review.threadId}/respond`, { requestId: review.requestId, behavior: 'allow', reviewDigest: values.body.reviewDigest });
    expect(answer.status).toBe(200); expect(answer.body.outcome).toBe('allowed-once');
    expect((await request('GET', `/api/highlevel/reviews/${review.actionId}`)).status).toBe(404);
    const history = JSON.stringify((await request('GET', `/api/threads/${review.threadId}/messages?limit=200`)).body);
    expect(history).not.toContain(sentinel); expect(history).not.toContain(values.body.reviewDigest);
    expect(history).toContain('highlevel-');
  }, 30000);
  it('RPC write loads exact desktop values and Allow dispatches once', async () => {
    const review = await seed(true);
    expect(review.actionId).toMatch(/^hla_[0-9a-f]{64}$/);
    const values = await request('GET', `/api/highlevel/reviews/${review.actionId}`);
    expect(values.status).toBe(200);
    expect(values.body.values.body).toBe(sentinel);
    const answer = await request('POST', `/api/threads/${review.threadId}/respond`, {
      requestId: review.requestId, behavior: 'allow', reviewDigest: values.body.reviewDigest,
    });
    expect(answer.body.outcome).toBe('allowed-once');
    let result: any;
    await expect.poll(() => {
      try { result = JSON.parse(readFileSync(join(fixture.info.dataDir, 'c2-rpc-result.json'), 'utf8')); return result.nonce; }
      catch { return ''; }
    }, { timeout: 10000 }).toBe(review.nonce);
    expect(result.result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(result.writes).toBe(1);
    evidence('rpc', result);
    expect((await request('GET', `/api/highlevel/reviews/${review.actionId}`)).status).toBe(404);
  }, 30000);
  it('T5 paired phone cannot read or allow an exact review but can Deny', async () => {
    const review = await seed();
    const values = await request('GET', `/api/highlevel/reviews/${review.actionId}`);
    const deniedValues = await request('GET', `/api/highlevel/reviews/${review.actionId}`, undefined, phone);
    expect(deniedValues.status).toBe(403); expect(JSON.stringify(deniedValues.body)).not.toContain(sentinel);
    const allow = await request('POST', `/api/threads/${review.threadId}/respond`, { requestId: review.requestId, behavior: 'allow', reviewDigest: values.body.reviewDigest }, phone);
    expect(allow.status).toBe(403); expect(allow.body.code).toBe('on_computer');
    const deny = await request('POST', `/api/threads/${review.threadId}/respond`, { requestId: review.requestId, behavior: 'deny' }, phone);
    expect(deny.status).toBe(200); expect(deny.body.outcome).toBe('rejected');
    expect((await request('GET', `/api/highlevel/reviews/${review.actionId}`)).status).toBe(404);
  }, 30000);
});
