// Stage a pinned Fuigo engine executable for every desktop target
// electron-builder will package. Pass --current for development to stage only
// the platform and architecture running this script, or --target <p>-<a> (or
// MURAGE_FUIGO_TARGETS) to stage for a cross-built target instead of this
// host — electron-builder builds per-platform, so the packaged target, not the
// build machine, chooses the binary.
//
// The npm `fuigo` entry point is a Node launcher and the real executable
// arrives brotli-compressed inside the matching `@fuigo/<platform>-<arch>`
// optional dependency, decompressed by a postinstall step into ~/.fuigo/bin.
// Those platform packages were unscoped (`fuigo-<platform>-<arch>`) through
// 1.0.2 and are scoped from 1.0.4 on; the unscoped names are not published at
// 1.0.4 at all, so the scope is not cosmetic.
// Copying out of node_modules would ship either the compressed artifact or a
// shim that needs Node on the user's machine, so this script fetches the
// platform package directly and decompresses the real native executable.
//
// The registry tarball and the decompressed executable are both verified
// against pinned SHA-256 digests, and the executable is verified again on
// every reuse. Nothing is installed globally; Murage updates this dependency
// with an ordinary reviewed app release.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";

// executableTarget/verifySha256 are format-level helpers with nothing
// cloudflared-specific in them; after-pack.mjs already reuses executableTarget
// the same way. Keeping one implementation means a staged binary can never be
// filed under the wrong target because a second copy of the header parser
// drifted.
import { executableTarget, verifySha256 } from "./prepare-cloudflared.mjs";
import { FUIGO_EXECUTABLE_NAMES } from "../electron/harness-resources.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

export const FUIGO_VERSION = "1.0.43";
export const FUIGO_REGISTRY = "https://registry.npmjs.org";

// Pinned to an exact version — never a floating range for a shipped binary.
// `tarballSha256` covers the published npm tarball; `binarySha256` covers the
// brotli-decompressed executable that actually ships.
//
// Pin preparation uses a sentinel that is deliberately not a digest:
// packaging fails closed until scripts/fill-fuigo-pin.sh verifies the release.
// Source marker for fuigo-bump.mjs: report gitHead 48d6f8e3c862c1a63043b44eb83a3615f0c3b8b8.
// See fuigo-1.0.43-provenance.json; older release receipts remain historical.
export const FUIGO_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    package: "@fuigo/darwin-arm64",
    tarballSha256: "820b41761792ecd4e706318339fc756ba11c0b9827c29a6839a662d39211b480",
    binarySha256: "b5ea4aecd27b0e913026086e5ab5cac103c8fbfbb9ca26c24ce6117e19620091",
  }),
  "darwin-x64": Object.freeze({
    package: "@fuigo/darwin-x64",
    tarballSha256: "f6542623d00d16fd0800abba7a5e70a2e924f69a8008bfa558257c0ef8ff6f85",
    binarySha256: "3dbdcd2d99a65889524b6b77295b4f2a87d9cfd5db50b66fd421fa4f5cc80e4a",
  }),
  "linux-arm64": Object.freeze({
    package: "@fuigo/linux-arm64",
    tarballSha256: "fb28ae482cb11b0899d8200a7133857526473d583a24d79e96443099ef901139",
    binarySha256: "1f83ffb549ab08e9668841e3d1aec0a70335187a6340687a2a3872353cffafae",
  }),
  "linux-x64": Object.freeze({
    package: "@fuigo/linux-x64",
    tarballSha256: "3d0d0932ed82e9ca497fb504f2aa87f2a9caa08f387277257d27772064497eb5",
    binarySha256: "d62ea93bc75ed09693e1b085b320c5656bd96429511d5d2f494886ca909861a1",
  }),
  // Retained for the upstream package inventory; see UNSTAGEABLE_TARGETS.
  "win32-arm64": Object.freeze({
    package: "@fuigo/win32-arm64",
    tarballSha256: "01883dbb7a504ecf268746a6651f6b0c62294d61123627486b2dadc7611000ea",
    binarySha256: "9e01826db39082ee3d9dccd024563beef49eaaff0663ff288be6053de28dfc0e",
  }),
  "win32-x64": Object.freeze({
    package: "@fuigo/win32-x64",
    tarballSha256: "329627e2f0503a09dd661b66de189dc805c45409d5f2cc3b70aee1d1b21272f0",
    binarySha256: "f837e817a71acce83d17542a84ad9e9fc5d8215e995ff45ae9c0ccd0b215bfdd",
  }),
});

