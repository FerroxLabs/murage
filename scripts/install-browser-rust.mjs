// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Install only the finite component closure extracted from the official channel
// manifest. No rustup install/target-add may fetch another manifest or component.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBuildInput } from "./fetch-build-input.mjs";

export const RUST_INPUTS = JSON.parse(readFileSync(new URL("./browser-rust-inputs.json", import.meta.url), "utf8"));
export const RUST_HOSTS = {
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu",
};

export function rustComponents(host, target, pin = RUST_INPUTS) {
  if (!pin.hosts.includes(host) || !pin.components[`rust-std/${target}`]) throw Error("Unsupported pinned Rust host/target");
  return [...new Set([`rustc/${host}`, `cargo/${host}`, `rust-std/${host}`, `rust-std/${target}`])]
    .map(key => ({ key, ...pin.components[key] }));
}

export async function installBrowserRust({ host, target, directory, pin = RUST_INPUTS,
  fetchImpl = globalThis.fetch, run = spawnSync }) {
  const components = rustComponents(host, target, pin);
  const output = resolve(directory);
  if (existsSync(output)) throw Error("Fresh Rust toolchain directory required");
  // Fail before extraction or execution if the official manifest has changed.
  await fetchBuildInput(pin.manifest.url, { sha256: pin.manifest.sha256, maxBytes: 2 * 1024 ** 2, fetchImpl, pins: {} });
  mkdirSync(output, { recursive: true });
  const prefix = join(output, "toolchain");
  for (const [index, component] of components.entries()) {
    const response = await fetchBuildInput(component.url, { sha256: component.sha256, maxBytes: 512 * 1024 ** 2, fetchImpl, pins: {} });
    const archive = join(output, `${index}.tar.xz`), extracted = join(output, `${index}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
    mkdirSync(extracted);
    const command = (file, args, cwd) => {
      const result = run(file, args, { cwd, stdio: "inherit", shell: false });
      if (result.error || result.status !== 0) throw Error(`Pinned Rust ${component.key} installation failed`);
    };
    command("tar", ["-xJf", archive, "-C", extracted], output);
    const roots = readdirSync(extracted);
    if (roots.length !== 1) throw Error("Unexpected Rust component archive layout");
    command("bash", ["install.sh", `--prefix=${prefix}`, "--disable-ldconfig"], join(extracted, roots[0]));
  }
  return prefix;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [target, directory, ...extra] = process.argv.slice(2);
    if (!target || !directory || extra.length) throw Error("usage: node scripts/install-browser-rust.mjs RUST_TARGET FRESH_DIRECTORY");
    const prefix = await installBrowserRust({ host: RUST_HOSTS[`${process.platform}-${process.arch}`], target, directory });
    // The workflow puts these direct binaries first; rustup proxies, if called
    // by another tool, also use this exact absolute sysroot without downloading.
    console.log(`Installed Rust ${RUST_INPUTS.version} at ${prefix}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
