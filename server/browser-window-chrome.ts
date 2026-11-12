import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nativeAuthenticodeIn } from './browser-windows-identity.ts';
import { extractChromeZip, readChromeVersion, readDebTar, type ChromeCandidate } from './browser-window-files.ts';
import { fileSha256, identity, inside, privateDirectory, sameManifest, treeManifest, type TreeEntry } from './browser-window-identity.ts';
import { assertGoogleLinuxPath, authenticateDeb, authenticateRpm, compareLinuxFiles, LinuxChromeError, validatePackageFiles, type ChromeFetch, type PackageFile, type ToolRun } from './browser-window-linux.ts';
import { GOOGLE_LINUX_KEY_ARMORED, GOOGLE_LINUX_KEYRING_BASE64 } from './browser-window-google-key.ts';
import { isChromeVersion, validateWindowChromeList, WINDOW_CHROME_VALIDATED, type WindowChromePlatform, type WindowChromeValidation } from './browser-window-validated.ts';
export type WindowChrome = { kind: 'installed' | 'cft'; executable: string; version: string; major: number; platform: WindowChromePlatform; evidence: string };
export type WindowChromeCause = 'no_display' | 'cloud_home' | 'not_installed' | 'org_managed' | 'unverified' | 'version_not_checked' | 'linux_not_google_package' | 'linux_repo_unreachable' | 'download_needed' | 'download_failed' | 'sandbox_blocked' | 'recheck_needed' | 'linux_evidence_needed';
export type WindowChromeResult = { ok: WindowChrome } | { cause: WindowChromeCause; detail: string };
export const WINDOW_CHROME_CAUSES: Record<WindowChromeCause, string> = {
  cloud_home: 'Pop out view is ready for this Cloud home.',
  no_display: 'Pop out view is ready here. A Chrome window needs a desktop screen.',
  not_installed: 'Pop out view is ready. A Chrome window needs a checked Google Chrome installation.',
  org_managed: 'Your organization manages Chrome. Pop out view is ready.',
  unverified: 'Pop out view is ready. Murage needs a verified Google Chrome for a separate window.',
  version_not_checked: "This Chrome version hasn't been checked with Murage yet. Pop out view still works.",
  linux_not_google_package: 'Install Google Chrome stable from Google to use a Chrome window. Pop out view is ready.',
  linux_repo_unreachable: 'Update Google Chrome, then try again.',
  download_needed: 'Download Chrome for Murage (about 200 MB, 600 MB on disk)',
  download_failed: 'Pop out view is ready. Tap Download Chrome for Murage to try again.',
  sandbox_blocked: 'Ask your administrator to allow the Google Chrome sandbox. Pop out view is ready.',
  recheck_needed: 'Murage needs to check Chrome again. Tap Open in Chrome window.',
  linux_evidence_needed: 'Murage needs to check this Chrome with Google once, about 110 MB.',
};
export const windowChromeCause = (cause: WindowChromeCause): WindowChromeResult => ({ cause, detail: WINDOW_CHROME_CAUSES[cause] });
export const GOOGLE_CODESIGN_REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';
export type ChromeDependencies = {
  candidates?: () => ChromeCandidate[];
  readVersion?: (platform: WindowChromePlatform, candidate: ChromeCandidate) => string;
  run?: ToolRun;
  fetch?: ChromeFetch;
  authenticode?: (path: string) => Promise<unknown>;
  policy?: () => Promise<boolean>;
  extractZip?: typeof extractChromeZip;
  grant?: (root: string) => Promise<void>;
};
export type WindowChromeOptions = { mode: 'prepare' | 'local'; platform?: WindowChromePlatform; arch?: string; env?: NodeJS.ProcessEnv; dataDir?: string; validated?: WindowChromeValidation; deps?: ChromeDependencies };
type ResolverOptions = Omit<WindowChromeOptions, 'mode'>;
type LinuxRecord = { packageVersion: string; format: 'deb' | 'rpm'; database: string; databaseIdentity: string; files: PackageFile[]; manifest: TreeEntry[] };
type VerifiedRecord = { chrome: WindowChrome; candidate: ChromeCandidate; manifest: TreeEntry[]; linux?: LinuxRecord; cftHashes?: Record<string, string> };
const runTool: ToolRun = (file, args) => new Promise((done, reject) => execFile(file, [...args], withHideInherit({ encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }), (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : done({ stdout, stderr })));
const runBytes = (file: string, args: string[]): Promise<Buffer> => new Promise((done, reject) => execFile(file, [...args], withHideInherit({ encoding: 'buffer', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 * 1024 }), (error, stdout) => error ? reject(error) : done(stdout)));
/** No redirects: a pin never authorizes a different origin, including a redirect
 * to a local endpoint. Actual transferred bytes are bounded as well as headers. */
export const fetchChromeBytes: ChromeFetch = async url => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['dl.google.com', 'storage.googleapis.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('Chrome HTTPS origin required');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error('Chrome download unavailable');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 350 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Chrome download size limit'); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
};
function installedCandidates(platform: WindowChromePlatform, env: NodeJS.ProcessEnv): ChromeCandidate[] {
  if (platform === 'darwin') return ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')].map(root => ({ root, executable: join(root, 'Contents', 'MacOS', 'Google Chrome') }));
  if (platform === 'win32') return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((p): p is string => Boolean(p)).map(base => { const root = join(base, 'Google', 'Chrome', 'Application'); return { root, executable: join(root, 'chrome.exe') }; });
  return [{ root: '/opt/google/chrome', executable: '/opt/google/chrome/chrome' }];
}
function boundExecutable(candidate: ChromeCandidate): string {
  const executable = realpathSync(candidate.executable);
  if (!inside(candidate.root, executable) || !lstatSync(executable).isFile()) throw new Error('Chrome executable leaves the verified tree');
  return executable;
}
function hashes(root: string, manifest: TreeEntry[]): Record<string, string> { return Object.fromEntries(manifest.filter(e => e.type === 'file').map(e => [e.path, fileSha256(join(root, e.path))])); }
function readPrivateRecord(file: string): string {
  const directory = dirname(file), stat = lstatSync(directory), record = lstatSync(file);
  if (!stat.isDirectory() || !record.isFile() || realpathSync(directory) !== directory || record.size > 16 * 1024 * 1024 || (process.platform !== 'win32' && ((stat.mode & 0o077) || (record.mode & 0o077) || stat.uid !== process.getuid?.() || record.uid !== process.getuid?.()))) throw new Error('Chrome evidence needs private files');
  return readFileSync(file, 'utf8');
}
function dbIdentity(file: string): string { return lstatSync(file).isDirectory() ? JSON.stringify(treeManifest(file)) : identity(lstatSync(file, { bigint: true })); }
function linuxSandbox(): boolean {
  // Google's setuid helper works independently of unprivileged user namespaces.
  // Never add a sandbox-disabling flag. S2 owns the actual launch result.
  try { const stat = lstatSync('/opt/google/chrome/chrome-sandbox'); if (stat.isFile() && stat.uid === 0 && (stat.mode & 0o4777) === 0o4755) return true; } catch { /* check user namespaces */ }
  try {
    if (Number(readFileSync('/proc/sys/user/max_user_namespaces', 'utf8')) <= 0) return false;
    if (existsSync('/proc/sys/kernel/unprivileged_userns_clone') && readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim() !== '1') return false;
    if (existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') && readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() !== '0') return false;
    return true;
  } catch { return false; }
}
export function createWindowChromeResolver(options: ResolverOptions = {}) {
  const platform = options.platform ?? process.platform as WindowChromePlatform, env = options.env ?? process.env, arch = options.arch ?? process.arch;
  const dataDir = resolve(options.dataDir ?? env.MURAGE_DATA_DIR ?? join(homedir(), '.murage'));
  const deps = options.deps ?? {}, run: ToolRun = (file, args) => (deps.run ?? runTool)(file, args), fetchBytes: ChromeFetch = url => (deps.fetch ?? fetchChromeBytes)(url);
  // Keep the list release-owned. A CLI test list is passed only to its private resolver.
  const validated = validateWindowChromeList(options.validated ?? WINDOW_CHROME_VALIDATED);
  const records = new Map<string, VerifiedRecord>();
  const prerequisite = (): WindowChromeResult | null => env.MURAGE_CLOUD_ROLE === 'home' ? windowChromeCause('cloud_home') : platform === 'linux' && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim() ? windowChromeCause('no_display') : !validated[platform] ? windowChromeCause('version_not_checked') : null;
  const target = platform === 'darwin' ? arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : '' : platform === 'win32' ? arch === 'x64' ? 'win64' : arch === 'ia32' ? 'win32' : '' : '';
  const pin = () => platform !== 'linux' && target && validated[platform]?.cft?.sha256[target] ? validated[platform].cft : null;
  const cftDir = (version: string) => join(dataDir, 'browser-window', 'cft', version);
  const cftCandidate = (directory: string): ChromeCandidate => platform === 'darwin'
    ? { root: join(directory, 'payload'), signatureRoot: join(directory, 'payload', `chrome-${target}`, 'Google Chrome for Testing.app'), versionFile: join(directory, 'payload', `chrome-${target}`, 'Google Chrome for Testing.app', 'Contents', 'Info.plist'), executable: join(directory, 'payload', `chrome-${target}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') }
    : { root: join(directory, 'payload'), executable: join(directory, 'payload', `chrome-${target}`, 'chrome.exe') };
  async function organizationManaged(): Promise<boolean> {
    if (deps.policy) return deps.policy();
    if (platform === 'win32') {
      const systemRoot = env.SystemRoot && /^[A-Za-z]:\\[^"\x00-\x1f]+$/.test(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows';
      // OpenSubKey returns null only for an absent key; access/security and
      // tool failures throw. reg.exe conflates those conditions in exit 1 and
      // localizes its diagnostic, so it cannot establish absence reliably.
      const script = "$ErrorActionPreference='Stop'; $base=$null; $key=$null; try { $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64); $key=$base.OpenSubKey('SOFTWARE\\Policies\\Google\\Chrome',$false); if ($null -eq $key) { [Console]::Out.WriteLine('absent'); exit 2 }; [Console]::Out.WriteLine('present'); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 3 } finally { if ($null -ne $key) { $key.Dispose() }; if ($null -ne $base) { $base.Dispose() } }";
      try {
        const result = await run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
        if (result.stdout.trim() !== 'present' || result.stderr.trim()) throw new Error('Chrome policy check did not complete');
        return true;
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        if (e.code === 2 && e.stdout?.trim() === 'absent' && e.stderr === '') return false;
        throw error;
      }
    }
    if (platform === 'darwin') return existsSync('/Library/Managed Preferences/com.google.Chrome.plist') || existsSync(join(homedir(), 'Library', 'Managed Preferences', 'com.google.Chrome.plist'));
    return existsSync('/etc/opt/chrome/policies/managed') && readdirSync('/etc/opt/chrome/policies/managed').some(name => name.endsWith('.json'));
  }
  async function trust(candidate: ChromeCandidate): Promise<void> {
    if (platform === 'darwin') {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate.signatureRoot ?? candidate.root]);
      await run('/usr/bin/codesign', ['-v', `-R=${GOOGLE_CODESIGN_REQUIREMENT}`, candidate.signatureRoot ?? candidate.root]);
      const notarization = await run('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', candidate.signatureRoot ?? candidate.root]);
      const answer = `${notarization.stdout}\n${notarization.stderr}`;
      if (!/(?:^|:\s*)accepted\s*$/m.test(answer) || !/^source=Notarized Developer ID\s*$/m.test(answer)) throw new Error('Notarized Google Chrome required');
    } else if (platform === 'win32') {
      const native = deps.authenticode ?? nativeAuthenticodeIn(env.MURAGE_RESOURCES_PATH ?? env.OMB_RESOURCES_PATH)?.authenticode;
      if (!native) throw new Error('Chrome native signer check required');
      let count = 0;
      for (const entry of treeManifest(candidate.root).filter(e => e.type === 'file')) {
        const file = join(candidate.root, entry.path);
        // Every PE, regardless of extension; extensions cannot hide a renamed image.
        if (readFileSync(file).subarray(0, 2).toString('ascii') !== 'MZ') continue;
        const signature = await native(file) as { status?: string; subject?: string; organization?: string; thumbprint?: string };
        if (signature?.status !== 'Valid' || signature.organization !== 'Google LLC' || typeof signature.subject !== 'string' || !/(?:^|,\s*)O=Google LLC(?:,|$)/.test(signature.subject) || !/^[a-f0-9]{64}$/i.test(signature.thumbprint ?? '')) throw new Error('Google leaf signer required');
        count++;
      }
      if (!count) throw new Error('Chrome PE image required');
    }
  }
  function linuxEvidencePath(version: string) { return join(dataDir, 'browser-window', 'linux-evidence', `google-chrome-stable-${version}.json`); }
  function discardLinux(candidate: ChromeCandidate, record?: LinuxRecord): void {
    records.delete(candidate.root);
    if (record) rmSync(linuxEvidencePath(record.packageVersion), { force: true });
  }
  function cachedLinux(): LinuxRecord | undefined {
    const directory = join(dataDir, 'browser-window', 'linux-evidence');
    if (!existsSync(directory)) return;
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || realpathSync(directory) !== directory || (directoryStat.mode & 0o077)) return;
    for (const file of readdirSync(directory).filter(f => /^google-chrome-stable-\d+\.\d+\.\d+\.\d+-\d+\.json$/.test(f)).sort().reverse()) {
      try {
        const path = join(directory, file), s = lstatSync(path); if (!s.isFile() || s.size > 16 * 1024 * 1024 || (s.mode & 0o077)) continue;
        const record = JSON.parse(readPrivateRecord(path)) as LinuxRecord;
        if (!/^\d+\.\d+\.\d+\.\d+-\d+$/.test(record.packageVersion) || !['deb', 'rpm'].includes(record.format) || !['/var/lib/dpkg/status', '/var/lib/rpm', '/usr/lib/sysimage/rpm'].includes(record.database)) continue;
        validatePackageFiles(record.files);
        if (record.databaseIdentity === dbIdentity(record.database)) return record;
        rmSync(path, { force: true });
      } catch { /* no authenticated cache for the current package database */ }
    }
  }
  async function linuxMetadata(mode: 'prepare' | 'local', prior?: LinuxRecord): Promise<Omit<LinuxRecord, 'files' | 'manifest'> | null> {
    if (prior && prior.databaseIdentity === dbIdentity(prior.database)) return prior;
    if (existsSync('/var/lib/dpkg/status')) {
      const database = '/var/lib/dpkg/status', text = readFileSync(database, 'utf8');
      const rows = text.split(/\n\n/).filter(p => /^Package: google-chrome-stable$/m.test(p) && /^Status: install ok installed$/m.test(p));
      const packageVersion = rows.length === 1 ? rows[0].match(/^Version: (\d+\.\d+\.\d+\.\d+-\d+)$/m)?.[1] : null;
      if (packageVersion) return { packageVersion, format: 'deb', database, databaseIdentity: dbIdentity(database) };
    }
    if (mode === 'local') return null;
    const database = ['/usr/lib/sysimage/rpm', '/var/lib/rpm'].find(existsSync); if (!database) return null;
    const answer = await run('/usr/bin/rpm', ['-qf', '/opt/google/chrome/chrome', '--qf', '%{NAME}\n%{VERSION}-%{RELEASE}\n']);
    const [name, packageVersion] = answer.stdout.trim().split('\n');
    if (name !== 'google-chrome-stable' || !/^\d+\.\d+\.\d+\.\d+-\d+$/.test(packageVersion)) throw new LinuxChromeError('linux_not_google_package', 'Stable package required');
    return { packageVersion, format: 'rpm', database, databaseIdentity: dbIdentity(database) };
  }
  async function verifyLinux(candidate: ChromeCandidate, mode: 'prepare' | 'local', metadata: Omit<LinuxRecord, 'files' | 'manifest'>, prior?: LinuxRecord): Promise<LinuxRecord> {
    assertGoogleLinuxPath(candidate.executable);
    if (prior && prior.packageVersion === metadata.packageVersion && prior.databaseIdentity === metadata.databaseIdentity) {
      try { const manifest = await compareLinuxFiles(candidate.root, prior.files, prior.manifest); return { ...metadata, files: prior.files, manifest }; }
      catch (error) {
        discardLinux(candidate, prior);
        if (mode === 'local') throw error;
        // Preparation is outside the gate: discard stale identities and rebuild
        // the signed package chain now, rather than requiring a failed retry.
      }
    }
    if (mode === 'local') throw new Error('Local provenance needs a prepared record');
    if (metadata.format === 'deb') {
      const owner = await run('/usr/bin/dpkg-query', ['-S', candidate.executable]);
      if (owner.stdout.trim() !== 'google-chrome-stable: /opt/google/chrome/chrome') throw new LinuxChromeError('linux_not_google_package', 'Stable package required');
    }
    const base = join(dataDir, 'browser-window'); privateDirectory(base); const work = mkdtempSync(join(base, 'linux-check-'));
    try {
      const keyring = join(work, 'google.gpg'), armoredKey = join(work, 'google.asc');
      writeFileSync(keyring, Buffer.from(GOOGLE_LINUX_KEYRING_BASE64, 'base64'), { mode: 0o600, flag: 'wx' }); writeFileSync(armoredKey, GOOGLE_LINUX_KEY_ARMORED, { mode: 0o600, flag: 'wx' });
      const common = { ...metadata, architecture: arch === 'x64' ? 'amd64' : 'arm64', workDir: work, keyring, armoredKey, run, fetch: fetchBytes };
      const aptRelease = '/var/lib/apt/lists/dl.google.com_linux_chrome_deb_dists_stable_InRelease';
      let cachedInRelease: Buffer | undefined;
      try { const stat = lstatSync(aptRelease); if (stat.isFile() && stat.size <= 8 * 1024 * 1024) cachedInRelease = readFileSync(aptRelease); } catch { /* fetch the signed release when apt has no copy */ }
      const files = metadata.format === 'deb' ? await authenticateDeb({ ...common, cachedInRelease, unpackDeb: async file => readDebTar(await runBytes('/usr/bin/dpkg-deb', ['--fsys-tarfile', file])) })
        : await authenticateRpm({ ...common, rpmUrl: `https://dl.google.com/linux/chrome/rpm/stable/${arch === 'x64' ? 'x86_64' : 'aarch64'}/google-chrome-stable-${metadata.packageVersion}.${arch === 'x64' ? 'x86_64' : 'aarch64'}.rpm` });
      const manifest = await compareLinuxFiles(candidate.root, files);
      if (metadata.databaseIdentity !== dbIdentity(metadata.database)) throw new Error('Package changed during verification');
      const record = { ...metadata, files, manifest }, file = linuxEvidencePath(metadata.packageVersion); privateDirectory(dirname(file));
      const temp = join(work, 'evidence.json'); writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temp, file);
      return record;
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  async function admit(candidate: ChromeCandidate, kind: 'installed' | 'cft', mode: 'prepare' | 'local', expectedVersion?: string, cftHashes?: Record<string, string>): Promise<WindowChromeResult> {
    const prior = records.get(candidate.root);
    let linux = prior?.linux;
    try {
      linux ??= platform === 'linux' ? cachedLinux() : undefined;
      if (linux && linux.databaseIdentity !== dbIdentity(linux.database)) {
        discardLinux(candidate, linux); linux = undefined;
      }
      const metadata = platform === 'linux' && !deps.readVersion ? await linuxMetadata(mode, linux) : null;
      const version = (deps.readVersion ? deps.readVersion(platform, candidate) : platform === 'linux' ? metadata?.packageVersion.split('-')[0] : readChromeVersion(platform, candidate));
      if (!version && platform === 'linux') return windowChromeCause(mode === 'local' ? 'linux_evidence_needed' : 'linux_not_google_package');
      if (!isChromeVersion(version) || (kind === 'installed' && !validated[platform].installedVersions.includes(version)) || (kind === 'cft' && (version !== pin()?.version || version !== expectedVersion))) return windowChromeCause('version_not_checked');
      const manifest = treeManifest(candidate.root), executable = boundExecutable(candidate);
      if (mode === 'local') {
        if (platform === 'linux' && !linux) return windowChromeCause('linux_evidence_needed');
        if (linux && !sameManifest(linux.manifest, manifest)) { discardLinux(candidate, linux); return windowChromeCause('recheck_needed'); }
        if (!prior) return windowChromeCause('recheck_needed');
        if (prior.chrome.version !== version || prior.chrome.executable !== executable || !sameManifest(prior.manifest, manifest)) { discardLinux(candidate, linux); return windowChromeCause('recheck_needed'); }
        if (platform === 'linux') {
          if (!metadata) return windowChromeCause('linux_evidence_needed');
          await verifyLinux(candidate, mode, metadata, linux);
          if (!linuxSandbox()) return windowChromeCause('sandbox_blocked');
        }
        return { ok: prior.chrome };
      }
      if (await organizationManaged()) return windowChromeCause('org_managed');
      if (kind === 'cft') {
        if (!cftHashes || JSON.stringify(hashes(candidate.root, manifest)) !== JSON.stringify(cftHashes)) return windowChromeCause('unverified');
      }
      if (platform === 'linux') {
        if (!metadata) return windowChromeCause('linux_not_google_package');
        linux = await verifyLinux(candidate, mode, metadata, linux);
        if (!linuxSandbox()) return windowChromeCause('sandbox_blocked');
      } else if (!prior || prior.chrome.version !== version || !sameManifest(prior.manifest, manifest)) await trust(candidate);
      if (!sameManifest(manifest, treeManifest(candidate.root)) || boundExecutable(candidate) !== executable) return windowChromeCause('recheck_needed');
      const chrome: WindowChrome = { kind, executable, version, major: Number(version.split('.')[0]), platform, evidence: `${kind === 'cft' ? 'Pinned Chrome for Testing' : 'Google Chrome'} ${version}; ${platform === 'linux' ? 'Google-signed stable package' : platform === 'darwin' ? 'Google signature and notarization' : 'trusted Google leaf signature'}; complete tree checked` };
      records.set(candidate.root, { chrome, candidate, manifest, linux, cftHashes }); return { ok: chrome };
    } catch (error) {
      // Cleanup failure must still refuse admission (for example read-only disk).
      try { discardLinux(candidate, linux); } catch { records.delete(candidate.root); }
      if (error instanceof LinuxChromeError) return windowChromeCause(error.cause);
      return windowChromeCause(mode === 'local' ? 'recheck_needed' : 'unverified');
    }
  }
  async function resolveChrome({ mode }: { mode: 'prepare' | 'local' }): Promise<WindowChromeResult> {
    const blocked = prerequisite(); if (blocked) return blocked;
    if (mode !== 'prepare' && mode !== 'local') return windowChromeCause('recheck_needed');
    const candidate = (deps.candidates?.() ?? installedCandidates(platform, env)).find(c => existsSync(c.executable));
    if (candidate) {
      // Shipped empty lists short-circuit even package metadata subprocesses.
      if (!validated[platform].installedVersions.length) return windowChromeCause('version_not_checked');
      const result = await admit(candidate, 'installed', mode);
      if ('cause' in result) records.delete(candidate.root);
      return result;
    }
    const selected = pin(); if (!selected) return windowChromeCause('not_installed');
    const directory = cftDir(selected.version), cached = cftCandidate(directory);
    if (!existsSync(cached.executable)) return windowChromeCause('download_needed');
    try {
      const record = JSON.parse(readPrivateRecord(join(directory, 'files.json'))) as { version: string; zipSha256: string; hashes: Record<string, string> };
      if (record.version !== selected.version || record.zipSha256 !== selected.sha256[target]) return windowChromeCause('unverified');
      const result = await admit(cached, 'cft', mode, selected.version, record.hashes);
      if ('cause' in result) records.delete(cached.root);
      return result;
    } catch { return windowChromeCause(mode === 'local' ? 'recheck_needed' : 'unverified'); }
  }
  let downloadInFlight: Promise<WindowChromeResult> | undefined;
  async function downloadOnce({ ownerRequested, onProgress }: { ownerRequested: boolean; onProgress: (progress: { phase: 'downloading' | 'checking' | 'ready'; bytes?: number }) => void }): Promise<WindowChromeResult> {
    const blocked = prerequisite(); if (blocked) return blocked;
    const selected = pin(); if (!selected) return windowChromeCause('not_installed');
    if (ownerRequested !== true) return windowChromeCause('download_needed');
    const base = join(dataDir, 'browser-window', 'cft'); let work: string | undefined;
    try {
      privateDirectory(base); work = mkdtempSync(join(base, '.download-')); onProgress({ phase: 'downloading' });
      const zip = join(work, 'chrome.zip'), bytes = await fetchBytes(`https://storage.googleapis.com/chrome-for-testing-public/${selected.version}/${target}/chrome-${target}.zip`);
      writeFileSync(zip, bytes, { mode: 0o600, flag: 'wx' });
      if (fileSha256(zip) !== selected.sha256[target]) return windowChromeCause('unverified');
      onProgress({ phase: 'checking', bytes: bytes.length }); await (deps.extractZip ?? extractChromeZip)(zip, join(work, 'payload'));
      const candidate = cftCandidate(work), manifest = treeManifest(candidate.root), fileHashes = hashes(candidate.root, manifest);
      const actual = deps.readVersion ? deps.readVersion(platform, candidate) : readChromeVersion(platform, candidate); if (actual !== selected.version) return windowChromeCause('unverified');
      if (await organizationManaged()) return windowChromeCause('org_managed');
      await trust(candidate);
      if (!sameManifest(manifest, treeManifest(candidate.root))) return windowChromeCause('recheck_needed');
      if (platform === 'win32') {
        if (deps.grant) await deps.grant(candidate.root);
        else { const { grantAppContainerRead } = await import('./browser-sandbox.ts'); await grantAppContainerRead(candidate.root, env.SystemRoot); }
      }
      // ACLs may update ctime; bytes and tree membership must remain pinned.
      if (JSON.stringify(hashes(candidate.root, treeManifest(candidate.root))) !== JSON.stringify(fileHashes)) return windowChromeCause('unverified');
      writeFileSync(join(work, 'files.json'), JSON.stringify({ version: selected.version, zipSha256: selected.sha256[target], hashes: fileHashes }), { mode: 0o600, flag: 'wx' });
      rmSync(zip); const destination = cftDir(selected.version);
      // Never replace an existing version in place. Its own verifier decides its
      // eligibility; a concurrent download cannot overwrite its checked files.
      if (existsSync(destination)) return resolveChrome({ mode: 'prepare' });
      renameSync(work, destination); work = undefined;
      const result = await resolveChrome({ mode: 'prepare' }); if ('ok' in result) onProgress({ phase: 'ready' });
      return result;
    } catch { return windowChromeCause('download_failed'); }
    finally { if (work) rmSync(work, { recursive: true, force: true }); }
  }
  return { resolve: resolveChrome, download: (input: Parameters<typeof downloadOnce>[0]) => {
    const blocked = prerequisite(); if (blocked) return Promise.resolve(blocked);
    if (!input.ownerRequested) return Promise.resolve(windowChromeCause(pin() ? 'download_needed' : 'not_installed'));
    if (!downloadInFlight) downloadInFlight = downloadOnce(input).finally(() => { downloadInFlight = undefined; }); return downloadInFlight;
  } };
}
// One resolver per process/data directory retains only fully verified records.
const resolvers = new Map<string, ReturnType<typeof createWindowChromeResolver>>();
function resolverFor(options: ResolverOptions) {
  if (options.deps || options.validated) return createWindowChromeResolver(options);
  const key = JSON.stringify([options.dataDir ?? options.env?.MURAGE_DATA_DIR ?? process.env.MURAGE_DATA_DIR, options.platform ?? process.platform, options.arch ?? process.arch, options.env ?? process.env]);
  let resolver = resolvers.get(key); if (!resolver) { resolver = createWindowChromeResolver(options); resolvers.set(key, resolver); } return resolver;
}
export async function resolveWindowChrome(options: WindowChromeOptions): Promise<WindowChromeResult> { return resolverFor(options).resolve({ mode: options.mode }); }
export async function downloadChromeForTesting(options: ResolverOptions & { ownerRequested: boolean; onProgress: Parameters<ReturnType<typeof createWindowChromeResolver>['download']>[0]['onProgress'] }): Promise<WindowChromeResult> { return resolverFor(options).download(options); }