// Pinned above, but NOT stageable yet: the shared executableTarget() parser
// cannot classify PE ARM64 (0xaa64). Refuse before downloading an archive that
// would pass its digest but fail header verification. Linux aarch64 is supported.
const UNSTAGEABLE_TARGETS = Object.freeze(new Set(["win32-arm64"]));

/** A target must be both pinned and classifiable by the shared header parser
 * before anything tries to fetch it. */
function assertStageable(target) {
  if (!Object.hasOwn(FUIGO_ASSETS, target)) throw new Error(`No pinned fuigo asset for ${target}`);
  if (UNSTAGEABLE_TARGETS.has(target)) {
    throw new Error(
      `fuigo ${target} is pinned but not yet stageable: executableTarget() cannot classify its header`,
    );
  }
}

/** The staged file name, taken from the one declaration of it so the staged
 * tree, the electron-builder `to:` basename and the name the server reads can
 * never drift: electron/harness-resources.mjs. */
export function fuigoExecutableName(target) {
  const name = FUIGO_EXECUTABLE_NAMES[target.slice(0, target.lastIndexOf("-"))];
  if (!name) throw new Error(`Murage ships no bundled fuigo for ${target}`);
  return name;
}

/** Path inside the npm tarball holding the brotli-compressed executable. */
function vendorEntry(target) {
  return `package/bin/${fuigoExecutableName(target)}.br`;
}

/** npm names a scoped package's tarball after the UNSCOPED half of the name:
 * `@fuigo/darwin-arm64` publishes at
 * `@fuigo/darwin-arm64/-/darwin-arm64-1.0.43.tgz`. Building the basename from
 * the full package id would request `@fuigo/darwin-arm64-1.0.43.tgz`, which
 * 404s, and would also push a `/` into the MURAGE_FUIGO_ARCHIVE_DIR cache
 * path. */
function unscopedPackageName(packageName) {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

export function tarballName(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  return `${unscopedPackageName(asset.package)}-${FUIGO_VERSION}.tgz`;
}

export function tarballUrl(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  return `${FUIGO_REGISTRY}/${asset.package}/-/${tarballName(target)}`;
}

/** Both sources serve the same release tarball bytes and share one SHA-256 pin. */
export function tarballUrls(target) {
  return [
    tarballUrl(target),
    `https://github.com/FerroxLabs/fuigo/releases/download/v${FUIGO_VERSION}/fuigo-${tarballName(target)}`,
  ];
}

/** Every target the desktop build for `platform` packages. This deliberately
 * covers LESS than FUIGO_ASSETS: electron-builder.yml builds macOS at arm64 and
 * x64, but Windows (nsis + zip) and Linux (AppImage + deb) at x64 only. The two
 * arm64 entries are pinned-and-reviewed, not staged by default. Do not "fix"
 * the apparent mismatch by widening this — widen electron-builder.yml first. */
export function targetsForHost(platform) {
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "linux") return ["linux-x64"];
  if (platform === "win32") return ["win32-x64"];
  throw new Error(`Fuigo packaging is unsupported on ${platform}`);
}

export function targetForCurrentHost(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  // Windows arm64 remains refused until the shared header parser supports it.
  if (!Object.hasOwn(FUIGO_ASSETS, target) || UNSTAGEABLE_TARGETS.has(target)) {
    throw new Error(`Fuigo development is unsupported on ${target}`);
  }
  return target;
}

