import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createFuigoIsolation, type FuigoIsolation } from "./fuigo-probe-isolation.ts";

const exec = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_TAR = 96 * 1024 * 1024;
const MAX_BINARY = 256 * 1024 * 1024;
export const FUIGO_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"] as const;
export interface FuigoProof { version: string; protocolVersion: 1; loadSession: true; sessionCreated: true }
export interface FuigoReceipt {
  schema: 1; instanceId: string; version: string; target: string; package: string; tarball: string;
  integrity: string; binarySha256: string; proof: FuigoProof; previousManagedCli?: string;
}
export type FuigoProbe = (cli: string, version: string | undefined, scratch: string) => Promise<FuigoProof>;
export function nativeFuigoVersion(value: string): string | null {
  return /^fuigo\s+(\d+\.\d+\.\d+)(?:\s+\([0-9a-f]{7,40}\))?\s*$/i.exec(value.trim())?.[1] ?? null;
}
export function supportedFuigoVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && match[1] === "1" && (Number(match[2]) > 0 || Number(match[3]) >= 9);
}
export function nativeFuigoTarget(bytes: Buffer): string | null {
  // Same executable formats staged by prepare-fuigo/prepare-cloudflared.
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    if (bytes.readUInt32LE(4) === 0x0100000c) return "darwin-arm64";
    if (bytes.readUInt32LE(4) === 0x01000007) return "darwin-x64";
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 0x3e) return "linux-x64";
  if (bytes.length >= 64 && bytes[0] === 77 && bytes[1] === 90) {
    const offset = bytes.readUInt32LE(60);
    if (offset <= bytes.length - 6 && bytes.subarray(offset, offset + 4).equals(Buffer.from("PE\0\0")) && bytes.readUInt16LE(offset + 4) === 0x8664) return "win32-x64";
  }
  return null;
}
async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maximum) throw new Error("Fuigo download was unavailable or exceeded its size limit.");
  const chunks: Buffer[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw new Error("Fuigo download exceeded its size limit.");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export async function latestFuigoVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${REGISTRY}/fuigo/latest`, { redirect: "error", signal: AbortSignal.timeout(15000) });
  const value = JSON.parse((await responseBytes(response, 1024 * 1024)).toString("utf8"));
  if (value.name !== "fuigo" || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) throw new Error("Fuigo update metadata did not identify a supported release version.");
  return value.version;
}
/** Extract only two exact regular entries; never unpack paths onto disk. */
export function nativeFuigoPackage(tgz: Buffer, target: string, version: string): Buffer {
  const tar = gunzipSync(tgz, { maxOutputLength: MAX_TAR });
  const wanted = `package/bin/${target.startsWith("win32-") ? "fuigo.exe" : "fuigo"}.br`;
  let compressed: Buffer | undefined, manifest: any;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/");
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw new Error("Fuigo archive contains an unsafe path.");
    const rawSize = field(124, 12).trim(); const size = /^[0-7]+$/.test(rawSize) ? parseInt(rawSize, 8) : NaN;
    const checksum = parseInt(field(148, 8), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || checksum !== actual) throw new Error("Fuigo archive is malformed.");
    if (name === wanted || name === "package/package.json") {
      if (header[156] !== 0 && header[156] !== 48) throw new Error("Fuigo archive entry must be a regular file.");
      const data = tar.subarray(offset + 512, offset + 512 + size);
      if (name === wanted) { if (compressed) throw new Error("Duplicate Fuigo binary."); compressed = data; }
      else { if (manifest !== undefined || size > 65536) throw new Error("Invalid Fuigo package identity."); manifest = JSON.parse(data.toString("utf8")); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const [platform, arch] = target.split("-");
  if (!compressed || manifest?.name !== `@fuigo/${target}` || manifest.version !== version || !Array.isArray(manifest.os) || !manifest.os.includes(platform) || !Array.isArray(manifest.cpu) || !manifest.cpu.includes(arch)) throw new Error("Fuigo package identity or target does not match.");
  const binary = brotliDecompressSync(compressed, { maxOutputLength: MAX_BINARY });
  if (nativeFuigoTarget(binary) !== target) throw new Error("Fuigo executable architecture does not match this computer.");
  return binary;
}
function probeEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "", HOME: home, USERPROFILE: home, FUIGO_HOME: join(home, "fuigo"), APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), TMPDIR: home, TEMP: home, TMP: home, NO_COLOR: "1", FUIGO_API_BASE_URL: "http://127.0.0.1:9" };
  if (process.platform === "win32") { if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; if (process.env.WINDIR) env.WINDIR = process.env.WINDIR; }
  return env;
}
export const probeNativeFuigo: FuigoProbe = async (cli, expectedVersion, scratch) => {
  const home = await mkdtemp(join(scratch, "probe-"));
  let cleanupSafe = true, isolation: FuigoIsolation | undefined;
  let proof: FuigoProof | undefined;
  try {
    const env = probeEnvironment(home);
    await mkdir(env.FUIGO_HOME!, { mode: 0o700 });
    // This random value belongs only to a synthetic local model, never a service.
    env.MURAGE_FUIGO_PROBE_KEY = randomUUID();
    env.FUIGO_TELEMETRY_ENABLED = "false";
    await writeFile(join(env.FUIGO_HOME!, "config.toml"), `[features]\nremote_fetch = false\n\n[model_providers.murage_native_probe]\nbase_url = "http://127.0.0.1:9/v1"\ncontext_window = 8192\nenv_key = "MURAGE_FUIGO_PROBE_KEY"\napi_backend = "chat_completions"\n\n[model.murage_native_probe]\nmodel = "murage-native-probe"\nmodel_provider = "murage_native_probe"\n`, { mode: 0o600, flag: "wx" });
    isolation = await createFuigoIsolation(cli, home, env);
    const { command, prefix } = isolation;
    let result;
    try { result = await exec(command, [...prefix, "--version"], { cwd: home, env, timeout: 15000, windowsHide: true, maxBuffer: 65536 }); }
    catch (error) {
      if ((error as { code?: unknown }).code === 72) throw Object.assign(new Error("Private Fuigo update isolation is unavailable. Keep the selected engine."), { code: "FUIGO_PROBE_UNQUALIFIED" });
      throw error;
    }
    const version = nativeFuigoVersion(result.stdout);
    if (!version || expectedVersion && version !== expectedVersion) throw new Error("Fuigo executable version did not match the verified release.");
    const child = spawn(command, [...prefix, "--permission-mode", "default", "--no-memory", "agent", "--no-leader", "-m", "murage_native_probe", "stdio"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    // Only the isolated synthetic probe can populate these bounded diagnostics.
    const diagnostic = { cause: "unknown", exitCode: null as number | null, signal: null as string | null, stderr: "", stdoutBytes: 0, stderrBytes: 0 };
    let stderrSample = "";
    const sanitize = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "")
      .split(env.MURAGE_FUIGO_PROBE_KEY!).join("[synthetic-key]").split(home).join("[probe-home]").split(cli).join("[candidate]")
      .replace(/(?:https?:\/\/)[^\s"']+/gi, "[url]")
      .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?").slice(-4096);
    child.once("exit", (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal; });
    let closed = false; child.once("close", () => { closed = true; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveProof, reject) => {
        let buffer = "", total = 0, requestId = 0, phase = "initialize", finished = false;
        const send = (method: string, params: unknown) => {
          phase = method; requestId++;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
        };
        const fail = (reason = "Fuigo ACP compatibility could not be verified. Keep the current engine.", rpcCode?: unknown, cause = "protocol") => {
          if (finished) return; finished = true;
          diagnostic.cause = cause;
          reject(Object.assign(new Error(reason), {
            code: "FUIGO_INCOMPATIBLE", probeMethod: phase,
            rpcCode: typeof rpcCode === "number" && Number.isSafeInteger(rpcCode) ? rpcCode : null,
            probeDiagnostic: diagnostic,
          }));
        };
        timer = setTimeout(() => fail(undefined, undefined, "timeout"), 20000);
        child.once("error", () => fail(undefined, undefined, "spawn")); child.once("close", () => fail(undefined, undefined, "child-close")); child.stdin.once("error", () => fail(undefined, undefined, "stdin"));
        child.stderr.on("data", chunk => { diagnostic.stderrBytes += chunk.length; stderrSample = (stderrSample + chunk.toString("utf8")).slice(0, 16384); diagnostic.stderr = sanitize(stderrSample); total += chunk.length; if (total > 512 * 1024) fail(undefined, undefined, "output-limit"); });
        child.stdout.on("data", chunk => {
          if (finished) return;
          diagnostic.stdoutBytes += chunk.length;
          total += chunk.length; if (total > 512 * 1024) { fail(undefined, undefined, "output-limit"); return; }
          buffer += chunk.toString("utf8");
          for (;;) {
            const newline = buffer.indexOf("\n"); if (newline < 0) break;
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
            let message: any; try { message = JSON.parse(line); } catch { fail(undefined, undefined, "stdout-json"); return; }
            if (message.method && message.id !== undefined) { fail(undefined, undefined, "server-request"); return; }
            if (message.id !== requestId) continue;
            if (message.jsonrpc !== "2.0" || message.error || !message.result) { fail("Fuigo refused the isolated ACP compatibility request. The release was not activated.", message.error?.code); return; }
            if (phase === "initialize") {
              if (message.result.protocolVersion !== 1 || message.result.agentCapabilities?.loadSession !== true || !Array.isArray(message.result.authMethods) || !message.result.authMethods.some((method: { id?: string }) => method?.id === "fuigo.api_key")) { fail("Fuigo does not advertise the required ACP 1 session-loading and isolated authentication capability. The release was not activated."); return; }
              send("authenticate", { methodId: "fuigo.api_key" });
            } else if (phase === "authenticate") {
              send("session/new", { cwd: home, mcpServers: [] });
            } else {
              if (typeof message.result.sessionId !== "string" || !message.result.sessionId) { fail(); return; }
              finished = true; resolveProof(); return;
            }
          }
        });
        send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      });
    } finally {
      clearTimeout(timer); child.stdin.end();
      await new Promise<void>((resolveExit, rejectExit) => {
        if (closed || !child.pid) { resolveExit(); return; }
        const stop = setTimeout(() => child.kill("SIGTERM"), 1000);
        const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        const limit = setTimeout(() => { cleanupSafe = false; rejectExit(Object.assign(new Error("Fuigo verification process cleanup is pending."), { code: "FUIGO_PROBE_CLEANUP" })); }, 5000);
        child.once("close", () => { clearTimeout(stop); clearTimeout(kill); clearTimeout(limit); resolveExit(); });
      });
    }
    proof = { version, protocolVersion: 1, loadSession: true, sessionCreated: true };
  } catch (error) {
    if ((error as { code?: unknown }).code === "FUIGO_PROBE_CLEANUP") cleanupSafe = false;
    throw error;
  } finally {
    try {
      await isolation?.cleanup();
    } catch (error) {
      cleanupSafe = false;
      throw error;
    } finally { if (cleanupSafe) await rm(home, { recursive: true, force: true }); }
  }
  if (!proof) throw Object.assign(new Error("Fuigo compatibility could not be verified."), { code: "FUIGO_INCOMPATIBLE" });
  return proof;
};
export async function managedFuigoReceipt(root: string, id: string, cli?: string): Promise<FuigoReceipt | null> {
  if (!cli || !/^[A-Za-z0-9][\w.-]{0,79}$/.test(id)) return null;
  try {
    const parent = await realpath(join(resolve(root), "fuigo", id)), path = resolve(cli);
    const parts = relative(parent, path).split(sep);
    if (parts.length !== 2 || !/^\d+\.\d+\.\d+-[0-9a-f-]+$/.test(parts[0]!) || !/^fuigo(?:\.exe)?$/.test(parts[1]!)) return null;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BINARY || await realpath(dirname(path)) !== dirname(path)) return null;
    const manifestPath = join(dirname(path), "manifest.json"), manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) return null;
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as FuigoReceipt;
    if (value.schema !== 1 || value.instanceId !== id || !supportedFuigoVersion(value.version) || !/^[a-f0-9]{64}$/.test(value.binarySha256) || value.proof?.version !== value.version || value.proof.protocolVersion !== 1 || !value.proof.loadSession || !value.proof.sessionCreated) return null;
    return value;
  } catch { return null; }
}
export async function stageNativeFuigo(options: { root: string; id: string; version: string; target: string; fetcher?: typeof fetch; probe?: FuigoProbe; previousManagedCli?: string }): Promise<string> {
  const { root, id, version, target } = options;
  if (!/^[A-Za-z0-9][\w.-]{0,79}$/.test(id) || !supportedFuigoVersion(version) || !(FUIGO_TARGETS as readonly string[]).includes(target)) throw new Error("This Fuigo release or platform is not supported by this Murage version.");
  const fetcher = options.fetcher ?? fetch, packageName = `@fuigo/${target}`;
  const tarball = `${REGISTRY}/@fuigo/${target}/-/${target}-${version}.tgz`;
  const response = await fetcher(`${REGISTRY}/${encodeURIComponent(packageName)}/${version}`, { redirect: "error", signal: AbortSignal.timeout(15000) });
  const metadata = JSON.parse((await responseBytes(response, 1024 * 1024)).toString("utf8"));
  const integrity = metadata.dist?.integrity;
  if (metadata.name !== packageName || metadata.version !== version || metadata.dist?.tarball !== tarball || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Fuigo release provenance could not be verified.");
  const archive = await responseBytes(await fetcher(tarball, { redirect: "error", signal: AbortSignal.timeout(90000) }), MAX_ARCHIVE);
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== integrity) throw new Error("Fuigo download checksum did not match. The current engine is unchanged.");
  const binary = nativeFuigoPackage(archive, target, version);
  const parent = join(root, "fuigo", id); await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(parent), `${version}-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
  const cli = join(directory, target.startsWith("win32-") ? "fuigo.exe" : "fuigo");
  try {
    await writeFile(cli, binary, { mode: 0o700, flag: "wx" }); if (!target.startsWith("win32-")) await chmod(cli, 0o700);
    const proof = await (options.probe ?? probeNativeFuigo)(cli, version, directory);
    if (proof.version !== version || proof.protocolVersion !== 1 || proof.loadSession !== true || proof.sessionCreated !== true) throw new Error("Fuigo protocol or version is incompatible with Murage.");
    const receipt: FuigoReceipt = { schema: 1, instanceId: id, version, target, package: packageName, tarball, integrity, binarySha256: createHash("sha256").update(binary).digest("hex"), proof, ...(options.previousManagedCli ? { previousManagedCli: options.previousManagedCli } : {}) };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
    return cli;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "FUIGO_PROBE_CLEANUP") await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function verifyManagedFuigo(root: string, id: string, cli: string, target: string, probe: FuigoProbe = probeNativeFuigo): Promise<void> {
  const receipt = await managedFuigoReceipt(root, id, cli);
  if (!receipt || receipt.target !== target) throw new Error("The previous managed Fuigo version could not be verified.");
  const binary = await readFile(cli);
  if (nativeFuigoTarget(binary) !== target || createHash("sha256").update(binary).digest("hex") !== receipt.binarySha256) throw new Error("The managed Fuigo executable has changed. Keep the current engine.");
  const proof = await probe(cli, receipt.version, dirname(cli));
  if (proof.version !== receipt.version || proof.protocolVersion !== 1 || !proof.loadSession || !proof.sessionCreated) throw new Error("The previous Fuigo version is incompatible with Murage.");
}
