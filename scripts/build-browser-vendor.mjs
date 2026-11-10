// Reviewed vendor build of the bundled bot-browser engine (agent-browser) for every target, so the
// control-token protection (PKT0 Part 2) is in the bytes on every platform. One invocation builds ONE
// (set, target) on a matching runner:
//   node scripts/build-browser-vendor.mjs --set 0.36.0|0.38.1 --target <target> --output ABSOLUTE_NEW_DIRECTORY
// Never run on a developer machine; the workflow .github/workflows/build-browser-vendor.yml is the only caller.
// (omb.3: the Windows target alone carries the no-console patch and revision; see VENDOR_SETS.revisions.)
// Replaces scripts/build-windows-browser-vendor.mjs for omb.2 (that script stays for the omb.1 record).
//
// Pin checklist, enforced in code before any build starts:
//   1. source archive: pinned commit, size and SHA-256
//   2. every patch: pinned SHA-256, applied in the pinned order (Windows: stdio patch, then control-token patch)
//   3. Rust 1.97.1 and pnpm 11.1.3
//   4. third_party/browser/README.md carries the Apache-2.0 modification notice and the statement that the
//      engine is no longer the official Vercel bytes (verifyReadmeNotice). A licence obligation, not a nicety.
//   5. the produced executable matches the requested target
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executableTarget } from "./prepare-cloudflared.mjs";
import { bundleInventory, releaseBytes } from "./prepare-browser.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

export const VENDOR_RUST = "1.97.1";
export const VENDOR_PNPM = "11.1.3";
export const VENDOR_REPOSITORY = "FerroxLabs/murage";

const PATCHES = {
  stdio: { file: "agent-browser-windows-stdio.patch", sha256: "27a268a90de47603a473daefb5679ef9ddde3fad9152d52b04e563b3e192c9a9", scope: "Windows handle inheritance (upstream PR1781, commit 81a98c349d04195396ffae6898bd375ad64280de)" },
  token036: { file: "patches/murage-control-token.fix1.patch", sha256: "e3ee2f219962306361d31e42fc3da3e83bc4a98e4b25fecd9445ae3cb2d015f7", scope: "Murage control token: ab1 frames, capped lines, absolute deadlines (on v0.36.0)" },
  noconsole: { file: "patches/murage-windows-no-console.patch", sha256: "e322aef056c5189fc042d67f096e77aa99304f105f63f8ba1155428c68e12656", scope: "Windows: every console-subsystem child the detached daemon spawns gets CREATE_NO_WINDOW (no console window per message)" },
  token0381: { file: "patches/murage-control-token.v0381.patch", sha256: "33fb532f001c879d9146b008173fe6429578c2c5e16f7e487256fcf2df978640", scope: "Murage control token fix1 ported to v0.38.1 (reply_budget keeps the mousemove duration rule)" },
};

export const VENDOR_SETS = {
  "0.36.0": {
    version: "0.36.0-omb.2", tag: "browser-engine-v0.36.0-omb.2",
    source: {
      commit: "eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
      asset: "agent-browser-eb05921bad874cd2a1b4fa5d1149f1ed26576cae.tar.gz",
      url: "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
      bytes: 1904718, sha256: "ed24a72a5260d9c1ea454cd849c44159bac570a6939ac645e4c5bdb98a421646",
    },
    // Windows is the only target the console fix touches, so it alone moves to revision omb.3 (other targets stay omb.2, byte for byte).
    revisions: { "win32-x64": { version: "0.36.0-omb.3", tag: "browser-engine-v0.36.0-omb.3" } },
    patches: (target) => (target === "win32-x64" ? ["stdio", "token036", "noconsole"] : ["token036"]),
    targets: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-musl-arm64", "linux-musl-x64", "linux-x64", "win32-x64"],
  },
  "0.38.1": {
    version: "0.38.1-omb.2", tag: "browser-engine-v0.38.1-omb.2",
    source: {
      commit: "aff6125c023b810ea3f2e5deec5379e9a4270bdc",
      asset: "agent-browser-aff6125c023b810ea3f2e5deec5379e9a4270bdc.tar.gz",
      url: "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/aff6125c023b810ea3f2e5deec5379e9a4270bdc",
      bytes: 2038372, sha256: "ec9d69100e64727e0341951595253218753de29093885e807c8ef0725ddf21f2",
    },
    patches: () => ["token0381"],
    targets: ["linux-arm64", "linux-x64"],
  },
};

export const VENDOR_TARGETS = {
  "darwin-arm64": { rust: "aarch64-apple-darwin", exe: "" },
  "darwin-x64": { rust: "x86_64-apple-darwin", exe: "" },
  "linux-arm64": { rust: "aarch64-unknown-linux-gnu", exe: "" },
  "linux-musl-arm64": { rust: "aarch64-unknown-linux-musl", exe: "" },
  "linux-musl-x64": { rust: "x86_64-unknown-linux-musl", exe: "" },
  "linux-x64": { rust: "x86_64-unknown-linux-gnu", exe: "" },
  "win32-x64": { rust: "x86_64-pc-windows-gnu", exe: ".exe" },
};

