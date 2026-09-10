import { chmod, lstat, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LICENSE_FILES } from "./cua-linux-release.mjs";
import {
  executableTarget,
  verifyCloudflaredExecutable,
} from "./prepare-cloudflared.mjs";
import { FUIGO_EXECUTABLE_NAMES, HARNESS_RESOURCE_DIRECTORIES } from "../electron/harness-resources.mjs";
import { FUIGO_VERSION, verifyFuigoExecutable } from "./prepare-fuigo.mjs";
import { validateFuigoProbeResources, stampSignedFuigoProbe } from "./fuigo-probe-resources.mjs";
import { verifyBrowserBundle } from "./prepare-browser.mjs";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { verifyWindowsBrowserImage, verifyWindowsBrowserSignatures, WINDOWS_BROWSER_IMAGE_PINS } from "../server/browser-windows-identity.ts";

async function requireRealDirectory(directory, mode = 0o755) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a real directory: ${directory}`);
  }
  if (mode !== undefined) await chmod(directory, mode);
}

async function requireRegularFile(file, mode) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a regular file: ${file}`);
  }
  if (mode !== undefined) await chmod(file, mode);
}

async function validateCloudflared(resources, platform, required) {
  const root = path.join(resources, "cloudflared");
  try {
    await lstat(root);
  } catch (error) {
    // Unit fixtures for the older CUA-only hook do not carry every packaged
    // resource. A real electron-builder context must fail closed because its
    // copier only warns when an extraResources `from` path is missing.
    if (error?.code === "ENOENT" && !required) return;
    throw error;
  }

  const unixMode = platform === "win32" ? undefined : 0o755;
  await requireRealDirectory(root, unixMode);
  const executable = path.join(root, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (JSON.stringify(await readdir(root)) !== JSON.stringify([path.basename(executable)])) {
    throw new Error(`Unexpected entries in packaged cloudflared resource: ${root}`);
  }
  await requireRegularFile(executable, unixMode);
  const target = executableTarget(await readFile(executable));
  const allowed = {
    darwin: new Set(["darwin-arm64", "darwin-x64"]),
    linux: new Set(["linux-x64"]),
    win32: new Set(["win32-x64"]),
  }[platform];
  if (!allowed?.has(target)) {
    throw new Error(`Packaged ${platform} app contains the wrong cloudflared target: ${target}`);
  }
  verifyCloudflaredExecutable(executable, target);

  const licenses = path.join(resources, "licenses");
  await requireRealDirectory(licenses, unixMode);
  await requireRegularFile(
    path.join(licenses, "cloudflared-LICENSE.txt"),
    platform === "win32" ? undefined : 0o644,
  );
  await requireRegularFile(
    path.join(licenses, "cloudflared-README.md"),
    platform === "win32" ? undefined : 0o644,
  );
}

// The bundled Fuigo engine gets the same treatment as cloudflared: the exact
// pinned bytes, the right architecture, an executable bit that survived the
// copy, and its own named license files. A missing or unreadable engine must
// fail the build here rather than ship an app whose engine can never start.
async function validateFuigo(resources, platform, required) {
  const root = path.join(resources, HARNESS_RESOURCE_DIRECTORIES.MURAGE_FUIGO_DIR);
  try {
    await lstat(root);
  } catch (error) {
    // Unit fixtures for the older CUA-only hook do not carry every packaged
    // resource. A real electron-builder context must fail closed because its
    // copier only warns when an extraResources `from` path is missing.
    if (error?.code === "ENOENT" && !required) return;
    throw error;
  }

  const unixMode = platform === "win32" ? undefined : 0o755;
  await requireRealDirectory(root, unixMode);
  const name = FUIGO_EXECUTABLE_NAMES[platform];
  if (!name) throw new Error(`Murage ships no bundled fuigo for ${platform}`);
  const executable = path.join(root, name);
  if (JSON.stringify(await readdir(root)) !== JSON.stringify([path.basename(executable)])) {
    throw new Error(`Unexpected entries in packaged fuigo resource: ${root}`);
  }
  await requireRegularFile(executable, unixMode);
  const target = executableTarget(await readFile(executable));
  const allowed = {
    darwin: new Set(["darwin-arm64", "darwin-x64"]),
    linux: new Set(["linux-x64"]),
    win32: new Set(["win32-x64"]),
  }[platform];
  if (!allowed?.has(target)) {
    throw new Error(`Packaged ${platform} app contains the wrong fuigo target: ${target}`);
  }
  // Byte-for-byte against the pinned digest, before platform signing
  // rewrites the signature — this is the last point the upstream bytes exist
  // unmodified inside the app.
  verifyFuigoExecutable(executable, target);

  const licenses = path.join(resources, "licenses");
  await requireRealDirectory(licenses, unixMode);
  for (const license of ["fuigo-LICENSE.txt", "fuigo-README.md", "fuigo-THIRD_PARTY_NOTICES.md"]) {
    await requireRegularFile(path.join(licenses, license), platform === "win32" ? undefined : 0o644);
  }
  console.log(`packaged fuigo ${FUIGO_VERSION} verified for ${target}`);
}

/** Target identity is established from packaged bytes, never the staging host.
 * Intel absence is explicit metadata only; this does not implement a fallback or
 * approve publishing an artifact without that native capability.
 */
export async function validatePackagedMemoryRuntime(resources, platform, archValue, required = true) {
  const server = path.join(resources, "server");
  const manifestFile = path.join(server, "memory-runtime-manifest.json");
  try { await lstat(manifestFile); }
  catch (error) { if (error?.code === "ENOENT" && !required) return; throw error; }
  const arch = typeof archValue === "string" ? archValue : ({ 1: "x64", 3: "arm64" })[archValue];
  const target = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].includes(target)) throw new Error(`Unsupported packaged memory target: ${target}`);
  for (const file of [manifestFile, path.join(server, "memory-model-manifest.json"), path.join(server, "memory/worker.js")]) await requireRegularFile(file);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const model = JSON.parse(await readFile(path.join(server, "memory-model-manifest.json"), "utf8"));
  const runtimes = manifest.packages?.filter(entry => entry.name === "onnxruntime-node");
  if (!Array.isArray(runtimes) || runtimes.length !== 1 || !manifest.packages.some(entry => entry.name === "@huggingface/transformers" && entry.version === model.runtimeVersion)) throw new Error("Packaged memory runtime manifest is incomplete or mismatched");
  const runtime = runtimes[0];
  if (typeof runtime.path !== "string" || path.isAbsolute(runtime.path)) throw new Error("Invalid packaged memory runtime path");
  const packageRoot = path.resolve(server, runtime.path), relative = path.relative(server, packageRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Packaged memory runtime path escapes server resources");
  await requireRealDirectory(packageRoot, platform === "win32" ? undefined : 0o755);
  const packageFile = path.join(packageRoot, "package.json"); await requireRegularFile(packageFile);
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  if (pkg.name !== "onnxruntime-node" || pkg.version !== runtime.version) throw new Error("Packaged ONNX Runtime version differs from manifest");
  const nativeRoot = path.join(packageRoot, "bin/napi-v6", platform, arch);
  const libraries = platform === "darwin" ? [`libonnxruntime.${pkg.version}.dylib`]
    : platform === "linux" ? ["libonnxruntime.so.1"]
    : ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"];
  const files = [], missingFiles = [];
  for (const name of ["onnxruntime_binding.node", ...libraries]) {
    const file = path.join(nativeRoot, name), recordPath = path.relative(server, file).split(path.sep).join("/");
    try { await requireRegularFile(file); }
    catch (error) { if (error?.code === "ENOENT") { missingFiles.push(recordPath); continue; } throw error; }
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(65536), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const actual = executableTarget(bytes.subarray(0, bytesRead));
      if (actual !== target) throw new Error(`Packaged memory architecture mismatch: ${recordPath} is ${actual}, expected ${target}`);
    } finally { await handle.close(); }
    files.push(recordPath);
  }
  const nativeBackendAvailable = missingFiles.length === 0;
  if (!nativeBackendAvailable && target !== "darwin-x64") throw new Error(`Packaged memory native runtime is missing for ${target}: ${missingFiles.join(", ")}`);
  const stagingHost = manifest.stagingHost ?? { platform: manifest.platform, arch: manifest.arch };
  if (typeof stagingHost.platform !== "string" || typeof stagingHost.arch !== "string") throw new Error("Packaged memory staging identity is missing");
  const verified = { ...manifest, platform, arch, stagingHost, nativeBackendAvailable,
    nativeBackend: { package: pkg.name, version: pkg.version, files, missingFiles } };
  await writeFile(manifestFile, JSON.stringify(verified, null, 2) + "\n");
  return verified;
}

