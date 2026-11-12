import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileSha256, sameManifest, treeManifest, type TreeEntry } from './browser-window-identity.ts';
export const GOOGLE_LINUX_FINGERPRINT = 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796';
export type ToolRun = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export type ChromeFetch = (url: string) => Promise<Buffer>;
export type PackageFile = { path: string; sha256: string; mode: number };
export class LinuxChromeError extends Error {
  readonly cause: 'unverified' | 'linux_repo_unreachable' | 'linux_not_google_package';
  constructor(cause: LinuxChromeError['cause'], message: string) { super(message); this.cause = cause; }
}
function refuse(message: string): never { throw new LinuxChromeError('unverified', message); }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertGoogleLinuxPath(candidate: string, inspect = (path: string) => {
  const stat = lstatSync(path); return { realpath: realpathSync(path), uid: stat.uid, mode: stat.mode };
}): void {
  const fail = () => { throw new LinuxChromeError('linux_not_google_package', 'Use the Google Chrome stable package.'); };
  if (candidate !== '/opt/google/chrome/chrome') fail();
  for (let path = candidate;; path = dirname(path)) {
    const s = inspect(path);
    if (s.realpath !== path || s.uid !== 0 || (s.mode & 0o022) !== 0 || (s.mode & 0o170000) !== (path === candidate ? 0o100000 : 0o040000)) fail();
    if (path === '/') break;
  }
}
export function validatePackageFiles(files: PackageFile[]): PackageFile[] {
  if (!files.length || files.length > 50_000) refuse('Empty package table');
  const seen = new Set<string>();
  for (const file of files) {
    if (!/^opt\/google\/chrome\/[^\\\x00-\x1f]+$/.test(file.path) || file.path.split('/').some(p => p === '..' || p === '.' || !p) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) refuse('Invalid package table');
    seen.add(file.path);
  }
  for (const name of ['chrome', 'chrome-sandbox', 'chrome_crashpad_handler']) if (!seen.has(`opt/google/chrome/${name}`)) refuse('Incomplete package table');
  return files;
}
/** Cached provenance still hashes both privileged images each launch. Other
 * files must retain their complete identity, including ctime and owner. */
export async function compareLinuxFiles(root: string, files: PackageFile[], prior?: TreeEntry[]): Promise<TreeEntry[]> {
  validatePackageFiles(files);
  const manifest = treeManifest(root), table = new Map(files.map(f => [f.path.slice('opt/google/chrome/'.length), f]));
  if (manifest.some(e => e.type === 'link') || manifest.filter(e => e.type === 'file').length !== files.length) refuse('Unlisted package file');
  if (prior && !sameManifest(prior, manifest)) refuse('Package identity changed');
  for (const entry of manifest.filter(e => e.type === 'file')) {
    const expected = table.get(entry.path);
    if (!expected || expected.mode !== entry.mode) refuse('Package mode changed');
    if (!prior || ['chrome', 'chrome-sandbox'].includes(entry.path)) if (fileSha256(join(root, entry.path)) !== expected.sha256) refuse('Package bytes changed');
  }
  if (!sameManifest(manifest, treeManifest(root))) refuse('Package changed while checking');
  return manifest;
}
type ProvenanceOptions = { packageVersion: string; architecture: string; workDir: string; keyring: string; armoredKey?: string; run: ToolRun; fetch: ChromeFetch };
function packageVersion(version: string): void { if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}-\d+$/.test(version)) refuse('Expected the stable package version'); }
async function checkKey(o: ProvenanceOptions): Promise<void> {
  const result = await o.run('/usr/bin/gpg', ['--batch', '--no-options', '--homedir', o.workDir, '--with-colons', '--show-keys', o.keyring]);
  const lines = result.stdout.split('\n'); const primaries: string[] = [];
  let primary = false;
  for (const line of lines) {
    const parts = line.split(':');
    if (parts[0] === 'pub') primary = true;
    else if (parts[0] === 'sub') primary = false;
    else if (parts[0] === 'fpr' && primary) { primaries.push(parts[9]); primary = false; }
  }
  if (primaries.length !== 1 || primaries[0] !== GOOGLE_LINUX_FINGERPRINT) refuse('Google full key fingerprint required');
}
async function fetchRepository(o: ProvenanceOptions, url: string): Promise<Buffer> {
  if (!url.startsWith('https://dl.google.com/linux/chrome/')) refuse('Google HTTPS repository required');
  try { return await o.fetch(url); } catch { throw new LinuxChromeError('linux_repo_unreachable', 'Update Google Chrome, then try again.'); }
}
/** gpgv authenticates InRelease first; neither apt-cache nor a local package
 * database establishes provenance. No package is installed or executed. */
