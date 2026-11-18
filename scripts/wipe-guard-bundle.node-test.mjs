// Owners: wipe-guard-bundle owns packaging regression; wg-shim owns guard semantics.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { copyDir } = createRequire(require.resolve('electron-builder'))('builder-util');
const shellPath = path => path.replaceAll('\\', '/');
const names = ['dd', 'diskutil', 'mkfs', 'mkfs.apfs', 'mkfs.btrfs', 'mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4', 'mkfs.fat', 'mkfs.hfs', 'mkfs.hfsplus', 'mkfs.minix', 'mkfs.msdos', 'mkfs.ntfs', 'mkfs.vfat', 'mkfs.xfs', 'mv', 'rm', 'rmdir', 'shred', 'wipefs'];
const inside = (tree, path) => { const rel = relative(tree, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
function walk(tree, visit) {
  for (const name of readdirSync(tree)) {
    const file = join(tree, name), stat = lstatSync(file);
    visit(file, stat);
    if (stat.isDirectory()) walk(file, visit);
  }
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 240_000, ...options });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}
function ok(file, args, options) {
  const result = run(file, args, options);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

test('source command shims are executable regular copies of the unchanged guard', () => {
  const shim = join(root, 'server/wipe-guard/shim');
  for (const name of names) {
    const file = join(shim, name);
    assert.ok(lstatSync(file).isFile(), name + ' must not be a link');
    assert.deepEqual(readFileSync(file), readFileSync(join(shim, 'guard.sh')), name);
    if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o755, name);
  }
});

