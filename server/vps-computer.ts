// BYO Linux VPS computer. The agent process stays local; Docker's own SSH
// transport reaches the user's daemon and the official Cua MCP server stays
// inside one managed container per bot.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DRIVER_LABEL,
  IMAGE as CUA_IMAGE,
  MANAGED_LABEL,
  managedImageDockerfile,
} from "./container-computer.ts";
import { isValidSshAlias, vpsSshAlias, type AppConfig } from "./config.ts";
import { augmentedPath } from "./env-path.ts";

export const VPS_IMAGE = CUA_IMAGE;
export const VPS_MANAGED_LABEL = "com.openmausbot.vps";
export const VPS_CONTAINER_LABEL = "com.openmausbot.container";
export const VPS_CONTAINER_PREFIX = "openmausbot-vps";

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;
const MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const NANO_CPUS = 2_000_000_000;
const PIDS_LIMIT = 512;
const SHM_BYTES = 512 * 1024 * 1024;
const SCREENSHOT_PATH = "/tmp/openmausbot-vps-preview.png";
const lifecycleLocks = new Map<string, Promise<void>>();

export interface VpsCommandOptions {
  input?: string;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type VpsLifecycleAction = "provision" | "start" | "stop";

export interface VpsComputerStatus {
  configured: boolean;
  sshAlias: string | null;
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "private" | "unsafe" | "unknown";
  mounts: "none" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  container_id: string | null;
  image_id: string | null;
}

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

/** Stable across restarts and independent of the bot's editable display name. */
export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

export function vpsDockerArgs(alias: string, args: string[]): string[] {
  if (!isValidSshAlias(alias)) {
    throw new Error("invalid VPS SSH config alias");
  }
  return ["-H", `ssh://${alias}`, ...args];
}

function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Docker-over-SSH command timed out"));
    }, options.timeoutMs ?? 120_000);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-16 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16 * 1024 * 1024);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Docker-over-SSH could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim().slice(-1000);
      reject(new Error(detail || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`));
    });
    child.stdin.end(options.input);
  });
}

function emptyStatus(botId: string, alias: string | null): VpsComputerStatus {
  return {
    configured: Boolean(alias),
    sshAlias: alias,
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    mounts: "unknown",
    security: "unknown",
    desktopReady: false,
    ready: false,
    problem: alias ? "Docker over SSH is not reachable" : "Configure a VPS SSH alias in App Settings → Connections",
    image_ref: VPS_IMAGE,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: vpsContainerName(botId),
    container_id: null,
    image_id: null,
  };
}

function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST
  );
}

function dockerSecurityIsHardened(config: {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
} | undefined): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  return (
    config.Memory === MEMORY_BYTES &&
    (config.MemorySwap ?? 0) === MEMORY_BYTES &&
    (config.NanoCpus ?? 0) === NANO_CPUS &&
    config.PidsLimit === PIDS_LIMIT &&
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid" &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    config.ShmSize === SHM_BYTES &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.OomKillDisable !== true &&
    config.AutoRemove !== true &&
    !config.RestartPolicy?.Name
  );
}

function hasNoHostMounts(detail: {
  Mounts?: unknown;
  HostConfig?: { Binds?: string[] | null; VolumesFrom?: string[] | null };
}): boolean {
  return (
    Array.isArray(detail.Mounts) &&
    detail.Mounts.length === 0 &&
    (!detail.HostConfig?.Binds || detail.HostConfig.Binds.length === 0) &&
    (!detail.HostConfig?.VolumesFrom || detail.HostConfig.VolumesFrom.length === 0)
  );
}

function hasNoPublishedPorts(config: {
  NetworkMode?: string;
  PortBindings?: Record<string, unknown> | null;
  PublishAllPorts?: boolean;
} | undefined, networks?: Record<string, unknown> | null): boolean {
  if (!config) return false;
  const networkMode = (config.NetworkMode ?? "").toLowerCase();
  if (!["default", "bridge"].includes(networkMode)) return false;
  const attached = Object.keys(networks ?? {}).map((name) => name.toLowerCase());
  if (attached.length !== 1 || !["default", "bridge"].includes(attached[0]!)) return false;
  return (
    config.PublishAllPorts !== true &&
    !Object.values(config.PortBindings ?? {}).some((value) => Array.isArray(value) && value.length > 0)
  );
}

function statusProblem(status: VpsComputerStatus): string | null {
  if (!status.configured) return "Configure a VPS SSH alias in App Settings → Connections";
  if (!status.daemonUp) return "Docker over SSH could not reach the VPS; check the SSH alias and Docker on the VPS";
  if (!status.image) return `Prepare the pinned OpenMausBot Cua image on the VPS (Driver ${CUA_DRIVER_VERSION})`;
  if (status.container === "missing") return "No OpenMausBot container exists for this bot on the VPS";
  if (!status.imageMatches) return "The VPS container uses an incompatible or untrusted OpenMausBot image";
  if (!status.managed) return "The VPS container name is occupied by a container OpenMausBot did not create";
  if (status.network === "unsafe") return "The VPS container uses an unapproved network or publishes ports; refusing to use it";
  if (status.mounts === "unsafe") return "The VPS container has host mounts; refusing to use it";
  if (status.security === "unsafe") return "The VPS container is missing OpenMausBot safety limits";
  if (status.container === "stopped") return "The OpenMausBot VPS container is stopped";
  if (!status.desktopReady) return "The VPS container started, but Cua Driver is not ready yet";
  return null;
}

export async function vpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const status = emptyStatus(botId, alias);
  if (!alias) return status;
  const run = (args: string[], timeoutMs = 10_000, input?: string) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs, input });

  try {
    await run(["info", "--format", "{{.ServerVersion}}"]);
    status.daemonUp = true;
  } catch {
    status.problem = statusProblem(status);
    return status;
  }

  let inspectedImageId: string | null = null;
  try {
    const inspected = JSON.parse((await run(["image", "inspect", VPS_IMAGE])).stdout) as Array<{
      Id?: string;
      id?: string;
      Config?: { Labels?: Record<string, string> };
      config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    }>;
    const image = inspected[0];
    const labels = image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels;
    const imageId = image?.Id ?? image?.id;
    inspectedImageId = imageId && IMAGE_ID.test(imageId) ? imageId : null;
    status.image_id = inspectedImageId;
    status.image = Boolean(inspectedImageId) && imageLabelsMatch(labels);
  } catch {
    status.image = false;
  }

  try {
    const inspected = JSON.parse((await run(["inspect", status.container_name])).stdout) as Array<{
      Config?: { Image?: string; Labels?: Record<string, string> };
      HostConfig?: {
        Binds?: string[] | null;
        VolumesFrom?: string[] | null;
        NetworkMode?: string;
        PortBindings?: Record<string, unknown> | null;
        PublishAllPorts?: boolean;
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number | null;
        CapDrop?: string[] | null;
        CapAdd?: string[] | null;
        Privileged?: boolean;
        PidMode?: string;
        IpcMode?: string;
        UTSMode?: string;
        ShmSize?: number;
        Devices?: unknown[] | null;
        DeviceRequests?: unknown[] | null;
        SecurityOpt?: string[] | null;
        UsernsMode?: string;
        CgroupnsMode?: string;
        OomKillDisable?: boolean | null;
        AutoRemove?: boolean;
        RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
      };
      Id?: string;
      id?: string;
      Image?: string;
      NetworkSettings?: { Networks?: Record<string, unknown> | null };
      Mounts?: unknown;
      State?: { Running?: boolean };
    }>;
    const detail = inspected[0];
    const labels = detail?.Config?.Labels;
    const containerId = detail?.Id ?? detail?.id;
    status.container_id = containerId && CONTAINER_ID.test(containerId) ? containerId : null;
    status.container = detail?.State?.Running ? "running" : "stopped";
    status.imageMatches =
      status.image &&
      Boolean(status.container_id) &&
      (detail?.Config?.Image === VPS_IMAGE || detail?.Config?.Image === inspectedImageId) &&
      Boolean(inspectedImageId) &&
      detail?.Image === inspectedImageId &&
      imageLabelsMatch(labels);
    status.managed =
      labels?.[VPS_MANAGED_LABEL] === "1" && labels?.[VPS_CONTAINER_LABEL] === status.container_name;
    status.network = hasNoPublishedPorts(detail?.HostConfig, detail?.NetworkSettings?.Networks) ? "private" : "unsafe";
    status.mounts = hasNoHostMounts(detail ?? {}) ? "none" : "unsafe";
    status.security = dockerSecurityIsHardened(detail?.HostConfig) ? "hardened" : "unsafe";

    const canProbe =
      status.container === "running" &&
      status.image &&
      status.imageMatches &&
      status.managed &&
      status.network === "private" &&
      status.mounts === "none" &&
      status.security === "hardened";
    if (canProbe) {
      const exec = [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        "-e",
        "DISPLAY=:1",
        "-e",
        "CUA_DRIVER_INSTALL_CHANNEL=python_package",
        status.container_name,
        CUA_EXECUTABLE,
      ];
      try {
        const version = await run([...exec, "--version"]);
        if (version.stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) throw new Error("unexpected Cua Driver version");
        await run([...exec, "status", "--socket", CUA_SOCKET]);
        status.desktopReady = true;
      } catch {
        status.desktopReady = false;
      }
    }
  } catch {
    status.container = "missing";
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

export function vpsContainerRunArgs(containerName: string, imageRef = VPS_IMAGE): string[] {
  if (!CONTAINER_NAME.test(containerName) || (imageRef !== VPS_IMAGE && !IMAGE_ID.test(imageRef))) {
    throw new Error("invalid managed VPS container or image reference");
  }
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${VPS_MANAGED_LABEL}=1`,
    "--label",
    `${VPS_CONTAINER_LABEL}=${containerName}`,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--cpus",
    "2",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--shm-size",
    "512m",
    imageRef,
  ];
}

