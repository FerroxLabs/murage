// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud home's Sentinel units (1.0.9, GAP-SENTINEL-109 sections 10.1 and 10.3): never root, no network of any kind,
// no container socket, read-only projection of exactly <DATA_DIR>/health, a separate persistent state directory, the
// installer wiring, and a descriptor the scanner accepts. The public health response and the home unit stay untouched.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEALTH_FILES } from "../../shared/health-protocol.mjs";
import { sentinelInstallationId } from "../../shared/sentinel-installation.mjs";
import { defaultOutputRoot, sourcePaths, validateDescriptor } from "../sentinel/paths.ts";
import { homeBootContract, homeServerEnvironment } from "./boot.ts";
// @ts-expect-error -- a standalone deployment script without declarations
import { CLOUD_DATA_DIR, CLOUD_ENTRY, CLOUD_INSTALLATION_ROOT, CLOUD_NODE, cloudDescriptor, cloudInstallationId } from "../../deploy/cloud-home/murage-sentinel-descriptor.mjs";

const read = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");

/** Directive -> every value it is given (comments and section headers dropped). */
function directives(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    out.set(key, [...(out.get(key) ?? []), line.slice(at + 1)]);
  }
  return out;
}

const service = read("murage-sentinel.service");
const timer = read("murage-sentinel.timer");
const unit = directives(service);
const one = (key: string) => { const values = unit.get(key) ?? []; expect(values, key).toHaveLength(1); return values[0]!; };
const ID = sentinelInstallationId(CLOUD_DATA_DIR)!;

