// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit, container-only replay of S5 from the preserved private fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { judgeRow, table } from './smooth-config.mjs';
import { loadBudgets } from './smooth-gate.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';

const [archiveArg, manifestArg, supportArg, outputArg] = process.argv.slice(2);
assert(archiveArg && manifestArg && supportArg && outputArg,
  'usage: s5-replay.mjs ARCHIVE MANIFEST PINNED_SUPPORT OUTPUT');
const archive = resolve(archiveArg), support = resolve(supportArg), output = resolve(outputArg);
const manifest = JSON.parse(readFileSync(manifestArg, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const archiveSha256 = hash.digest('hex');
assert.equal(archiveSha256, manifest.archiveSha256, 'S5 archive differs from the preserved fixture');
assert(manifest.messages > 10000 && manifest.links.length === 12, 'S5 needs the original history and links');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'smooth-s5-replay-'));
const data = join(scratch, 'murage'), work = join(scratch, 'source'), out = join(scratch, 'out');
const run = (cmd, args, env, log) => {
  const fd = openSync(join(output, log), 'w');
  try {
    const result = spawnSync(cmd, args, { env, cwd: work, stdio: ['ignore', fd, fd], timeout: 900000 });
    assert(!result.error && result.status === 0, `${log}: command failed (${result.status ?? result.error?.code})`);
  } finally { closeSync(fd); }
};
const history = (through = Number.MAX_SAFE_INTEGER) => {
  const db = new DatabaseSync(join(data, 'messages.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT rowid, json FROM messages WHERE thread_id=? AND rowid<=? ORDER BY rowid').all(manifest.thread, through);
    return { messages: rows.length, lastRowid: rows.at(-1)?.rowid, historySha256: sha(JSON.stringify(rows)) };
  } finally { db.close(); }
};
try {
  // The archive is hash-verified before extraction. Neither this tree nor any
  // original data is mutated; all server writes are under this private /tmp root.
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', scratch], { stdio: 'inherit' });
  assert.equal(extracted.status, 0);
  assert(!existsSync(join(data, 'config.json')) && !existsSync(join(data, 'routines.json')),
    'S5 requires the drained, disconnected fixture');
  const before = { bot: manifest.bot, thread: manifest.thread, ...history() };
  const desk = join(data, 'workspaces', manifest.bot, 'threads', manifest.thread);
  before.links = [];
  for (const dir of ['.claude/skills', '.agents/skills', '.grok/skills']) {
    for (const name of readdirSync(join(desk, dir))) {
      const path = join(desk, dir, name);
      if (lstatSync(path).isSymbolicLink()) before.links.push({ name: `${dir}/${name}`, target: readlinkSync(path) });
    }
  }
  before.links.sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(before.messages, manifest.messages, 'S5 history count changed');
  assert.deepEqual(before.links, [...manifest.links].sort((a, b) => a.name.localeCompare(b.name)), 'S5 pinned links changed');
  writeFileSync(join(output, 'input-proof.json'), JSON.stringify({ archiveSha256, before }, null, 2) + '\n');

  // The original S5 rig rebases bot.cwd, but this archive also pins task.cwd
  // to its Mac desk. Adapt that one fixture path to the copied desk; retain
  // the history, procedure pin and all old-root skill symlinks verbatim.
  const botsPath = join(data, 'bots.json'), bots = JSON.parse(readFileSync(botsPath, 'utf8'));
  const bot = (Array.isArray(bots) ? bots : bots.bots).find(bot => bot.id === manifest.bot);
  const task = bot.tasks.find(task => task.threadId === manifest.thread);
  const taskCwd = { from: task.cwd, to: desk };
  task.cwd = desk;
  writeFileSync(botsPath, JSON.stringify(bots));
  writeFileSync(join(output, 'fixture-preparation.json'), JSON.stringify({ taskCwd }, null, 2) + '\n');

  const source = process.cwd();
  const excluded = new Set(['.git', '.planning', 'node_modules', 'dist', 'dist-server', 'dist-native']);
  cpSync(source, work, { recursive: true, filter: path => !excluded.has(path.slice(source.length + 1).split('/')[0]) });
  symlinkSync(realpathSync(join(source, 'node_modules')), join(work, 'node_modules'), 'dir');
  // Support is exported from the original overlay, including its fake-engine
  // pin and prebuild helpers. Their hashes are retained with the replay.
  const supportHashes = {};
  for (const name of ['fake-acp-cli.ts', 'fake-claude-cli.ts', 'fake-codex-app-server.ts', 'fake-pi-cli.ts', 'fixture-request.ts']) {
    const file = join(support, name);
    supportHashes[name] = sha(readFileSync(file));
    assert.equal(supportHashes[name], manifest.supportHashes[name], 'S5 fake engine pin changed');
    cpSync(file, join(work, 'server/testing', name));
  }
  for (const name of ['prebuild-index.mjs', 'prebuild-before-listen.sh']) {
    const file = join(support, name);
    supportHashes[name] = sha(readFileSync(file));
    assert.equal(supportHashes[name], manifest.supportHashes[name], 'S5 prebuild pin changed');
    cpSync(file, join(work, 'scripts/smoothness', name));
  }
  for (const name of ['bwrap', 'murage-cage.bpf', 'murage-power.bpf', 'manifest.json', 'COPYING']) {
    const file = join(support, 'cage', name);
    supportHashes[`cage/${name}`] = sha(readFileSync(file));
    assert.equal(supportHashes[`cage/${name}`], manifest.supportHashes[`cage/${name}`], 'S5 cage pin changed');
    const destination = join(work, 'dist-native/cage', `${process.platform}-${process.arch}`, name);
    mkdirSync(join(destination, '..'), { recursive: true });
    cpSync(file, destination);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(MURAGE_|OMB_|FAKE_|SMOOTH_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: join(scratch, 'home'), SMOOTH_NODE: process.execPath, MURAGE_DATA_DIR: data,
    SMOOTH_PREBUILD_LOG: join(output, 'prebuild.log'), SMOOTH_WORK: work, SMOOTH_OUT: out,
    SMOOTH_CTL: join(scratch, 'ctl'), SMOOTH_LABEL: 's5-only', SMOOTH_SCENARIOS: 'longThread',
    SMOOTH_ENGINES: 'fake', TREE_SHA: manifest.sourceHead,
  });
  mkdirSync(env.HOME); mkdirSync(out);
  run('bash', ['scripts/smoothness/prebuild-before-listen.sh', work, join(data, 'messages.db'), 'true'], env, 'prebuild-command.log');
  run(process.execPath, ['scripts/smoothness/smooth.mjs'], env, 'replay.log');
  const result = JSON.parse(readFileSync(join(out, 'results-s5-only.json'), 'utf8'));
  const after = history();
  result.fixtureReplay = { archiveSha256, before, after: { messages: after.messages,
    originalHistorySha256: history(before.lastRowid).historySha256 }, taskCwd, supportHashes };
  result.s5Verdicts = loadBudgets().rows.filter(row => row.id.startsWith('S5.')).map(row => judgeRow(row, result));
  writeFileSync(join(output, 's5-replay-results.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(output, 's5-gate.md'), table({ rows: result.s5Verdicts, failed: result.s5Verdicts.filter(row => !row.pass).length,
    pass: result.s5Verdicts.every(row => row.pass) }, 'S5-only original fixture replay') + '\n');
  assert.equal(result.fixtureReplay.after.originalHistorySha256, before.historySha256, 'S5 original history was mutated');
  assert(result.s5Verdicts.every(row => row.pass), 'S5 replay failed a row');
} finally {
  if (existsSync(out)) cpSync(out, join(output, 'rig'), { recursive: true });
  if (existsSync(join(work, 'dist-native'))) cpSync(join(work, 'dist-native'), join(output, 'native'), { recursive: true });
  safeWipeSync(scratch);
}
