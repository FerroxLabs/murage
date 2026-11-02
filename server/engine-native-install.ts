// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native vendor installs for Claude Code and Codex (ENGINE-SIGNIN simple path, Install). No shell, no PowerShell, no Node.
// Every fetch is HTTPS. Claude: the steps of the vendor's install.sh and install.ps1, read 11-01:
//   https://downloads.claude.ai/claude-code-releases/latest                         plain text, the version
//   https://downloads.claude.ai/claude-code-releases/<version>/manifest.json        platforms[<target>] = { binary, checksum, size }
//   https://downloads.claude.ai/claude-code-releases/<version>/<target>/claude[.exe]
//   then `<binary> install stable`, which puts the launcher in ~/.local/bin. The download is deleted.
// Codex: the release of the version the registry names. api.github.com lists each asset with its sha256 digest. Mac and Linux
// take codex-package-<target>.tar.gz, the asset the vendor's install.sh takes, and Windows the .exe.zip: both are the whole
// package, whose codex-package.json names the entrypoint, with rg, the sandbox helpers and resources beside it. The bare
// codex-<target>.tar.gz holds no rg and no bwrap, so it is not used. The package stays in place as it was built.
// A temporary download lives in a folder only the owner can read, inside Murage's own data folder, and leaves on every path.
// Nothing runs until its checksum has passed, and a file gets its execute bit only then.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as yauzl from "yauzl";
import { nativeFuigoTarget, readTarHeader } from "./fuigo-native-update.ts";

export const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const CODEX_RELEASES_API = "https://api.github.com/repos/openai/codex/releases/tags";
const CODEX_DOWNLOADS = "https://github.com/openai/codex/releases/download";
/** GitHub answers a release download with one redirect to its own asset store. That one hop, and nothing else. */
const GITHUB_ASSET_HOSTS: ReadonlySet<string> = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const CLAUDE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 512;
/** A download that sends nothing for this long is stopped. There is no limit on a slow one that keeps moving. */
const STALL_MS = 60_000;
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_PREFIX = "download-";

export interface NativeInstallProgress { phase: "download" | "check" | "install"; received: number; total: number }
export type NativeRun = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;
interface NativeInstallOptions {
  root: string; platform: NodeJS.Platform; arch: string; fetcher: typeof fetch; run: NativeRun; envPath?: string;
  onProgress?: (progress: NativeInstallProgress) => void;
}

export function versionFrom(value: string | null | undefined): string | null {
  return value?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/** The only names a vendor binary starts with. NODE_OPTIONS, ELECTRON_*, MURAGE_* and every other name stay out. */
const PASSED_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "windir", "LANG", "LC_ALL"] as const;
export function nativeInstallEnv(options: { path?: string; temp: string; source?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const env: NodeJS.ProcessEnv = { PATH: options.path ?? "", TMPDIR: options.temp, TMP: options.temp, TEMP: options.temp };
  for (const name of PASSED_ENV) { const value = source[name]; if (value) env[name] = value; }
  return env;
}

function https(url: string): string {
  if (new URL(url).protocol !== "https:") throw new Error("Engine downloads use HTTPS only.");
  return url;
}
async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maximum) throw new Error("Engine release metadata was unavailable.");
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw new Error("Engine release metadata exceeded its size limit.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Writes the body to a new owner-only file while hashing it. Refuses a wrong size at the first byte past it. */
async function saveVerified(response: Response, file: string, expected: { size: number; sha256: string }, stall: () => void, onBytes: (received: number) => void): Promise<void> {
  if (!response.ok || !response.body) throw new Error("The engine download was unavailable.");
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) !== expected.size) throw new Error("The engine download has the wrong size.");
  const hash = createHash("sha256");
  const output = await open(file, "wx", 0o600);
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      stall();
      received += value.byteLength;
      if (received > expected.size) throw new Error("The engine download has the wrong size.");
      hash.update(value);
      await output.writeFile(value);
      onBytes(received);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); await output.close(); }
  if (received !== expected.size) throw new Error("The engine download has the wrong size.");
  if (hash.digest("hex") !== expected.sha256) throw new Error("The engine download failed its checksum.");
}

