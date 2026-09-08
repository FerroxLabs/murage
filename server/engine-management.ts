import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ManagedEngineInstance {
  instanceId: string; driverKind: string; cli?: string;
  snapshot: { state: string; version?: string | null };
}
export interface EngineManagementStatus {
  supported: boolean; installedVersion: string | null; latestVersion?: string;
  updateAvailable: boolean; message: string; busy: boolean;
}
interface Dependencies {
  root: string;
  getInstance: (id: string) => Promise<ManagedEngineInstance | undefined>;
  isBusy: () => boolean;
  /** Persist the verified path and reload providers. Must atomically refuse active turns. */
  activate: (id: string, cli: string) => Promise<void>;
  platform?: NodeJS.Platform;
  envPath?: string;
  fetch?: typeof fetch;
  run?: (command: string, args: string[], cwd: string) => Promise<string>;
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
    return instance.driverKind === "codex" && ["darwin", "linux"].includes(this.deps.platform ?? process.platform);
  }
  async status(id: string): Promise<EngineManagementStatus> {
    const instance = await this.instance(id);
    const installedVersion = versionFrom(instance.snapshot.version);
    const latestVersion = this.versions.get(instance.driverKind);
    return { supported: this.supported(instance), installedVersion, latestVersion,
      updateAvailable: !!(latestVersion && installedVersion && newer(latestVersion, installedVersion)),
      busy: this.running,
      message: instance.driverKind === "fuigo" ? "Fuigo is included with Murage. Update Murage to update its bundled engine."
        : this.supported(instance) ? "Murage keeps your current engine until the new version is verified. Requires Node.js and npm."
        : "Use the engine’s setup guide to install or update on this platform." };
  }
  async check(id: string): Promise<EngineManagementStatus> {
    const instance = await this.instance(id);
    if (!this.supported(instance) && instance.driverKind !== "fuigo") return this.status(id);
    const packageName = instance.driverKind === "fuigo" ? "fuigo" : "@openai%2Fcodex";
    const response = await (this.deps.fetch ?? fetch)(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error("Could not check for engine updates. Try again.");
    const metadata = await response.json() as { version?: unknown };
    if (typeof metadata.version !== "string" || !versionPattern.test(metadata.version)) throw new Error("The update service returned an unsupported version. Try again later.");
    this.versions.set(instance.driverKind, metadata.version);
    return this.status(id);
  }
  async install(id: string): Promise<EngineManagementStatus> {
    if (this.running || this.deps.isBusy()) throw new Error("Finish or stop running tasks before updating an engine.");
    this.running = true;
    try {
      const instance = await this.instance(id);
      if (!this.supported(instance)) throw new Error("Managed installation is not supported for this engine on this platform. Use its setup guide.");
      await this.check(id);
      const version = this.versions.get(instance.driverKind)!;
      await mkdir(this.deps.root, { recursive: true });
      const candidate = await mkdtemp(join(this.deps.root, "codex-" + version + "-"));
      await mkdir(join(candidate, "home"));
      await writeFile(join(candidate, "package.json"), JSON.stringify({ private: true }));
      const run = this.deps.run ?? (async (command: string, args: string[], cwd: string) => {
        const env: NodeJS.ProcessEnv = { PATH: this.deps.envPath ?? process.env.PATH, HOME: join(candidate, "home"),
          TMPDIR: candidate, npm_config_cache: join(candidate, "cache"), npm_config_userconfig: join(candidate, "empty-npmrc"),
          npm_config_globalconfig: join(candidate, "empty-global-npmrc"), CI: "1" };
        const result = await exec(command, args, { cwd, env, timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
        return result.stdout;
      });
      let activationAttempted = false;
      try {
        await run("npm", ["install", "--prefix", candidate, "--registry=https://registry.npmjs.org", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "@openai/codex@" + version], candidate);
        const cli = join(candidate, "node_modules", ".bin", "codex");
        const reported = await run(cli, ["--version"], candidate);
        if (versionFrom(reported) !== version) throw new Error("version mismatch");
        if (this.deps.isBusy()) throw new Error("active tasks");
        activationAttempted = true;
        await this.deps.activate(id, cli);
      } catch {
        // Never forward npm output, environment paths or credential-bearing config.
        throw new Error(activationAttempted
          ? "Engine activation did not complete. Check the selected engine in Settings before retrying."
          : "Engine installation could not be verified or activated. Your previous engine is unchanged. Finish running tasks, check Node.js/npm and your connection, then retry.");
      }
      this.running = false;
      return this.status(id);
    } finally { this.running = false; }
  }
}