function assertUsableContainer(status: VpsComputerStatus) {
  if (
    !status.image ||
    !status.imageMatches ||
    !status.managed ||
    status.network !== "private" ||
    status.mounts !== "none" ||
    status.security !== "hardened"
  ) {
    throw Object.assign(new Error(status.problem ?? "The existing VPS container is unsafe or incompatible"), {
      status: 409,
    });
  }
}

async function prepareVpsImage(alias: string, runner: VpsCommandRunner) {
  await runner(vpsDockerArgs(alias, ["pull", BASE_IMAGE]), { timeoutMs: 10 * 60_000 });
  await runner(vpsDockerArgs(alias, ["build", "-t", VPS_IMAGE, "-"]), {
    input: managedImageDockerfile(),
    timeoutMs: 10 * 60_000,
  });
}

async function waitForVpsReady(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
  budgetMs = 60_000,
): Promise<VpsComputerStatus> {
  const deadline = Date.now() + budgetMs;
  let status = await vpsComputerStatus(cfg, botId, runner);
  while (!status.ready && Date.now() < deadline) {
    if (
      !status.daemonUp ||
      !status.image ||
      !status.imageMatches ||
      !status.managed ||
      status.container !== "running" ||
      status.network !== "private" ||
      status.mounts !== "none" ||
      status.security !== "hardened"
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    status = await vpsComputerStatus(cfg, botId, runner);
  }
  return status;
}

async function withVpsLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleLocks.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
  }
}