// electron-builder normalizes copied resource directories to 0775. That is
// unsafe for a root-owned executable path after DEB/AppImage installation, so
// repair and revalidate the exact tree after resources are copied and before
// either artifact target is assembled.
export default async function afterPack(context) {
  const resources = context.packager?.getResourcesDir?.(context.appOutDir) ?? (
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, "Murage.app", "Contents", "Resources")
      : path.join(context.appOutDir, "resources")
  );
  await validateCloudflared(resources, context.electronPlatformName, Boolean(context.packager));
  await validateFuigo(resources, context.electronPlatformName, Boolean(context.packager));
  const fuigoProbe = await validateFuigoProbeResources(resources, context.electronPlatformName, Boolean(context.packager));
  await validatePackagedMemoryRuntime(resources, context.electronPlatformName, context.arch, Boolean(context.packager));
  // Resource copying only warns about missing sources. Validate the exact target
  // and complete pinned inventory before signing can change executable bytes.
  if (context.packager) {
    const arch = typeof context.arch === "string" ? context.arch : ({ 1: "x64", 3: "arm64" })[context.arch];
    verifyBrowserBundle(path.join(resources, "browser-engine"), `${context.electronPlatformName}-${arch}`);
  }

  // electron-builder's single-file extraResources copier does not run its
  // Windows signing transformer. Sign only the verified packaged copy, using
  // the same configured signer as the app and installer, before archiving it.
  if (context.electronPlatformName === "win32" && context.packager) {
    const browser = browserBundlePaths(path.join(resources, "browser-engine"), "win32-x64");
    const executables = [
      path.join(resources, HARNESS_RESOURCE_DIRECTORIES.MURAGE_FUIGO_DIR, FUIGO_EXECUTABLE_NAMES.win32),
      browser.engine, browser.chrome,
      ...(fuigoProbe ? [fuigoProbe.file] : []),
    ];
    for (const executable of executables) {
      if (await context.packager.signIf(executable) !== true) {
        throw new Error(`Packaged Windows signing did not complete: ${path.basename(executable)}`);
      }
    }
    for (const [file, pin] of [[browser.engine, WINDOWS_BROWSER_IMAGE_PINS.engine], [browser.chrome, WINDOWS_BROWSER_IMAGE_PINS.chrome]]) {
      if (!verifyWindowsBrowserImage(await readFile(file), pin).signed) throw new Error("Packaged Windows browser signing left an unsigned image");
    }
    await verifyWindowsBrowserSignatures([browser.engine, browser.chrome, ...(fuigoProbe ? [fuigoProbe.file] : [])], process.env.SystemRoot);
    if (fuigoProbe) await stampSignedFuigoProbe(fuigoProbe);
  }

  if (context.electronPlatformName !== "linux") return;

  const cuaRoot = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cuaRoot, "licenses");
  for (const directory of [context.appOutDir, resources, cuaRoot, licenses]) {
    await requireRealDirectory(directory);
  }
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    await requireRegularFile(path.join(cuaRoot, executable), 0o755);
  }
  await requireRegularFile(path.join(cuaRoot, "release.json"), 0o644);
  for (const license of LICENSE_FILES) {
    await requireRegularFile(path.join(licenses, license), 0o644);
  }
}
