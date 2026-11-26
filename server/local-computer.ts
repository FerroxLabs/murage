import "../shared/win-hide-child-process.mjs";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 as winPath } from "node:path";
import { WINDOWS_DRIVER_CONTRACT_VERSION, WINDOWS_DRIVER_SHA256, WINDOWS_DRIVER_VERSION } from "../shared/cua-driver-windows-pins.mjs";

export const REQUIRED_LINUX_TOOLS = ["click", "get_window_state", "list_apps", "type_text"];
// Keep this exact field set synchronized with DRIVER_FILE_IDENTITY_KEYS in
// electron/cua-linux.cjs; Electron publishes it and the server revalidates it.
export const DRIVER_FILE_IDENTITY_KEYS = [
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
  platform: "darwin" | "linux" | "win32";
  generation?: string;
  scope: "local-computer";
};

type LegacyConnectionDescriptor = {
  mode?: string;
  status?: unknown;
  socketPath?: unknown;
  mcpCommand?: unknown;
  mcpArgs?: unknown;
  mcpEnv?: unknown;
};

type LinuxConnectionDescriptor = Record<string, unknown>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

// win32 never decodes a legacy descriptor: a legacy file names ANY command, and Windows runs only the
// pinned, supervised driver (decodeWindowsDescriptor).
function legacyPlatform(platform: NodeJS.Platform): "darwin" | null {
  if (platform === "darwin") return platform;
  return null;
}

function validDriverFileIdentity(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, DRIVER_FILE_IDENTITY_KEYS) &&
    DRIVER_FILE_IDENTITY_KEYS.every(
      (key) => typeof (value as Record<string, unknown>)[key] === "string" && /^\d+$/.test((value as Record<string, string>)[key]),
    )
  );
}

