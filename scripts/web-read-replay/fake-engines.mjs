// Only dependency-free repository fakes. This preload runs inside the isolated
// verification data directory before the product imports its configuration.
export function fakeEngineSetup(root) {
  return `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)}, data = process.env.MURAGE_DATA_DIR;
process.env.NODE_ENV = 'test';
globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
process.env.FLUX_API_KEY = 'sk-flux-' + 'f'.repeat(40);
if (!data || !data.includes('murage-verify-data-')) throw Error('Not a verification fixture');
const configPath = join(data, 'config.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
const home = join(data, 'fake-driver-home'); mkdirSync(join(home, '.factory'), { recursive: true });
writeFileSync(join(home, '.factory/auth.v2.file'), 'offline-fixture');
const base = { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: 'happy', FAKE_ACP_MCP_READY: '1', FAKE_ACP_MODELS: 'gpt-5.6-sol,gemini-3.1-pro,flux-auto' };
for (const [id, driver, file, extra] of [
  ['fake-codex', 'codex', 'fake-codex-app-server.ts', {}],
  ['fake-droid-sol', 'droidAgent', 'fake-acp-cli.ts', { FACTORY_HOME_OVERRIDE: home, FAKE_ACP_VERSION: 'droid 0.245.0' }],
  ['fake-gemini', 'geminiAgent', 'fake-acp-cli.ts', { GEMINI_API_KEY: 'offline-fixture', FAKE_ACP_VERSION: 'gemini 1.0.62' }],
  ['fake-fuigo', 'fuigoAgent', 'fake-acp-cli.ts', { FUIGO_API_KEY: 'offline-fixture', FAKE_ACP_VERSION: 'fuigo 1.0.62' }],
]) config.instances[id] = { driver, displayName: id, config: { cli: join(root, 'server/testing', file) }, environment: { ...base, ...extra } };
writeFileSync(configPath, JSON.stringify(config));
`;
}
export const fakeSpecs = [
  { id: 'verification', driver: 'claudeAgent', model: 'claude-sonnet-5-5', cli: 'fake-claude-cli.ts' },
  { id: 'fake-codex', driver: 'codex', model: 'gpt-5.6-sol', cli: 'fake-codex-app-server.ts' },
  { id: 'fake-droid-sol', driver: 'droidAgent', model: 'gpt-5.6-sol', cli: 'fake-acp-cli.ts' },
  { id: 'fake-gemini', driver: 'geminiAgent', model: 'gemini-3.1-pro', cli: 'fake-acp-cli.ts' },
  { id: 'fake-fuigo', driver: 'fuigoAgent', model: 'flux-auto', cli: 'fake-acp-cli.ts' },
];
