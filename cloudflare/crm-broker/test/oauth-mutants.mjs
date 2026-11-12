import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'cloudflare/crm-broker/src/oauth.ts';
const original = readFileSync(path, 'utf8');
const mutants = [
  ['M-OAUTH-STAGING-REDIRECT-UNPINNED', 'config.redirectUri===`${origin.origin}/v1/crm/callback`', 'true'],
  ['M-SCOPE-REQUESTED-AS-GRANTED', 'const scopes = [...new Set(v.scope.split(" "))].sort();', 'const scopes = [...qualifiedScopes].sort();'],
  ['M-OAUTH-MISSING-REFRESH-SCOPE', 'const v = value as Record<string, unknown>;', 'const v = value as Record<string, unknown>; v.scope ??= "contacts.readonly";'],
  ['M-OAUTH-REFRESH-ROTATION', 'refreshToken: v.refresh_token,', 'refreshToken: v.access_token,'],
];
mkdirSync('evidence/hl-c1-broker/mutants', { recursive: true });
try {
  for (const [name, before, after] of mutants) {
    if (!original.includes(before)) throw new Error(`Unreachable mutant ${name}`);
    writeFileSync(path, original.replace(before, after));
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'cloudflare/crm-broker/test/oauth.test.ts'], { encoding: 'utf8' });
    const log = run.stdout + run.stderr;
    writeFileSync(`evidence/hl-c1-broker/mutants/${name}.log`, log);
    if (run.status !== 1 || !log.includes('AssertionError') || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(log)) throw new Error(`Not assertion-killed: ${name}`);
    console.log(`${name}: ASSERTION-KILLED (exit ${run.status})`);
    writeFileSync(path, original);
  }
} finally { writeFileSync(path, original); }
