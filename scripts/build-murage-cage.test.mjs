import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { BUBBLEWRAP_SHA256, BUBBLEWRAP_URL, CAGE_BUILD_IMAGE, CAGE_BUILD_SCRIPT, LIBCAP_SHA256, LIBCAP_URL, LIBCAP_VERSION, MESON_FLAGS, buildMurageCage, cageArguments, cloudFilterPin, verifyBubblewrapSource, verifyLibcapSource, verifyBwrapImage, verifyGlibcFloor, verifyCloudFilter, verifyPowerFilter } from "./build-murage-cage.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

// The orchestration fixture substitutes digests only for explicitly registered
// bytes, avoiding real downloads/compilation. Rejection tests use real SHA-256.
const { fixtureHashes } = vi.hoisted(() => ({ fixtureHashes: new Map() }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, createHash: (...args) => {
    const hash = actual.createHash(...args);
    const update = hash.update.bind(hash);
    hash.update = (bytes, ...options) => {
      update(bytes, ...options);
      const fixture = fixtureHashes.get(String(bytes));
      if (fixture) hash.digest = () => fixture;
      return hash;
    };
    return hash;
  } };
});

const directories = [];
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), "murage-cage-build-")); directories.push(dir); return dir; };
beforeEach(() => {
  vi.stubEnv("MURAGE_CAGE_TARBALL", "");
  vi.stubEnv("MURAGE_CAGE_LIBCAP_TARBALL", "");
});
afterEach(() => {
  fixtureHashes.clear();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) removeTempDirSync(dir);
});
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pins = source("deploy/cloud-home/SECCOMP-BPF-HASHES.txt");
const powerPins = source("native/power-seccomp/POWER-BPF-HASHES.txt");
const pinnedImage = "docker.io/library/almalinux:8@sha256:8b469a3a78515e8a18ea8fc727e6a3679e1d0c5ba6f58d5b30be3d0d9b86cffe";
const pinnedPackages = ["gcc-8.5.0-29.el8_10.alma.1", "make-4.2.1-11.el8", "meson-0.58.2-2.el8",
  "ninja-build-1.8.2-1.el8", "pkgconf-pkg-config-1.4.2-1.el8", "binutils-2.30-128.el8_10",
  "xz-5.2.4-4.el8_6", "tar-1.30-13.el8_10", "perl-5.26.3-423.el8_10.1"];
const elf = (arch = "x64") => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(arch === "x64" ? 0x3e : 0xb7, 18);
  return bytes;
};

function sourceFetcher() {
  fixtureHashes.set("fixture bubblewrap source", BUBBLEWRAP_SHA256);
  fixtureHashes.set("fixture libcap source", LIBCAP_SHA256);
  return vi.fn(async url => {
    if (![BUBBLEWRAP_URL, LIBCAP_URL].includes(url)) throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, arrayBuffer: async () => Buffer.from(url === BUBBLEWRAP_URL ? "fixture bubblewrap source" : "fixture libcap source") };
  });
}

