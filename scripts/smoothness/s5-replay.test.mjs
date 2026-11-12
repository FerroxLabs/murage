// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeRow } from './smooth-config.mjs';
import { loadBudgets } from './smooth-gate.mjs';

// The private archive and its manifest stay outside Git. Ordinary fixture tests
// remain self-contained; this explicit evidence check qualifies the S5 replay.
describe.runIf(Boolean(process.env.S5_REPLAY_RESULTS))('original S5 fixture replay', () => {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const manifest = process.env.S5_REPLAY_RESULTS && read(process.env.S5_REPLAY_MANIFEST);
  const result = process.env.S5_REPLAY_RESULTS && read(process.env.S5_REPLAY_RESULTS);

  it('retains the original long history and every old-root skill link before sending', () => {
    expect(result.fixtureReplay).toBeDefined();
    const proof = result.fixtureReplay;
    expect(proof.archiveSha256).toBe(manifest.archiveSha256);
    expect(proof.before.bot).toBe(manifest.bot);
    expect(proof.before.thread).toBe(manifest.thread);
    expect(proof.before.messages).toBe(manifest.messages);
    expect(proof.before.messages).toBeGreaterThan(10000);
    expect(proof.before.historySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.before.links).toEqual([...manifest.links].sort((a, b) => a.name.localeCompare(b.name)));
    expect(proof.before.links).toHaveLength(12);
    expect(proof.supportHashes).toEqual(manifest.supportHashes);
    expect(proof.before.links.every(link => link.target.startsWith(`${proof.taskCwd.from}/.murage-procedures/`))).toBe(true);
    expect(proof.taskCwd.to).toContain('/smooth-s5-replay-');
    expect(proof.after.originalHistorySha256).toBe(proof.before.historySha256);
    expect(proof.after.messages).toBeGreaterThan(manifest.messages);
    expect(result.scenarios.longThread).toMatchObject({
      thread: manifest.thread, bot: manifest.bot, threadMessages: manifest.messages, n: 5,
    });
    expect(Object.keys(result.scenarios)).toEqual(['longThread']);
    expect(result).toMatchObject({ engines: 'fake', phase: 'finished', status: 'COMPLETE' });
    expect(result.nativePreflight).toMatchObject({ loaded: true, noReplace: true });
  });

  for (const id of ['S5.firstText', 'S5.resumed', 'S5.failed']) {
    it(`${id}: retains a PASS against the unchanged rig budget`, () => {
      const verdict = judgeRow(loadBudgets().rows.find(row => row.id === id), result);
      expect(verdict).toMatchObject({ pass: true });
      expect(result.s5Verdicts.find(row => row.id === id)).toEqual(verdict);
    });
  }
});
