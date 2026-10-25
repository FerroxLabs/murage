import { cloudHomeCopy } from "./copy.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { CLOUD_BROKER_DIR, CLOUD_ENGINES } from "./turn-process.ts";
import { readSecretPipe } from "./server-secrets.ts";
import { homeBootContract, homeServerEnvironment, readBootFile } from "./boot.ts";
import { decodeCloudBootEnvelope, SealedSecretStore } from "./secrets.ts";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { readOwnerTimeZone, writeOwnerTimeZone } from "./timezone.ts";

export interface HomeIdentity { uid: number; gid: number; turnGid: number; proxyUid: number; proxyGid: number; engineGids: Record<string, number> }
const validId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
/** Validate the image-owned identity file, including one distinct group per cloud engine. */
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
/** Engine homes are root:murage-eng-<engine> 2770: neither the server uid nor the
 * raw turn uid holds the group, so only the launcher (which adds exactly one
 * engine group inside bwrap) can reach a home. */
export function prepareEngineHomes(identity: Pick<HomeIdentity, "engineGids">, root = "/data/engine-homes", chown: (path: string, uid: number, gid: number) => void = chownSync): void {
  mkdirSync(root, { recursive: true, mode: 0o711 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeRoot);
  chown(root, 0, 0); chmodSync(root, 0o711);
  for (const engine of CLOUD_ENGINES) {
    for (const directory of [`${root}/${engine}`, `${root}/${engine}/tmp`]) {
      mkdirSync(directory, { recursive: true, mode: 0o2770 });
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeDirectory);
      chown(directory, 0, identity.engineGids[engine]); chmodSync(directory, 0o2770);
    }
  }
}

/** Claude's approval sockets live in a root:murage-turn 3770 directory (setgid, plus the sticky bit so a turn cannot unlink a socket it does not own): the server
 * (a murage-turn member) binds them, and the launcher binds only this directory
 * into Claude turns. Nothing is created inside any engine home. */
