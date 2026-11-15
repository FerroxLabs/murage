import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { check, select, expandNodeTests, nodeGateFiles, readLists } from './ci-test-tiers.mjs';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'ci-node-gates-'));
  const write = (path, source) => writeFileSync(join(root, path), source);
  try {
    for (const dir of ['ci', 'electron', 'shared', 'scripts/nested', 'native/helper', 'src/e2e', 'server', 'lanes/audit', '.github/workflows']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    write('vite.config.ts', 'test: {include: ["shared/*.test.ts"],exclude: []}');
    write('shared/example.test.ts', '');
    write('ci/gate-tests.txt', 'shared/example.test.ts\tall\tfixture\n');
    write('ci/extended-tests.txt', '');
    write('package.json', JSON.stringify({ scripts: {} }));
    write('.github/workflows/ci.yml', 'jobs: {}');
    body(root, write);
  } finally { removeTempDirSync(root); }
}

it('registered Node gates must have a blocking runner and never enter a Vitest shard', () => fixture((root, write) => {
  write('electron/startup.node-test.mjs', '');
  write('ci/gate-tests.txt', 'shared/example.test.ts\tall\tfixture\nelectron/startup.node-test.mjs\tall\tstartup\n');
  write('package.json', JSON.stringify({ scripts: { 'test:electron': 'node --test "electron/*.node-test.mjs"' } }));
  write('.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - run: pnpm test:electron\n');
  expect(check(root).problems).toEqual([]);
  expect(select({ tier: 'gate' }, root).files).toEqual(['shared/example.test.ts']);
  write('package.json', JSON.stringify({ scripts: {} }));
  // MAIN RULING INT-CONFLICT-DEFAULT c24d4d9fef 619386c4b7: retain the missing-runner failure and pin its exact orphan diagnostic.
  expect(check(root).problems).toEqual(['unwired node-test file: electron/startup.node-test.mjs (add a blocking CI/nightly Node runner)']);
}));

it('discovers unlisted Node files independently of package scripts and tiers', () => fixture((root, write) => {
  const files = ['scripts/nested/new.node-test.mjs', 'native/helper/protocol.node-test.mjs', 'src/e2e/offline.node-test.ts', 'scripts/new.node-test.cjs', 'server/new.node-test.mjs', 'lanes/audit/new.node-test.mjs'];
  for (const file of files) write(file, '');
  expect(check(root).problems).toHaveLength(files.length);
  for (const file of files) expect(check(root).problems).toContain(`unwired node-test file: ${file} (add a blocking CI/nightly Node runner)`);
}));

it('an unused script or a nonblocking step does not wire a Node test', () => fixture((root, write) => {
  write('scripts/example.node-test.mjs', '');
  write('package.json', JSON.stringify({ scripts: { 'test:scripts': 'node --test "scripts/**/*.node-test.mjs"' } }));
  expect(check(root).problems).toHaveLength(1);
  for (const workflow of [
    'jobs:\n  quality:\n    continue-on-error: true\n    steps:\n      - run: pnpm test:scripts\n',
    'jobs:\n  quality:\n    steps:\n      - run: npm run test:scripts\n        continue-on-error: true\n',
    'jobs:\n  quality:\n    steps:\n      - run: pnpm test:scripts\n        working-directory: another-package\n',
  ]) {
    write('.github/workflows/ci.yml', workflow);
    expect(check(root).problems).toHaveLength(1);
  }
  write('.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - run: npm run test:scripts\n');
  expect(check(root).problems).toEqual([]);
}));

it('glob exclusions need another runner; nightly and nested package scripts count', () => fixture((root, write) => {
  write('scripts/linux.node-test.mjs', '');
  write('scripts/mac.node-test.mjs', '');
  const args = ['--exclude', 'scripts/mac.node-test.mjs', 'scripts/**/*.node-test.mjs'];
  expect(expandNodeTests(args, root)).toEqual(['scripts/linux.node-test.mjs']);
  write('package.json', JSON.stringify({ scripts: {
    'test:scripts': 'node scripts/ci-test-tiers.mjs run-node --exclude scripts/mac.node-test.mjs "scripts/**/*.node-test.mjs"',
    'test:all': 'pnpm test:scripts && pnpm test:all',
  } }));
  write('.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - run: pnpm test:all\n');
  expect(check(root).problems).toHaveLength(1);
  expect(check(root).problems[0]).toContain('scripts/mac.node-test.mjs');
  write('.github/workflows/nightly.yml', 'jobs:\n  mac:\n    steps:\n      - run: node --test scripts/mac.node-test.mjs\n');
  expect(check(root).problems).toEqual([]);
}));

