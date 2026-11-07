import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { claudeNativeTarget, clearDownloads, codexNativeTarget, installClaudeNative, stageCodexNative, versionFrom, type NativeInstallProgress, type NativeRun } from "./engine-native-install.ts";
import { FUIGO_TARGETS, fuigoVersionNewer, latestFuigoVersion, managedFuigoReceipt, nativeFuigoTarget, offeredFuigoVersion, probeNativeFuigo, qualifiedFuigoVersion, stageNativeFuigo, supportedFuigoVersion, verifyManagedFuigo, type FuigoProbe } from "./fuigo-native-update.ts";
import { execCli } from "./procs.ts";

export { versionFrom };
/** The installed Fuigo's version for Health (HEALTH-DOCTOR-FUIGO-VERSION): the managed install's receipt first, else the
 * version the engine reports ("fuigo 1.0.39" reads as "1.0.39"). Never a pinned or qualified number. */
export async function installedFuigoVersion(root: string, instance: { instanceId: string; cli?: string; snapshot: { version?: string | null } }): Promise<string | null> {
  return (await managedFuigoReceipt(root, instance.instanceId, instance.cli))?.version ?? versionFrom(instance.snapshot.version);
}

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
  /** Set while a native install is running on this engine. */
  progress?: NativeInstallProgress;
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
  run?: NativeRun;
  /** The engine path every other instance is configured with. A managed package one of them uses is never removed. */
  otherClis?: (id: string) => readonly string[];
  /** Forget what was found on PATH, so the next probe sees an engine that just arrived. */
  resetProbes?: () => void;
  fuigoProbe?: FuigoProbe;
  /** Clock for the release cache (tests). */
  now?: () => number;
}
/** How long a looked-up latest release is served before it is refreshed. */
export const LATEST_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
/** A vendor binary's own install: longer than a version print, and bounded. */
const NATIVE_RUN_TIMEOUT_MS = 300_000;
const versionPattern = /^\d+\.\d+\.\d+$/;
/** The shared launcher with the env it was handed and nothing else: no terminal, no shell, and its output is never forwarded. */
const runNative: NativeRun = (command, args, cwd, env) => new Promise((resolve, reject) => {
  execCli(command, args, { cwd, env: env ?? {}, timeout: NATIVE_RUN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true, absoluteExecutable: true },
    (error, stdout) => { if (error) reject(error); else resolve(stdout); });
});
/** The folder of a managed Codex under `root`, or null for any other path. A custom or PATH engine is never touched. */
function managedCodexFolder(root: string, cli: string | undefined): string | null {
  if (!cli) return null;
  const inside = relative(root, cli), folder = inside.split(sep)[0]!;
  return !inside.startsWith("..") && inside.includes(sep) && /^codex-\d+\.\d+\.\d+-/.test(folder) ? join(root, folder) : null;
}
function newer(a: string, b: string): boolean {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (aa[i] !== bb[i]) return aa[i]! > bb[i]!; }
  return false;
}
/** Present in any state, even one too old to run: a version was read from it. */
const present = (instance: ManagedEngineInstance) => instance.snapshot.state === "available" || versionFrom(instance.snapshot.version) !== null;
/** Fixed vendor identity; renderer supplies only instance ID and action.
 * Existing CLI and user config are untouched until --version succeeds and the
 * caller's idle gate permits activation. Claude Code installs to its own place
 * (~/.local/bin, already on the search path), so nothing is activated for it.
 */
