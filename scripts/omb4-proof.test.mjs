// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('.github/workflows/omb4-proof.yml');
const workflow = parse(source);
const prepare = workflow.jobs.proof.steps.find(step => step.name?.startsWith('Prepare exact candidate')).run;
describe('native OMB4 ownership proof workflow', () => {
  it('carries the selected fusepy interpreter through a sudo environment reset', () => {
    const root = mkdtempSync(join(tmpdir(), 'omb4-sudo-env-'));
    try {
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'proof'));
      const python = join(root, 'proof', 'pinned-python');
      // Stand in only for privilege elevation and the FUSE server. Execute the
      // exact workflow command with sudo's normal clean environment boundary.
      writeFileSync(join(root, 'bin', 'sudo'), '#!/bin/sh\nexec /usr/bin/env -i "$@"\n', { mode: 0o755 });
      writeFileSync(python, '#!/bin/sh\nprintf "selected-fusepy-interpreter\\n"\n', { mode: 0o755 });
      writeFileSync(join(root, 'proof', 'stress.sh'), '#!/bin/bash\nset -euo pipefail\n"${OMB4_FUSE_PYTHON:?missing selected fusepy interpreter}"\n');
      const step = workflow.jobs.proof.steps.find(row => row.name === 'Actual PID allocator wrap, stale nominee refusal, and FUSE D-state');
      const result = spawnSync('bash', ['-c', 'export PATH="$PWD/bin:$PATH"\nexport OMB4_FUSE_PYTHON="$PWD/proof/pinned-python"\n' + step.run], {
        cwd: root,
        env: { ...process.env, HOME: root },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('selected-fusepy-interpreter');
    } finally {
      removeTempDirSync(root);
    }
  });
  it('binds every applied patch to the current source bytes', () => {
    const patches = [...prepare.matchAll(/\('((?:patches\/)?[\w.-]+\.patch)', '([a-f0-9]{64})'\)/g)];
    expect(patches).toHaveLength(4);
    for (const [, path, hash] of patches) {
      expect(createHash('sha256').update(read(`third_party/browser/${path}`)).digest('hex'), path).toBe(hash);
    }
    expect(prepare).toContain('git rev-parse HEAD:third_party/browser');
  });
  it('retains native platform, forced PID reuse and real FUSE witnesses', () => {
    expect(workflow.jobs.proof.strategy.matrix.include.map(row => row.lane)).toEqual([
      'macos-arm64', 'macos-x64', 'windows-x64', 'ubuntu-glibc', 'alpine-musl', 'linux-pid-reuse-fuse',
    ]);
    for (const witness of ['ownership_native_pid_reuse_refuses_sentinel', 'ownership_native_fuse_d_state_retains_pin_and_retries']) {
      expect(prepare).toContain(`fn ${witness}()`);
      expect(prepare).toContain(`native::ownership::behavior_tests::${witness}`);
    }
    expect(prepare).toContain("assert_eq!(signals(), 0");
    expect(prepare).toContain("assert_ne!(pending & (1 << (libc::SIGKILL - 1)), 0");
    expect(workflow.jobs.proof['continue-on-error']).toBeUndefined();
  });
  it('requires the current launch-bound close CLI tests beside native job-handle exhaustion', () => {
    const patch = read('third_party/browser/patches/murage-window-ownership.patch');
    for (const name of ['close_all', 'dashboard_stop', 'launch_group_stop', 'close_owned']) {
      const test = `ownership_N1_${name}_saves_dirty_state_before_force`;
      expect(prepare).toContain(`'${test}'`);
      expect(patch).toContain(`fn ${test}()`);
    }
    for (const routine of ['open_close_job', 'close_job_active', 'release_close_job']) {
      expect(prepare).toContain(`${routine}(`);
      expect(patch).toContain(`fn ${routine}(`);
    }
    expect(prepare).toContain('.args(["launch-group", "--stop", "--launch-id", &id, "--owner-file"])');
    expect(prepare).toContain('assert!(output.status.success())');
    expect(prepare).toContain('assert_eq!(reply["closed"], true)');
    expect(prepare).toContain('--ownership-native-wait');
    expect(prepare).toContain("'--features', 'ownership-test-fixtures'");
    expect(prepare).toContain("zero/ignored tests are not proof");
  });
});
