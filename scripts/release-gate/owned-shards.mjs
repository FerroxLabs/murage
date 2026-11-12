// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Read only this invocation's xtrace, including an interrupted invocation.
// Never infer ownership from a shared SHA/name prefix or a registry directory.
export function cleanupOwnedShards(log, sha, out) {
  if (!existsSync(log)) return;
  const trace = readFileSync(log, 'utf8');
  const ownedRun = /^\+ RUN=(\/root\/fuigo-builds\/tools\/runs\/[a-f0-9]{9}-[0-9]+)$/m.exec(trace)?.[1];
  if (!ownedRun || !ownedRun.split('/').at(-1).startsWith(sha.slice(0, 9) + '-')) return;
  const source = join(ownedRun, 'src');
  const candidates = spawnSync('docker', ['ps', '-aq', '--filter', 'volume=' + source], { encoding: 'utf8' });
  if (candidates.status !== 0) throw Error('Cannot inspect owned shard containers before source cleanup');
  for (const id of candidates.stdout.trim().split(/\s+/).filter(Boolean)) {
    if (!/^[a-f0-9]+$/.test(id)) throw Error('Invalid owned shard container id');
    const removed = spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8' });
    if (removed.status !== 0) throw Error('Could not remove owned shard container; retaining mounts');
  }
  safeWipeSync(source, { within: ownedRun });
  writeFileSync(join(out, 'vt-source-cleanup.json'), JSON.stringify({ ownedRun, sourceRemoved: true }));
}
