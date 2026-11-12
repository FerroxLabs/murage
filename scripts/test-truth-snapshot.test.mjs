// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

it.skipIf(process.platform !== 'linux')('comparison snapshot keeps export-ignored fixtures, executable modes, links and exact Git revisions', () => {
  const root=mkdtempSync(join(tmpdir(),'truth-snapshot-test-'));
  try {
    const repo=join(root,'repo'), unpacked=join(root,'unpacked'), archive=join(root,'sources.tar.gz');
    mkdirSync(repo);mkdirSync(unpacked);writeFileSync(join(root,'gitconfig'),'');
    const env={...process.env,GIT_CONFIG_GLOBAL:join(root,'gitconfig'),GIT_CONFIG_SYSTEM:join(root,'gitconfig')};
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init','-q');
    mkdirSync(join(repo,'tests/fixtures'),{recursive:true});mkdirSync(join(repo,'apps/mobile/contract'),{recursive:true});
    writeFileSync(join(repo,'.gitattributes'),'/tests export-ignore\n/apps/mobile export-ignore\n');
    writeFileSync(join(repo,'tests/fixtures/required.json'),'fixture bytes\n');
    writeFileSync(join(repo,'apps/mobile/contract/schema.json'),'mobile contract\n');
    writeFileSync(join(repo,'run.sh'),'#!/bin/sh\nexit 0\n');chmodSync(join(repo,'run.sh'),0o755);
    symlinkSync('tests/fixtures/required.json',join(repo,'fixture-link'));
    git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.test','commit','-qm','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(repo,'head.txt'),'head-only\n');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.test','commit','-qm','head');const head=git('rev-parse','HEAD');
    const linked=join(root,'linked');git('worktree','add','--detach',linked,head);
    execFileSync('python3',['scripts/test-truth/snapshot.py','--repo',linked,'--revision',head,'--base',base,'--output',archive],{env,stdio:'pipe'});
    execFileSync('tar',['-xzf',archive,'-C',unpacked]);
    expect(readFileSync(join(unpacked,'tests/fixtures/required.json'),'utf8')).toBe('fixture bytes\n');
    expect(readFileSync(join(unpacked,'apps/mobile/contract/schema.json'),'utf8')).toBe('mobile contract\n');
    expect(readFileSync(join(unpacked,'fixture-link'),'utf8')).toBe('fixture bytes\n');
    execFileSync(join(unpacked,'run.sh'));
    expect(execFileSync('git',['-C',unpacked,'rev-parse','HEAD'],{env,encoding:'utf8'}).trim()).toBe(head);
    expect(execFileSync('git',['-C',unpacked,'rev-parse',base],{env,encoding:'utf8'}).trim()).toBe(base);
    expect(execFileSync('git',['-C',unpacked,'status','--porcelain'],{env,encoding:'utf8'})).toBe('');
    const manifest=JSON.parse(readFileSync(join(root,'sources-manifest.json'),'utf8'));
    expect(manifest.revision).toBe(head);expect(manifest.files['fixture-link'].kind).toBe('symlink');
    expect(manifest.files['run.sh'].mode).toBe('100755');expect(existsSync(join(unpacked,'head.txt'))).toBe(true);
  } finally {removeTempDirSync(root);}
}, 45_000);