function vpsLockKey(cfg: AppConfig, botId: string): string | null {
  const alias = vpsSshAlias(cfg);
  return alias ? `${alias}:${vpsContainerName(botId)}` : null;
}

export async function vpsComputerAction(
  action: VpsLifecycleAction,
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in App Settings → Connections"), { status: 409 });
  const operation = async () => {
    const before = await vpsComputerStatus(cfg, botId, runner);
    if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? "Docker over SSH is not reachable"), { status: 409 });
    const run = (args: string[], timeoutMs = 2 * 60_000) => runner(vpsDockerArgs(alias, args), { timeoutMs });

    const containerRef = before.container_id ?? before.container_name;
    if (action === "provision") {
      if (before.container === "missing") {
        if (!before.image) await prepareVpsImage(alias, runner);
        const imageRef = before.image_id ?? (await vpsComputerStatus(cfg, botId, runner)).image_id;
        if (!imageRef) throw Object.assign(new Error("The prepared VPS image could not be identified"), { status: 409 });
        await run(vpsContainerRunArgs(before.container_name, imageRef));
      } else {
        assertUsableContainer(before);
        if (before.container === "stopped") await run(["start", containerRef]);
      }
    } else if (action === "start") {
      if (before.container === "missing") throw Object.assign(new Error("No VPS container exists for this bot"), { status: 409 });
      if (before.container === "running") throw Object.assign(new Error("The VPS container is already running"), { status: 409 });
      assertUsableContainer(before);
      await run(["start", containerRef]);
    } else {
      if (before.container !== "running") throw Object.assign(new Error("The VPS container is not running"), { status: 409 });
      assertUsableContainer(before);
      await run(["stop", containerRef]);
    }
    return action === "stop" ? vpsComputerStatus(cfg, botId, runner) : waitForVpsReady(cfg, botId, runner);
  };
  return withVpsLifecycleLock(vpsLockKey(cfg, botId)!, operation);
}

