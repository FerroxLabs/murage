// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const CAGE_BUILD_HELP = "run `pnpm build:murage-cage` (needs Linux x64 or arm64, Docker running, build-essential, pkg-config, libseccomp-dev 2.5.5, binutils and xz-utils)";
export const CAGE_APPARMOR_HELP = "Murage source engines need an AppArmor profile on this host; run `pnpm cage:apparmor` once from this repository (it asks for your sudo password one time), then start Murage again.";
export const CAGE_SMOKE_ARGS = ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"];
const USERNS_DENIAL = /^bwrap: (?:setting up uid map: (?:Permission denied|Operation not permitted)|(?:unshare user ns|Creating new namespace failed): (?:Permission denied|Operation not permitted)|No permissions to create a new namespace)/m;

function appArmorRestrictsUserns(exists, read) {
  try {
    return exists("/sys/kernel/security/apparmor")
      && read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
  } catch { return false; }
}

/** Prepare source launches only. Packaged launches still use the shipped cage. */
export function prepareSourceCage({ platform = process.platform, arch = process.arch,
  repoRoot = root, exists = existsSync, read = readFileSync, exec = execFileSync, say = console.log } = {}) {
  // Linux x64 and arm64 have a pinned power filter; other Linux architectures start as
  // before and the engine launch itself says why it cannot run there.
  if (platform !== "linux" || !["x64", "arm64"].includes(arch)) return;
  const complete = () => ["bwrap", "murage-power.bpf", "murage-cage.bpf", "manifest.json", "COPYING"]
    .every(name => exists(path.join(repoRoot, "dist-native/cage", `linux-${arch}`, name)));
  try {
    if (!complete()) {
      exec("docker", ["info"], { cwd: repoRoot, stdio: "ignore", timeout: 30000 });
      say("Building the Murage cage for Linux engines (first launch only, takes a few minutes)...");
      // Keep automatic preparation failures to one actionable line. Running the
      // named command directly shows the full build diagnostics.
      exec("pnpm", ["build:murage-cage"], { cwd: repoRoot, stdio: "ignore" });
      if (!complete()) throw new Error("incomplete cage");
    }
  } catch {
    throw new Error(`Murage cage preparation could not finish: ${CAGE_BUILD_HELP}.`);
  }
  try {
    exec(path.resolve(repoRoot, "dist-native/cage", `linux-${arch}`, "bwrap"), CAGE_SMOKE_ARGS,
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
  } catch (error) {
    if (USERNS_DENIAL.test(String(error.stderr ?? "")) && appArmorRestrictsUserns(exists, read)) {
      throw new Error(CAGE_APPARMOR_HELP);
    }
    throw new Error("Murage cage launch check did not complete; check this host's unprivileged user namespace support and run `pnpm build:murage-cage` to view build diagnostics.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { prepareSourceCage(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
