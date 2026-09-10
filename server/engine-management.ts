import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ManagedNpmUnavailable, verifiedWindowsCodexPath, windowsNpmCommand } from "./codex-managed-windows.ts";
import { FUIGO_TARGETS, latestFuigoVersion, managedFuigoReceipt, nativeFuigoTarget, probeNativeFuigo, stageNativeFuigo, supportedFuigoVersion, verifyManagedFuigo, type FuigoProbe } from "./fuigo-native-update.ts";

export interface ManagedEngineInstance {
  instanceId: string; driverKind: string; cli?: string;
  bundledCli?: string;
  defaultSource?: "path" | "bundled";
  snapshot: { state: string; version?: string | null };
}
export interface EngineManagementStatus {
  supported: boolean; installedVersion: string | null; latestVersion?: string;
  updateAvailable: boolean; message: string; busy: boolean;
  source?: "managed" | "bundled" | "path" | "custom" | "unknown";
  releaseSupported?: boolean; rollbackAvailable?: boolean; bundledAvailable?: boolean;
}
interface Dependencies {
  root: string;
  getInstance: (id: string) => Promise<ManagedEngineInstance | undefined>;
  isBusy: () => boolean;
  /** Persist the verified path and reload providers. Must atomically refuse active turns. */
  activate: (id: string, cli: string, expectedCli?: string | null) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
  envPath?: string;
  fetch?: typeof fetch;
  run?: (command: string, args: string[], cwd: string) => Promise<string>;
  fuigoProbe?: FuigoProbe;
}
const exec = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+$/;
export function versionFrom(value: string | null | undefined): string | null {
  return value?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}
function newer(a: string, b: string): boolean {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (aa[i] !== bb[i]) return aa[i]! > bb[i]!; }
  return false;
}
/** Fixed registry/package identity; renderer supplies only instance ID and action.
 * Each candidate has its own prefix/cache/home. Existing CLI and user config are
 * untouched until --version succeeds and the caller's idle gate permits activation.
 */