/** Auto is intentionally read-only: it can attach only to an existing ready container. */
export async function reuseVps(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus | null> {
  const key = vpsLockKey(cfg, botId);
  const status = await (key ? withVpsLifecycleLock(key, () => vpsComputerStatus(cfg, botId, runner)) : vpsComputerStatus(cfg, botId, runner));
  return status.ready ? status : null;
}

function bridgePath(): string {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "vps-container-mcp.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
}

export function vpsContainerMcpArgs(alias: string, containerName: string): string[] {
  if (!isValidSshAlias(alias) || (!CONTAINER_NAME.test(containerName) && !CONTAINER_ID.test(containerName))) {
    throw new Error("invalid VPS MCP connection");
  }
  return vpsDockerArgs(alias, [
    "exec",
    "-i",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    "DISPLAY=:1",
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    containerName,
    CUA_EXECUTABLE,
    "mcp",
    "--socket",
    CUA_SOCKET,
  ]);
}

export function vpsComputerMcp(cfg: AppConfig, botId: string, containerRef?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw new Error("VPS is not configured — add an SSH config alias first");
  return {
    command: process.execPath,
    args: [bridgePath(), alias, containerRef ?? vpsContainerName(botId)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function vpsDriverError(driverKind: string, computerMcp: boolean): string | null {
  if (driverKind === "boxAgent") {
    return "The Computer engine runs its agent on Box and cannot use a self-hosted VPS — choose Claude or an ACP engine";
  }
  if (!computerMcp) {
    return "This model engine cannot mount a self-hosted VPS computer — choose Claude or an ACP engine";
  }
  return null;
}

function validImage(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length < 512) return null;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png && bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii"))) return "image/png";
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9]))
    ? "image/jpeg"
    : null;
}

export async function vpsComputerScreenshot(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  return withVpsLifecycleLock(vpsLockKey(cfg, botId)!, async () => {
    const status = await vpsComputerStatus(cfg, botId, runner);
    if (!status.ready) throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
    const containerRef = status.container_id ?? status.container_name;
    const exec = [
      "exec",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      "-e",
      "DISPLAY=:1",
      "-e",
      "CUA_DRIVER_INSTALL_CHANNEL=python_package",
      containerRef,
      CUA_EXECUTABLE,
      "call",
      "get_desktop_state",
      "{}",
      "--socket",
      CUA_SOCKET,
      "--screenshot-out-file",
      SCREENSHOT_PATH,
    ];
    try {
      await runner(vpsDockerArgs(alias, exec), { timeoutMs: 30_000 });
      const encoded = (await runner(vpsDockerArgs(alias, [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        containerRef,
        "base64",
        "-w0",
        SCREENSHOT_PATH,
      ]), { timeoutMs: 30_000 })).stdout.trim();
      const mime = validImage(Buffer.from(encoded, "base64"));
      if (!mime) throw Object.assign(new Error("Cua Driver returned an incomplete VPS screenshot"), { status: 502 });
      return { png: encoded, format: mime === "image/jpeg" ? "jpeg" : "png" };
    } finally {
      await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerRef, "rm", "-f", SCREENSHOT_PATH]), {
        timeoutMs: 10_000,
      }).catch(() => {});
    }
  });
}
