// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns the raise consumer; Cloud identity owns caller proofs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { isOwnersComputer } from './cloud-owner-surface.ts';
import { setCloudIdentity } from './cloud-request-identity.ts';
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
afterEach(() => vi.unstubAllEnvs());
it.each(['preview', 'apply'])('Cloud phone cannot mint a release through %s when defaults and acknowledgements are already raised', async mode => {
  vi.stubEnv('MURAGE_CLOUD_ROLE', 'home');
  const headers = {}; setCloudIdentity(headers, { id: 'fixture-device', account: 'owner', scope: 'owner-phone', revoked: false } as any);
  const start = source.indexOf('    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/permissions\\/refresh$/);');
  const end = source.indexOf('    // 1.0.4 SL-K K3:', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const mint = vi.fn(), save = vi.fn();
  const context = vm.createContext({ path: '/api/bots/bot/permissions/refresh', method: 'POST', req: { headers }, url: new URL('http://fixture.invalid'), res: {}, isOwnersComputer,
    // This is the dangerous old classification: an authenticated Cloud phone
    // is a desktop surface. Only the actual physical-owner predicate excludes it.
    requestSurface: () => 'desktop',
    readBody: async () => ({ scope: 'open', targetLevel: 'no-limits', ...(mode === 'apply' ? { rosterId: 'roster', afterRev: 1 } : {}) }),
    store: { bot: () => ({ noLimits: true, fullAccess: true, autoApprove: true, noLimitsAcknowledgedAt: 1, permissionRev: 1 }), raiseTaskPermissions: save },
    ownerLimitContinuations: { authorizeRaisedCard: mint }, json: (_res: unknown, status: number) => status,
  });
  vm.runInContext(ts.transpileModule(`globalThis.run=async()=>{let m;${source.slice(start,end)}}`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
  expect(await context.run()).toBe(404); expect(mint).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