export class EngineManager {
  private running = false;
  private versions = new Map<string, string>();
  private deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }
  private async instance(id: string) {
    const instance = await this.deps.getInstance(id);
    if (!instance) throw new Error("Engine not found. Refresh Settings and try again.");
    return instance;
  }
  private supported(instance: ManagedEngineInstance) {
    const platform=this.deps.platform??process.platform;
    if (instance.driverKind === "fuigo") return platform === "darwin" && (FUIGO_TARGETS as readonly string[]).includes(`${platform}-${this.deps.arch ?? process.arch}`);
    return instance.driverKind === "codex" && (["darwin", "linux"].includes(platform)
      ||platform==="win32"&&(this.deps.arch??process.arch)==="x64");
  }
  async status(id: string): Promise<EngineManagementStatus> {
    const instance = await this.instance(id);
    const installedVersion = versionFrom(instance.snapshot.version);
    const latestVersion = this.versions.get(instance.driverKind);
    if (instance.driverKind === "fuigo") {
      const receipt = await managedFuigoReceipt(this.deps.root, id, instance.cli);
      const source = receipt ? "managed" : instance.cli && instance.cli !== "fuigo"
        ? instance.cli === instance.bundledCli ? "bundled" : "custom" : instance.defaultSource ?? "unknown";
      const supported = this.supported(instance), releaseSupported = latestVersion ? supportedFuigoVersion(latestVersion) : undefined;
      return { supported, installedVersion, latestVersion, source, releaseSupported, busy: this.running,
        updateAvailable: !!(latestVersion && installedVersion && newer(latestVersion, installedVersion)),
        rollbackAvailable: !!(receipt?.previousManagedCli && await managedFuigoReceipt(this.deps.root, id, receipt.previousManagedCli)),
        bundledAvailable: !!instance.bundledCli,
        message: !supported ? "Native Fuigo update isolation is not qualified on this platform. The selected engine is unchanged."
          : releaseSupported === false ? "The latest Fuigo release is outside this Murage version’s compatibility range. Keep the current engine."
          : source === "custom" || source === "path" || source === "unknown" ? "Your existing Fuigo selection is preserved. Choose Use managed Fuigo to opt in to verified native updates; no Node.js or npm is required."
          : "Fuigo updates independently of Murage. Native downloads are checksum, architecture and ACP-compatibility checked before use; no Node.js or npm is required." };
    }
    return { supported: this.supported(instance), installedVersion, latestVersion,
      updateAvailable: !!(latestVersion && installedVersion && newer(latestVersion, installedVersion)),
      busy: this.running,
      message: this.supported(instance) ? "Murage keeps your current engine until the new version is verified. Requires Node.js and npm."
        : "Use the engine’s setup guide to install or update on this platform." };
  }
  async check(id: string): Promise<EngineManagementStatus> {
    const instance = await this.instance(id);
    if (instance.driverKind === "fuigo") {
      this.versions.set("fuigo", await latestFuigoVersion(this.deps.fetch));
      return this.status(id);
    }
    if (!this.supported(instance)) return this.status(id);
    const packageName = "@openai%2Fcodex";
    const response = await (this.deps.fetch ?? fetch)(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error("Could not check for engine updates. Try again.");
    const metadata = await response.json() as { version?: unknown };
    if (typeof metadata.version !== "string" || !versionPattern.test(metadata.version)) throw new Error("The update service returned an unsupported version. Try again later.");
    this.versions.set(instance.driverKind, metadata.version);
    return this.status(id);
  }
  async install(id: string, options: { allowCustom?: boolean } = {}): Promise<EngineManagementStatus> {
    if (this.running || this.deps.isBusy()) throw new Error("Finish or stop running tasks before updating an engine.");
    this.running = true;
    try {
      const instance = await this.instance(id);
      if (instance.driverKind === "fuigo") {
        const expectedCli = instance.cli ?? null;
        if (!this.supported(instance)) throw new Error("Native Fuigo installation is not supported on this platform.");
        const status = await this.status(id);
        if (!options.allowCustom && status.source !== "managed" && status.source !== "bundled") throw new Error("Choose Use managed Fuigo explicitly to replace the current custom or PATH selection.");
        await this.check(id);
        const version = this.versions.get("fuigo")!;
        if (!supportedFuigoVersion(version)) throw new Error("This Fuigo release is not supported by this Murage version.");
        let cli: string;
        try {
          cli = await stageNativeFuigo({ root: this.deps.root, id, version, target: `${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}`, fetcher: this.deps.fetch, probe: this.deps.fuigoProbe,
            ...(status.source === "managed" && instance.cli ? { previousManagedCli: instance.cli } : {}) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "FUIGO_INCOMPATIBLE") throw error;
          throw new Error("Native Fuigo download or compatibility verification failed. The selected engine is unchanged. No Node.js/npm setup is needed.");
        }
        await this.activateFuigo(id, cli, expectedCli);
        this.running = false;
        return this.status(id);
      }
      if (!this.supported(instance)) throw new Error("Managed installation is not supported for this engine on this platform. Use its setup guide.");
      await this.check(id);
      const version = this.versions.get(instance.driverKind)!;
      await mkdir(this.deps.root, { recursive: true });
      const candidate = await mkdtemp(join(this.deps.root, "codex-" + version + "-"));
      await mkdir(join(candidate, "home"));
      for(const directory of ["appdata","localappdata","codex-home"])await mkdir(join(candidate,"home",directory));
      await writeFile(join(candidate, "package.json"), JSON.stringify({ private: true }));
      const run = this.deps.run ?? (async (command: string, args: string[], cwd: string) => {
        const env: NodeJS.ProcessEnv = { PATH: this.deps.envPath ?? process.env.PATH, HOME: join(candidate, "home"),
          USERPROFILE:join(candidate,"home"),APPDATA:join(candidate,"home","appdata"),LOCALAPPDATA:join(candidate,"home","localappdata"),CODEX_HOME:join(candidate,"home","codex-home"),
          TMPDIR: candidate,TMP:candidate,TEMP:candidate, npm_config_cache: join(candidate, "cache"), npm_config_userconfig: join(candidate, "empty-npmrc"),
          npm_config_globalconfig: join(candidate, "empty-global-npmrc"), CI: "1" };
        if((this.deps.platform??process.platform)==="win32" && process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
        const invocation=(this.deps.platform??process.platform)==="win32"&&command==="npm"?await windowsNpmCommand(args):{command,args};
        const result = await exec(invocation.command, invocation.args, { cwd, env, timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,windowsHide:true });
        return result.stdout;
      });
      let activationAttempted = false;
      try {
        await run("npm", ["install", "--prefix", candidate, "--registry=https://registry.npmjs.org", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", "--save-exact", "@openai/codex@" + version], candidate);
        const cli = (this.deps.platform??process.platform)==="win32"
          ?await verifiedWindowsCodexPath(candidate,version)
          :join(candidate, "node_modules", ".bin", "codex");
        const reported = await run(cli, ["--version"], candidate);
        if (versionFrom(reported) !== version) throw new Error("version mismatch");
        if (this.deps.isBusy()) throw new Error("active tasks");
        activationAttempted = true;
        await this.deps.activate(id, cli);
      } catch (error) {
        if(error instanceof ManagedNpmUnavailable)throw error;
        // Never forward npm output, environment paths or credential-bearing config.
        throw new Error(activationAttempted
          ? "Engine activation did not complete. Check the selected engine in Settings before retrying."
          : "Engine installation could not be verified or activated. Your previous engine is unchanged. Finish running tasks, check Node.js/npm and your connection, then retry.");
      }
      this.running = false;
      return this.status(id);
    } finally { this.running = false; }
  }

  private async activateFuigo(id: string, cli: string, expectedCli: string | null): Promise<void> {
    const current = await this.instance(id);
    if ((current.cli ?? null) !== expectedCli) throw new Error("The selected Fuigo engine changed while verification ran. Refresh Settings before changing it again.");
    if (this.deps.isBusy()) throw new Error("Tasks started while verifying Fuigo. Finish them before activating the update; the selected engine is unchanged.");
    try { await this.deps.activate(id, cli, expectedCli); }
    catch { throw new Error("Fuigo activation did not complete. Check the selected engine in Settings before retrying; no task was retried automatically."); }
  }
  async rollback(id: string): Promise<EngineManagementStatus> {
    if (this.running || this.deps.isBusy()) throw new Error("Finish or stop running tasks before changing Fuigo.");
    this.running = true;
    try {
      const instance = await this.instance(id);
      if (!this.supported(instance)) throw new Error("Native Fuigo update isolation is not qualified on this platform. Keep the selected engine.");
      const expectedCli = instance.cli ?? null;
      const current = instance.driverKind === "fuigo" ? await managedFuigoReceipt(this.deps.root, id, instance.cli) : null;
      if (!current?.previousManagedCli) throw new Error("No previous verified managed Fuigo version is available.");
      await verifyManagedFuigo(this.deps.root, id, current.previousManagedCli, `${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}`, this.deps.fuigoProbe);
      await this.activateFuigo(id, current.previousManagedCli, expectedCli); this.running = false; return this.status(id);
    } finally { this.running = false; }
  }
  async useBundled(id: string): Promise<EngineManagementStatus> {
    if (this.running || this.deps.isBusy()) throw new Error("Finish or stop running tasks before changing Fuigo.");
    this.running = true;
    try {
      const instance = await this.instance(id);
      if (instance.driverKind !== "fuigo" || !instance.bundledCli) throw new Error("This installation has no declared bundled Fuigo fallback.");
      if (!this.supported(instance)) throw new Error("Native Fuigo update isolation is not qualified on this platform. Keep the selected engine.");
      const expectedCli = instance.cli ?? null;
      const stat = await lstat(instance.bundledCli);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024 || nativeFuigoTarget(await readFile(instance.bundledCli)) !== `${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}`) throw new Error("The bundled Fuigo executable could not be verified.");
      await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
      const scratch = await mkdtemp(join(this.deps.root, "fuigo-bundle-probe-")); let cleanupSafe = true;
      try {
        const proof = await (this.deps.fuigoProbe ?? probeNativeFuigo)(instance.bundledCli, undefined, scratch);
        if (proof.protocolVersion !== 1 || !proof.loadSession || !proof.sessionCreated) throw new Error("The bundled Fuigo protocol could not be verified.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "FUIGO_PROBE_CLEANUP") cleanupSafe = false; throw error; }
      finally { if (cleanupSafe) await rm(scratch, { recursive: true, force: true }); }
      await this.activateFuigo(id, instance.bundledCli, expectedCli); this.running = false; return this.status(id);
    } finally { this.running = false; }
  }
}
