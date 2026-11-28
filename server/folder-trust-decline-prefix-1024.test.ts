// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 S03 (Fable 49d6db4742 H1a, Astra 5f3b49f69b): the folder-trust card lists the saved "Don't trust" answers inside and above the
// asked folder (drivers/acp/core.ts: turn.folderTrust.snapshot.declines). Each saved No was
// resolved on disk (isUnrecordableTrustRoot -> realpath) BEFORE the string prefix test, so a No once given for a folder on a sleeping
// volume froze a card for any unrelated local folder. The file calls are observed with the turn's own trust-fs collector: every call
// the code makes is noted, and none may touch the unrelated folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { snapshotTrustFs } from './trust-fs.ts';
import { seedFuigoHome } from './folder-trust-seed.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'decline-prefix-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const asked = join(root, 'repo'), inside = join(asked, 'sub'), unrelated = join(root, 'sleeping-volume', 'share');
for (const folder of [inside, unrelated]) mkdirSync(folder, { recursive: true });
const store = new FolderTrustStore(join(root, 'folder-trust.json'));
store.remember(unrelated, 'reject', 'picker'); store.remember(inside, 'reject', 'picker');
const touched = (snapshot: Map<string, unknown>) => [...snapshot.keys()].filter(key => key.includes(unrelated));

it('the card\'s saved-No lists never resolve an unrelated saved No on disk, and still list the ones inside', async () => {
  const index = store.snapshot();
  let lists: [string[], string[]] = [[], []];
  const snapshot = await snapshotTrustFs(() => { lists = [index.declines(asked), index.declines(asked, true)]; });
  expect(touched(snapshot), 'the saved-decline list made a file call on an unrelated folder').toEqual([]);
  expect(lists[0], 'the No inside the asked folder is still named').toEqual([inside]);
});

// Fable 49d6db4742 H1b: the fresh Fuigo home's seed (seedFuigoHome, awaited by drivers/acp/core.ts on every Fuigo turn with a fresh home)
// checks every saved path on disk (fuigoSeedPathValid -> isUnrecordableTrustRoot). Those calls must be answered off the serving thread
// in the seed's own trust scope, so the turn's collector around it sees none of them on the unrelated folder.
it('the fresh home seed checks every saved answer off the serving thread', async () => {
  const home = join(root, 'fresh-home'); mkdirSync(home);
  let seeding: ReturnType<typeof seedFuigoHome> | undefined;
  const snapshot = await snapshotTrustFs(() => { seeding ??= seedFuigoHome({ path: home, cloud: false }, { trustKeys: [], rejects: [{ key: unrelated, folder: unrelated }], realCwd: asked, policyGrant: false, cloudHome: null }); });
  const seed = await seeding!;
  expect(touched(snapshot), 'the seed checked a saved answer with a synchronous file call').toEqual([]);
  expect(seed.declines, 'the saved No is still seeded').toEqual([unrelated]);
});

// Fable d66f84912c H1(b): with the policy grant on and a saved No, the seed first checks the policy folder (folderPolicySeedAllowed):
// the key of every folder from the turn's folder to the root (folderTrustKey: realpath, git root) was resolved on the serving thread,
// before the seed's own off-thread step. Those calls must be answered in the seed's own trust scope too.
it('the policy folder check of the fresh home seed resolves the folder keys off the serving thread', async () => {
  const home = join(root, 'policy-home'); mkdirSync(home);
  let seeding: ReturnType<typeof seedFuigoHome> | undefined;
  const snapshot = await snapshotTrustFs(() => { seeding ??= seedFuigoHome({ path: home, cloud: false }, { trustKeys: [], rejects: [{ key: unrelated, folder: unrelated }], realCwd: asked, policyGrant: true, cloudHome: null }); });
  const seed = await seeding!;
  expect([...snapshot.keys()].filter(key => key.includes(asked)), 'the policy folder check resolved a folder key with a synchronous file call').toEqual([]);
  expect(seed.policySeeded, 'the policy folder is still seeded').toBe(true);
});
