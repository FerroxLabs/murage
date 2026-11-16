// SPDX-License-Identifier: AGPL-3.0-or-later
// Checker producer: wipe-v3. Review regression consumer: c4-misc-d.
import { expect, it } from 'vitest';
import { wipeBreaker } from './wipe-breaker.ts';
import { RootRegistry } from './wipe/registry.ts';

const pathPort = { realpath: (path: string) => path, isBlockDevice: () => false };
const context = { home: '/home/fixture', cwd: '/work/other', project: '/work/other', dataDir: '/state/app', platform: 'linux' as const, pathPort, mountInventory: { contains: () => false } };

it.each(['/ho*', '/[h]ome', '/?sr', '/[b-d]in'])('review: a top-level protected glob %s requires a wipe card', path => {
  expect(wipeBreaker('rm -rf ' + path, context)).toBeTruthy();
});

it.each(['/work/[p]roject', '/work/projec[t]', '/work/[!x]roject', '/work/[a-z]roject'])('review: registered root glob %s requires a wipe card', path => {
  const registry = new RootRegistry(pathPort);
  registry.replace('bot:fixture:cwd', ['/work/project']);
  expect(wipeBreaker('rm -rf ' + path, { ...context, registry })).toBeTruthy();
});

function registryWithTargetAt(targetIndex: number) {
  const registry = new RootRegistry(pathPort);
  // MAIN RULING 1115-C4D2-GROK H2: first, middle and last registration retain the real target.
  for (let index = 0; index < 257; index++) {
    if (index === targetIndex) registry.replace('bot:target:cwd', ['/projects/target']);
    else registry.replace('bot:fixture-' + index + ':cwd', ['/projects/unrelated-' + index]);
  }
  return registry;
}
it('review: the 257th protected sibling retains protection under a bounded glob query', () => {
  const registry = registryWithTargetAt(256);
  expect(wipeBreaker('rm -rf /projects/target*', { ...context, registry })).toBeTruthy();
  expect(wipeBreaker('rm -rf /projects/target', { ...context, registry })).toBeTruthy();
});
it.each([0, 128])('review: a protected overflow target registered at %s retains protection', targetIndex => {
  // MAIN RULING 1115-C4D2-GROK H2: add the first/middle cases while retaining the existing last-child test identity.
  const registry = registryWithTargetAt(targetIndex);
  expect(wipeBreaker('rm -rf /projects/target*', { ...context, registry })).toBeTruthy();
  expect(wipeBreaker('rm -rf /projects/target', { ...context, registry })).toBeTruthy();
});

it('review: unmatched globs below an unsaturated registry remain ordinary deletes', () => {
  const registry = new RootRegistry(pathPort);
  registry.replace('bot:fixture:cwd', ['/work/project']);
  for (const path of ['/scratch/no*', '/work/[x]roject', '/work/[!p]roject', '/work/project/build*']) {
    expect(wipeBreaker('rm -rf ' + path, { ...context, registry }), path).toBeNull();
  }
});

it('review: registered top-level roots retain their normalized parent', () => {
  const registry = new RootRegistry(pathPort);
  registry.replace('bot:fixture:cwd', ['/registered-project']);
  expect(wipeBreaker('rm -rf /registered-*', { ...context, registry })).toBeTruthy();
});

it('review: dropping siblings restores a complete bounded glob query', () => {
  const registry = new RootRegistry(pathPort);
  for (let index = 0; index < 257; index++) registry.replace('bot:fixture-' + index + ':cwd', ['/projects/unrelated-' + index]);
  // MAIN RULING 1115-DIGEST-ADOPTED G1: bounded arrays and complete subtree inventory are separate contracts.
  expect(registry.protectedChildren('/projects')).toHaveLength(256);
  expect(registry.protectedSubtreeChildren('/projects').sort()).toEqual(
    Array.from({ length: 257 }, (_, index) => '/projects/unrelated-' + index).sort());
  // MAIN RULING 1115-C4D2-GROK H2 supersedes G1: overflow must fail closed even without a matching child.
  expect(wipeBreaker('rm -rf /projects/target*', { ...context, registry })).toBeTruthy();
  registry.drop('bot:fixture-256:cwd');
  expect(registry.protectedChildren('/projects')).toHaveLength(256);
  expect(registry.protectedSubtreeChildren('/projects').sort()).toEqual(
    Array.from({ length: 256 }, (_, index) => '/projects/unrelated-' + index).sort());
  expect(wipeBreaker('rm -rf /projects/target*', { ...context, registry })).toBeNull();
});

it('review: a bounded-only registry cannot hide a protected overflow child', () => {
  // MAIN RULING 1115-C4D2-GROK H2: a capped provider without a complete inventory fails closed.
  const registry = new RootRegistry(pathPort);
  for (let index = 0; index < 256; index++) registry.replace('bot:fixture-' + index + ':cwd', ['/projects/unrelated-' + index]);
  registry.replace('bot:target:cwd', ['/projects/target']);
  const bounded = { contains: (path: string) => registry.contains(path), protectedChildren: (dir: string) => registry.protectedChildren(dir) };
  expect(bounded.protectedChildren('/projects')).toHaveLength(256);
  expect(bounded.protectedChildren('/projects')).not.toContain('/projects/target');
  expect(wipeBreaker('rm -rf /projects/target*', { ...context, registry: bounded })).toBeTruthy();
});