// Windows's release checkout has no symlink privilege requirement. The legacy
// link-copy mutation is exercised on POSIX; Windows exercises a real disabled checkout.
for (const checkout of process.platform === 'win32' ? ['normal', 'symlinks-disabled'] : ['normal', 'symlinks-disabled', 'legacy-links']) {
  test(`relocatable complete server bundle (${checkout})`, { timeout: 300_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'guard-package-'));
    try {
      const build = join(scratch, 'build');
      mkdirSync(build);
      for (const name of ['server', 'scripts', 'shared', 'src', 'electron', 'native', 'cloudflare', 'installer', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(root, name), join(build, name), { recursive: true, verbatimSymlinks: true });
      symlinkSync(realpathSync(join(root, 'node_modules')), join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const source = join(build, 'server/wipe-guard/shim');
      if (checkout === 'symlinks-disabled') {
        // A real index checkout, including Git's 120000 -> text-file conversion.
        ok('git', ['init', '--quiet'], { cwd: source });
        ok('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: source });
        for (const name of names) rmSync(join(source, name));
        ok('git', ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=false', 'checkout-index', '--all', '--force'], { cwd: source });
        rmSync(join(source, '.git'), { recursive: true, force: true });
      }
      if (checkout === 'legacy-links') {
        // Keep a legacy input witness: recursive cp must not reintroduce build paths.
        for (const name of names) { rmSync(join(source, name)); symlinkSync('guard.sh', join(source, name)); }
      }
      ok(process.execPath, ['scripts/bundle-server.mjs'], { cwd: build });
      const dist = join(build, 'dist-server');
      const shims = [];
      walk(dist, (file, stat) => {
        if (stat.isSymbolicLink()) {
          let hop = file; const seen = new Set();
          while (lstatSync(hop).isSymbolicLink()) {
            assert.ok(!seen.has(hop), 'link cycle: ' + file); seen.add(hop);
            const target = readlinkSync(hop);
            assert.ok(!isAbsolute(target), 'absolute link: ' + file);
            hop = resolve(dirname(hop), target);
            assert.ok(inside(dist, hop), 'escaping link: ' + file);
          }
          assert.ok(inside(dist, realpathSync(file)), file);
        }
        if (stat.isDirectory() && file.endsWith(join('wipe-guard', 'shim'))) shims.push(relative(dist, file));
      });
      assert.ok(shims.length >= 4, 'every inlined environment reader needs runtime assets');
      const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'));
      assert.equal(config.asar, true);
      assert.ok(config.extraResources.some(entry => entry.from === 'dist-server' && entry.to === 'server'));
      // Use the installed packager's extraResources copier, including its
      // real-file permission handling. Server resources are outside ASAR.
      const packaged = join(scratch, 'relocated', ...(process.platform === 'darwin' ? ['Fixture.app', 'Contents', 'Resources'] : ['resources']), 'server');
      await copyDir(dist, packaged, { isUseHardLink: () => false });
      // Remove the entire build machine source/output before executing the copy.
      rmSync(build, { recursive: true, force: true });
      for (const dir of shims) for (const name of names) {
        const file = join(packaged, dir, name);
        assert.ok(lstatSync(file).isFile(), file);
        assert.deepEqual(readFileSync(file), readFileSync(join(packaged, dir, 'guard.sh')), name);
        if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o755, file);
      }
      const envModule = await import(pathToFileURL(join(packaged, 'env-path.js')).href);
      const env = envModule.wipeGuardEnvironment({ PATH: process.env.PATH }, join(scratch, 'guard.json'));
      const resolvedShim = env.PATH.split(process.platform === 'win32' ? ';' : ':')[0];
      assert.ok(inside(packaged, resolvedShim), resolvedShim);
      assert.ok(existsSync(join(resolvedShim, 'guard.sh')), resolvedShim);
      const real = join(scratch, 'real'); mkdirSync(real);
      const witness = '#!/bin/sh\nprintf "<%s>\\n" "$@"\nprintf "ordinary stderr\\n" >&2\nexit 37\n';
      const client = join(scratch, 'client.sh');
      writeFileSync(client, '#!/bin/sh\nexit 10\n', { mode: 0o755 });
      const realTools = {};
      for (const name of names) { const file = join(real, name); writeFileSync(file, witness, { mode: 0o755 }); realTools[name] = shellPath(file); }
      const protectedRoot = join(scratch, 'protected'); mkdirSync(protectedRoot);
      const guard = join(scratch, 'guard.json');
      writeFileSync(guard, JSON.stringify({ v: 1, socket: shellPath(join(scratch, 'fixture.sock')), threadId: 'fixture-turn', token: 'fixture-only', roots: [shellPath(protectedRoot)], client: ['sh', shellPath(client)], realTools, off: false }), { mode: 0o600 });
      for (const dir of shims) for (const name of names) {
        const file = join(packaged, dir, name);
        const shell = process.platform === 'win32' ? 'bash' : '/bin/sh';
        const options = { cwd: scratch, env: { ...process.env, PATH: `${join(packaged, dir)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, MURAGE_WIPE_GUARD: shellPath(guard) } };
        // Formatting any operand is intentionally a wipe. Its harmless help
        // form still has to preserve all following argument bytes and streams.
        const ordinaryArgs = name === 'mkfs' || name.startsWith('mkfs.') ? ['--help', 'ordinary value', '', '-literal'] : ['ordinary value', '', '-literal'];
        const ordinary = run(shell, [shellPath(file), ...ordinaryArgs], options);
        assert.equal(ordinary.status, 37, file + ordinary.stderr);
        assert.equal(ordinary.stdout, (ordinaryArgs[0] === '--help' ? '<--help>\n' : '') + '<ordinary value>\n<>\n<-literal>\n', file);
        assert.equal(ordinary.stderr, 'ordinary stderr\n', file);
        // These device spellings reach only the inert witness if protection
        // regresses; this fixture never invokes a host disk or deletion tool.
        const args = name === 'dd' ? ['of=/dev/sda'] : name === 'diskutil' ? ['eraseDisk', 'APFS', 'fixture', '/dev/sda'] : name === 'mv' ? [protectedRoot, join(scratch, 'moved')] : name === 'rm' ? ['-rf', protectedRoot] : name === 'rmdir' ? [protectedRoot] : ['/dev/sda'];
        const blocked = run(shell, [shellPath(file), ...args.map(shellPath)], options);
        assert.equal(blocked.status, 10, file + blocked.stderr);
        assert.equal(blocked.stdout, '', file);
        assert.match(blocked.stderr, /wipe guard: refused/);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
