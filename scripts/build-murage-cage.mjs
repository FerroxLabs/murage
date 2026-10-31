// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 108-native-prereq contract: addon v10 removes and verifies the two Windows
// shutdown privileges; Linux ships pinned bubblewrap 0.13.1, both BPF files,
// COPYING and a build manifest, with packaging and AppArmor wiring. Runtime
// launch logic and the forwarder belong to the TypeScript lane. Designs and
// the cloud generator stay unchanged. The Claude gate owns builds, tests and
// commits. Local execution is source review only; verification rounds 0/8,
// unsuccessful corrections 0/8. Stop here at a reviewable diff for that gate.
// Gate checks: focused script/addon tests, Linux x64 and arm64 builds with both
// cloud hash pins, packaged-file rejection tests, MSVC /MT and mingw compilation
// with the Windows import check. Windows token behavior needs a disposable child.
// Handoff: implementation and source review complete; git diff --check passed.
// Build, test, package and Windows runtime results remain pending at the gate.
//
// Linux only. Host prerequisites on Ubuntu 24.04: Node, docker, a C compiler
// (build-essential), pkg-config, libseccomp-dev, binutils and xz-utils.
// libseccomp 2.5.5 produces the pinned filters on the host. Only bwrap and its
// static libcap are built in the digest-pinned AlmaLinux container (glibc 2.28).
// Usage (native x64): node scripts/build-murage-cage.mjs --arch x64
// Offline: add --tarball /path/to/bubblewrap-0.13.1.tar.xz, or set
// MURAGE_CAGE_TARBALL to that path (also used by package:linux scripts), plus
// --libcap-tarball /path/to/libcap-2.76.tar.xz or MURAGE_CAGE_LIBCAP_TARBALL.
// Local tarballs skip source downloads; Docker still needs the image and RPMs.
// arm64 needs a native arm64 host with docker and the same host prerequisites.
// No cross-compiler is used: each generator runs on its target architecture.
// Both x86_64 and aarch64 hashes are already pinned in SECCOMP-BPF-HASHES.txt;
// both are enforced and recorded. murage-power.bpf is pinned per architecture in
// native/power-seccomp/POWER-BPF-HASHES.txt (x86_64 and aarch64). No namespace or power calls run at build time.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAGE_BUILD_IMAGE, floorDockerArgs, verifyGlibcFloor, verifyNeededLibraries } from "./linux-floor.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const BUBBLEWRAP_VERSION = "0.13.1";
export const BUBBLEWRAP_SHA256 = "0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d";
export const BUBBLEWRAP_URL = `https://github.com/containers/bubblewrap/releases/download/v${BUBBLEWRAP_VERSION}/bubblewrap-${BUBBLEWRAP_VERSION}.tar.xz`;
export const MESON_FLAGS = ["--buildtype=release", "--wrap-mode=nodownload", "-Dselinux=disabled", "-Dman=disabled", "-Dbash_completion=disabled", "-Dzsh_completion=disabled", "-Dtests=false", "-Dprefer_static=true"];
export { CAGE_BUILD_IMAGE, verifyGlibcFloor, verifyNeededLibraries } from "./linux-floor.mjs";
export const LIBCAP_VERSION = "2.76";
export const LIBCAP_URL = "https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.76.tar.xz";
// Ordered sources for the same sha256-pinned tarball: the kernel.org geo-edge
// first, then the Fastly-fronted cdn.kernel.org. Integrity comes from
// LIBCAP_SHA256, so any source that answers is checked the same way.
export const LIBCAP_URLS = [LIBCAP_URL, "https://cdn.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.76.tar.xz"];
export const LIBCAP_SHA256 = "629da4ab29900d0f7fcc36227073743119925fd711c99a1689bbf5c9b40c8e6f";
// Literal recipe: no host paths, compiler settings or environment values are
// interpolated. Keep these Meson flags identical to MESON_FLAGS above.
export const CAGE_BUILD_SCRIPT = String.raw`#!/bin/bash
set -euo pipefail
case "$MURAGE_BUILD_UID" in ''|*[!0-9]*) exit 2 ;; esac
case "$MURAGE_BUILD_GID" in ''|*[!0-9]*) exit 2 ;; esac
# Also return ownership on ordinary build failures so host cleanup can succeed.
trap 'chown -R "$MURAGE_BUILD_UID:$MURAGE_BUILD_GID" /work' EXIT
cd /work
dnf -y --setopt=install_weak_deps=False --enablerepo=powertools install \
  gcc-8.5.0-29.el8_10.alma.1 make-4.2.1-11.el8 meson-0.58.2-2.el8 \
  ninja-build-1.8.2-1.el8 pkgconf-pkg-config-1.4.2-1.el8 binutils-2.30-128.el8_10 \
  xz-5.2.4-4.el8_6 tar-1.30-13.el8_10 perl-5.26.3-423.el8_10.1
tar -xJf bubblewrap-0.13.1.tar.xz --no-same-owner
tar -xJf libcap-2.76.tar.xz --no-same-owner
make -C libcap-2.76/libcap libcap.a
mkdir pkgconfig toolchain
cat > pkgconfig/libcap.pc <<'EOF'
Name: libcap
Description: Static libcap for Murage bubblewrap
Version: 2.76
Libs: /work/libcap-2.76/libcap/libcap.a
Cflags: -I/work/libcap-2.76/libcap/include
EOF
export PKG_CONFIG_PATH=/work/pkgconfig
meson setup build bubblewrap-0.13.1 --buildtype=release --wrap-mode=nodownload -Dselinux=disabled -Dman=disabled -Dbash_completion=disabled -Dzsh_completion=disabled -Dtests=false -Dprefer_static=true
meson compile -C build bwrap
gcc --version > toolchain/cc.txt
meson --version > toolchain/meson.txt
ninja --version > toolchain/ninja.txt
pkg-config --version > toolchain/pkgConfig.txt
ld --version > toolchain/linker.txt
rpm -q gcc make meson ninja-build pkgconf-pkg-config binutils xz tar perl glibc glibc-devel | tee toolchain/packages.txt
`;
const GENERATOR_FLAGS = ["-O2", "-Wall", "-Wextra", "-Werror"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyBubblewrapSource(file) {
  if (!lstatSync(file).isFile()) throw new Error("CAGE_SOURCE_NOT_REGULAR");
  const hash = sha256(readFileSync(file));
  if (hash !== BUBBLEWRAP_SHA256) throw new Error(`CAGE_SOURCE_HASH_MISMATCH: ${hash}`);
  return hash;
}

export function verifyLibcapSource(file) {
  if (!lstatSync(file).isFile()) throw new Error("CAGE_LIBCAP_SOURCE_NOT_REGULAR");
  const hash = sha256(readFileSync(file));
  if (hash !== LIBCAP_SHA256) throw new Error(`CAGE_LIBCAP_SOURCE_HASH_MISMATCH: ${hash}`);
  return hash;
}

export function cloudFilterPin(arch, text) {
  const name = { x64: "x86_64", arm64: "aarch64" }[arch];
  if (!name) throw new Error("CAGE_ARCH_UNSUPPORTED");
  const rows = [...text.matchAll(/^([a-z0-9_]+)\s+([a-f0-9]{64})\s*$/gm)].filter(row => row[1] === name);
  if (rows.length !== 1) throw new Error(`CAGE_FILTER_PIN_REQUIRED: ${name}`);
  return rows[0][2];
}

export function verifyCloudFilter(file, arch, pins) {
  const hash = sha256(readFileSync(file));
  if (hash !== cloudFilterPin(arch, pins)) throw new Error(`CAGE_FILTER_HASH_MISMATCH: ${arch} ${hash}`);
  return hash;
}

/** murage-power.bpf: the same per-architecture pin, from native/power-seccomp/POWER-BPF-HASHES.txt (x86_64 and aarch64). */
export function verifyPowerFilter(file, arch, pins) {
  const hash = sha256(readFileSync(file));
  if (hash !== cloudFilterPin(arch, pins)) throw new Error(`CAGE_POWER_FILTER_HASH_MISMATCH: ${arch} ${hash}`);
  return hash;
}

export function verifyBwrapImage(bytes, arch, dynamicSection) {
  const machine = { x64: 0x3e, arm64: 0xb7 }[arch];
  if (!machine || bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== machine) throw new Error("CAGE_BINARY_ARCH_MISMATCH");
  verifyNeededLibraries(dynamicSection);
}

export function cageArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === "--arch" ? "arch" : args[i] === "--tarball" ? "tarball" : args[i] === "--libcap-tarball" ? "libcapTarball" : null;
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || options[key]) throw new Error("usage: build-murage-cage.mjs [--arch x64|arm64] [--tarball FILE] [--libcap-tarball FILE]");
    options[key] = args[++i];
  }
  return options;
}