/** Selection is by BUILD TARGET, not build host: explicit --target/env wins,
 * then --current (development), then everything this host's package script
 * builds. A cross-build names its targets and never inherits process.arch. */
export function targetsForPreparation({
  current = false,
  targets = [],
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (targets.length > 0) {
    for (const target of targets) assertStageable(target);
    return [...new Set(targets)];
  }
  return current ? [targetForCurrentHost(platform, arch)] : targetsForHost(platform);
}

export function parsePrepareFuigoArgs(args = [], environment = process.env) {
  const parsed = { current: false, targets: [] };
  const fromEnv = (environment.MURAGE_FUIGO_TARGETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  parsed.targets.push(...fromEnv);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--current") {
      parsed.current = true;
      continue;
    }
    if (arg === "--target") {
      const value = args[index + 1];
      if (!value) throw new Error("Usage: node scripts/prepare-fuigo.mjs [--current] [--target <platform>-<arch>]");
      parsed.targets.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      parsed.targets.push(arg.slice("--target=".length));
      continue;
    }
    throw new Error("Usage: node scripts/prepare-fuigo.mjs [--current] [--target <platform>-<arch>]");
  }
  if (parsed.current && parsed.targets.length > 0) {
    throw new Error("prepare-fuigo: --current and --target are mutually exclusive");
  }
  return parsed;
}

/** Bytes-level identity check. The executable header is parsed rather than
 * trusted so a correctly checksummed asset still cannot be staged into the
 * wrong target directory. */
export function verifyPinnedBinary(value, target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  const actualTarget = executableTarget(value);
  if (actualTarget !== target) {
    throw new Error(`fuigo architecture mismatch (expected ${target}, received ${actualTarget})`);
  }
  return verifySha256(value, asset.binarySha256, `${target} fuigo executable`);
}

export function assertFuigoPinReady(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset || ![asset.tarballSha256, asset.binarySha256].every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error(`fuigo ${target}: FILL\x2dAT-NPM; run scripts/fill-fuigo-pin.sh after publication`);
  }
}

function targetRunsOnHost(target, platform = process.platform, arch = process.arch) {
  return target === `${platform}-${arch}`;
}

function executableHasPinnedVersion(binary, target) {
  // A dual-architecture macOS package is prepared in one invocation, and a
  // cross-build stages targets this host cannot execute at all. Those still
  // have pinned bytes and a checked Mach-O/ELF/PE header; only the runnable
  // one is actually executed.
  if (!targetRunsOnHost(target)) return true;
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return result.status === 0 && `${result.stdout}\n${result.stderr}`.includes(`fuigo ${FUIGO_VERSION}`);
}

export function verifyFuigoExecutable(binary, target) {
  verifyPinnedBinary(readFileSync(binary), target);
  if (!executableHasPinnedVersion(binary, target)) {
    throw new Error(`${target} executable did not identify as fuigo ${FUIGO_VERSION}`);
  }
}

export function expectedManifest(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  return {
    version: FUIGO_VERSION,
    target,
    registryPackage: `${asset.package}@${FUIGO_VERSION}`,
    tarball: tarballName(target),
    tarballSha256: asset.tarballSha256,
    binarySha256: asset.binarySha256,
  };
}

function executableIsCurrent(binary, manifestFile, target) {
  if (!existsSync(binary) || !existsSync(manifestFile)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest(target))) return false;
    verifyFuigoExecutable(binary, target);
    return true;
  } catch {
    return false;
  }
}

function extractionFailure(result) {
  return result.error?.message ?? String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
}