export function prepareBrokerDir(identity: Pick<HomeIdentity, "turnGid">, directory = CLOUD_BROKER_DIR, chown: (path: string, uid: number, gid: number) => void = chownSync): void {
  mkdirSync(directory, { recursive: true, mode: 0o3770 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeDirectory);
  chown(directory, 0, identity.turnGid); chmodSync(directory, 0o3770);
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

export function validateVolumeMarker(stat: { isFile(): boolean; uid: number; mode: number; size: number }, value: string, machineId: string): void {
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 130 || value !== `${machineId}\n`) throw new Error(cloudHomeCopy.homeVolumeBelongsToAnotherMachineOrItsBindingIsInvalid);
}

export function assertUnboundVolumeEmpty(dataDir: string): void {
  if (!existsSync(join(dataDir, ".murage-home-machine")) && readdirSync(dataDir).some(name => name !== "lost+found")) throw new Error(cloudHomeCopy.unboundHomeVolumeIsNotEmpty);
}

export function bindHomeVolume(dataDir: string, machineId: string, uid: number, gid: number, proxyUid: number, proxyGid: number): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o711 });
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) throw new Error(cloudHomeCopy.homeVolumeMustBeADirectory);
  assertUnboundVolumeEmpty(dataDir);
  const marker = join(dataDir, ".murage-home-machine");
  let fd: number;
  try {
    fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${machineId}\n`); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    validateVolumeMarker(stat, readFileSync(fd, "utf8"), machineId);
  } finally { closeSync(fd); }
  // The shared data-dir lease (electron/data-dir-lease.mjs) lives beside the
  // data folder, so the server uid must be able to create files in /data. The
  // sticky bit keeps it from unlinking or renaming anything it does not own
  // (the machine marker, engine homes, browser, proxy); others keep traversal.
  chownSync(dataDir, 0, gid);
  chmodSync(dataDir, 0o1771);
  for (const [name, owner, group, mode] of [
    ["home", uid, gid, 0o700], ["home/secrets", uid, gid, 0o700], ["server-home", uid, gid, 0o700],
    ["proxy", uid, proxyGid, 0o2750], ["caddy", proxyUid, proxyGid, 0o700], ["browser", 0, 0, 0o711],
  ] as const) {
    const path = join(dataDir, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chownSync(path, owner, group); chmodSync(path, mode);
  }
  prepareHealthProbeDir(dataDir);
}

/** The data-write readiness probe's directory (deploy/cloud-home/murage-control DATA_PROBE_DIR): a top-level entry of the bound volume,
 *  root:root 0700, the only /data path murage-control.service may write. Made here, as root, only after the binding marker is valid
 *  (bindHomeVolume), so an unbound volume never holds it (assertUnboundVolumeEmpty), and before the server drops privileges, so no murage
 *  process can create the name first; /data's sticky bit then keeps the murage group from replacing it. Idempotent. The final component is
 *  created with mkdir (which never follows a symlink) and opened O_NOFOLLOW|O_DIRECTORY, then owner and mode are set on that descriptor;
 *  a symlink, a non-directory or a directory on another device is refused. Excluded from backups (server/data-dir-inventory.ts). */
export const HEALTH_PROBE_DIR_NAME = ".murage-health";
export function prepareHealthProbeDir(dataDir: string, chown: (fd: number, uid: number, gid: number) => void = fchownSync): void {
  const path = join(dataDir, HEALTH_PROBE_DIR_NAME);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch { throw new Error(cloudHomeCopy.invalidHomeStorageDirectory); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== statSync(dataDir).dev) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chown(fd, 0, 0);
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
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
  if (process.getuid?.() !== 0) throw new Error(cloudHomeCopy.homeSupervisorMustStartAsRoot);
  process.umask(0o077);
  assertImmutableCode("/opt/murage");
  const rawFd = process.env.MURAGE_CLOUD_SECRETS_FD;
  if (!rawFd || !/^\d+$/u.test(rawFd) || Number(rawFd) < 3) throw new Error(cloudHomeCopy.homeSecretsDescriptorIsMissing);
  const fd = Number(rawFd);
  const raw = readSecretPipe(fd);
  const secrets = decodeCloudBootEnvelope(raw, process.env.MURAGE_CLOUD_MACHINE_ID ?? "");
  const contract = homeBootContract({ ...process.env, MURAGE_CLOUD_BOOTSTRAP_SECRET: secrets.bootstrapSecret })!;
  delete process.env.MURAGE_CLOUD_BOOTSTRAP_SECRET;
  // IDs are image-owned, not values supplied by the service user.
  const identity = parseHomeIdentity(JSON.parse(readBootFile("/etc/murage-home/identity.json")));
  bindHomeVolume("/data", contract.machineId, identity.uid, identity.gid, identity.proxyUid, identity.proxyGid);
  prepareEngineHomes(identity);
  prepareBrokerDir(identity);
  (process as NodeJS.Process & { initgroups(user: string, group: number): void }).initgroups("murage", identity.gid);
  process.setgid!(identity.gid);
  process.setuid!(identity.uid);
  if (!existsSync("/data/home/owner.json")) writeOwnerTimeZone("/data/home", "UTC");
  const env = homeServerEnvironment(contract, readOwnerTimeZone("/data/home"), process.env.MURAGE_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT ?? "8800", process.env.MURAGE_SAFE_MODE === "1");
  process.env.TZ = env.TZ;
  const store = new SealedSecretStore("/data/home/secrets", contract.machineId, secrets.dataKey);
  secrets.dataKey.fill(0);
  const session = createHomeSupervisorSession({
    store, bootstrapSecret: secrets.bootstrapSecret,
    onError: () => { console.error(cloudHomeCopy.homeSupervisorRefusedAPrivateMessage); },
  });
  let stop: () => void;
  try { stop = superviseHome({
    env, serverCommand: "/usr/local/bin/node", serverArgs: ["/opt/murage/dist-server/index.js"],
    envelope: session.envelope,
    attach: session.attachChild,
    onStop: code => { session.close(); process.exitCode = code; },
  }); } catch (error) { session.close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startHomeSupervisor().catch(() => { console.error(cloudHomeCopy.homeSupervisorCouldNotStartCheckTheBootContractAndVolumePermissions); process.exitCode = 1; });
}
