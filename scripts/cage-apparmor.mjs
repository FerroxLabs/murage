// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SOURCE_CAGE_PROFILE = "/etc/apparmor.d/murage-src-cage";

export function sourceCageProfile(repoRoot, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Murage cage AppArmor setup does not support architecture ${arch}.`);
  const bwrap = path.posix.resolve(repoRoot, "dist-native/cage", `linux-${arch}`, "bwrap");
  // Keep the attachment literal: quoted spaces are allowed, policy syntax and
  // AppArmor path patterns are not. Never turn a checkout path into a glob.
  if (/[\x00-\x1f\x7f"\\*?\[\]{}^]/.test(bwrap)) {
    throw new Error("Murage cage AppArmor setup needs a repository path without control characters, quotes, backslashes or pattern characters.");
  }
  return `abi <abi/4.0>,
include <tunables/global>

profile murage-src-cage-bwrap "${bwrap}" flags=(unconfined) {
  userns,
}
`;
}

/** Explicit one-time command only. Source preparation never invokes sudo. */
export function installSourceCageAppArmor({ platform = process.platform, arch = process.arch,
  repoRoot = root, realpath = realpathSync, exists = existsSync, exec = execFileSync, say = console.log } = {}) {
  if (platform !== "linux") throw new Error("Murage cage AppArmor setup runs on Linux only.");
  // AppArmor matches the kernel's resolved executable path, including when the
  // checkout was opened through a directory symlink.
  const resolvedRoot = realpath(repoRoot);
  const profile = sourceCageProfile(resolvedRoot, arch);
  const bwrap = path.posix.join(resolvedRoot, "dist-native/cage", `linux-${arch}`, "bwrap");
  if (!exists(bwrap)) throw new Error("Build the Murage cage first with `pnpm build:murage-cage`, then run `pnpm cage:apparmor` again.");
  say(`Writing ${SOURCE_CAGE_PROFILE} with sudo, then loading it with sudo apparmor_parser -r:\n${profile}`);
  exec("sudo", ["tee", SOURCE_CAGE_PROFILE], { input: profile, stdio: ["pipe", "ignore", "inherit"] });
  exec("sudo", ["apparmor_parser", "-r", SOURCE_CAGE_PROFILE], { stdio: "inherit" });
  say("The source cage AppArmor profile is installed. Start Murage again.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installSourceCageAppArmor(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