export class EngineManager {
  private running = false;
  /** The native install under way. Status reads it without probing the engine, so a progress poll costs nothing. */
  private installing: { id: string; progress: NativeInstallProgress } | null = null;
  private versions = new Map<string, string>();
  /** When each driver's latest release was last looked up, and the lookup in flight. */
  private checkedAt = new Map<string, number>();
  private refreshing = new Map<string, Promise<void>>();
  private deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }
  private async instance(id: string) {
    const instance = await this.deps.getInstance(id);
    if (!instance) throw new Error("Engine not found. Refresh Settings and try again.");
    return instance;
  }
  private supported(instance: ManagedEngineInstance) {
    const platform=this.deps.platform??process.platform;
    if (instance.driverKind === "claudeAgent") return !present(instance) && process.env.MURAGE_CLOUD_ROLE !== "home" && claudeNativeTarget(platform, this.deps.arch ?? process.arch) !== null;
    if (instance.driverKind === "fuigo") return (platform === "darwin" || (["linux", "win32"].includes(platform) && (this.deps.arch ?? process.arch) === "x64")) && (FUIGO_TARGETS as readonly string[]).includes(`${platform}-${this.deps.arch ?? process.arch}`);
    return instance.driverKind === "codex" && codexNativeTarget(platform, this.deps.arch ?? process.arch) !== null;
  }
  async status(id: string): Promise<EngineManagementStatus> {
    if (this.installing?.id === id) return { supported: true, installedVersion: null, updateAvailable: false, message: "", busy: true, progress: this.installing.progress };
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
          : latestVersion && installedVersion && newer(installedVersion, latestVersion) ? `You have Fuigo ${installedVersion}, which is newer than this Murage version offers. It stays as it is.`
          : releaseSupported === false ? "The latest Fuigo release is outside this Murage version’s compatibility range. Keep the current engine."
          : source === "custom" || source === "path" || source === "unknown" ? "Your existing Fuigo selection is preserved. Choose Use managed Fuigo to opt in to verified native updates; no Node.js or npm is required."
          : "Fuigo updates independently of Murage. Native downloads are checksum, architecture and ACP-compatibility checked before use; no Node.js or npm is required." };
    }
    if (instance.driverKind === "claudeAgent") return { supported: this.supported(instance), installedVersion, updateAvailable: false, busy: this.running,
      message: this.supported(instance) ? "Murage downloads Claude Code from Anthropic and checks it before it runs. No Node.js needed."
        : "Use the engine’s setup guide to install or update on this platform." };
    return { supported: this.supported(instance), installedVersion, latestVersion,
      updateAvailable: !!(latestVersion && installedVersion && newer(latestVersion, installedVersion)),
      busy: this.running,
      message: this.supported(instance) ? "Murage keeps your current engine until the new version is verified. No Node.js needed."
        : "Use the engine’s setup guide to install or update on this platform." };
  }
  /** The latest release, as last seen. Settings asks on every visit: the
   *  answer it already has comes back at once, and a lookup older than the TTL
   *  is refreshed in the background for the next visit. Only the first visit,
   *  or an install (`fresh`), waits on the registry. */
  async check(id: string, options: { fresh?: boolean } = {}): Promise<EngineManagementStatus> {
    const instance = await this.instance(id);
    // Claude Code updates itself: there is no release of ours to look up.
    if (instance.driverKind === "claudeAgent" || (instance.driverKind !== "fuigo" && !this.supported(instance))) return this.status(id);
    const kind = instance.driverKind, now = (this.deps.now ?? Date.now)();
    if (!options.fresh && this.versions.has(kind)) {
      if (now - (this.checkedAt.get(kind) ?? 0) >= LATEST_VERSION_TTL_MS) this.refreshInBackground(kind);
      return this.status(id);
    }
    await this.lookUp(kind);
    return this.status(id);
  }
  /** One lookup per driver at a time; a second caller joins it. */
  private lookUp(kind: string): Promise<void> {
    let pending = this.refreshing.get(kind);
    if (!pending) {
      pending = this.fetchLatest(kind).then(version => {
        this.versions.set(kind, version);
        this.checkedAt.set(kind, (this.deps.now ?? Date.now)());
      }).finally(() => { this.refreshing.delete(kind); });
      this.refreshing.set(kind, pending);
    }
    return pending;
  }
  private refreshInBackground(kind: string): void {
    // The release already shown stays until a newer lookup succeeds.
    this.lookUp(kind).catch(() => { /* kept: the last known release */ });
  }
  private async fetchLatest(kind: string): Promise<string> {
    // Capped at the release this Murage version is qualified for: a newer
    // registry latest is offered as the cap, so an owner on it sees up to date.
    if (kind === "fuigo") return offeredFuigoVersion(await latestFuigoVersion(this.deps.fetch));
    const packageName = "@openai%2Fcodex";
    const response = await (this.deps.fetch ?? fetch)(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error("Could not check for engine updates. Try again.");
    const metadata = await response.json() as { version?: unknown };
    if (typeof metadata.version !== "string" || !versionPattern.test(metadata.version)) throw new Error("The update service returned an unsupported version. Try again later.");
    return metadata.version;
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
        await this.check(id, { fresh: true });
        const version = this.versions.get("fuigo")!;
        if (!qualifiedFuigoVersion(version)) throw new Error("This Fuigo release is not supported by this Murage version.");
        // An owner already on a newer Fuigo keeps it: never a downgrade. A
        // managed install's receipt names its version when the probe did not.
        const current = status.installedVersion ?? (await managedFuigoReceipt(this.deps.root, id, instance.cli))?.version ?? null;
        if (current && fuigoVersionNewer(current, version)) { this.running = false; return this.status(id); }
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
      if (instance.driverKind === "claudeAgent") {
        // An engine already here is never installed over. Its updates are Claude Code's own.
        if (present(instance)) { this.running = false; return this.status(id); }
        if (!this.supported(instance)) throw new Error("Managed installation is not supported for this engine on this platform. Use its setup guide.");
        await this.installClaude(id);
        this.installing = null; this.running = false;
        this.deps.resetProbes?.();
        const found = await this.status(id);
        if (!found.installedVersion) throw new Error("Claude Code is installed, and Murage can't see it yet. Choose Check again, or restart Murage.");
        return found;
      }
      if (!this.supported(instance)) throw new Error("Managed installation is not supported for this engine on this platform. Use its setup guide.");
      await this.check(id, { fresh: true });
      const version = this.versions.get(instance.driverKind)!;
      // An owner already on a newer Codex keeps it: never a downgrade, as with Fuigo.
      const current = versionFrom(instance.snapshot.version);
      if (current && newer(current, version)) { this.running = false; return this.status(id); }
      await clearDownloads(this.deps.root);
      this.installing = { id, progress: { phase: "download", received: 0, total: 0 } };
      let activationAttempted = false, staged: { cli: string; candidate: string } | undefined;
      const replaced = managedCodexFolder(this.deps.root, instance.cli);
      try {
        staged = await stageCodexNative({ ...this.nativeOptions(id), version });
        if (this.deps.isBusy()) throw new Error("active tasks");
        activationAttempted = true;
        await this.deps.activate(id, staged.cli);
      } catch (error) {
        if (staged && !activationAttempted) await rm(staged.candidate, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
        // Never forward vendor output or environment paths.
        throw new Error(activationAttempted
          ? "Engine activation did not complete. Check the selected engine in Settings before retrying."
          : "Engine installation could not be verified or activated. Your previous engine is unchanged. Finish running tasks, check your connection, then retry.", { cause: error });
      }
      // A package is about 500 MB: the one it replaced leaves once the new one is live.
      const shared = this.deps.otherClis?.(id).some(cli => managedCodexFolder(this.deps.root, cli) === replaced) ?? true;
      if (replaced && replaced !== staged.candidate && !shared) await rm(replaced, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
      this.installing = null; this.running = false;
      return this.status(id);
    } finally { this.installing = null; this.running = false; }
  }
  private nativeOptions(id: string) {
    return { root: this.deps.root, platform: this.deps.platform ?? process.platform, arch: this.deps.arch ?? process.arch, fetcher: this.deps.fetch ?? fetch,
      run: this.deps.run ?? runNative, envPath: this.deps.envPath ?? process.env.PATH,
      onProgress: (progress: NativeInstallProgress) => { this.installing = { id, progress }; } };
  }
  private async installClaude(id: string): Promise<void> {
    await clearDownloads(this.deps.root);
    this.installing = { id, progress: { phase: "download", received: 0, total: 0 } };
    try { await installClaudeNative(this.nativeOptions(id)); }
    // Never forward vendor output or environment paths.
    catch (error) { throw new Error("Claude Code could not be installed. Check your connection and try again.", { cause: error }); }
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
