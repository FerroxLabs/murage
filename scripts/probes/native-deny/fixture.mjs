// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const owned = new WeakMap();
export function createFixture(tempRoot = tmpdir()) {
  const parent = realpathSync(tempRoot);
  const root = mkdtempSync(join(parent, 'murage-native-deny-'));
  const fixture = { root, home: join(root, 'home'), work: join(root, 'work', 'repo') };
  const marker = randomUUID();
  const st = lstatSync(root);
  owned.set(fixture, { parent, root, dev: st.dev, ino: st.ino, marker });
  try {
    for (const dir of ['home', 'tmp', 'work/repo/.git/objects', 'work/repo/.git/refs/heads',
      'work/repo/.claude', 'work/repo/protected', 'home/.config', 'home/.local/share',
      'home/.cache', 'home/AppData/Roaming', 'home/AppData/Local', 'home/.codex',
      'home/.claude', 'home/.grok', 'home/.fuigo', 'home/.cursor', 'home/.gemini/config']) {
      mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(root, '.fixture-owner'), marker, { mode: 0o600 });
    writeFixture(fixture, 'work/repo/.git/HEAD', 'ref: refs/heads/probe\n');
    writeFixture(fixture, 'work/repo/.git/config', '[core]\nrepositoryformatversion = 0\nbare = false\n');
    writeFixture(fixture, 'work/repo/.claude/settings.json', '{}\n');
    for (const name of ['git-global', 'git-system']) writeFixture(fixture, name, '');
    return fixture;
  } catch (error) {
    // The unexposed freshly created root cannot have been replaced by an engine.
    if (root && dirname(root) === parent) rmSync(root, { recursive: true, force: true });
    owned.delete(fixture);
    throw error;
  }
}

export function fixturePath(fixture, rel) {
  const record = owned.get(fixture);
  if (!record || fixture.root !== record.root || !rel || isAbsolute(rel) || rel.includes('\\')) throw new Error('FIXTURE-PATH');
  const rootStat = lstatSync(record.root);
  if (rootStat.isSymbolicLink() || rootStat.dev !== record.dev || rootStat.ino !== record.ino) throw new Error('FIXTURE-ROOT-REPLACED');
  const path = resolve(record.root, rel);
  const tail = relative(record.root, path);
  if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('FIXTURE-PATH');
  let at = record.root;
  for (const part of tail.split(sep)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) throw new Error('FIXTURE-SYMLINK');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

export function writeFixture(fixture, rel, data, mode = 0o600) {
  const path = fixturePath(fixture, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode });
  return path;
}

export function cleanupFixture(fixture) {
  const record = owned.get(fixture);
  if (!record) throw new Error('FIXTURE-NOT-OWNED');
  let st;
  try { st = lstatSync(record.root); }
  catch (error) { if (error.code === 'ENOENT') { owned.delete(fixture); return; } throw error; }
  const marker = join(record.root, '.fixture-owner');
  if (!record.root || fixture.root !== record.root || dirname(record.root) !== record.parent ||
    !record.root.startsWith(join(record.parent, 'murage-native-deny-')) || st.isSymbolicLink() ||
    !st.isDirectory() || st.dev !== record.dev || st.ino !== record.ino ||
    lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== record.marker) throw new Error('FIXTURE-CLEANUP-REFUSED');
  rmSync(record.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  owned.delete(fixture);
}

export async function withFixture(fn, tempRoot) {
  const fixture = createFixture(tempRoot);
  try { return await fn(fixture); } finally { cleanupFixture(fixture); }
}

// Deliberately allowlist the inherited environment: no API credentials, agents,
// proxies, preload scripts, user config pointers or login helpers reach a child.
export function fixtureEnv(fixture, inherited = process.env) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    const entry = Object.entries(inherited).find(([name]) => name.toUpperCase() === key.toUpperCase());
    if (entry) env[key] = entry[1];
  }
  return Object.assign(env, {
    HOME: fixture.home, USERPROFILE: fixture.home,
    APPDATA: join(fixture.home, 'AppData/Roaming'), LOCALAPPDATA: join(fixture.home, 'AppData/Local'),
    XDG_CONFIG_HOME: join(fixture.home, '.config'), XDG_DATA_HOME: join(fixture.home, '.local/share'),
    XDG_CACHE_HOME: join(fixture.home, '.cache'), XDG_STATE_HOME: join(fixture.home, '.local/state'),
    TMPDIR: join(fixture.root, 'tmp'), TMP: join(fixture.root, 'tmp'), TEMP: join(fixture.root, 'tmp'),
    GIT_CONFIG_GLOBAL: join(fixture.root, 'git-global'), GIT_CONFIG_SYSTEM: join(fixture.root, 'git-system'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: fixture.root,
    CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'), CODEX_HOME: join(fixture.home, '.codex'),
    GROK_HOME: join(fixture.home, '.grok'), FUIGO_HOME: join(fixture.home, '.fuigo'),
    CURSOR_CONFIG_DIR: join(fixture.home, '.cursor'), OPENCODE_CONFIG_DIR: join(fixture.home, '.config/opencode'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', DISABLE_AUTOUPDATER: '1', NO_COLOR: '1', CI: '1',
  });
}