/** One download with a stall limit around both the request and the body. */
async function download(start: (signal: AbortSignal) => Promise<Response>, file: string, expected: { size: number; sha256: string }, onBytes: (received: number) => void): Promise<void> {
  const control = new AbortController();
  let timer = setTimeout(() => control.abort(), STALL_MS);
  const stall = () => { clearTimeout(timer); timer = setTimeout(() => control.abort(), STALL_MS); };
  try { await saveVerified(await start(control.signal), file, expected, stall, onBytes); }
  finally { clearTimeout(timer); }
}

/** A folder for one install, removed on every path. */
async function withDownloadFolder<T>(root: string, work: (folder: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(await realpath(root), DOWNLOAD_PREFIX));
  await chmod(folder, 0o700);
  try { return await work(folder); }
  finally { await rm(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {}); }
}
/** What a crash or a power cut left behind. Called with no install running. */
export async function clearDownloads(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(names.filter(name => name.startsWith(DOWNLOAD_PREFIX))
    .map(name => rm(join(root, name), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {})));
}

const linuxIsMusl = (arch: string): boolean => existsSync(`/lib/libc.musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`);
/** The vendor's name for this computer, the way install.sh and install.ps1 work it out. Null when it lists none. */
export function claudeNativeTarget(platform: NodeJS.Platform, arch: string, musl: (arch: string) => boolean = linuxIsMusl): string | null {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform === "darwin" || platform === "win32") return `${platform}-${arch}`;
  if (platform === "linux") return `linux-${arch}${musl(arch) ? "-musl" : ""}`;
  return null;
}

/** Downloads, checks and installs Claude Code. Returns the version downloaded; the launcher is Claude's own from here. */
export async function installClaudeNative(options: NativeInstallOptions): Promise<string> {
  const { root, platform, arch, fetcher, run } = options;
  const target = claudeNativeTarget(platform, arch);
  if (!target) throw new Error("Claude Code has no native build for this computer.");
  const metadata = (url: string, maximum: number) => fetcher(https(url), { redirect: "error", signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }).then(response => boundedText(response, maximum));
  const version = (await metadata(`${CLAUDE_RELEASES}/latest`, 256)).trim();
  if (!CLAUDE_VERSION.test(version)) throw new Error("The release service named an unsupported version.");
  const manifest = JSON.parse(await metadata(`${CLAUDE_RELEASES}/${version}/manifest.json`, 1024 * 1024)) as { version?: unknown; platforms?: Record<string, { checksum?: unknown; size?: unknown } | undefined> };
  const row = manifest.platforms && Object.hasOwn(manifest.platforms, target) ? manifest.platforms[target] : undefined;
  const sha256 = row?.checksum, size = row?.size;
  if (manifest.version !== version || typeof sha256 !== "string" || !SHA256.test(sha256) || !Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_DOWNLOAD)
    throw new Error("The release manifest does not list this computer.");
  const total = size as number, windows = platform === "win32";
  return withDownloadFolder(root, async (folder) => {
    const binary = join(folder, windows ? "claude.exe" : "claude");
    options.onProgress?.({ phase: "download", received: 0, total });
    await download(signal => fetcher(https(`${CLAUDE_RELEASES}/${version}/${target}/${windows ? "claude.exe" : "claude"}`), { redirect: "error", signal }),
      binary, { size: total, sha256 }, received => options.onProgress?.({ phase: "download", received, total }));
    options.onProgress?.({ phase: "install", received: total, total });
    // The checksum passed above. Only now can this file run.
    if (!windows) await chmod(binary, 0o700);
    await run(binary, ["install", "stable"], folder, nativeInstallEnv({ path: options.envPath, temp: folder }));
    return version;
  });
}

const CODEX_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
});
export const codexNativeTarget = (platform: NodeJS.Platform, arch: string): string | null => CODEX_TARGETS[`${platform}-${arch}`] ?? null;

