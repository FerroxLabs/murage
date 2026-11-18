import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { grokAcpSupport } from './drivers/acp/grok.ts';
import { applyHermesAskHook } from './drivers/acp/hermes.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
it('Grok excludes WebFetch at launch', () => {
  const args = grokAcpSupport.spawnArgs({} as any, { integrations: { agents: {} } } as any, { cliVersion: '1.0.62', env: {} });
  expect(args).toContain('--deny'); expect(args).toContain('WebFetch');
  expect(args.indexOf('WebFetch')).toBeLessThan(args.indexOf('agent'));
});
it('Hermes managed overlay disables the native web and browser toolsets', () => {
  const home = mkdtempSync(join(tmpdir(), 'web-hermes-'));
  const env: Record<string, string> = { HOME: home, HERMES_HOME: home, MURAGE_DATA_DIR: home };
  try {
    applyHermesAskHook(env, { hostComputer: false, webRead: true } as any);
    const config = parse(readFileSync(join(env.HERMES_MANAGED_DIR, 'config.yaml'), 'utf8'));
    expect(config.agent.disabled_toolsets).toEqual(expect.arrayContaining(['web', 'browser']));
  } finally { removeTempDirSync(home); }
});
