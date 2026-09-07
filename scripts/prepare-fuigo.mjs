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
  rmSync,
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

export const FUIGO_VERSION = "1.0.6";
export const FUIGO_REGISTRY = "https://registry.npmjs.org";

// Pinned to an exact version — never a floating range for a shipped binary.
// `tarballSha256` covers the published npm tarball; `binarySha256` covers the
// brotli-decompressed executable that actually ships.
//
// All six targets fuigo@1.0.6 declares are pinned here, including the two
// arm64 ones Murage does not build today. That is deliberate and is NOT an
// inconsistency with targetsForHost() below: pinning is "this digest has been
// reviewed", staging is "electron-builder packages this". Keeping the reviewed
// digest here makes a future builder arch flip a one-line change to
// targetsForHost rather than a fresh supply-chain review under deadline.
export const FUIGO_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    package: "@fuigo/darwin-arm64",
    tarballSha256: "f7bb3f682f81a167ad056da7b5cee625445f9d31ac19cfeb208b65030af5bae5",
    binarySha256: "dfc0f618662076f6e3d8b2353934bd1f141d838ae40290444b3d730a8bfc9eb8",
  }),
  "darwin-x64": Object.freeze({
    package: "@fuigo/darwin-x64",
    tarballSha256: "cb6eaf4fd36de8721c3f3f001763f72473ed975d9e83005e8983b2054aca17cf",
    binarySha256: "9f77a1b9e5d412a09519bd44908885f0d11fd98056453160ae03e2c121f19a29",
  }),
  "linux-arm64": Object.freeze({
    package: "@fuigo/linux-arm64",
    tarballSha256: "f1b3ff451b2d90663a261d9b5603ac34ee2e05a8bd7df4cd8c15cf8885f96936",
    binarySha256: "960e5418c1ef00c75374ad9a1d1dc3647930a46ddd23e4471c4590c921e2c9bc",
  }),
  "linux-x64": Object.freeze({
    package: "@fuigo/linux-x64",
    tarballSha256: "4829fdd96c92bac4bc0170db756fd0946a8b685e9ced6963e350b6fc2020d4fa",
    binarySha256: "95999a9d87bedddab1ae8e2749b2b9bbc51c2222b5fc6ddc6ed77fc3f08be1d1",
  }),
  // The old note here said fuigo-win32-arm64 was declared but unpublished.
  // That is no longer true: under the scope, @fuigo/win32-arm64@1.0.6 publishes
  // and resolves normally, re-checked against the live registry at this bump.
  // The remaining obstacle is on our side, not upstream — see
  // UNSTAGEABLE_TARGETS.
  "win32-arm64": Object.freeze({
    package: "@fuigo/win32-arm64",
    tarballSha256: "b6685a0cdc8c1e812705ac37fd199b9c22ab0b1035403c693221b8910d2301bf",
    binarySha256: "5c3e17f341502a606c1e3c46ebba92e21092574786e5c27cbc3a1bd32b7822c2",
  }),
  "win32-x64": Object.freeze({
    package: "@fuigo/win32-x64",
    tarballSha256: "851c8bd81dba143446358673aa37da9c6dc6b1030448e848893ae140c2aa833b",
    binarySha256: "8ae9f33ed2d1536cf5741913d30720ab4741468b1b9b8872ce08b3cdd9dbd923",
  }),
});

// Pinned and digest-reviewed above, but NOT stageable yet. verifyPinnedBinary()
// parses the real executable header through the shared executableTarget() in
// prepare-cloudflared.mjs, and that parser classifies only ELF x86-64
// (e_machine 0x3e) and PE AMD64 (0x8664). The published 1.0.6 arm64 engines are
// ELF aarch64 (0xb7) and PE ARM64 (0xaa64) — read off the real downloaded bytes,
// not assumed — so staging either one would download ~40MB, pass the tarball
// digest, then die inside a cloudflared-worded "unsupported executable format"
// before the binary digest was ever compared. Refuse up front instead.
//
// The refusal lives here rather than in a second header parser on purpose: one
// parser is exactly why executableTarget is imported. Teaching it those two
// machine values deletes this set and nothing else.
const UNSTAGEABLE_TARGETS = Object.freeze(new Set(["linux-arm64", "win32-arm64"]));

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
 * `@fuigo/darwin-arm64/-/darwin-arm64-1.0.6.tgz`. Building the basename from
 * the full package id would request `@fuigo/darwin-arm64-1.0.6.tgz`, which
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
  // Windows and Linux arm64 hosts stay refused even now that both engines are
  // pinned, because staging on them cannot succeed: the shared header parser
  // rejects ELF aarch64 and PE ARM64 (see UNSTAGEABLE_TARGETS). Refusing at
  // argument time is a clear "unsupported"; allowing it would swap that for a
  // long download ending in a misleading cloudflared error. The day
  // executableTarget learns those two machine values, this stops refusing on
  // its own with no edit here.
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

async function registryBytes(target) {
  const cacheDirectory = process.env.MURAGE_FUIGO_ARCHIVE_DIR;
  const cached = cacheDirectory ? join(cacheDirectory, tarballName(target)) : "";
  if (cached && existsSync(cached)) return readFileSync(cached);

  const url = tarballUrl(target);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`could not download ${tarballName(target)}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function stagedDirectory(root, target) {
  return join(root, "dist-native", "fuigo", target);
}

async function stageTarget(root, target) {
  assertStageable(target);
  const asset = FUIGO_ASSETS[target];

  const finalDirectory = stagedDirectory(root, target);
  const executable = fuigoExecutableName(target);
  const binary = join(finalDirectory, executable);
  const manifestFile = join(finalDirectory, "manifest.json");
  if (executableIsCurrent(binary, manifestFile, target)) {
    console.log(`fuigo ${FUIGO_VERSION} already staged for ${target}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), `murage-fuigo-${target}-`));
  try {
    const payload = await registryBytes(target);
    verifySha256(payload, asset.tarballSha256, tarballName(target));

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
    if (!target.startsWith("win32-")) {
      // copyFile preserves the source mode on Unix in current Node, but make
      // the executable contract explicit instead of depending on that detail.
      chmodSync(stagedBinary, 0o755);
    }
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(expectedManifest(target), null, 2)}\n`,
      { mode: 0o600 },
    );
    rmSync(finalDirectory, { recursive: true, force: true });
    renameSync(staging, finalDirectory);
    console.log(`staged fuigo ${FUIGO_VERSION} for ${target}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