interface CodexAsset { url: string; size: number; sha256: string }
async function codexAsset(version: string, name: string, fetcher: typeof fetch): Promise<CodexAsset> {
  const tag = `rust-v${version}`;
  const response = await fetcher(https(`${CODEX_RELEASES_API}/${tag}`), { redirect: "error", signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json", "user-agent": "Murage" } });
  const release = JSON.parse(await boundedText(response, 16 * 1024 * 1024)) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("The Codex release could not be verified.");
  const found = (release.assets as Array<{ name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }>).filter(asset => asset?.name === name);
  const url = `${CODEX_DOWNLOADS}/${tag}/${name}`, asset = found[0];
  const digest = typeof asset?.digest === "string" ? /^sha256:([a-f0-9]{64})$/.exec(asset.digest)?.[1] : undefined;
  if (found.length !== 1 || asset!.browser_download_url !== url || !digest || !Number.isSafeInteger(asset!.size) || (asset!.size as number) <= 0 || (asset!.size as number) > MAX_DOWNLOAD)
    throw new Error("The Codex release does not list this computer.");
  return { url, size: asset!.size as number, sha256: digest };
}

/** GitHub's one redirect, read by hand: HTTPS, its asset store, and no further hop. The digest then proves the bytes. */
async function githubAsset(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  const first = await fetcher(https(url), { redirect: "manual", signal });
  if (first.status < 300 || first.status >= 400) return first;
  await first.body?.cancel().catch(() => {});
  const location = new URL(first.headers.get("location") ?? "");
  if (location.protocol !== "https:" || !GITHUB_ASSET_HOSTS.has(location.hostname) || location.port || location.username) throw new Error("The Codex download redirected somewhere else.");
  return fetcher(location.href, { redirect: "error", signal });
}

const PACKAGE_SEGMENT = /^[\w+-][\w.+-]*$/;
/** Where one entry lands. A name that leaves `folder`, or an odd one, refuses the archive. */
function packagePath(folder: string, name: string): string {
  const destination = resolve(folder, name), inside = relative(folder, destination);
  if (!name.split("/").every(segment => PACKAGE_SEGMENT.test(segment)) || inside.startsWith("..") || inside.split(sep).includes("..")) throw new Error("The Codex archive has a file path outside its own folder.");
  return destination;
}

/** Streams the whole gzip tar package below `folder`. Every path is checked before it is written, a link or any entry that is not a
 *  plain file or folder refuses the archive, and files are owner-only; one marked executable by the vendor stays executable by the owner. */
export async function extractTarPackage(archive: string, folder: string): Promise<void> {
  const source = createReadStream(archive), gunzip = createGunzip();
  source.once("error", error => gunzip.destroy(error));
  let block = Buffer.alloc(0), remaining = 0, padding = 0, expanded = 0, entries = 0, ended = false;
  let output: FileHandle | undefined, written = "", executable = false;
  const finish = async () => {
    if (!output) return;
    await output.close(); output = undefined;
    if (executable) await chmod(written, 0o700);
  };
  try {
    for await (const chunk of source.pipe(gunzip) as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length;) {
        if (remaining > 0) {
          const part = chunk.subarray(at, at + remaining);
          await output?.writeFile(part);
          at += part.length; remaining -= part.length;
          if (remaining === 0) await finish();
        } else if (padding > 0) {
          const skip = Math.min(padding, chunk.length - at); at += skip; padding -= skip;
        } else if (ended) { break; } else {
          const part = chunk.subarray(at, at + 512 - block.length);
          block = Buffer.concat([block, part]); at += part.length;
          if (block.length < 512) continue;
          const header = block; block = Buffer.alloc(0);
          if (header.every(byte => byte === 0)) { ended = true; continue; }
          const entry = readTarHeader(header, "Codex");
          expanded += entry.size;
          if (++entries > MAX_ENTRIES || expanded > MAX_EXPANDED) throw new Error("The Codex archive exceeded its size limit.");
          if (entry.type === 49 || entry.type === 50) throw new Error("The Codex archive holds a link.");
          // The vendor's tar writes a pax record before each entry. It is skipped unread, so only the checked name below can place a file.
          if (entry.type === 120 || entry.type === 103) { remaining = entry.size; padding = (512 - entry.size % 512) % 512; continue; }
          const name = entry.name.replace(/\/$/, ""), destination = packagePath(folder, name);
          if (entry.type === 53 && entry.size === 0) { await mkdir(destination, { recursive: true, mode: 0o700 }); continue; }
          if (!entry.regular || entry.name.endsWith("/")) throw new Error("The Codex archive entry is not a plain file.");
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          output = await open(destination, "wx", 0o600);
          written = destination; executable = (parseInt(header.subarray(100, 108).toString("latin1"), 8) & 0o100) !== 0;
          remaining = entry.size; padding = (512 - entry.size % 512) % 512;
          if (remaining === 0) await finish();
        }
      }
    }
    if (remaining > 0 || padding > 0 || !ended) throw new Error("The Codex archive is incomplete.");
  } finally { await output?.close(); source.destroy(); }
}

/** Unpacks the whole Windows package below `folder`. A path that leaves it, a link, or an encrypted entry refuses the archive. */
export async function extractZipPackage(archive: string, folder: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((done, fail) => yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, opened) => error ? fail(error) : done(opened)));
  try {
    if (zip.entryCount < 1 || zip.entryCount > MAX_ENTRIES) throw new Error("The Codex archive has the wrong shape.");
    let expanded = 0;
    await new Promise<void>((done, fail) => {
      zip.once("error", fail);
      zip.once("end", done);
      zip.on("entry", (entry: yauzl.Entry) => void (async () => {
        const directory = entry.fileName.endsWith("/"), name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
        const destination = packagePath(folder, name);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000 || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) || entry.isEncrypted()) throw new Error("The Codex archive entry is not a plain file.");
        if (directory) { await mkdir(destination, { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED) throw new Error("The Codex archive exceeded its size limit.");
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const stream = await new Promise<Readable>((ready, refuse) => zip.openReadStream(entry, (error, opened) => error ? refuse(error) : ready(opened)));
        await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        zip.readEntry();
      })().catch(fail));
      zip.readEntry();
    });
  } finally { zip.close(); }
}