describe("the cage build inputs", () => {
  it("pins the release tarball and rejects other bytes before a tool or download runs", async () => {
    expect(BUBBLEWRAP_URL).toBe("https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz");
    expect(BUBBLEWRAP_SHA256).toBe("0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d");
    const tarball = path.join(scratch(), "bubblewrap-0.13.1.tar.xz");
    writeFileSync(tarball, "wrong source archive");
    const exec = vi.fn(), fetcher = vi.fn();
    await expect(buildMurageCage({ platform: "linux", arch: "x64", hostArch: "x64", tarball, exec, fetcher })).rejects.toThrow("CAGE_SOURCE_HASH_MISMATCH");
    expect(exec).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => verifyBubblewrapSource(scratch())).toThrow("CAGE_SOURCE_NOT_REGULAR");
  });

  it("runs only on Linux and generates each filter on its own architecture", async () => {
    const exec = vi.fn(), fetcher = vi.fn();
    for (const [platform, arch, hostArch, error] of [
      ["darwin", "arm64", "arm64", "CAGE_LINUX_REQUIRED"],
      ["linux", "ia32", "ia32", "CAGE_ARCH_UNSUPPORTED"],
      ["linux", "arm64", "x64", "CAGE_NATIVE_ARCH_REQUIRED"],
    ]) await expect(buildMurageCage({ platform, arch, hostArch, exec, fetcher })).rejects.toThrow(error);
    expect(exec).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins libcap and refuses wrong bytes, directories and symlinks before any tool or fetch", async () => {
    expect(LIBCAP_VERSION).toBe("2.76");
    expect(LIBCAP_URL).toBe("https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.76.tar.xz");
    expect(LIBCAP_SHA256).toBe("629da4ab29900d0f7fcc36227073743119925fd711c99a1689bbf5c9b40c8e6f");
    const dir = scratch(), file = path.join(dir, "libcap.tar.xz"), link = path.join(dir, "link.tar.xz");
    writeFileSync(file, "wrong libcap source");
    symlinkSync(file, link);
    for (const [libcapTarball, error] of [[file, "CAGE_LIBCAP_SOURCE_HASH_MISMATCH"], [dir, "CAGE_LIBCAP_SOURCE_NOT_REGULAR"], [link, "CAGE_LIBCAP_SOURCE_NOT_REGULAR"]]) {
      const exec = vi.fn(), fetcher = vi.fn();
      await expect(buildMurageCage({ platform: "linux", arch: "x64", hostArch: "x64", libcapTarball, exec, fetcher })).rejects.toThrow(error);
      expect(exec).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(() => verifyLibcapSource(libcapTarball)).toThrow(error);
    }
    vi.stubEnv("MURAGE_CAGE_LIBCAP_TARBALL", file);
    const exec = vi.fn(), fetcher = vi.fn();
    await expect(buildMurageCage({ platform: "linux", arch: "x64", hostArch: "x64", exec, fetcher })).rejects.toThrow("CAGE_LIBCAP_SOURCE_HASH_MISMATCH");
    expect(exec).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["hash", "http", "network"])("refuses a libcap download failure (%s) before exec", async failure => {
    const fetcher = sourceFetcher();
    fetcher.mockImplementationOnce(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fixture bubblewrap source") }));
    fetcher.mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("network unavailable");
      return { ok: failure !== "http", status: 503, arrayBuffer: async () => Buffer.from("wrong downloaded libcap") };
    });
    const exec = vi.fn(), outputRoot = scratch();
    await expect(buildMurageCage({ platform: "linux", arch: "x64", hostArch: "x64", outputRoot, exec, fetcher })).rejects.toThrow(
      failure === "hash" ? "CAGE_LIBCAP_SOURCE_HASH_MISMATCH" : "CAGE_LIBCAP_SOURCE_DOWNLOAD");
    expect(exec).not.toHaveBeenCalled();
    expect(readdirSync(outputRoot)).toEqual([]);
  });

  it("accepts only the documented CLI options", () => {
    expect(cageArguments(["--arch", "arm64", "--tarball", "/tmp/source archive.tar.xz"])).toEqual({ arch: "arm64", tarball: "/tmp/source archive.tar.xz" });
    expect(cageArguments(["--libcap-tarball", "/tmp/libcap source.tar.xz"])).toEqual({ libcapTarball: "/tmp/libcap source.tar.xz" });
    for (const args of [["--hash", "other"], ["--arch"], ["--libcap-tarball"], ["--libcap-tarball", "a", "--libcap-tarball", "b"], ["--tarball", "--arch", "x64"], ["--arch", "x64", "--arch", "arm64"]]) expect(() => cageArguments(args)).toThrow("usage:");
  });

  it("disables SELinux, man pages, completions and Meson downloads", () => {
    for (const flag of ["-Dselinux=disabled", "-Dman=disabled", "-Dbash_completion=disabled", "-Dzsh_completion=disabled", "--wrap-mode=nodownload"]) expect(MESON_FLAGS).toContain(flag);
  });

  it("uses a literal pinned container recipe, including ownership cleanup", () => {
    expect(CAGE_BUILD_IMAGE).toBe(pinnedImage);
    for (const pkg of pinnedPackages) expect(CAGE_BUILD_SCRIPT).toContain(pkg);
    expect(CAGE_BUILD_SCRIPT).toContain("dnf -y --setopt=install_weak_deps=False --enablerepo=powertools install");
    expect(CAGE_BUILD_SCRIPT).toContain("make -C libcap-2.76/libcap libcap.a");
    expect(CAGE_BUILD_SCRIPT).toContain("Libs: /work/libcap-2.76/libcap/libcap.a");
    expect(CAGE_BUILD_SCRIPT).toContain("Cflags: -I/work/libcap-2.76/libcap/include");
    expect(CAGE_BUILD_SCRIPT).toContain(`meson setup build bubblewrap-0.13.1 ${MESON_FLAGS.join(" ")}`);
    expect(CAGE_BUILD_SCRIPT).toContain("meson compile -C build bwrap");
    expect(CAGE_BUILD_SCRIPT).toContain("rpm -q gcc make meson ninja-build pkgconf-pkg-config binutils xz tar perl glibc glibc-devel");
    for (const name of ["UID", "GID"]) expect(CAGE_BUILD_SCRIPT).toContain(`case "$MURAGE_BUILD_${name}" in ''|*[!0-9]*) exit 2 ;; esac`);
    expect(CAGE_BUILD_SCRIPT).toContain('trap \'chown -R "$MURAGE_BUILD_UID:$MURAGE_BUILD_GID" /work\' EXIT');
    const literal = source("scripts/build-murage-cage.mjs").match(/export const CAGE_BUILD_SCRIPT = String\.raw`([\s\S]*?)`;/)?.[1];
    expect(literal).toBe(CAGE_BUILD_SCRIPT);
    expect(literal).not.toContain("${");
    // Both native targets use the matching container platform.
    expect(source("scripts/linux-floor.mjs")).toContain('arch === "x64" ? "linux/amd64" : "linux/arm64"');
  });
});