export async function buildMurageCage({ arch = process.arch, platform = process.platform, hostArch = process.arch,
  tarball = process.env.MURAGE_CAGE_TARBALL, libcapTarball = process.env.MURAGE_CAGE_LIBCAP_TARBALL,
  outputRoot = path.join(root, "dist-native/cage"),
  exec = execFileSync, fetcher = globalThis.fetch, env = process.env } = {}) {
  if (platform !== "linux") throw new Error("CAGE_LINUX_REQUIRED");
  if (!["x64", "arm64"].includes(arch)) throw new Error("CAGE_ARCH_UNSUPPORTED");
  if (arch !== hostArch) throw new Error("CAGE_NATIVE_ARCH_REQUIRED: use a native target-architecture host with docker");
  // Reject local input before running any tool, and before touching a previous output.
  if (tarball) verifyBubblewrapSource(path.resolve(tarball));
  if (libcapTarball) verifyLibcapSource(path.resolve(libcapTarball));
  const pins = readFileSync(path.join(root, "deploy/cloud-home/SECCOMP-BPF-HASHES.txt"), "utf8");
  const pinnedHash = cloudFilterPin(arch, pins);
  const powerPins = readFileSync(path.join(root, "native/power-seccomp/POWER-BPF-HASHES.txt"), "utf8");
  const pinnedPowerHash = cloudFilterPin(arch, powerPins);
  mkdirSync(outputRoot, { recursive: true });
  const work = mkdtempSync(path.join(path.resolve(outputRoot), ".build-"));
  const cc = env.CC || "cc";
  const run = (command, args, extra = {}) => exec(command, args, { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, env, ...extra });
  const version = (command, args = ["--version"]) => String(run(command, args)).trim().split("\n")[0];
  try {
    const archive = path.join(work, `bubblewrap-${BUBBLEWRAP_VERSION}.tar.xz`);
    if (tarball) copyFileSync(path.resolve(tarball), archive);
    else {
      const response = await fetcher(BUBBLEWRAP_URL, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`CAGE_SOURCE_DOWNLOAD: HTTP ${response.status}`);
      writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
    const sourceSha256 = verifyBubblewrapSource(archive);
    const libcapSource = path.join(work, `libcap-${LIBCAP_VERSION}.tar.xz`);
    if (libcapTarball) copyFileSync(path.resolve(libcapTarball), libcapSource);
    else {
      let lastError;
      let downloaded = false;
      for (const url of LIBCAP_URLS) {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          writeFileSync(libcapSource, Buffer.from(await response.arrayBuffer()));
          downloaded = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!downloaded) {
        throw new Error(`CAGE_LIBCAP_SOURCE_DOWNLOAD: ${lastError.message}`, { cause: lastError });
      }
    }
    const libcapSourceSha256 = verifyLibcapSource(libcapSource);
    writeFileSync(path.join(work, "build.sh"), CAGE_BUILD_SCRIPT);
    run("docker", floorDockerArgs({ arch, mounts: [{ source: work, target: "/work" }] }),
      { timeout: 40 * 60 * 1000, stdio: "inherit" });
    const source = path.join(work, `bubblewrap-${BUBBLEWRAP_VERSION}`);
    const build = path.join(work, "build");
    const stage = path.join(work, "stage");
    mkdirSync(stage);
    const containerVersion = name => readFileSync(path.join(work, "toolchain", `${name}.txt`), "utf8").trim().split("\n")[0];
    const toolchain = {
      cc: version(cc), containerCc: containerVersion("cc"),
      meson: containerVersion("meson"), ninja: containerVersion("ninja"),
      pkgConfig: containerVersion("pkgConfig"), linker: containerVersion("linker"),
      libcap: LIBCAP_VERSION,
      libseccomp: version("pkg-config", ["--modversion", "libseccomp"]),
      packages: readFileSync(path.join(work, "toolchain/packages.txt"), "utf8").trim().split("\n"),
    };
    const capArchive = path.join(work, `libcap-${LIBCAP_VERSION}/libcap/libcap.a`);
    const staticLibs = "/work/libcap-2.76/libcap/libcap.a";
    const binary = path.join(build, "bwrap");
    verifyBwrapImage(readFileSync(binary), arch, String(run("readelf", ["-d", binary])));
    verifyGlibcFloor(String(run("objdump", ["-T", binary])));
    copyFileSync(binary, path.join(stage, "bwrap"));
    chmodSync(path.join(stage, "bwrap"), 0o755);
    copyFileSync(path.join(source, "COPYING"), path.join(stage, "COPYING"));
    const filters = {};
    for (const [name, relative] of [
      ["murage-cage.bpf", "deploy/cloud-home/murage-seccomp.c"],
      ["murage-power.bpf", "native/power-seccomp/murage-power-seccomp.c"],
    ]) {
      const generatorSource = path.join(root, relative);
      const generator = path.join(work, `${name}.generator`);
      run(cc, [...GENERATOR_FLAGS, generatorSource, "-o", generator, "-lseccomp"], { stdio: "inherit" });
      run(generator, [path.join(stage, name)], { stdio: "inherit" });
      filters[name] = { source: relative, sourceSha256: sha256(readFileSync(generatorSource)),
        sha256: name === "murage-cage.bpf" ? verifyCloudFilter(path.join(stage, name), arch, pins) : verifyPowerFilter(path.join(stage, name), arch, powerPins),
        pinnedSha256: name === "murage-cage.bpf" ? pinnedHash : pinnedPowerHash };
      chmodSync(path.join(stage, name), 0o644);
    }
    const manifest = { schema: 1, target: `linux-${arch}`, executable: "bwrap", version: BUBBLEWRAP_VERSION,
      source: BUBBLEWRAP_URL, sourceSha256, binarySha256: sha256(readFileSync(binary)), toolchain,
      containerImage: CAGE_BUILD_IMAGE, glibcFloor: "2.28", libcapVersion: LIBCAP_VERSION, libcapSourceSha256,
      buildFlags: { meson: MESON_FLAGS, generators: [...GENERATOR_FLAGS, "-lseccomp"], libcap: staticLibs },
      libcapSha256: sha256(readFileSync(capArchive)), filters, license: "COPYING" };
    chmodSync(path.join(stage, "COPYING"), 0o644);
    writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    const output = path.join(outputRoot, manifest.target);
    mkdirSync(output, { recursive: true });
    // Publish only after all build checks pass; write the manifest last.
    for (const name of ["bwrap", "murage-cage.bpf", "murage-power.bpf", "COPYING", "manifest.json"]) {
      // A source launch uses these same files. S4 refuses helpers writable by
      // the server user; replace an earlier read-only output when rebuilding.
      rmSync(path.join(output, name), { force: true });
      copyFileSync(path.join(stage, name), path.join(output, name));
      chmodSync(path.join(output, name), name === "bwrap" ? 0o555 : 0o444);
    }
    console.log(`Murage cage built: ${manifest.target}`);
    return manifest;
  } finally {
    // Best effort: a cleanup failure must never hide the build's own error.
    try { rmSync(work, { recursive: true, force: true }); } catch (error) { console.warn(`cage build folder ${work} was not removed: ${error.message}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildMurageCage(cageArguments(process.argv.slice(2)));
