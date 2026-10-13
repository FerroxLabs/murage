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

export const FUIGO_VERSION = "1.0.24";
export const FUIGO_REGISTRY = "https://registry.npmjs.org";

// Pinned to an exact version — never a floating range for a shipped binary.
// `tarballSha256` covers the published npm tarball; `binarySha256` covers the
// brotli-decompressed executable that actually ships.
//
// Provenance for 1.0.24: official fuigo and all six @fuigo platform
// metadata records report gitHead 17824fce851baadd29018261e3184eb43e379253.
// Each registry archive was downloaded and verified against its published
// SHA-512 integrity and SHA-1 shasum, then SHA-256 hashed. The matching
// package/bin executable was Brotli-decompressed without install scripts,
// SHA-256 hashed and its Mach-O/ELF/PE machine header independently checked.
// See fuigo-1.0.24-provenance.json for the exact source and registry receipts.
// All six declared platform packages are pinned; the existing Linux/Windows
// arm64 staging refusals below remain in force. Cross-target byte/header
// verification is not native execution qualification on those platforms.
export const FUIGO_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    package: "@fuigo/darwin-arm64",
    tarballSha256: "b5406dc1d544c4c875fe47d267d8e5e953eace8d0d8bf0ab99d4bce398ca1546",
    binarySha256: "30d205448dc2d4f19b74a0a2a8de44ac7a0ae1ffc579cf77f7023b065974d4e8",
  }),
  "darwin-x64": Object.freeze({
    package: "@fuigo/darwin-x64",
    tarballSha256: "b07f544088874c72d93d9a095320f21d5288bfe6e272707dce3487510880543a",
    binarySha256: "5f9510546a641d6bd8bcaecd4518a088229b42eb77c4afcfc11f433bb8ec9788",
  }),
  "linux-arm64": Object.freeze({
    package: "@fuigo/linux-arm64",
    tarballSha256: "8fed5eddc7f01ec33ce9f6262b1f5cca9f10daa81784ad7633b3f241aaa5f6cd",
    binarySha256: "12aeb1ce1dd86734cf5ae34db245465bf963c926d8ac26543d00f00f195c66a7",
  }),
  "linux-x64": Object.freeze({
    package: "@fuigo/linux-x64",
    tarballSha256: "dc7e8ee2e206690dc583b24721df4cc85812312af9bf5ea86732ce195c054e26",
    binarySha256: "47ffced5b1f1a26be7903b0f1ee923a61259e0be1b0acf9effafdccc7e68fb3b",
  }),
  // The old note here said fuigo-win32-arm64 was declared but unpublished.
  // That is no longer true: under the scope, @fuigo/win32-arm64@1.0.24 publishes
  // and resolves normally, re-checked against the live registry at this bump.
  // The remaining obstacle is on our side, not upstream — see
  // UNSTAGEABLE_TARGETS.
  "win32-arm64": Object.freeze({
    package: "@fuigo/win32-arm64",
    tarballSha256: "e5e05a87ffb69b45e0736a884ebd45aebc5b96018f4bc9b1fe153811bc817aad",
    binarySha256: "4031aaaa62373d0f66c35791927026275588ae17ed630013ef1791f41a61f42c",
  }),
  "win32-x64": Object.freeze({
    package: "@fuigo/win32-x64",
    tarballSha256: "4cdb9ed2fab284161358477cb5a946204f191685cd3649becb5026d0d12e5f59",
    binarySha256: "027fa9c0affabac093da1b3d668871f9b913626e28be8388ad08813c57d4aaed",
  }),
});

// Pinned and digest-reviewed above, but NOT stageable yet. verifyPinnedBinary()
// parses the real executable header through the shared executableTarget() in
// prepare-cloudflared.mjs, and that parser classifies only ELF x86-64
// (e_machine 0x3e) and PE AMD64 (0x8664). The published 1.0.24 arm64 engines are
// ELF aarch64 (0xb7) and PE ARM64 (0xaa64) — read off the real downloaded bytes
// at this bump — so staging either one
// would download ~35-50MB, pass the tarball
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
 * `@fuigo/darwin-arm64/-/darwin-arm64-1.0.24.tgz`. Building the basename from
 * the full package id would request `@fuigo/darwin-arm64-1.0.24.tgz`, which
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
    safeWipeSync(finalDirectory, { within: root });
    renameSync(staging, finalDirectory);
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
