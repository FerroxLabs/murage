// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import path from "node:path";

export const LINUX_FLOOR_IMAGE = "docker.io/library/almalinux:8@sha256:8b469a3a78515e8a18ea8fc727e6a3679e1d0c5ba6f58d5b30be3d0d9b86cffe";
export const CAGE_BUILD_IMAGE = LINUX_FLOOR_IMAGE;
export const GLIBC_FLOOR = "2.28";

export function compareVersions(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function maxGlibcVersion(objdumpOutput) {
  let max = null;
  for (const [, version] of objdumpOutput.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/g)) {
    if (max === null || compareVersions(version, max) > 0) max = version;
  }
  return max;
}

export function verifyGlibcFloor(objdumpOutput) {
  const max = maxGlibcVersion(objdumpOutput);
  // Preserve the cage's public error identifier for existing callers.
  if (max !== null && compareVersions(max, GLIBC_FLOOR) > 0) throw new Error(`CAGE_GLIBC_FLOOR_EXCEEDED: ${max}`);
  return max;
}

export function verifyNeededLibraries(dynamicSection, allowed = ["libc.so.6"]) {
  for (const line of dynamicSection.split("\n")) {
    const library = line.match(/\[([^\]]+)\]/)?.[1];
    if (line.includes("(NEEDED)") && !allowed.includes(library)) {
      throw new Error(`CAGE_BINARY_DYNAMIC_DEPENDENCY: ${library ?? "malformed NEEDED entry"}`);
    }
  }
}

// The command is always a literal recipe or a fixed path supplied by the caller.
// Paths travel only through bind mounts, never through shell interpolation.
export function floorDockerArgs({ arch, mounts, env = {
  MURAGE_BUILD_UID: process.getuid?.(), MURAGE_BUILD_GID: process.getgid?.(),
}, command = ["/bin/bash", "/work/build.sh"] }) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("LINUX_FLOOR_ARCH_UNSUPPORTED");
  const args = ["run", "--rm", "--platform", arch === "x64" ? "linux/amd64" : "linux/arm64"];
  for (const { source, target, readOnly = false } of mounts) {
    for (const value of [source, target]) {
      if (typeof value !== "string" || !path.isAbsolute(value) || /[,\r\n\x00]/.test(value)) throw new Error("LINUX_FLOOR_INVALID_MOUNT");
    }
    args.push("--mount", `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`);
  }
  args.push("--workdir", "/work");
  if (Object.keys(env).some(key => !["MURAGE_BUILD_UID", "MURAGE_BUILD_GID"].includes(key))) throw new Error("LINUX_FLOOR_INVALID_ENV");
  for (const key of ["MURAGE_BUILD_UID", "MURAGE_BUILD_GID"]) {
    const value = env[key];
    if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error("LINUX_FLOOR_INVALID_ID");
    args.push("--env", `${key}=${value}`);
  }
  return [...args, LINUX_FLOOR_IMAGE, ...command];
}
