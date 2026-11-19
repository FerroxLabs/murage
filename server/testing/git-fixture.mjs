// Disposable Git metadata for repository-inventory tests, including archive runs.
// Source files are copied; no command reads or writes the runner's Git directory.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWipeSync } from './safe-wipe.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const generated = new Set(['.git', '.v101-ref', '.v102-ref', '.vrel-ref', 'node_modules', 'dist', 'dist-server', 'dist-native', 'dist-companion', '.test-tmp', 'test-results', 'playwright-report', '.vite', '.cache']);

export function gitFixture(files, { sourceRoot: source = sourceRoot } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'murage-git-fixture-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const config = join(root, '.fixture-gitconfig');
  writeFileSync(config, '');
  Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config });
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const copy = path => {
    if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..') || /^[A-Za-z]:/.test(path)) throw new Error('Invalid fixture inventory path');
    mkdirSync(dirname(join(root, path)), { recursive: true });
    const stat = lstatSync(join(source, path));
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(join(source, path)), join(root, path));
    else if (stat.isDirectory()) mkdirSync(join(root, path), { recursive: true });
    else copyFileSync(join(source, path), join(root, path));
  };
  const walk = (path = '') => {
    for (const entry of readdirSync(join(source, path), { withFileTypes: true })) {
      if (generated.has(entry.name)) continue;
      const next = path ? `${path}/${entry.name}` : entry.name;
      if (next === 'release') continue; // Top-level packaging output, never apps/mobile source sets.
      if (entry.isDirectory()) walk(next);
      else if (entry.isSymbolicLink()) {
        mkdirSync(dirname(join(root, next)), { recursive: true });
        symlinkSync(readlinkSync(join(source, next)), join(root, next));
      } else if (entry.isFile()) copy(next);
    }
  };
  try {
    const manifest = join(source, 'server/testing/.git-ls-files.fixture');
    let tracked = files;
    if (tracked === undefined) {
      try { tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: source, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean); }
      catch { /* An archive has no Git index; use its captured inventory below. */ }
    }
    if (tracked !== undefined) tracked.forEach(copy);
    else if (existsSync(manifest)) readFileSync(manifest, 'utf8').split('\0').filter(Boolean).forEach(copy);
    else walk();
    git('init', '--quiet');
    const privateConfig = join(root, '.git', 'fixture-config');
    renameSync(config, privateConfig);
    Object.assign(env, { GIT_CONFIG_GLOBAL: privateConfig, GIT_CONFIG_SYSTEM: privateConfig });
    git('add', '--force', '--all', '--', '.');
    // Keep the bootstrap path readable for existing callers. Git itself uses
    // the private metadata path; this compatibility file never enters audits.
    appendFileSync(join(root, '.git', 'info', 'exclude'), '\n/.fixture-gitconfig\n');
    writeFileSync(config, '');
    return { root, env, git, dispose: () => safeWipeSync(root) };
  } catch (error) {
    safeWipeSync(root);
    throw error;
  }
}
