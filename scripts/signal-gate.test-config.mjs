// Run every registered Signal gate file, including release/packaging and the
// shared prompt wrapper, without test-name filters or a second hand-kept list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const include = readFileSync(new URL('../ci/gate-tests.txt', import.meta.url), 'utf8')
  .split('\n').filter(line => {
    const [path, , reason = ''] = line.split('\t');
    return /(?:\/signal\/|\/signal-|\/SignalSettings\.)/.test(path) || /\bSignal\b/.test(reason);
  })
  .map(line => line.split('\t')[0]);

export default {
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: { include, fileParallelism: false, environment: 'node' },
};
