#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapt the external shard dispatcher's stock Node image without editing the
// shared tool. All limits, mounts, labels and network flags pass through.
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
const docker = process.env.MURAGE_REAL_DOCKER;
if (!docker || !isAbsolute(docker)) throw Error('MURAGE_REAL_DOCKER must name the absolute Docker executable');
const args = process.argv.slice(2);
if (args[0] === 'run') {
  // Stop at the image, so an identical string in the container's command is
  // never rewritten. All value-taking options used by the dispatcher consume
  // their next argument; boolean switches and --option=value do not.
  const switches = new Set(['--rm', '--init', '--privileged', '--read-only', '--tty', '--interactive', '--detach', '--publish-all', '--oom-kill-disable']);
  let image = 1;
  while (image < args.length && args[image].startsWith('-')) {
    const option = args[image++];
    if (option === '--') break;
    if (!option.includes('=') && !switches.has(option) && !/^-[itdP]+$/.test(option)) image++;
  }
  if (args[image] === 'node:24-bookworm') {
    args[image] = process.env.MURAGE_TEST_IMAGE ?? 'murage-release-test:node24-bookworm';
    // Archive-based shards do not have the controller's Git object store.
    // The replay already accepts an explicit, controller-pinned source SHA.
    const revision = process.env.MURAGE_TEST_REVISION;
    if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw Error('MURAGE_TEST_REVISION must be a full commit SHA');
    if (revision) args.splice(image, 0, '--env', `FIELD_REPLAY_SHA=${revision}`);
    // The leak guard deliberately delegates to the shared, authoritative pair.
    // Transport it read-only; never replace it with a local pattern list.
    const shared = process.env.MURAGE_TEST_SHARED_GUARD_DIR;
    if (shared) {
      if (!isAbsolute(shared)) throw Error('MURAGE_TEST_SHARED_GUARD_DIR must be absolute');
      args.splice(image, 0, ...['leak-guard.sh', 'public-leak-patterns.txt'].flatMap(file =>
        ['--mount', `type=bind,source=${join(shared, file)},target=/opt/murage-test-shared/${file},readonly`]),
      '--env', 'PUBLIC_LEAK_GUARD_SHARED_DIR=/opt/murage-test-shared');
    }
  }
}
const result = spawnSync(docker, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 128);
