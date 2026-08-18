import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  DISPLAY,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import type { AppConfig } from "./config.ts";
import {
  VPS_CONTAINER_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  vpsComputerAction,
  vpsComputerScreenshot,
  vpsComputerStatus,
  vpsComputerMcp,
  vpsContainerMcpArgs,
  vpsContainerName,
  vpsContainerRunArgs,
  vpsDockerArgs,
  vpsDriverError,
  reuseVps,
  type VpsCommandRunner,
} from "./vps-computer.ts";

const BOT_ID = "bot-1234-abcd";
const CONFIG: AppConfig = { vps: { sshAlias: "production-vps" } };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const screenshot = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function fixture({
  image = true,
  container = true,
  running = true,
  managed = true,
  mounts = false,
  publicPorts = false,
  publishAllPorts = false,
  deviceRequests = false,
  networkMode = "default",
  containerImageId = IMAGE_ID,
  inspectedImageId = IMAGE_ID,
  rebuiltImageId,
  containerId = CONTAINER_ID,
  privileged = false,
  pidMode = "",
  ipcMode,
  capAdd = ["CAP_SETUID", "CAP_SETGID"],
  screenshotValid = true,
  screenshotCaptureFails = false,
  securityOpt = [],
  memory = 4 * 1024 * 1024 * 1024,
  restartPolicyName = "no",
  cgroupnsMode,
  imageLabelsMatch = true,
}: {
  image?: boolean;
  container?: boolean;
  running?: boolean;
  managed?: boolean;
  mounts?: boolean;
  publicPorts?: boolean;
  publishAllPorts?: boolean;
  deviceRequests?: boolean;
  networkMode?: string;
  containerImageId?: string;
  inspectedImageId?: string;
  rebuiltImageId?: string;
  containerId?: string;
  privileged?: boolean;
  pidMode?: string;
  ipcMode?: string;
  capAdd?: string[];
  screenshotValid?: boolean;
  screenshotCaptureFails?: boolean;
  securityOpt?: string[];
  memory?: number;
  restartPolicyName?: string;
  cgroupnsMode?: string;
  imageLabelsMatch?: boolean;
} = {}) {
  const name = vpsContainerName(BOT_ID);
  const provisioningArgs = vpsContainerRunArgs(name);
  const argValue = (flag: string) => {
    const index = provisioningArgs.indexOf(flag);
    if (index >= 0) return provisioningArgs[index + 1] ?? "";
    return provisioningArgs.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? "";
  };
  const calls: Array<{ args: string[]; options?: { input?: string; timeoutMs?: number } }> = [];
  const state = { image, container, running, imageLabelsMatch, inspectedImageId };
  const runner: VpsCommandRunner = async (args, options) => {
    calls.push({ args, options });
    const command = args[2];
    if (command === "info") return { stdout: "29\n", stderr: "" };
    if (command === "image") {
      if (!state.image) throw new Error("missing image");
      return {
        stdout: JSON.stringify([{
          Config: { Labels: state.imageLabelsMatch ? {
             [MANAGED_LABEL]: "1",
             [DRIVER_LABEL]: CUA_DRIVER_VERSION,
             [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
             [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          } : { [MANAGED_LABEL]: "0" } },
          Id: state.inspectedImageId,
        }]),
        stderr: "",
      };
    }
    if (command === "inspect") {
      if (!state.container) throw new Error("missing container");
      return {
        stdout: JSON.stringify([{
          Config: {
            Image: state.image ? VPS_IMAGE : "old-image",
            Labels: {
              [VPS_MANAGED_LABEL]: managed ? "1" : "0",
              [VPS_CONTAINER_LABEL]: managed ? name : "other-container",
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
            },
          },
           Id: containerId,
          Image: state.image ? containerImageId : "old-image-id",
          HostConfig: {
            Binds: mounts ? ["/host:/container"] : [],
            VolumesFrom: [],
            NetworkMode: networkMode,
            PortBindings: publicPorts ? { "6901/tcp": [{ HostIp: "0.0.0.0" }] } : {},
            PublishAllPorts: publishAllPorts,
            Memory: memory,
            MemorySwap: 4 * 1024 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
            PidsLimit: 512,
            CapDrop: ["ALL"],
            CapAdd: capAdd,
            Privileged: privileged,
            PidMode: pidMode,
            IpcMode: ipcMode ?? argValue("--ipc"),
            UTSMode: "",
            ShmSize: 512 * 1024 * 1024,
            Devices: [],
            DeviceRequests: deviceRequests ? [{ Driver: "nvidia" }] : [],
            SecurityOpt: securityOpt,
            UsernsMode: "",
            CgroupnsMode: cgroupnsMode ?? argValue("--cgroupns"),
            OomKillDisable: false,
            AutoRemove: false,
            RestartPolicy: { Name: restartPolicyName, MaximumRetryCount: 0 },
          },
          NetworkSettings: {
            Networks: { [networkMode === "default" ? "bridge" : networkMode]: {} },
          },
          Mounts: mounts ? [{ Source: "/host", Destination: "/container" }] : [],
          State: { Running: state.running },
        }]),
        stderr: "",
      };
    }
    if (command === "exec") {
      if (screenshotCaptureFails && args.includes("get_desktop_state")) throw new Error("capture failed");
      if (args.includes("base64")) return { stdout: screenshotValid ? screenshot.toString("base64") : "not-an-image", stderr: "" };
      if (args.at(-1) === "--version") return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n`, stderr: "" };
      if (args.includes("status")) return { stdout: "running\n", stderr: "" };
      if (args.includes("health_report")) {
        return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }), stderr: "" };
      }
      if (args.includes("get_desktop_state")) return { stdout: "{}\n", stderr: "" };
      return { stdout: "{}\n", stderr: "" };
    }
    if (command === "pull") return { stdout: "pulled\n", stderr: "" };
    if (command === "build") {
      state.image = true;
      state.imageLabelsMatch = true;
      state.inspectedImageId = rebuiltImageId ?? state.inspectedImageId;
      expect(options?.input).toContain(`FROM ${BASE_IMAGE}`);
      return { stdout: "built\n", stderr: "" };
    }
    if (command === "run") {
      state.container = true;
      state.running = true;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "start") {
      state.running = true;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "stop") {
      state.running = false;
      return { stdout: `${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected Docker command ${command}`);
  };
  return { calls, runner, state, name };
}

describe("VPS computer", () => {
  it("uses a deterministic, bot-id-derived managed container name", () => {
    expect(vpsContainerName(BOT_ID)).toBe(vpsContainerName(BOT_ID));
    expect(vpsContainerName(BOT_ID)).not.toBe(vpsContainerName("another-bot"));
    expect(vpsContainerName(BOT_ID)).toMatch(/^openmausbot-vps-[a-z0-9-]+$/);
  });

  it("passes the SSH target as one validated Docker argv value", () => {
    expect(vpsDockerArgs("production-vps", ["info"])).toEqual(["-H", "ssh://production-vps", "info"]);
    for (const alias of ["production-vps;touch", "ssh://production-vps", "-H", "--host=evil", "prod vps", "prod\n-v"] ) {
      expect(() => vpsDockerArgs(alias, ["info"])).toThrow(/alias/);
    }
    expect(() => vpsContainerMcpArgs("production-vps", "not a container")).toThrow(/connection/);
  });

  it("reports a ready container only when image, labels, limits, mounts, network, and Cua pass", async () => {
    const fake = fixture();
    const status = await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    expect(status).toMatchObject({
      configured: true,
      daemonUp: true,
      image: true,
      imageMatches: true,
      managed: true,
      network: "private",
      mounts: "none",
      security: "hardened",
      desktopReady: true,
      ready: true,
      problem: null,
    });
    expect(fake.calls[0]?.args).toEqual(["-H", "ssh://production-vps", "info", "--format", "{{.ServerVersion}}"]);
    const probes = fake.calls.filter(
      ({ args }) =>
        args[2] === "exec" &&
        (args.at(-1) === "--version" || args.includes("status") || args.includes("health_report") || args.includes("get_desktop_state")),
    );
    expect(probes).toHaveLength(4);
    expect(probes.every(({ args }) => args.includes(CONTAINER_ID))).toBe(true);
    expect(probes.every(({ args }) => !args.includes(fake.name))).toBe(true);
    expect(probes.every(({ args }) => args.includes(`DISPLAY=${DISPLAY}`))).toBe(true);
    expect(probes.every(({ args }) => args.includes("CUA_DRIVER_RS_TELEMETRY_ENABLED=0"))).toBe(true);
  });

  it("refuses host mounts, public ports, and unowned containers", async () => {
    const mounted = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ mounts: true }).runner);
    expect(mounted.ready).toBe(false);
    expect(mounted.mounts).toBe("unsafe");

    const publicPorts = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publicPorts: true }).runner);
    expect(publicPorts.ready).toBe(false);
    expect(publicPorts.network).toBe("unsafe");

    const publishedAll = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publishAllPorts: true }).runner);
    expect(publishedAll.ready).toBe(false);
    expect(publishedAll.network).toBe("unsafe");

    const devices = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ deviceRequests: true }).runner);
    expect(devices.ready).toBe(false);
    expect(devices.security).toBe("unsafe");

    const sharedNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "shared-net" }).runner);
    expect(sharedNetwork.ready).toBe(false);
    expect(sharedNetwork.network).toBe("unsafe");

    const hostNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "host" }).runner);
    expect(hostNetwork.ready).toBe(false);
    expect(hostNetwork.network).toBe("unsafe");

    const privileged = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ privileged: true }).runner);
    expect(privileged.ready).toBe(false);
    expect(privileged.security).toBe("unsafe");

    const hostNamespaces = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ pidMode: "host", ipcMode: "host" }).runner,
    );
    expect(hostNamespaces.ready).toBe(false);
    expect(hostNamespaces.security).toBe("unsafe");

    const extraCapability = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ capAdd: ["CAP_SETUID", "CAP_SETGID", "CAP_SYS_ADMIN"] }).runner,
    );
    expect(extraCapability.ready).toBe(false);
    expect(extraCapability.security).toBe("unsafe");

    const unsafeProfile = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ securityOpt: ["seccomp=unconfined"], memory: 1024, restartPolicyName: "always", cgroupnsMode: "host" }).runner,
    );
    expect(unsafeProfile.ready).toBe(false);
    expect(unsafeProfile.security).toBe("unsafe");

    const wrongImage = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerImageId: "c".repeat(64) }).runner);
    expect(wrongImage.ready).toBe(false);
    expect(wrongImage.imageMatches).toBe(false);

    const malformedImageId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ inspectedImageId: "--help" }).runner);
    expect(malformedImageId.ready).toBe(false);
    expect(malformedImageId.image).toBe(false);

    const malformedContainerId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerId: "--help" }).runner);
    expect(malformedContainerId.ready).toBe(false);
    expect(malformedContainerId.container_id).toBeNull();

    const unowned = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ managed: false }).runner);
    expect(unowned.ready).toBe(false);
    expect(unowned.managed).toBe(false);
  });

  it("lets explicit provisioning build and run the pinned container, but Auto only reuses", async () => {
    const auto = fixture({ image: false, container: false });
    expect(await reuseVps(CONFIG, BOT_ID, auto.runner)).toBeNull();
    expect(auto.calls.some(({ args }) => ["run", "start", "build", "pull"].includes(args[2]!))).toBe(false);

    const provision = fixture({ image: false, container: false });
    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run).toContain("--memory");
    expect(run).toContain("--pids-limit");
    expect(run).toContain("--ipc");
    expect(run[run.indexOf("--ipc") + 1]).toBe("private");
    expect(run).toContain("--cgroupns");
    expect(run[run.indexOf("--cgroupns") + 1]).toBe("private");
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.join(" ")).toContain(`--label ${VPS_MANAGED_LABEL}=1`);
    expect(run.join(" ")).toContain(`--label ${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`);
    expect(run).not.toContain("--mount");
    expect(run).not.toContain("-p");
    expect(provision.calls.some(({ args }) => args[2] === "build")).toBe(true);
  });

  it("uses the image id produced by a rebuild", async () => {
    const staleImageId = `sha256:${"b".repeat(64)}`;
    const provision = fixture({
      image: true,
      imageLabelsMatch: false,
      container: false,
      inspectedImageId: staleImageId,
      rebuiltImageId: IMAGE_ID,
    });

    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.at(-1)).not.toBe(staleImageId);
  });

  it("starts and sleeps only the managed container, never the VPS", async () => {
    const start = fixture({ running: false });
    const started = await vpsComputerAction("start", CONFIG, BOT_ID, start.runner);
    expect(started.container).toBe("running");
    expect(start.calls.some(({ args }) => args[2] === "start")).toBe(true);
    expect(start.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);

    const stop = fixture();
    const stopped = await vpsComputerAction("stop", CONFIG, BOT_ID, stop.runner);
    expect(stopped.container).toBe("stopped");
    expect(stop.calls.some(({ args }) => args[2] === "stop" && args[3] === CONTAINER_ID)).toBe(true);
    expect(stop.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);
  });

  it("serializes concurrent provisioning for the same bot", async () => {
    const fake = fixture({ image: false, container: false });
    const results = await Promise.all([
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
    ]);
    expect(results.every((status) => status.ready)).toBe(true);
    expect(fake.calls.filter(({ args }) => args[2] === "run")).toHaveLength(1);
  });

  it("mounts the official Cua MCP server through the tiny remote exec bridge", () => {
    const connection = vpsComputerMcp(CONFIG, BOT_ID);
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.slice(-2)).toEqual(["production-vps", vpsContainerName(BOT_ID)]);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(vpsComputerMcp(CONFIG, BOT_ID, CONTAINER_ID).args.slice(-2)).toEqual(["production-vps", CONTAINER_ID]);
    expect(vpsContainerMcpArgs("production-vps", vpsContainerName(BOT_ID))).toEqual([
      "-H",
      "ssh://production-vps",
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
      "-e",
      "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
      vpsContainerName(BOT_ID),
      "/usr/local/libexec/openmausbot/cua-driver",
      "mcp",
      "--socket",
      "/run/user/1000/openmausbot-cua.sock",
    ]);
  });

  it("captures screenshots through Cua Driver and validates the returned image", async () => {
    const fake = fixture();
    const frame = await vpsComputerScreenshot(CONFIG, BOT_ID, fake.runner);
    expect(frame).toEqual({ png: screenshot.toString("base64"), format: "png" });
    expect(fake.calls.some(({ args }) => args.includes("get_desktop_state"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("base64") && args.includes("-u") && args.includes("cua"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);

    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, fixture({ screenshotValid: false }).runner)).rejects.toThrow(/incomplete/);

    const failedCapture = fixture({ screenshotCaptureFails: true });
    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, failedCapture.runner)).rejects.toThrow(/capture failed/);
    expect(failedCapture.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);
  });

  it("fails clearly for BoxAgent and engines without computer MCP", () => {
    expect(vpsDriverError("boxAgent", true)).toMatch(/cannot use a self-hosted VPS/);
    expect(vpsDriverError("codex", false)).toMatch(/cannot mount/);
    expect(vpsDriverError("claudeAgent", true)).toBeNull();
  });

  it("fails cleanly when no VPS alias is configured", async () => {
    await expect(vpsComputerAction("provision", {}, BOT_ID, fixture().runner)).rejects.toThrow(/not configured/);
  });
});