function currentDriverFileIdentity(file: string): Record<string, string> {
  const stat = statSync(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameDriverFileIdentity(expected: unknown, actual: Record<string, string>): boolean {
  return (
    validDriverFileIdentity(expected) &&
    DRIVER_FILE_IDENTITY_KEYS.every((key) => expected[key] === actual[key])
  );
}

/** The cua-driver release and daemon contract this build mounts (shared with the Windows decoder, CONTRACT-REQ C1). */
export const CUA_DRIVER_VERSION = "0.55.0";
export const CUA_CONTRACT_VERSION = "0.9.0";

/** 0.55.0 sends telemetry and checks for updates unless told not to; upstream reads "0" and "false" as off for telemetry. */
function driverPhoneHomeOff(env: Record<string, unknown>): boolean {
  return (
    (env.CUA_DRIVER_RS_TELEMETRY_ENABLED === "0" || env.CUA_DRIVER_RS_TELEMETRY_ENABLED === "false") &&
    env.CUA_DRIVER_RS_UPDATE_CHECK === "false"
  );
}

export function decodeLegacyDescriptor(
  value: LegacyConnectionDescriptor,
  platform: NodeJS.Platform,
): LocalComputerConnection | null {
  const supportedPlatform = legacyPlatform(platform);
  // Only a complete connection the app says is ready: a known mode, a ready
  // status, the driver's socket, and the driver's own MCP subcommand. Anything
  // less (unavailable, stale, half written, hand edited) mounts nothing.
  if (
    !supportedPlatform || !value || typeof value !== "object" ||
    !(value.mode === "embedded" || (supportedPlatform === "darwin" && value.mode === "standalone")) ||
    value.status !== "ready" ||
    typeof value.socketPath !== "string" || !value.socketPath ||
    typeof value.mcpCommand !== "string" || !value.mcpCommand.trim()
  ) {
    return null;
  }
  if (!Array.isArray(value.mcpArgs) || value.mcpArgs[0] !== "mcp") return null;
  if (!value.mcpEnv || typeof value.mcpEnv !== "object" || Array.isArray(value.mcpEnv)) return null;
  const args: unknown[] = value.mcpArgs;
  if (!args.every((arg) => typeof arg === "string")) return null;
  const env = value.mcpEnv as Record<string, unknown>;
  if (!Object.values(env).every((entry) => typeof entry === "string")) return null;
  // CONTRACT-REQ C2: the Mac app writes both off-keys into every driver
  // process it starts (electron/cua.mjs CUA_ENV), so a darwin descriptor that
  // lacks either, or turns either on, was not written by it and mounts nothing.
  if (supportedPlatform === "darwin" && !driverPhoneHomeOff(env)) return null;
  return {
    command: value.mcpCommand,
    args,
    env: env as Record<string, string>,
    platform: supportedPlatform,
    scope: "local-computer",
  };
}

export function decodeLinuxDescriptor(value: LinuxConnectionDescriptor): LocalComputerConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x11 = value.mode === "linux-x11-supervised" && value.session === "x11";
  const wayland =
    value.mode === "linux-wayland-gnome-supervised" &&
    value.session === "wayland" &&
    value.compositor === "gnome-mutter";
  const descriptorKeys = [
    "schemaVersion",
    "mode",
    "platform",
    "session",
    "enabled",
    "status",
    "ownerPid",
    "generation",
    "driver",
    "daemon",
    "mcp",
    "toolNames",
    "doctorWarnings",
    ...(wayland ? ["compositor"] : []),
  ];
  if (
    (!x11 && !wayland) ||
    !exactKeys(value, descriptorKeys) ||
    value.schemaVersion !== 1 ||
    value.platform !== "linux" ||
    value.enabled !== true ||
    value.status !== "ready" ||
    !Number.isInteger(value.ownerPid) ||
    (value.ownerPid as number) <= 0 ||
    typeof value.generation !== "string" ||
    !/^[0-9a-f-]{32,64}$/i.test(value.generation)
  ) {
    return null;
  }

  const driver = value.driver as Record<string, unknown>;
  const daemon = value.daemon as Record<string, unknown>;
  const mcp = value.mcp as Record<string, unknown>;
  if (
    !driver ||
    !daemon ||
    !mcp ||
    Array.isArray(driver) ||
    Array.isArray(daemon) ||
    Array.isArray(mcp) ||
    !exactKeys(driver, ["path", "version", "source", "manifestSchema", "fileIdentity"]) ||
    !exactKeys(daemon, [
      "socketPath",
      "pid",
      "contractVersion",
      "toolsListSchemaVersion",
      "capabilityVersion",
      "mcpProtocolVersion",
    ]) ||
    !exactKeys(mcp, ["command", "args", "env"])
  ) {
    return null;
  }
  if (
    typeof driver.path !== "string" ||
    !isAbsolute(driver.path) ||
    driver.version !== CUA_DRIVER_VERSION ||
    !["bundled", "environment", "user-local", "path"].includes(String(driver.source)) ||
    driver.manifestSchema !== "1" ||
    !validDriverFileIdentity(driver.fileIdentity) ||
    typeof daemon.socketPath !== "string" ||
    !isAbsolute(daemon.socketPath) ||
    !Number.isInteger(daemon.pid) ||
    (daemon.pid as number) <= 0 ||
    daemon.contractVersion !== CUA_CONTRACT_VERSION ||
    daemon.toolsListSchemaVersion !== "1" ||
    daemon.capabilityVersion !== "1" ||
    daemon.mcpProtocolVersion !== "2025-06-18" ||
    mcp.command !== driver.path ||
    !Array.isArray(mcp.args) ||
    mcp.args.length !== 4 ||
    mcp.args[0] !== "mcp" ||
    mcp.args[1] !== "--embedded" ||
    mcp.args[2] !== "--socket" ||
    mcp.args[3] !== daemon.socketPath ||
    !mcp.env ||
    typeof mcp.env !== "object" ||
    Array.isArray(mcp.env) ||
    !exactKeys(mcp.env as Record<string, unknown>, [
      "CUA_DRIVER_EMBEDDED",
      "CUA_DRIVER_HOST_BUNDLE_ID",
      "CUA_DRIVER_RS_UPDATE_CHECK",
      "CUA_DRIVER_RS_TELEMETRY_ENABLED",
      ...(wayland ? ["CUA_DRIVER_RS_ENABLE_WAYLAND"] : []),
    ]) ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_EMBEDDED !== "1" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_HOST_BUNDLE_ID !== "com.murage.app" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_UPDATE_CHECK !== "false" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_TELEMETRY_ENABLED !== "false" ||
    (wayland && (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_ENABLE_WAYLAND !== "1")
  ) {
    return null;
  }

  if (
    !Array.isArray(value.toolNames) ||
    value.toolNames.some((name) => typeof name !== "string") ||
    REQUIRED_LINUX_TOOLS.some((name) => !(value.toolNames as string[]).includes(name)) ||
    !Array.isArray(value.doctorWarnings)
  ) {
    return null;
  }
  for (const warning of value.doctorWarnings) {
    if (
      !warning ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      ![3, 4].includes(Object.keys(warning).length) ||
      !Object.keys(warning).every((key) => ["label", "status", "message", "detail"].includes(key)) ||
      typeof warning.label !== "string" ||
      warning.status !== "warn" ||
      typeof warning.message !== "string" ||
      (warning.detail !== undefined && typeof warning.detail !== "string")
    ) {
      return null;
    }
  }

  return {
    command: driver.path,
    args: [...(mcp.args as string[])],
    env: { ...(mcp.env as Record<string, string>) },
    platform: "linux",
    generation: value.generation,
    scope: "local-computer",
  };
}

/** The Windows driver pin and the env every Windows driver process gets (DESIGN 1022-cua-windows D4/D5). */
export const WINDOWS_DRIVER_PIN = Object.freeze({
  version: WINDOWS_DRIVER_VERSION,
  contractVersion: WINDOWS_DRIVER_CONTRACT_VERSION,
  sha256: WINDOWS_DRIVER_SHA256,
});
export const WINDOWS_DRIVER_ENV = Object.freeze({
  CUA_DRIVER_EMBEDDED: "1",
  CUA_DRIVER_HOST_BUNDLE_ID: "com.murage.app",
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
  CUA_DRIVER_RS_UPDATE_CHECK: "false",
  DO_NOT_TRACK: "1",
});
const WINDOWS_PIPE = /^\\\\\.\\pipe\\murage-cua-\d+-[0-9a-f]{12}$/;
const WINDOWS_IDENTITY_KEYS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;

export function windowsDriverPath(resourcesPath: string): string {
  return winPath.join(resourcesPath, "cua-win32-x64", "cua-driver.exe");
}

/** The only win32 descriptor that mounts anything (D5): exact keys, the pinned version and contract, the driver at
 * `<resourcesPath>\cua-win32-x64\cua-driver.exe`, its sha256 equal to the server's OWN pin (never trusted from
 * the file), the private pipe name, and exactly the D4 env. Anything else is null (unavailable). */
export function decodeWindowsDescriptor(
  value: Record<string, unknown>,
  { resourcesPath, pin = WINDOWS_DRIVER_PIN }: { resourcesPath: string | undefined; pin?: { sha256: string; version?: string; contractVersion?: string } },
): (LocalComputerConnection & { driverSha256: string; pipe: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof resourcesPath !== "string" || !resourcesPath) return null;
  const version = pin.version ?? WINDOWS_DRIVER_PIN.version;
  const contractVersion = pin.contractVersion ?? WINDOWS_DRIVER_PIN.contractVersion;
  if (
    !exactKeys(value, ["mode", "platform", "schemaVersion", "status", "generation", "driver", "daemon", "mcp"]) ||
    value.mode !== "windows-supervised" ||
    value.platform !== "win32" ||
    value.schemaVersion !== 1 ||
    value.status !== "ready" ||
    typeof value.generation !== "string" ||
    !/^[0-9a-f]{12}$/.test(value.generation)
  ) return null;
  const driver = value.driver as Record<string, unknown>;
  const daemon = value.daemon as Record<string, unknown>;
  const mcp = value.mcp as Record<string, unknown>;
  const plain = (entry: unknown): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  if (
    !plain(driver) || !plain(daemon) || !plain(mcp) ||
    !exactKeys(driver, ["path", "version", "source", "sha256", "fileIdentity"]) ||
    !exactKeys(daemon, ["pipe", "pid", "contractVersion", "toolsListSchemaVersion", "capabilityVersion", "mcpProtocolVersion"]) ||
    !exactKeys(mcp, ["command", "args", "env"])
  ) return null;
  const identity = driver.fileIdentity;
  if (
    driver.path !== windowsDriverPath(resourcesPath) ||
    driver.version !== version ||
    driver.source !== "bundled" ||
    typeof pin.sha256 !== "string" || driver.sha256 !== pin.sha256 ||
    !plain(identity) || !exactKeys(identity, WINDOWS_IDENTITY_KEYS) ||
    !WINDOWS_IDENTITY_KEYS.every((key) => typeof identity[key] === "string" && /^\d+$/.test(identity[key] as string)) ||
    typeof daemon.pipe !== "string" || !WINDOWS_PIPE.test(daemon.pipe) ||
    !Number.isInteger(daemon.pid) || (daemon.pid as number) <= 0 ||
    daemon.contractVersion !== contractVersion ||
    daemon.toolsListSchemaVersion !== "1" ||
    daemon.capabilityVersion !== "1" ||
    daemon.mcpProtocolVersion !== "2025-06-18" ||
    mcp.command !== driver.path ||
    !Array.isArray(mcp.args) || mcp.args.length !== 4 ||
    mcp.args[0] !== "mcp" || mcp.args[1] !== "--embedded" || mcp.args[2] !== "--socket" || mcp.args[3] !== daemon.pipe ||
    !plain(mcp.env) || !exactKeys(mcp.env, Object.keys(WINDOWS_DRIVER_ENV)) ||
    Object.entries(WINDOWS_DRIVER_ENV).some(([key, expected]) => (mcp.env as Record<string, unknown>)[key] !== expected)
  ) return null;
  return {
    command: driver.path as string,
    args: [...(mcp.args as string[])],
    env: { ...WINDOWS_DRIVER_ENV },
    platform: "win32",
    generation: value.generation,
    scope: "local-computer",
    driverSha256: pin.sha256,
    pipe: daemon.pipe,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedPrivate(stat: Stats, uid: number): boolean {
  return (stat.uid === uid || stat.uid === 0) && (stat.mode & 0o077) === 0;
}

export function validateLinuxDescriptorRuntime(
  descriptorFile: string,
  raw: LinuxConnectionDescriptor,
  {
    uid = process.getuid?.() ?? -1,
    isProcessAlive = processAlive,
  }: { uid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): boolean {
  try {
    const descriptorStat = lstatSync(descriptorFile);
    const descriptorDirectoryStat = lstatSync(dirname(descriptorFile));
    if (
      !descriptorStat.isFile() ||
      descriptorStat.isSymbolicLink() ||
      !ownedPrivate(descriptorStat, uid) ||
      !descriptorDirectoryStat.isDirectory() ||
      descriptorDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(descriptorDirectoryStat, uid)
    ) {
      return false;
    }

    const driver = raw.driver as Record<string, unknown>;
    const daemon = raw.daemon as Record<string, unknown>;
    const binaryPath = driver.path as string;
    const socketPath = daemon.socketPath as string;
    const binaryStat = statSync(binaryPath);
    const currentFileIdentity = currentDriverFileIdentity(binaryPath);
    const socketStat = lstatSync(socketPath);
    const socketDirectoryStat = lstatSync(dirname(socketPath));
    if (
      realpathSync(binaryPath) !== binaryPath ||
      !sameDriverFileIdentity(driver.fileIdentity, currentFileIdentity) ||
      !binaryStat.isFile() ||
      (binaryStat.uid !== uid && binaryStat.uid !== 0) ||
      (binaryStat.mode & 0o111) === 0 ||
      (binaryStat.mode & 0o022) !== 0 ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      !ownedPrivate(socketStat, uid) ||
      !socketDirectoryStat.isDirectory() ||
      socketDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(socketDirectoryStat, uid) ||
      !isProcessAlive(raw.ownerPid as number) ||
      !isProcessAlive(daemon.pid as number)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A legacy darwin/win32 descriptor still names ANY command to run, and
 * unlike the Linux one it carries nothing the shape check can bind to a
 * driver we shipped. So at runtime the file itself has to be one only this
 * user could have written: a regular file, not a symlink, owned by this user
 * and closed against group and other writes — and in a directory with the
 * same properties, because a directory anyone may write is how a
 * well-permissioned file gets replaced.
 *
 * libuv reports every writable Windows file as uid 0 mode 0o666, so the
 * ownership and permission bits cannot carry meaning there; on win32 only
 * the regular-file and symlink refusals apply. */
export function validateLegacyDescriptorRuntime(
  descriptorFile: string,
  platform: NodeJS.Platform,
  { uid = process.getuid?.() ?? -1 }: { uid?: number } = {},
): boolean {
  try {
    const descriptorStat = lstatSync(descriptorFile);
    const directoryStat = lstatSync(dirname(descriptorFile));
    if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) return false;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    if (platform === "win32") return true;
    if (descriptorStat.uid !== uid || (descriptorStat.mode & 0o022) !== 0) return false;
    if (directoryStat.uid !== uid || (directoryStat.mode & 0o022) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.MURAGE_USER_DATA,
  home = homedir(),
  validateLinuxRuntime = validateLinuxDescriptorRuntime,
  validateLegacyRuntime = validateLegacyDescriptorRuntime,
  resourcesPath = process.env.MURAGE_RESOURCES_PATH,
  windowsPin = WINDOWS_DRIVER_PIN,
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
  validateLinuxRuntime?: (file: string, raw: LinuxConnectionDescriptor) => boolean;
  validateLegacyRuntime?: (file: string, platform: NodeJS.Platform) => boolean;
  resourcesPath?: string;
  windowsPin?: { sha256: string; version?: string; contractVersion?: string };
} = {}): LocalComputerConnection | null {
  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (platform === "darwin" && !userData) {
    // Legacy/dev fallback, only when Electron did not name its exact folder.
    for (const directory of ["Murage", "murage", "OpenGrokBot", "opengrokbot"]) {
      candidates.push(join(home, "Library", "Application Support", directory, "cua-connection.json"));
    }
  }

  const file = firstPresentCuaDescriptor(candidates);
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (platform === "linux") {
      const decoded = decodeLinuxDescriptor(raw);
      if (decoded && validateLinuxRuntime(file, raw)) return decoded;
    } else if (platform === "win32") {
      // Never the legacy decoder (D5): only the pinned, supervised shape.
      const decoded = decodeWindowsDescriptor(raw, { resourcesPath, pin: windowsPin });
      if (decoded && validateLegacyRuntime(file, platform)) return decoded;
    } else {
      const decoded = decodeLegacyDescriptor(raw, platform);
      if (decoded && validateLegacyRuntime(file, platform)) return decoded;
    }
  } catch {
    // Invalid, tampered, or stale descriptors are unavailable.
  }
  return null;
}

/** The first candidate that exists decides. An older folder can never stand
 * in for a present but unavailable, malformed or unreadable descriptor at a
 * more specific place (upstream #1730). */
function firstPresentCuaDescriptor(candidates: string[]): string | null {
  for (const file of new Set(candidates)) {
    try {
      lstatSync(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return file;
    }
  }
  return null;
}