describe("murage-sentinel.service", () => {
  it("never runs as root and never regains privileges", () => {
    expect(one("User")).not.toMatch(/^(root|0)$/);
    expect(one("Group")).not.toMatch(/^(root|0)$/);
    expect(one("NoNewPrivileges")).toBe("yes");
    expect(one("CapabilityBoundingSet")).toBe("");
    expect(one("AmbientCapabilities")).toBe("");
    for (const key of ["ExecStart", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"]) {
      for (const value of unit.get(key) ?? []) expect(value, `${key} runs without a privileged prefix`).not.toMatch(/^[+!@:-]/);
    }
    expect(unit.has("PermissionsStartOnly")).toBe(false);
  });

  it("has no network and no container socket", () => {
    expect(one("PrivateNetwork")).toBe("yes");
    expect(one("RestrictAddressFamilies")).toBe("AF_UNIX");
    expect(one("IPAddressDeny")).toBe("any");
    expect(service).not.toMatch(/docker\.sock[^ \n]*:|podman[^ \n]*:/);
    expect(one("InaccessiblePaths")).toContain("/run/docker.sock");
  });

  it("sees only <DATA_DIR>/health, read-only, and writes only its own state directory", () => {
    expect(one("ProtectSystem")).toBe("strict");
    expect(one("ProtectHome")).toBe("yes");
    expect(one("TemporaryFileSystem")).toBe("/data:ro");
    expect(unit.get("BindReadOnlyPaths")).toEqual([`-${CLOUD_DATA_DIR}/health:${CLOUD_INSTALLATION_ROOT}/health`]);
    for (const key of ["BindPaths", "ReadWritePaths"]) expect(unit.has(key), key).toBe(false);
    expect(one("StateDirectory")).toBe(`murage-sentinel murage-sentinel/MurageSentinel murage-sentinel/MurageSentinel/${ID}`);
    expect(one("StateDirectoryMode")).toBe("0700");
    expect(one("RuntimeDirectory")).toBe("murage-sentinel murage-sentinel/home");
  });

  it("runs the bundled scanner once with the pinned Node and its descriptor, at background priority, bounded", () => {
    expect(one("Type")).toBe("oneshot");
    expect(one("ExecStart")).toBe(`${CLOUD_NODE} ${CLOUD_ENTRY} /var/lib/murage-sentinel/MurageSentinel/${ID}/descriptor.json --once`);
    expect(one("ExecStartPre")).toBe(`${CLOUD_NODE} /usr/local/libexec/murage-sentinel-descriptor.mjs`);
    expect(one("Nice")).toBe("19");
    expect(one("IOSchedulingClass")).toBe("idle");
    expect(one("TimeoutStartSec")).toBe("60");
    expect(one("MemoryMax")).toBe("256M");
  });

  it("names the same installation id as every producer of /data/home", () => {
    expect(cloudInstallationId()).toBe(ID);
    expect(ID).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("one output root for the scanner and the home server", () => {
  it("the home server's owner reads and delivery resolve the folder the unit writes", () => {
    const contract = homeBootContract({ MURAGE_CLOUD_ROLE: "home", MURAGE_CLOUD_MACHINE_ID: "fixture-home", MURAGE_CLOUD_ADMIN_URL: "https://admin.murage.test",
      MURAGE_PUBLIC_ORIGIN: "https://home.murage.test", MURAGE_CLOUD_BOOTSTRAP_SECRET: "b".repeat(32) })!;
    const env = homeServerEnvironment(contract, "UTC");
    const serverSide = defaultOutputRoot(sentinelInstallationId(env.MURAGE_DATA_DIR!)!, { platform: "linux", env, home: env.HOME });
    const unitEnv = Object.fromEntries((unit.get("Environment") ?? []).map(line => line.split("=", 2) as [string, string]));
    expect(unitEnv.MURAGE_SENTINEL_STATE_DIR).toBe(env.MURAGE_SENTINEL_STATE_DIR);
    const written = cloudDescriptor({ entryBytes: Buffer.from("x"), env: unitEnv }).outputRoot;
    expect(serverSide).toBe(written);
    expect(serverSide).toBe(`/var/lib/murage-sentinel/MurageSentinel/${ID}`);
    expect(one("ExecStart")).toContain(`${serverSide}/descriptor.json`);
    expect(defaultOutputRoot(ID, { platform: "linux", env: { HOME: "/data/server-home" }, home: "/data/server-home" })).not.toBe(serverSide);
  });

  it("an explicit state folder is the base on every OS, and a relative one gives no root", () => {
    for (const platform of ["linux", "darwin"] as const) expect(defaultOutputRoot(ID, { platform, env: { MURAGE_SENTINEL_STATE_DIR: "/srv/s" }, home: "/home/a" })).toBe(`/srv/s/MurageSentinel/${ID}`);
    expect(defaultOutputRoot(ID, { platform: "linux", env: { MURAGE_SENTINEL_STATE_DIR: "srv/s" }, home: "/home/a" })).toBeNull();
    expect(defaultOutputRoot(ID, { platform: "linux", env: {}, home: "/home/a" })).toBe(`/home/a/.local/state/MurageSentinel/${ID}`);
  });
});

describe("murage-sentinel.timer", () => {
  const t = directives(timer);
  it("checks 120 s after the previous run ends, with no catch-up and no wake", () => {
    expect(t.get("OnUnitInactiveSec")).toEqual(["120s"]);
    expect(t.get("OnBootSec")).toEqual(["60s"]);
    expect(t.get("Unit")).toEqual(["murage-sentinel.service"]);
    expect(t.has("Persistent")).toBe(false);
    expect(t.has("WakeSystem")).toBe(false);
  });
});

describe("the Cloud descriptor", () => {
  it("is one the scanner accepts: projected root, fixed sources, entry outside the data, pinned Node", () => {
    const descriptor = cloudDescriptor({ entryBytes: Buffer.from("// bundled scanner\n") });
    const checked = validateDescriptor(descriptor, "linux");
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(descriptor.installationId).toBe(ID);
    expect(descriptor.sources).toEqual(sourcePaths(`${CLOUD_INSTALLATION_ROOT}/health`, "linux"));
    expect(Object.keys(descriptor.sources)).toEqual(Object.keys(HEALTH_FILES));
    expect(descriptor.executable.path).toBe(CLOUD_NODE);
    expect(descriptor.executable.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the image installer", () => {
  const image = read("build-image.sh");
  it("installs both units and the descriptor writer and enables the timer", () => {
    expect(image).toContain("install -m 0644 deploy/cloud-home/murage-sentinel.service /etc/systemd/system/murage-sentinel.service");
    expect(image).toContain("install -m 0644 deploy/cloud-home/murage-sentinel.timer /etc/systemd/system/murage-sentinel.timer");
    expect(image).toContain("install -m 0755 deploy/cloud-home/murage-sentinel-descriptor.mjs /usr/local/libexec/murage-sentinel-descriptor.mjs");
    expect(image).toMatch(/^systemctl enable murage-sentinel\.timer$/m);
  });

  it("leaves the home unit and its privilege model alone", () => {
    expect(read("murage-home.service")).not.toContain("sentinel");
  });
});
