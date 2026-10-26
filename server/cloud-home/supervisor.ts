import { cloudHomeCopy } from "./copy.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { CLOUD_ENGINES } from "./turn-process.ts";
import { readSecretPipe } from "./server-secrets.ts";
import { homeBootContract, homeServerEnvironment } from "./boot.ts";
import { decodeCloudBootEnvelope, SealedSecretStore } from "./secrets.ts";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { readOwnerTimeZone, writeOwnerTimeZone } from "./timezone.ts";
import { sweepAgyFreezes } from "./b1b-recovery.ts";

// The slot supervisor (LANE-G-UPDATE-STATE-MACHINE r3 sec. 1.2): release-slot code that is started by the image-owned root launcher
// (deploy/cloud-home/murage-home-launch.py) AFTER the volume binding and the privilege drop, through the verified slot descriptor.
// It refuses to run as uid 0; everything root-only (bindHomeVolume, prepareEngineHomes, prepareBrokerDir, home-volume-spec.ts) is the
// launcher's, in Python, with the TypeScript kept as the spec.

export interface HomeIdentity { uid: number; gid: number; turnGid: number; proxyUid: number; proxyGid: number; engineGids: Record<string, number> }
const validId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
/** Validate the image-owned identity (handed over by the launcher as MURAGE_HOME_IDENTITY), including one distinct group per cloud engine. */
export function parseHomeIdentity(raw: unknown): HomeIdentity {
  const value = raw as Partial<HomeIdentity> | null;
  if (!value || typeof value !== "object" || ![value.uid, value.gid, value.turnGid, value.proxyUid, value.proxyGid].every(validId)) throw new Error(cloudHomeCopy.invalidHomeServiceIdentity);
  const engineGids = value.engineGids;
  if (!engineGids || typeof engineGids !== "object" || Array.isArray(engineGids)) throw new Error(cloudHomeCopy.invalidHomeServiceIdentity);
  const taken = new Set<number>([value.gid!, value.turnGid!, value.proxyGid!]);
  for (const engine of CLOUD_ENGINES) {
    const gid = (engineGids as Record<string, unknown>)[engine];
    if (!validId(gid) || taken.has(gid)) throw new Error(cloudHomeCopy.invalidHomeServiceIdentity);
    taken.add(gid);
  }
  return value as HomeIdentity;
}

/** The only roots slot code may run from: a release slot, by its real path (never /opt/murage, the link the launcher resolved). */
export const RELEASE_ROOT_PATTERN = /^\/opt\/murage-releases\/(A|B)$/u;
export function homeReleaseRoot(value: string | undefined): string {
  if (!value || !RELEASE_ROOT_PATTERN.test(value)) throw new Error(cloudHomeCopy.homeReleaseRootIsInvalid);
  return value;
}

/** The slot supervisor never runs as root: the launcher dropped to the home service user before the exec. */
/** An unknown uid (undefined) is a refusal, never a default to the real uid: callers pass process.getuid?.() explicitly. */
export function assertUnprivileged(uid: number | undefined): void {
  if (uid === undefined || uid === 0) throw new Error(cloudHomeCopy.homeSupervisorMustNotRunAsRoot);
}

export function assertImmutableCode(root: string): void {
  const absolute = resolve(root);
  for (let path = absolute;; path = dirname(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(cloudHomeCopy.homeSupervisorCodeMustBeRootOwnedAndNotWritableByTheServiceUser);
    if (path === dirname(path)) break;
  }
  function visit(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(`${absolute}/`)) throw new Error(cloudHomeCopy.homeCodeLinkEscapesItsInstallation);
      return; // The target is visited through its real directory entry.
    }
    if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(cloudHomeCopy.homeSupervisorCodeMustBeRootOwnedAndNotWritableByTheServiceUser);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  }
  visit(absolute);
}

export function homeChildExit(child: "server" | "proxy", code: number | null): "restart-server" | "stop" {
  return child === "server" && code === 75 ? "restart-server" : "stop";
}