export async function registryBytes(target, {
  fetcher = fetch,
  archiveDirectory = process.env.MURAGE_FUIGO_ARCHIVE_DIR,
} = {}) {
  assertStageable(target);
  const cached = archiveDirectory ? join(archiveDirectory, tarballName(target)) : "";
  const verified = (bytes) => {
    verifySha256(bytes, FUIGO_ASSETS[target].tarballSha256, tarballName(target));
    return bytes;
  };
  if (cached && existsSync(cached)) return verified(readFileSync(cached));

  const failures = [];
  for (const url of tarballUrls(target)) {
    let bytes;
    try {
      const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
      continue;
    }
    // Only transport failures try the next source. Corrupt bytes fail closed.
    return verified(bytes);
  }
  throw new Error(`could not download ${tarballName(target)}: ${failures.join("; ")}`);
}

export function stagedDirectory(root, target) {
  return join(root, "dist-native", "fuigo", target);
}

function applyTargetDirectoryModes(directory, target) {
  if (!target.startsWith("win32-")) {
    // mkdtemp and the manifest start private; the shipped tree must be
    // readable and traversable by a different runtime user.
    chmodSync(directory, 0o755);
    chmodSync(join(directory, "manifest.json"), 0o644);
    // copyFile preserves the source mode on Unix in current Node, but make
    // the executable contract explicit instead of depending on that detail.
    chmodSync(join(directory, fuigoExecutableName(target)), 0o755);
  }
}

export function finalizeTargetDirectory(staging, finalDirectory, target) {
  applyTargetDirectoryModes(staging, target);
  renameSync(staging, finalDirectory);
}

async function stageTarget(root, target) {
  assertStageable(target);
  assertFuigoPinReady(target);
  const finalDirectory = stagedDirectory(root, target);
  const executable = fuigoExecutableName(target);
  const binary = join(finalDirectory, executable);
  const manifestFile = join(finalDirectory, "manifest.json");
  if (executableIsCurrent(binary, manifestFile, target)) {
    applyTargetDirectoryModes(finalDirectory, target);
    console.log(`fuigo ${FUIGO_VERSION} already staged for ${target}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), `murage-fuigo-${target}-`));
  try {
    const payload = await registryBytes(target);

    const archive = join(scratch, basename(tarballName(target)));
    writeFileSync(archive, payload, { mode: 0o600 });
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted, { mode: 0o700 });
    const result = spawnSync("tar", ["-xzf", archive, "-C", extracted, vendorEntry(target)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
    });
    if (result.status !== 0) {
      throw new Error(`could not extract ${tarballName(target)}: ${extractionFailure(result)}`);
    }
    const compressed = join(extracted, ...vendorEntry(target).split("/"));
    if (!existsSync(compressed)) {
      throw new Error(`${tarballName(target)} did not contain ${vendorEntry(target)}`);
    }

    // The published bytes are brotli-compressed to fit npm's tarball limit.
    // Ship the DECOMPRESSED executable: a compressed blob does not run, and on
    // macOS a file materialised after packaging would sit unsigned inside a
    // hardened-runtime bundle and fail notarization.
    const candidate = join(scratch, executable);
    writeFileSync(candidate, brotliDecompressSync(readFileSync(compressed)), { mode: 0o700 });
    if (!target.startsWith("win32-")) chmodSync(candidate, 0o700);

    verifyFuigoExecutable(candidate, target);

    const parent = dirname(finalDirectory);
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, `.${target}-`));
    const stagedBinary = join(staging, executable);
    copyFileSync(candidate, stagedBinary);
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(expectedManifest(target), null, 2)}\n`,
      { mode: 0o600 },
    );
    safeWipeSync(finalDirectory, { within: root });
    finalizeTargetDirectory(staging, finalDirectory, target);
    console.log(`staged fuigo ${FUIGO_VERSION} for ${target}`);
  } finally {
    safeWipeSync(scratch);
  }
}

export async function prepareFuigo({
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
  current = false,
  targets = [],
} = {}) {
  for (const target of targetsForPreparation({ current, targets, platform, arch })) {
    await stageTarget(root, target);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await prepareFuigo(parsePrepareFuigoArgs(process.argv.slice(2)));
}
