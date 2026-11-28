// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 S03: FolderTrustIndex.sourceNow (the ACP launch, its epoch checks, the engine's own trust request) reads the engine's trust file
// state through upstreamTrustNow, which makes no file call on the serving thread (the booted witness is folder-trust-turn-offthread-1024).
// This guards that the answer is still the right one: the same as the turn's trust step computed, and a file changed mid-turn shows up
// as a new revision and is never a grant.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { probeUpstreamTrustFs, upstreamTrustForTurn, upstreamTrustNow } from './folder-trust-upstream-cache.ts';
import { answerFromTrustFs, snapshotTrustFs } from './trust-fs.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'source-now-'))), repo = join(home, 'repo'), file = join(home, 'trusted_folders.toml');
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(repo);
// the turn's two steps, as index.ts runs them: the probe (folder-trust-probe.ts) then the answer, both over one snapshot
const turnStep = async () => answerFromTrustFs(await snapshotTrustFs(() => probeUpstreamTrustFs(home, repo, 1)), () => upstreamTrustForTurn(home, repo, 1));

it('a check after the turn step answers what the turn step computed, and a changed file is a new revision, never a grant', async () => {
  writeFileSync(file, `[folders.${JSON.stringify(repo)}]\ntrusted = true\ndecided_at = 1789152451\n`);
  let turn = await turnStep();
  await expect.poll(async () => (turn = await turnStep()).readable, { timeout: 5_000 }).toBe(true);
  expect(turn.trusted).toBe(true);
  expect(upstreamTrustNow(home, repo, 1), 'the launch check reads the turn\'s own answer').toEqual(turn);
  writeFileSync(file, `[folders.${JSON.stringify(repo)}]\ntrusted = false\ndecided_at = 1789152452\n# changed\n`);
  await expect.poll(() => upstreamTrustNow(home, repo, 1).revision, { timeout: 5_000, message: 'a file changed mid-turn is a new revision' }).not.toBe(turn.revision);
  expect(upstreamTrustNow(home, repo, 1), 'the changed file is unknown until a turn step reads it: never a grant').toMatchObject({ readable: false, trusted: false });
});