const repository = fileURLToPath(new URL("../", import.meta.url));
const browserDir = join(repository, "third_party/browser");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The vendor revision of one (set, target): the set's own, unless the target has a later per-target revision. */
export const vendorVersion = (set, target) => VENDOR_SETS[set].revisions?.[target]?.version ?? VENDOR_SETS[set].version;
export const vendorTag = (set, target) => VENDOR_SETS[set].revisions?.[target]?.tag ?? VENDOR_SETS[set].tag;
export const vendorAssetName = (set, target) => `agent-browser-${target}-${vendorVersion(set, target)}${VENDOR_TARGETS[target].exe}`;
export const vendorAssetUrl = (set, target) => `https://github.com/${VENDOR_REPOSITORY}/releases/download/${vendorTag(set, target)}/${vendorAssetName(set, target)}`;

/** What the inherited stdio patch writes into Cargo.toml and Cargo.lock (it was cut for omb.1). It is only the
 * text the build replaces: the version the binary reports is always derived from the vendor set below, so a
 * new vendor revision can never keep printing an old one. */
export const STDIO_PATCH_PACKAGE_VERSION = "0.36.0-omb.1";

/** What `agent-browser --version` prints for a build: the vendor revision wherever the stdio patch is applied
 * (it stamps the package version), the upstream version everywhere else. The smoke checks exactly this. */
export const reportedEngineVersion = (set, target) => (VENDOR_SETS[set].patches(target).includes("stdio") ? vendorVersion(set, target) : set);

/** Rewrites the one `agent-browser` package version in a Cargo.toml / Cargo.lock to `to`; refuses unless exactly one is found. */
export function stampPackageVersion(text, from, to) {
  const needle = `name = "agent-browser"\nversion = "${from}"`;
  const parts = text.split(needle);
  assert.equal(parts.length, 2, `Expected exactly one agent-browser package version "${from}" to stamp, found ${parts.length - 1}`);
  return parts.join(`name = "agent-browser"\nversion = "${to}"`);
}

export function parseVendorBuildArgs(args) {
  const usage = "Usage: node scripts/build-browser-vendor.mjs --set 0.36.0|0.38.1 --target TARGET --output ABSOLUTE_NEW_DIRECTORY";
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--set", "--target", "--output"].includes(args[i]) || args[i + 1] === undefined || values.has(args[i])) throw new Error(usage);
    values.set(args[i], args[i + 1]);
  }
  const set = values.get("--set"), target = values.get("--target"), output = values.get("--output");
  if (!set || !target || !output || !isAbsolute(output)) throw new Error(usage);
  if (!Object.hasOwn(VENDOR_SETS, set)) throw new Error(`Unknown engine set ${set}`);
  if (!VENDOR_SETS[set].targets.includes(target)) throw new Error(`Set ${set} does not build ${target}`);
  return { set, target, output: resolve(output) };
}

export function verifyVendorPatch(key, bytes) {
  assert(Object.hasOwn(PATCHES, key), `Unknown patch ${key}`);
  assert.equal(digest(bytes), PATCHES[key].sha256, `Patch ${PATCHES[key].file} failed pinned SHA-256 verification`);
}

// Fable FIX 2: a licence obligation once the official Vercel bytes are replaced. The build refuses without it.
export const README_NOTICE_PHRASES = [
  "Modification notice (Apache-2.0 section 4(b))",
  "no longer the official Vercel",
  "murage-control-token",
];
export function verifyReadmeNotice(text) {
  for (const phrase of README_NOTICE_PHRASES) assert(text.includes(phrase), `third_party/browser/README.md is missing the required notice text: "${phrase}"`);
}