/** Supervision uses IPC for private messages and a distinct one-shot FD for secrets. */
export function superviseHome(input: {
  env: NodeJS.ProcessEnv; serverCommand: string; serverArgs: string[];
  envelope: () => string; attach: (server: ChildProcess) => void; spawnChild?: typeof spawn; onStop?: (code: number) => void;
}): () => void {
  const launch = input.spawnChild ?? spawn;
  let stopped = false;
  let server: ChildProcess;
  const stop = (code = 0) => { if (stopped) return; stopped = true; input.onStop?.(code); server?.kill("SIGTERM"); };
  function startServer(): void {
    server = launch(input.serverCommand, input.serverArgs, { env: input.env, stdio: ["ignore", "inherit", "inherit", "pipe", "ipc"] });
    const child = server;
    const failed = () => { if (!stopped && server === child) stop(1); };
    input.attach(child);
    const fd = child.stdio[3] as Writable;
    fd.on("error", failed);
    fd.end(input.envelope());
    child.once("error", failed);
    child.once("exit", code => {
      if (stopped || server !== child) return;
      if (homeChildExit("server", code) === "restart-server") startServer();
      else failed();
    });
  }
  startServer();
  return () => stop();
}

export async function startHomeSupervisor(): Promise<void> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") {
    homeBootContract(process.env); // Reject partial contracts without affecting desktop imports.
    throw new Error(cloudHomeCopy.theHomeSupervisorRequiresTheHomeRole);
  }
  assertUnprivileged(process.getuid?.());
  process.umask(0o077);
  // A second, unprivileged check of the tree the launcher already sealed and verified; the root it names is the slot's real path.
  const releaseRoot = homeReleaseRoot(process.env.MURAGE_RELEASE_ROOT);
  assertImmutableCode(releaseRoot);
  const rawFd = process.env.MURAGE_CLOUD_SECRETS_FD;
  if (!rawFd || !/^\d+$/u.test(rawFd) || Number(rawFd) < 3) throw new Error(cloudHomeCopy.homeSecretsDescriptorIsMissing);
  const fd = Number(rawFd);
  const raw = readSecretPipe(fd);
  const secrets = decodeCloudBootEnvelope(raw, process.env.MURAGE_CLOUD_MACHINE_ID ?? "");
  const contract = homeBootContract({ ...process.env, MURAGE_CLOUD_BOOTSTRAP_SECRET: secrets.bootstrapSecret })!;
  delete process.env.MURAGE_CLOUD_BOOTSTRAP_SECRET;
  // IDs are image-owned (/etc/murage-home/identity.json, read by the root launcher), not values supplied by the service user; the
  // supervisor must be running as exactly that user.
  const identity = parseHomeIdentity(JSON.parse(process.env.MURAGE_HOME_IDENTITY ?? "null"));
  if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid) throw new Error(cloudHomeCopy.homeSupervisorMustNotRunAsRoot);
  if (!existsSync("/data/home/owner.json")) writeOwnerTimeZone("/data/home", "UTC");
  const env = homeServerEnvironment(contract, readOwnerTimeZone("/data/home"), process.env.MURAGE_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT ?? "8800", process.env.MURAGE_SAFE_MODE === "1");
  process.env.TZ = env.TZ;
  const store = new SealedSecretStore("/data/home/secrets", contract.machineId, secrets.dataKey);
  secrets.dataKey.fill(0);
  // A turn killed with the launcher (crash, OOM, restart) can leave its antigravity .agents frozen: thaw it before the server serves.
  void sweepAgyFreezes().catch(() => { console.error(cloudHomeCopy.agyFreezeSweepFailed); });
  const session = createHomeSupervisorSession({
    store, bootstrapSecret: secrets.bootstrapSecret,
    onError: () => { console.error(cloudHomeCopy.homeSupervisorRefusedAPrivateMessage); },
  });
  let stop: () => void;
  try { stop = superviseHome({
    env, serverCommand: "/usr/local/bin/node", serverArgs: [`${releaseRoot}/dist-server/index.js`],
    envelope: session.envelope,
    attach: session.attachChild,
    onStop: code => { session.close(); process.exitCode = code; },
  }); } catch (error) { session.close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
}

/** The launcher execs this script through the verified slot descriptor (/proc/self/fd/<D>/dist-server/...); node loads the main
 *  entry by its real path, so the real path of argv[1] is what names this module. */
function isMainModule(argv1: string | undefined): boolean {
  if (!argv1) return false;
  try { return realpathSync(resolve(argv1)) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMainModule(process.argv[1])) {
  void startHomeSupervisor().catch(() => { console.error(cloudHomeCopy.homeSupervisorCouldNotStartCheckTheBootContractAndVolumePermissions); process.exitCode = 1; });
}