export async function authenticateDeb(o: ProvenanceOptions & { unpackDeb: (file: string) => Promise<PackageFile[]>; cachedInRelease?: Buffer }): Promise<PackageFile[]> {
  packageVersion(o.packageVersion);
  if (!['amd64', 'arm64'].includes(o.architecture)) refuse('Unsupported package architecture');
  await checkKey(o);
  const base = 'https://dl.google.com/linux/chrome/deb/';
  const release = o.cachedInRelease ?? await fetchRepository(o, `${base}dists/stable/InRelease`);
  const releaseFile = join(o.workDir, 'InRelease'); writeFileSync(releaseFile, release, { mode: 0o600, flag: 'wx' });
  const signature = await o.run('/usr/bin/gpgv', ['--homedir', o.workDir, '--output', '-', '--status-fd', '2', '--keyring', o.keyring, releaseFile]);
  const sigs = `${signature.stdout}\n${signature.stderr}`.split('\n').filter(l => l.startsWith('[GNUPG:] VALIDSIG '));
  if (!sigs.some(l => { const fields = l.trim().split(/\s+/); return fields[2] === GOOGLE_LINUX_FINGERPRINT || fields.at(-1) === GOOGLE_LINUX_FINGERPRINT; })) refuse('Google InRelease signature required');
  const text = signature.stdout;
  const block = text.match(/^SHA256:\r?\n((?:[ \t]+[^\n]+\n?)+)/m)?.[1];
  const expectedPath = `main/binary-${o.architecture}/Packages`;
  const matches = (block ?? '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[2] === expectedPath);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0][0])) refuse('Packages SHA-256 missing');
  const packages = await fetchRepository(o, `${base}dists/stable/${expectedPath}`);
  if (packages.length !== Number(matches[0][1]) || sha256(packages) !== matches[0][0]) refuse('Packages SHA-256 mismatch');
  const entries = packages.toString('utf8').split(/\r?\n\r?\n/).map(block => {
    const row: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) { const m = line.match(/^([A-Za-z0-9-]+): (.*)$/); if (m) { if (m[1] in row) refuse('Duplicate package field'); row[m[1]] = m[2]; } }
    return row;
  }).filter(p => p.Package === 'google-chrome-stable' && p.Version === o.packageVersion && p.Architecture === o.architecture);
  if (!entries.length) throw new LinuxChromeError('linux_repo_unreachable', 'Update Google Chrome, then try again.');
  if (entries.length !== 1) refuse('Ambiguous stable package');
  const entry = entries[0];
  if (!/^pool\/[A-Za-z0-9_./+-]+\.deb$/.test(entry.Filename ?? '') || entry.Filename.split('/').some(p => p === '..') || !/^[a-f0-9]{64}$/.test(entry.SHA256 ?? '')) refuse('Invalid package reference');
  const deb = await fetchRepository(o, `${base}${entry.Filename}`);
  if (deb.length !== Number(entry.Size) || sha256(deb) !== entry.SHA256) refuse('Deb SHA-256 mismatch');
  const file = join(o.workDir, 'chrome.deb'); writeFileSync(file, deb, { flag: 'wx', mode: 0o600 });
  return validatePackageFiles(await o.unpackDeb(file));
}
export async function authenticateRpm(o: ProvenanceOptions & { rpmUrl: string }): Promise<PackageFile[]> {
  packageVersion(o.packageVersion); await checkKey(o);
  if (o.armoredKey) await checkKey({ ...o, keyring: o.armoredKey });
  const url = new URL(o.rpmUrl);
  if (url.origin !== 'https://dl.google.com' || !/^\/linux\/chrome\/rpm\/stable\/[^/]+\/[^/]+\.rpm$/.test(url.pathname) || url.search || url.hash) refuse('Exact Google RPM URL required');
  const rpm = join(o.workDir, 'chrome.rpm'); writeFileSync(rpm, await fetchRepository(o, url.href), { flag: 'wx', mode: 0o600 });
  const database = join(o.workDir, 'rpm-keyring'); mkdirSync(database, { mode: 0o700 });
  await o.run('/usr/bin/rpm', ['--dbpath', database, '--initdb']);
  await o.run('/usr/bin/rpm', ['--dbpath', database, '--import', o.armoredKey ?? o.keyring]);
  const verified = await o.run('/usr/bin/rpmkeys', ['--dbpath', database, '--checksig', rpm]);
  if (!/\bdigests signatures OK\s*$/m.test(verified.stdout) || /NOKEY|NOT OK|NOTTRUSTED|UNSIGNED/i.test(`${verified.stdout}\n${verified.stderr}`)) refuse('Google RPM signature required');
  const header = await o.run('/usr/bin/rpm', ['--dbpath', database, '-qp', '--qf', '%{NAME}\n%{VERSION}-%{RELEASE}\n%{FILEDIGESTALGO}\n', rpm]);
  if (header.stdout.trim() !== `google-chrome-stable\n${o.packageVersion}\n8`) refuse('Stable RPM identity and SHA-256 required');
  const dump = await o.run('/usr/bin/rpm', ['--dbpath', database, '-qp', '--dump', rpm]);
  const files: PackageFile[] = [];
  for (const line of dump.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/); if (!fields[0].startsWith('/opt/google/chrome/')) continue;
    const mode = Number.parseInt(fields[4], 8);
    if ((mode & 0o170000) === 0o040000) continue;
    if ((mode & 0o170000) !== 0o100000 || fields[5] !== 'root' || fields[6] !== 'root' || fields[10] !== 'X') refuse('Unexpected RPM file kind');
    files.push({ path: fields[0].slice(1), sha256: fields[3], mode: mode & 0o7777 });
  }
  return validatePackageFiles(files);
}