describe("the emitted cage files", () => {
  it.each(["x64", "arm64"].flatMap(arch => ["download", "offline", "glibc", "dependency"].map(mode => [arch, mode])))("builds %s through one isolated Docker invocation and host generators (%s)", async (arch, mode) => {
    const outputRoot = path.join(scratch(), "host output with spaces");
    if (mode === "offline") {
      const previous = path.join(outputRoot, "linux-x64");
      mkdirSync(previous, { recursive: true });
      for (const name of ["bwrap", "murage-cage.bpf", "murage-power.bpf", "COPYING", "manifest.json"]) {
        writeFileSync(path.join(previous, name), "previous build");
        chmodSync(path.join(previous, name), name === "bwrap" ? 0o555 : 0o444);
      }
    }
    const fetcher = sourceFetcher();
    if (mode === "offline") {
      const inputs = scratch();
      for (const [variable, file, bytes] of [
        ["MURAGE_CAGE_TARBALL", "bubblewrap.tar.xz", "fixture bubblewrap source"],
        ["MURAGE_CAGE_LIBCAP_TARBALL", "libcap.tar.xz", "fixture libcap source"],
      ]) {
        writeFileSync(path.join(inputs, file), bytes);
        vi.stubEnv(variable, path.join(inputs, file));
      }
    }
    fixtureHashes.set("fixture cloud filter", cloudFilterPin(arch, pins));
    fixtureHashes.set("fixture power filter", cloudFilterPin(arch, powerPins));
    const rpmArch = arch === "x64" ? "x86_64" : "aarch64";
    const packages = [...pinnedPackages.map(pkg => `${pkg}.${rpmArch}`), `glibc-2.28-fixture.${rpmArch}`, `glibc-devel-2.28-fixture.${rpmArch}`];
    let work;
    const exec = vi.fn((command, args) => {
      if (command === "docker") {
        expect(fetcher).toHaveBeenCalledTimes(mode === "offline" ? 0 : 2);
        const mount = args[args.indexOf("--mount") + 1];
        work = mount.slice("type=bind,source=".length, -",target=/work".length);
        expect(path.dirname(work)).toBe(outputRoot);
        expect(args).toEqual(["run", "--rm", "--platform", arch === "x64" ? "linux/amd64" : "linux/arm64",
          "--mount", `type=bind,source=${work},target=/work`, "--workdir", "/work",
          "--env", `MURAGE_BUILD_UID=${process.getuid()}`, "--env", `MURAGE_BUILD_GID=${process.getgid()}`,
          pinnedImage, "/bin/bash", "/work/build.sh"]);
        expect(args).not.toContain("--privileged");
        expect(args.some(arg => arg.startsWith("--cap-add") || arg === "--network" || arg.startsWith("--network="))).toBe(false);
        expect(readdirSync(work).sort()).toEqual(["bubblewrap-0.13.1.tar.xz", "build.sh", "libcap-2.76.tar.xz"]);
        expect(readFileSync(path.join(work, "build.sh"), "utf8")).toBe(CAGE_BUILD_SCRIPT);
        expect(CAGE_BUILD_SCRIPT).not.toContain("host-env-must-not-be-spliced");
        expect(verifyBubblewrapSource(path.join(work, "bubblewrap-0.13.1.tar.xz"))).toBe(BUBBLEWRAP_SHA256);
        expect(verifyLibcapSource(path.join(work, "libcap-2.76.tar.xz"))).toBe(LIBCAP_SHA256);
        for (const dir of ["build", "bubblewrap-0.13.1", "libcap-2.76/libcap", "toolchain"]) mkdirSync(path.join(work, dir), { recursive: true });
        writeFileSync(path.join(work, "build/bwrap"), elf(arch));
        writeFileSync(path.join(work, "bubblewrap-0.13.1/COPYING"), "fixture license");
        writeFileSync(path.join(work, "libcap-2.76/libcap/libcap.a"), "fixture static libcap");
        for (const name of ["cc", "meson", "ninja", "pkgConfig", "linker"]) writeFileSync(path.join(work, `toolchain/${name}.txt`), `container ${name}\n`);
        writeFileSync(path.join(work, "toolchain/packages.txt"), packages.join("\n") + "\n");
        return "";
      }
      if (command === "host-cc" && args[0] === "--version") return "host compiler\n";
      if (command === "pkg-config" && args.join(" ") === "--modversion libseccomp") return "2.5.5\n";
      if (command === "readelf") {
        expect(args).toEqual(["-d", path.join(work, "build/bwrap")]);
        return ` (NEEDED) Shared library: [${mode === "dependency" ? "libcap.so.2" : "libc.so.6"}]`;
      }
      if (command === "objdump") {
        expect(args).toEqual(["-T", path.join(work, "build/bwrap")]);
        return `(GLIBC_${mode === "glibc" ? "2.38" : "2.28"}) fixture_symbol`;
      }
      if (command === "host-cc") {
        expect(args.slice(0, 4)).toEqual(["-O2", "-Wall", "-Wextra", "-Werror"]);
        expect(args.at(-1)).toBe("-lseccomp");
        expect(args[4]).toMatch(/(?:deploy\/cloud-home\/murage-seccomp|native\/power-seccomp\/murage-power-seccomp)\.c$/);
        return "";
      }
      if (command === path.join(work, "murage-cage.bpf.generator") || command === path.join(work, "murage-power.bpf.generator")) {
        writeFileSync(args[0], command.endsWith("murage-cage.bpf.generator") ? "fixture cloud filter" : "fixture power filter");
        return "";
      }
      throw new Error(`Unexpected host command: ${command} ${args.join(" ")}`);
    });
    const result = buildMurageCage({ platform: "linux", arch, hostArch: arch, outputRoot, exec, fetcher,
      env: { ...process.env, CC: "host-cc", PKG_CONFIG_PATH: "host-env-must-not-be-spliced", MURAGE_CAGE_BUILD_IMAGE: "host-env-must-not-be-spliced" } });
    if (["glibc", "dependency"].includes(mode)) {
      await expect(result).rejects.toThrow(mode === "glibc" ? "CAGE_GLIBC_FLOOR_EXCEEDED: 2.38" : "CAGE_BINARY_DYNAMIC_DEPENDENCY");
      expect(readdirSync(outputRoot)).toEqual([]);
      expect(exec.mock.calls.some(([command]) => command.endsWith(".generator"))).toBe(false);
    } else {
      const manifest = await result;
      expect(manifest).toMatchObject({ schema: 1, target: `linux-${arch}`, executable: "bwrap", version: "0.13.1",
        source: BUBBLEWRAP_URL, sourceSha256: BUBBLEWRAP_SHA256, containerImage: pinnedImage, glibcFloor: "2.28",
        libcapVersion: "2.76", libcapSourceSha256: LIBCAP_SHA256,
        libcapSha256: createHash("sha256").update("fixture static libcap").digest("hex"),
        binarySha256: createHash("sha256").update(elf(arch)).digest("hex"),
        toolchain: { cc: "host compiler", containerCc: "container cc", meson: "container meson", ninja: "container ninja",
          pkgConfig: "container pkgConfig", linker: "container linker", libcap: "2.76", libseccomp: "2.5.5", packages },
        buildFlags: { meson: MESON_FLAGS, libcap: "/work/libcap-2.76/libcap/libcap.a", generators: ["-O2", "-Wall", "-Wextra", "-Werror", "-lseccomp"] },
        filters: { "murage-cage.bpf": { sha256: cloudFilterPin(arch, pins) }, "murage-power.bpf": { sha256: cloudFilterPin(arch, powerPins) } },
      });
      const output = path.join(outputRoot, `linux-${arch}`);
      expect(readdirSync(output).sort()).toEqual(["COPYING", "bwrap", "manifest.json", "murage-cage.bpf", "murage-power.bpf"]);
      expect(JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"))).toEqual(manifest);
      if (process.platform !== "win32") {
        for (const name of readdirSync(output)) {
          expect(statSync(path.join(output, name)).mode & 0o777).toBe(name === "bwrap" ? 0o555 : 0o444);
        }
      }
      expect(exec.mock.calls.filter(([command]) => command.endsWith(".generator"))).toHaveLength(2);
    }
    expect(exec.mock.calls.filter(([command]) => command === "docker")).toHaveLength(1);
    expect(exec.mock.calls[0][0]).toBe("docker");
    expect(existsSync(work)).toBe(false);
  });

  it("enforces both existing cloud pins and refuses missing or ambiguous pins", () => {
    expect(cloudFilterPin("x64", pins)).toBe("93f6dc1957bfa072862f220644164b8324732fa9e22761b4282cf4f89eacd366");
    expect(cloudFilterPin("arm64", pins)).toBe("b90881d11a3e8b3a810afbaf2da3330dab92aa2419376d51ff56737fa45a8d1b");
    expect(() => cloudFilterPin("x64", "")).toThrow("CAGE_FILTER_PIN_REQUIRED");
    expect(() => cloudFilterPin("arm64", pins + pins)).toThrow("CAGE_FILTER_PIN_REQUIRED");
    expect(() => cloudFilterPin("s390x", pins)).toThrow("CAGE_ARCH_UNSUPPORTED");
  });

  it("compares filter bytes to the selected architecture's digest", () => {
    const file = path.join(scratch(), "filter.bpf");
    writeFileSync(file, "fixture filter");
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    const fixturePins = `x86_64 ${hash}\naarch64 ${"a".repeat(64)}\n`;
    expect(verifyCloudFilter(file, "x64", fixturePins)).toBe(hash);
    expect(() => verifyCloudFilter(file, "arm64", fixturePins)).toThrow("CAGE_FILTER_HASH_MISMATCH");
    expect(() => verifyCloudFilter(file, "x64", pins)).toThrow("CAGE_FILTER_HASH_MISMATCH");
  });

  it("refuses a wrong architecture or a dynamic libcap/SELinux dependency", () => {
    for (const [arch, machine] of [["x64", 0x3e], ["arm64", 0xb7]]) {
      const bytes = Buffer.alloc(64);
      bytes.writeUInt32BE(0x7f454c46, 0); bytes[4] = 2; bytes[5] = 1;
      bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18);
      expect(() => verifyBwrapImage(bytes, arch, " (NEEDED) Shared library: [libc.so.6]")).not.toThrow();
      expect(() => verifyBwrapImage(bytes, arch === "x64" ? "arm64" : "x64", "")).toThrow("CAGE_BINARY_ARCH_MISMATCH");
      for (const lib of ["libcap.so.2", "libselinux.so.1", "libm.so.6", "libpthread.so.0"]) expect(() => verifyBwrapImage(bytes, arch, ` (NEEDED) Shared library: [libc.so.6]\n (NEEDED) Shared library: [${lib}]`)).toThrow("CAGE_BINARY_DYNAMIC_DEPENDENCY");
    }
    expect(() => verifyBwrapImage(Buffer.alloc(8), "x64", "")).toThrow("CAGE_BINARY_ARCH_MISMATCH");
  });

  it("compares GLIBC versions numerically against 2.28, including patch versions", () => {
    expect(() => verifyGlibcFloor("(GLIBC_2.28) fn\n(GLIBC_2.14) fn\nGLIBC_2.9 fn\nGLIBC_2.28.0 fn")).not.toThrow();
    for (const version of ["2.38", "2.28.1", "2.29", "2.100", "3.0"]) {
      expect(() => verifyGlibcFloor(`(GLIBC_2.9) old\n(GLIBC_${version}) new`)).toThrow(`CAGE_GLIBC_FLOOR_EXCEEDED: ${version}`);
    }
  });

  it("ships the five build outputs only on Linux and builds them on every Linux packaging path", () => {
    const config = parse(source("electron-builder.yml"));
    const cage = config.linux.extraResources.find(entry => entry.to === "cage");
    expect(cage).toEqual({ from: "dist-native/cage/linux-${arch}", to: "cage", filter: ["bwrap", "murage-cage.bpf", "murage-power.bpf", "manifest.json", "COPYING"] });
    for (const entries of [config.extraResources, config.mac.extraResources, config.win.extraResources]) expect(entries.some(entry => entry.to === "cage")).toBe(false);
    const scripts = JSON.parse(source("package.json")).scripts;
    expect(scripts["build:murage-cage"]).toBe("node scripts/build-murage-cage.mjs");
    for (const name of ["package:linux", "package:linux:offline", "package:linux:dir"]) expect(scripts[name]).toContain("pnpm build:murage-cage && pnpm build:engine-exclusion && electron-builder");
  });

  it.each([
    ["x64", "x86_64", "72cf57db4cd8ff5ec32f5a477be727ac0cfa29d8a9b240515dc4fb2504aed4a6"],
    ["arm64", "aarch64", "ed3bd9b4e5761211665c25c00153aaf1de2c21851a414c5e76ef689c7eb06c3a"],
  ])("pins murage-power.bpf for %s and refuses other bytes or missing pins", (arch, name, pin) => {
    expect(cloudFilterPin(arch, powerPins)).toBe(pin);
    expect(() => cloudFilterPin(arch, "")).toThrow("CAGE_FILTER_PIN_REQUIRED");
    expect(() => cloudFilterPin(arch, powerPins + powerPins)).toThrow("CAGE_FILTER_PIN_REQUIRED");
    expect(() => cloudFilterPin("riscv64", powerPins)).toThrow("CAGE_ARCH_UNSUPPORTED");
    const file = path.join(scratch(), "murage-power.bpf");
    writeFileSync(file, "a drifted power filter");
    expect(() => verifyPowerFilter(file, arch, powerPins)).toThrow("CAGE_POWER_FILTER_HASH_MISMATCH");
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(verifyPowerFilter(file, arch, `${name} ${hash}\n`)).toBe(hash);
  });

  it("checks the emitted power filter against the pin, not against its own bytes", () => {
    const build = source("scripts/build-murage-cage.mjs");
    expect(build).toContain("verifyPowerFilter(path.join(stage, name), arch, powerPins)");
    expect(build).not.toContain(": sha256(readFileSync(path.join(stage, name)))");
  });
});