/** The package's own manifest names what runs. It has to match this release, and rg has to be there. */
async function packageEntrypoint(candidate: string, version: string, target: string, windows: boolean): Promise<string> {
  const entrypoint = windows ? `codex-${target}.exe` : "bin/codex";
  const meta = JSON.parse(await readFile(join(candidate, "codex-package.json"), "utf8")) as { version?: unknown; target?: unknown; entrypoint?: unknown; pathDir?: unknown };
  if (meta.version !== version || meta.target !== target || meta.entrypoint !== entrypoint || meta.pathDir !== "codex-path") throw new Error("The Codex package does not match its release.");
  const rg = await lstat(join(candidate, "codex-path", windows ? "rg.exe" : "rg"));
  if (!rg.isFile() || (!windows && (rg.mode & 0o100) === 0)) throw new Error("The Codex package has no rg.");
  return join(candidate, ...entrypoint.split("/"));
}

/** Downloads and checks one Codex release into its own new folder, and proves `--version` there. The caller activates it. */
export async function stageCodexNative(options: NativeInstallOptions & { version: string }): Promise<{ cli: string; candidate: string }> {
  const { root, version, platform, arch, fetcher, run } = options;
  const target = codexNativeTarget(platform, arch);
  if (!target) throw new Error("Codex has no native build for this computer.");
  const windows = platform === "win32", name = windows ? `codex-${target}.exe.zip` : `codex-package-${target}.tar.gz`;
  const asset = await codexAsset(version, name, fetcher);
  return withDownloadFolder(root, async (folder) => {
    const archive = join(folder, name), total = asset.size;
    options.onProgress?.({ phase: "download", received: 0, total });
    await download(signal => githubAsset(asset.url, fetcher, signal), archive, asset, received => options.onProgress?.({ phase: "download", received, total }));
    options.onProgress?.({ phase: "check", received: total, total });
    const candidate = await mkdtemp(join(await realpath(root), `codex-${version}-`));
    await chmod(candidate, 0o700);
    try {
      await (windows ? extractZipPackage(archive, candidate) : extractTarPackage(archive, candidate));
      const cli = await packageEntrypoint(candidate, version, target, windows);
      const stat = await lstat(cli);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The Codex executable is not a plain file.");
      const handle = await open(cli, "r");
      const head = Buffer.alloc(Math.min(4096, stat.size));
      try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
      if (nativeFuigoTarget(head) !== `${platform}-${arch}`) throw new Error("The Codex executable is for another computer.");
      if (!windows) await chmod(cli, 0o700);
      const home = join(folder, "home");
      for (const directory of ["appdata", "localappdata", "codex-home"]) await mkdir(join(home, directory), { recursive: true });
      const reported = await run(cli, ["--version"], candidate, { ...nativeInstallEnv({ path: options.envPath, temp: folder, source: { SystemRoot: process.env.SystemRoot, windir: process.env.windir } }),
        HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), CODEX_HOME: join(home, "codex-home") });
      if (versionFrom(reported) !== version) throw new Error("version mismatch");
      return { cli, candidate };
    } catch (error) { await rm(candidate, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {}); throw error; }
  });
}
