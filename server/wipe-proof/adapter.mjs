// Owners: wg-proof owns these consumers; wg-shim owns guard.sh/guard-lib.sh/guard-request.sh,
// wg-callback owns client.mjs and guard JSON, wg-pwsh owns guard.ps1/external.ps1,
// wg-text and wg-win own wipeBreaker. All unpublished path assumptions live here.
// Assumptions: named POSIX links invoke guard.sh beside guard-lib.sh; Windows
// format.cmd/diskpart.cmd honor realTools and external.ps1 honors SystemRoot.
// Proxies use a terminating error and LASTEXITCODE=126 for refusal. Update ONLY
// this adapter if producer entrypoints change. Wire format is the MAIN addendum.
// Published POSIX deny status is 10 (wg-shim); unreachable MUST be 126 per the
// refined design. Windows external refusals are 126; proxy process errors are 1.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const here = path.dirname(fileURLToPath(import.meta.url));
export const posixStatus = { deny: 10, unreachable: 126 };
// MAIN RULING 1114-WG-SHIM-TIMING: the shim may add at most 10 ms (median) to a command it lets through.
// Git Bash: the shim is a script that execs the real tool, so it is exactly one more MSYS process image than the direct
// call, and one image costs about as much as the whole budget there. The direct call measured in the same run is two
// images (the launching sh and the tool), so half its median is that unavoidable cost; the 10 ms then bounds the shim's
// own work on every host. A second extra image (a full direct-call median of overhead) is still over the budget.
export const fastPathBudgetMs = (platform, realMedianMs) => 10 + (platform === 'win32' ? realMedianMs / 2 : 0);
// The fast path is timed in fastPathBlocks independent blocks, each with its own warm-up and medians, and the row judges
// the median block. A load burst on a shared runner (macOS 2026-11-18: 11.07 ms in one run, 5.12 ms in the run before)
// spoils at most one block; a shim slow in most blocks still fails. Never a retry: every block is measured and reported.
export const fastPathBlocks = 3;
export const medianBlock = blocks => [...blocks].sort((a, b) => a.overheadMs - b.overheadMs)[Math.floor(blocks.length / 2)];
export const ruleIds = new Set(['wipe-check-fault', 'delete-root', 'delete-home', 'delete-system-folder',
  'disk-erase', 'fork-bomb', 'unreadable', 'unknown-target', 'protected-path', 'other']);
export const tools = ['rm', 'rmdir', 'mv', 'dd', 'shred', 'wipefs', 'mkfs', 'mkfs.ext4', 'diskutil'];
export const product = {
  shim: path.resolve(here, '../wipe-guard/shim'),
  client: path.resolve(here, '../wipe-guard/client.mjs'),
  powershell: path.resolve(here, '../wipe-guard/pwsh'),
  checker: path.resolve(here, '../wipe-breaker.ts'),
};
export const shQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
// Git Bash accepts drive paths with forward slashes. Requests may instead use
// /c/... or /cygdrive/c/...; the fixture endpoint compares them as native paths.
export const shellFile = value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
export const shellCanonicalFile = value => shellFile(value).replace(/^([a-z]):\//i, (_, drive) => '/' + drive.toLowerCase() + '/');
export const nativeFixturePath = value => process.platform === 'win32'
  ? value.replace(/^\/(?:cygdrive\/)?([a-z])\//i, (_, drive) => drive + ':/') : value;
export const argvEqual = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
  actual.every((value, index) => process.platform === 'win32' && /^(?:[a-z]:|\/[a-z]\/)/i.test(value)
    ? path.resolve(nativeFixturePath(value)).toLowerCase() === path.resolve(nativeFixturePath(expected[index])).toLowerCase()
    : value === expected[index]);
export async function installPosix(destination, source = product.shim) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of ['guard.sh', 'guard-lib.sh', 'guard-request.sh']) {
    await fs.copyFile(path.join(source, name), path.join(destination, name));
    await fs.chmod(path.join(destination, name), 0o700);
  }
  for (const name of tools) {
    if (process.platform === 'win32') await fs.copyFile(path.join(destination, 'guard.sh'), path.join(destination, name));
    else await fs.symlink('guard.sh', path.join(destination, name));
  }
}
export async function installWindows(destination, source = product.powershell) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of ['guard.ps1', 'external.ps1', 'format.cmd', 'diskpart.cmd'])
    await fs.copyFile(path.join(source, name), path.join(destination, name));
}
export async function loadChecker(file = product.checker) {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  if (typeof module.wipeBreaker !== 'function') throw Error('checker-contract');
  return module.wipeBreaker;
}