function command(file, args, cwd, { input, capture = false } = {}) {
  const result = spawnSync(file, args, {
    cwd, input, encoding: "utf8", timeout: 45 * 60_000,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: "x86_64-w64-mingw32-gcc" },
  });
  if (result.error || result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

export async function buildBrowserVendor({ set, target, output }) {
  const plan = VENDOR_SETS[set], targetInfo = VENDOR_TARGETS[target];
  assert(isAbsolute(output) && !existsSync(output), "Output must be a new absolute directory; existing artifacts are never overwritten");
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or later is required");
  verifyReadmeNotice(readFileSync(join(browserDir, "README.md"), "utf8"));
  const version = vendorVersion(set, target);
  const keys = plan.patches(target);
  const patches = keys.map((key) => { const bytes = readFileSync(join(browserDir, PATCHES[key].file)); verifyVendorPatch(key, bytes); return { key, bytes }; });
  const rust = command("rustc", ["--version"], repository, { capture: true });
  const cargo = command("cargo", ["--version"], repository, { capture: true });
  assert(rust.startsWith(`rustc ${VENDOR_RUST} `), `Expected Rust ${VENDOR_RUST}, got ${rust}`);
  assert(cargo.startsWith(`cargo ${VENDOR_RUST} `), `Expected Cargo ${VENDOR_RUST}, got ${cargo}`);
  const scratch = mkdtempSync(join(tmpdir(), "omb-browser-vendor-"));
  try {
    const source = join(scratch, "source");
    mkdirSync(source);
    const archive = join(scratch, plan.source.asset);
    writeFileSync(archive, await releaseBytes(plan.source));
    command("tar", ["-xzf", archive, "--strip-components=1", "-C", source], scratch);
    // Order is pinned: every patch must apply cleanly to the tree the previous one produced.
    for (const { bytes } of patches) {
      command("git", ["apply", "--check", "-"], source, { input: bytes });
      command("git", ["apply", "--whitespace=error-all", "-"], source, { input: bytes });
    }
    // The stdio patch carries an omb.1 package version. Stamp this build's own vendor version over it, in the
    // manifest and the lock (--locked below stays consistent), so the Windows exe prints the revision it ships as.
    const stamped = keys.includes("stdio");
    if (stamped) {
      for (const file of ["cli/Cargo.toml", "cli/Cargo.lock"]) {
        const path = join(source, file);
        const text = readFileSync(path, "utf8");
        writeFileSync(path, stampPackageVersion(text, STDIO_PATCH_PACKAGE_VERSION, version));
        assert(!readFileSync(path, "utf8").includes(`"${STDIO_PATCH_PACKAGE_VERSION}"`), `${file} still names ${STDIO_PATCH_PACKAGE_VERSION}`);
      }
    }
    const pnpm = command("pnpm", ["--version"], source, { capture: true });
    assert.equal(pnpm, VENDOR_PNPM, `Expected pnpm ${VENDOR_PNPM}`);
    // Keep the real upstream dashboard: build.rs otherwise silently embeds a placeholder.
    command("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], source);
    command("pnpm", ["--filter", "dashboard", "build"], source);
    const dashboard = join(source, "packages/dashboard/out");
    assert(!readFileSync(join(dashboard, "index.html"), "utf8").includes("Dashboard not built"));
    command("cargo", ["build", "--locked", "--release", "--manifest-path", "cli/Cargo.toml", "--target", targetInfo.rust], source);
    const binary = join(source, "cli/target", targetInfo.rust, `release/agent-browser${targetInfo.exe}`);
    const bytes = readFileSync(binary);
    assert.equal(executableTarget(bytes).replace("-musl", ""), target.replace("-musl", ""), "Vendor build did not produce the requested target's executable");
    if (stamped) {
      // The package version is compiled into the executable; an omb.1 string left in it means the stamp did not reach the build.
      assert(bytes.includes(Buffer.from(version)), `Built executable does not carry ${version}`);
      assert(!bytes.includes(Buffer.from(STDIO_PATCH_PACKAGE_VERSION)), `Built executable still carries ${STDIO_PATCH_PACKAGE_VERSION}`);
    }
    mkdirSync(output, { recursive: true });
    const asset = vendorAssetName(set, target);
    copyFileSync(binary, join(output, asset));
    for (const [from, to] of [
      ["LICENSE", "agent-browser-LICENSE.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core.txt", "LICENSE-axe-core.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt", "LICENSE-axe-core-THIRD-PARTY.txt"],
    ]) copyFileSync(join(source, from), join(output, to));
    for (const { key } of patches) copyFileSync(join(browserDir, PATCHES[key].file), join(output, PATCHES[key].file.replace("patches/", "")));
    copyFileSync(join(browserDir, "README.md"), join(output, "README.md"));
    const provenance = {
      schemaVersion: 2, version, reportedVersion: reportedEngineVersion(set, target), set, target, rustTarget: targetInfo.rust,
      source: plan.source,
      patches: patches.map(({ key }) => ({ file: PATCHES[key].file, sha256: PATCHES[key].sha256, scope: PATCHES[key].scope })),
      toolchain: { rust, cargo, pnpm, node: process.version, runner: `${process.platform}-${process.arch}` },
      cargoLockSha256: digest(readFileSync(join(source, "cli/Cargo.lock"))),
      pnpmLockSha256: digest(readFileSync(join(source, "pnpm-lock.yaml"))),
      dashboardInventorySha256: digest(JSON.stringify(bundleInventory(dashboard))),
      executable: { asset, bytes: bytes.length, sha256: digest(bytes) },
      signing: "unsigned vendor bytes; Murage packaging verifies the pinned SHA-256, then signs and notarizes",
    };
    writeFileSync(join(output, `${asset}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(JSON.stringify(provenance, null, 2));
    return provenance;
  } finally { safeWipeSync(scratch); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildBrowserVendor(parseVendorBuildArgs(process.argv.slice(2)));
}
