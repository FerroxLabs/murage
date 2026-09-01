// Stage a pinned Fuigo engine executable for every desktop target
// electron-builder will package. Pass --current for development to stage only
// the platform and architecture running this script, or --target <p>-<a> (or
// MURAGE_FUIGO_TARGETS) to stage for a cross-built target instead of this
// host — electron-builder builds per-platform, so the packaged target, not the
// build machine, chooses the binary.
//
// The npm `fuigo` entry point is a Node launcher and the real executable
// arrives brotli-compressed inside the matching `fuigo-<platform>-<arch>`
// optional dependency, decompressed by a postinstall step into ~/.fuigo/bin.
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

export const FUIGO_VERSION = "1.0.1";
export const FUIGO_REGISTRY = "https://registry.npmjs.org";

// Pinned to an exact version — never a floating range for a shipped binary.
// `tarballSha256` covers the published npm tarball; `binarySha256` covers the
// brotli-decompressed executable that actually ships.
export const FUIGO_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    package: "fuigo-darwin-arm64",
    tarballSha256: "c4a5d836be258734dc0da0566b26e9841cbb59fd59ff6ec6442d7efc2e93f914",
    binarySha256: "d861b35824ead4f96ec60e26ae3389d8245cce1081402a6a3c58e93b6449c140",
  }),
  "darwin-x64": Object.freeze({
    package: "fuigo-darwin-x64",
    tarballSha256: "db7f26a39fbb63913fbd8cff35fa989815b948ba2060c9fe9f08a7f288f3a2ea",
    binarySha256: "60a398bfa4482171acf36ffe7d42ea61f9e8b2e96acbcb9f1531b5159b2f32bb",
  }),
  "linux-x64": Object.freeze({
    package: "fuigo-linux-x64",
    tarballSha256: "a3cbfb62b735ead7af46d3e45f2ee719efe064f1b0235c7b7aa2e56b1112e4c3",
    binarySha256: "f58e78d1fca5f0ef0400672be6c1238dcf7222862ddf3f2fae6dbe270adeff0a",
  }),
  // fuigo 1.0.1 declares fuigo-win32-arm64 as an optionalDependency but no
  // such package is published (the registry answers 404). Murage builds
  // Windows x64 only, so there is nothing to pin for arm64 yet.
  "win32-x64": Object.freeze({
    package: "fuigo-win32-x64",
    tarballSha256: "6be9462ea8c37ad81353051a42ba71d4d50fe3e2dc88172cfdaf107d6ba95a8b",
    binarySha256: "1f4cdc47f13ba88f02bceba262824cccf20d4978b0eae2bcfb2b9d1e96cfbc38",
  }),
});

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

export function tarballName(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  return `${asset.package}-${FUIGO_VERSION}.tgz`;
}

export function tarballUrl(target) {
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);
  return `${FUIGO_REGISTRY}/${asset.package}/-/${tarballName(target)}`;
}

/** Every target the desktop build for `platform` packages. */
export function targetsForHost(platform) {
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "linux") return ["linux-x64"];
  if (platform === "win32") return ["win32-x64"];
  throw new Error(`Fuigo packaging is unsupported on ${platform}`);
}

export function targetForCurrentHost(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(FUIGO_ASSETS, target)) {
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
    for (const target of targets) {
      if (!Object.hasOwn(FUIGO_ASSETS, target)) throw new Error(`No pinned fuigo asset for ${target}`);
    }
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
  const asset = FUIGO_ASSETS[target];
  if (!asset) throw new Error(`No pinned fuigo asset for ${target}`);

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
