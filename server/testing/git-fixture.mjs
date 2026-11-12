// Disposable Git metadata for repository-inventory tests, including archive runs.
// Source files are copied; no command reads or writes the runner's Git directory.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWipeSync } from './safe-wipe.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const generated = new Set(['.git', '.v101-ref', '.v102-ref', '.vrel-ref', 'node_modules', 'dist', 'dist-server', 'dist-native', 'dist-companion', '.test-tmp', 'test-results', 'playwright-report', '.vite', '.cache']);

export function gitFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'murage-git-fixture-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const config = join(root, '.fixture-gitconfig');
  writeFileSync(config, '');
  Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config });
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const copy = path => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(root, path));
  };
  const walk = (path = '') => {
    for (const entry of readdirSync(join(sourceRoot, path), { withFileTypes: true })) {
      if (generated.has(entry.name)) continue;
      const next = path ? `${path}/${entry.name}` : entry.name;
      if (next === 'release') continue; // Top-level packaging output, never apps/mobile source sets.
      if (entry.isDirectory()) walk(next);
      else if (entry.isSymbolicLink()) {
        mkdirSync(dirname(join(root, next)), { recursive: true });
        symlinkSync(readlinkSync(join(sourceRoot, next)), join(root, next));
      } else if (entry.isFile()) copy(next);
    }
  };
  try {
    if (files) files.forEach(copy); else walk();
    git('init', '--quiet');
    git('add', '--force', '--all', '--', '.');
    return { root, env, git, dispose: () => safeWipeSync(root) };
  } catch (error) {
    safeWipeSync(root);
    throw error;
  }
}
