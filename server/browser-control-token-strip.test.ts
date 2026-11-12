import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('the merged control-token module loads in the production strip-types server', () => {
  const module = fileURLToPath(new URL('./browser-control-token.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `await import(${JSON.stringify(module)})`], { encoding: 'utf8', timeout: 10000 });
  expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
  expect(result.status).toBe(0);
});