it.each([
  'pnpm test:scripts || true',
  'pnpm test:scripts; true',
  'pnpm test:scripts | cat',
  'pnpm test:scripts &',
  'set +e\npnpm test:scripts\ntrue',
])('does not count a shell command that masks failure: %s', command => fixture((root,write)=>{
  write('scripts/example.node-test.mjs','');
  write('package.json',JSON.stringify({scripts:{'test:scripts':'node --test "scripts/**/*.node-test.mjs"'}}));
  write('.github/workflows/ci.yml',`jobs:\n  quality:\n    steps:\n      - run: |\n${command.split('\n').map(line=>'          '+line).join('\n')}\n`);
  expect(check(root).problems).toHaveLength(1);
  write('.github/workflows/ci.yml','jobs:\n  quality:\n    steps:\n      - run: pnpm test:scripts\n');
  write('package.json',JSON.stringify({scripts:{'test:scripts':'node --test "scripts/**/*.node-test.mjs" || true'}}));
  expect(check(root).problems).toHaveLength(1);
}));

it.each(['false', '${{ false }}', '${{ 0 }}', '${{ null }}', "${{ '' }}"])(
  'does not count an expression-disabled step or job: %s', condition => fixture((root,write)=>{
    write('scripts/example.node-test.mjs','');
    for(const level of ['job','step']) {
      write('.github/workflows/ci.yml',`jobs:\n  quality:\n${level==='job'?`    if: ${condition}\n`:''}    steps:\n      - run: node --test scripts/example.node-test.mjs\n${level==='step'?`        if: ${condition}\n`:''}`);
      expect(check(root).problems).toHaveLength(1);
    }
  })
);

it('registered probe Node tests stay out of Vitest and require their blocking runner',()=>{
 const root=mkdtempSync(join(tmpdir(),'ci-probe-node-gates-'));
 try{
  for(const dir of ['ci','scripts','.github/workflows'])mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'.github/workflows/ci.yml'),'jobs:\n  quality:\n    steps:\n      - run: pnpm test:electron\n');
  writeFileSync(join(root,'vite.config.ts'),'test: {include: ["scripts/*.test.mjs"],exclude: ["scripts/probe.test.mjs"]}');
  writeFileSync(join(root,'scripts/unit.test.mjs'),'');writeFileSync(join(root,'scripts/probe.test.mjs'),'');
  writeFileSync(join(root,'ci/gate-tests.txt'),'scripts/unit.test.mjs\tall\tunit\nscripts/probe.test.mjs\tall\tprobe\n');writeFileSync(join(root,'ci/extended-tests.txt'),'');
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:electron':'node --test "scripts/probe.test.mjs"'}}));
  expect(check(root).problems).toEqual([]);expect(select({tier:'gate'},root).files).toEqual(['scripts/unit.test.mjs']);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{}}));expect(check(root).problems).toHaveLength(1);
 }finally{removeTempDirSync(root);}
});

it('No limits release rulings are blocking Node gates outside every Vitest shard',()=>{
 for(const path of ['scripts/no-limits-live/ruling-1019.node-test.mjs','scripts/no-limits-live/ruling.node-test.mjs']) {
  expect(nodeGateFiles()).toContain(path);
  expect(readLists().gate.has(path)).toBe(true);
  expect(select({tier:'gate'}).files).not.toContain(path);
 }
 expect(check().problems).toEqual([]);
});

it('all 30 added release Vitest files and the Node ruling have blocking tiers',()=>{
 const rows=readFileSync(new URL('../ci/test-truth-r2-tiers.tsv',import.meta.url),'utf8').trim().split('\n').slice(1).map(line=>line.split('\t'));
 expect(rows).toHaveLength(31);
 const lists=readLists();
 for(const [path,tier,oses,reason] of rows){
  expect(tier,path).toBe('gate');expect(oses,path).toBe('all');expect(reason,path).not.toBe('');
  expect(lists.gate.has(path),path).toBe(true);expect(lists.extended.has(path),path).toBe(false);
 }
});

it('recognises the existing blocking root Node runner without treating a nonblocking step as coverage', () => fixture((root, write) => {
  write('scripts/root.node-test.mjs', '');
  write('.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - run: sudo -E "$(command -v node)" --test scripts/root.node-test.mjs\n');
  expect(nodeGateFiles(root)).toEqual(['scripts/root.node-test.mjs']);
  expect(check(root).problems).toEqual([]);
  write('.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - run: sudo -E "$(command -v node)" --test scripts/root.node-test.mjs\n        continue-on-error: true\n');
  expect(check(root).problems).toEqual(['unwired node-test file: scripts/root.node-test.mjs (add a blocking CI/nightly Node runner)']);
}));

// Registry consumer owner: c4-misc-a2. Wipe gate producer owner: wipe-hybrid.
// MAIN RULING 1114-C4A-WIPE-WINS: the approved wipe gate covers every OS,
// including the inert shell premises; no Linux-only registration is retained.
it('merged wipe v3 regressions stay in the blocking gate on their supported systems',()=>{
 const lists=readLists();
 for(const name of ['corpus-v3','env-contract','fault-v3','mutant-v3-witness',
  'perf-v3','ruling-1114-contexts','v3-premise','v3-regressions']){
  const path=`server/wipe/${name}.test.ts`;
  expect(lists.gate.get(path)?.osText,path).toBe('all');
  expect(lists.extended.has(path),path).toBe(false);
  for(const os of ['linux','mac','windows']){
   expect(select({tier:'gate',os}).files,path).toContain(path);
  }
 }
});
