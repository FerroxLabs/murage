import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./prepare-cloudflared.mjs", () => ({
  executableTarget: () => "win32-x64",
  verifyCloudflaredExecutable: vi.fn(),
}));
vi.mock("./prepare-fuigo.mjs", () => ({
  FUIGO_VERSION: "fixture",
  verifyFuigoExecutable: vi.fn(),
}));
vi.mock("./prepare-browser.mjs", () => ({ verifyBrowserBundle: vi.fn() }));
import { verifyBrowserBundle } from "./prepare-browser.mjs";
vi.mock("../server/browser-windows-identity.ts", async importOriginal => ({
  ...await importOriginal(),
  verifyWindowsBrowserImage: vi.fn(() => ({ signed: true })),
  verifyWindowsBrowserSignatures: vi.fn(async () => {}),
}));
import { verifyWindowsBrowserImage, verifyWindowsBrowserSignatures } from "../server/browser-windows-identity.ts";
import afterPack from "./after-pack.mjs";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { verifyFuigoExecutable } from "./prepare-fuigo.mjs";

const temporaryDirectories = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  verifyWindowsBrowserImage.mockReturnValue({ signed: true });
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-windows-signing-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  for (const name of ["fuigo", "cloudflared", "licenses"]) fs.mkdirSync(path.join(resources, name), { recursive: true });
  const executable = path.join(resources, "fuigo", "fuigo.exe");
  fs.writeFileSync(executable, "pinned fixture");
  const browser = browserBundlePaths(path.join(resources, "browser-engine"), "win32-x64");
  fs.mkdirSync(path.dirname(browser.chrome), { recursive: true });
  fs.writeFileSync(browser.engine, "pinned browser engine");
  fs.writeFileSync(browser.chrome, "pinned browser chrome");
  fs.writeFileSync(path.join(resources, "cloudflared", "cloudflared.exe"), "vendor fixture");
  for (const name of ["fuigo-LICENSE.txt", "fuigo-README.md", "fuigo-THIRD_PARTY_NOTICES.md", "cloudflared-LICENSE.txt", "cloudflared-README.md"]) {
    fs.writeFileSync(path.join(resources, "licenses", name), "fixture");
  }
  // Supply the runtime preconditions enforced before signing. The dedicated
  // after-pack-memory tests retain real architecture/absence negative coverage.
  const server = path.join(resources, "server");
  const runtimePath = "node_modules/onnxruntime-node";
  const runtime = path.join(server, runtimePath);
  const native = path.join(runtime, "bin/napi-v6/win32/x64");
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(path.join(server, "memory"), { recursive: true });
  fs.writeFileSync(path.join(server, "memory/worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "memory-model-manifest.json"), JSON.stringify({ runtimeVersion: "4.2.0" }));
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.24.3" }));
  fs.writeFileSync(path.join(server, "memory-runtime-manifest.json"), JSON.stringify({
    platform: "win32", arch: "x64", packages: [
      { name: "@huggingface/transformers", version: "4.2.0", path: "node_modules/@huggingface/transformers" },
      { name: "onnxruntime-node", version: "1.24.3", path: runtimePath },
    ],
  }));
  const header = Buffer.alloc(128);
  header.write("MZ", 0); header.writeUInt32LE(0x40, 0x3c);
  header.write("PE\0\0", 0x40); header.writeUInt16LE(0x8664, 0x44);
  for (const name of ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"])
    fs.writeFileSync(path.join(native, name), header);
  const signIf = vi.fn(async file => {
    expect(verifyFuigoExecutable).toHaveBeenCalledWith(executable, "win32-x64");
    expect(verifyBrowserBundle).toHaveBeenCalledWith(path.join(resources, "browser-engine"), "win32-x64");
    fs.appendFileSync(file, " signed fixture");
    return true;
  });
  return { executable, browser, signIf, context: { appOutDir, arch: "x64", electronPlatformName: "win32", packager: { signIf } } };
}

it("verifies the entire pinned inventory before signing all three packaged Windows engines", async () => {
  const { context, executable, browser, signIf } = fixture();
  await afterPack(context);
  expect(signIf.mock.calls.map(([file]) => file)).toEqual([executable, browser.engine, browser.chrome]);
  expect(fs.readFileSync(browser.engine, "utf8")).toBe("pinned browser engine signed fixture");
  expect(fs.readFileSync(browser.chrome, "utf8")).toBe("pinned browser chrome signed fixture");
  expect(verifyWindowsBrowserSignatures).toHaveBeenCalledWith([browser.engine, browser.chrome], process.env.SystemRoot);
  expect(fs.readFileSync(executable, "utf8")).toBe("pinned fixture signed fixture");
});

it("never signs an engine rejected by pinned-byte verification", async () => {
  const { context, signIf } = fixture();
  verifyFuigoExecutable.mockImplementation(() => { throw new Error("SHA-256 verification failed"); });
  await expect(afterPack(context)).rejects.toThrow("SHA-256 verification failed");
  expect(signIf).not.toHaveBeenCalled();
});

it("fails packaging if the configured signer skips the engine", async () => {
  const { context, signIf } = fixture();
  signIf.mockResolvedValue(false);
  await expect(afterPack(context)).rejects.toThrow("Windows signing did not complete");
});

it("propagates Azure signing failures before artifacts are assembled", async () => {
  const { context, signIf } = fixture();
  signIf.mockRejectedValue(new Error("Azure signing failed"));
  await expect(afterPack(context)).rejects.toThrow("Azure signing failed");
});


it("never signs any engine when the browser bundle pin is rejected", async () => {
  const { context, signIf } = fixture();
  verifyBrowserBundle.mockImplementation(() => { throw new Error("Browser pinned SHA-256 verification failed"); });
  await expect(afterPack(context)).rejects.toThrow("Browser pinned SHA-256 verification failed");
  expect(signIf).not.toHaveBeenCalled();
});

it.each(["agent-browser.exe", "chrome-headless-shell.exe"])("fails closed when browser signing is skipped for %s", async (name) => {
  const { context, signIf } = fixture();
  signIf.mockImplementation(async file => path.basename(file) !== name);
  await expect(afterPack(context)).rejects.toThrow(`Windows signing did not complete: ${name}`);
});


it("rejects signed browser content changes before trusting the signature", async () => {
  const { context } = fixture();
  verifyWindowsBrowserImage.mockImplementation(() => { throw new Error("Windows browser image differs from its pinned original"); });
  await expect(afterPack(context)).rejects.toThrow("differs from its pinned original");
  expect(verifyWindowsBrowserSignatures).not.toHaveBeenCalled();
});

it("rejects unsigned output and invalid final browser signatures", async () => {
  const { context } = fixture();
  verifyWindowsBrowserImage.mockReturnValue({ signed: false });
  await expect(afterPack(context)).rejects.toThrow("left an unsigned image");
  verifyWindowsBrowserImage.mockReturnValue({ signed: true });
  verifyWindowsBrowserSignatures.mockRejectedValue(new Error("Windows browser requires a valid Ferrox Labs signature"));
  await expect(afterPack(context)).rejects.toThrow("valid Ferrox Labs signature");
});


it("copies the configured browser EXEs without electron-builder's early signing transformer", async () => {
  const require = createRequire(import.meta.url);
  const builder = path.dirname(require.resolve("electron-builder/package.json"));
  const { FileMatcher, copyFiles } = require(require.resolve("app-builder-lib/out/fileMatcher.js", { paths: [builder] }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-browser-copy-")); temporaryDirectories.push(root);
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const entries = config.win.extraResources.filter(entry => entry.to.startsWith("browser-engine"));
  const source = path.join(root, "dist-native/browser/win32-x64");
  const browser = browserBundlePaths(source, "win32-x64");
  fs.mkdirSync(path.dirname(browser.chrome), { recursive: true });
  fs.writeFileSync(browser.engine, "original engine"); fs.writeFileSync(browser.chrome, "original chrome");
  fs.writeFileSync(path.join(source, "manifest.json"), "original manifest");
  const expand = value => value.replaceAll("${arch}", "x64");
  const matchers = entries.map(entry => new FileMatcher(path.join(root, entry.from), path.join(root, "resources", entry.to), expand, entry.filter));
  const transformer = vi.fn(() => null);
  await copyFiles(matchers, transformer, false);
  const copied = browserBundlePaths(path.join(root, "resources/browser-engine"), "win32-x64");
  expect(fs.readFileSync(copied.engine, "utf8")).toBe("original engine");
  expect(fs.readFileSync(copied.chrome, "utf8")).toBe("original chrome");
  expect(fs.readFileSync(copied.manifest, "utf8")).toBe("original manifest");
  expect(transformer.mock.calls.map(([file]) => path.basename(file))).not.toContain("agent-browser.exe");
  expect(transformer.mock.calls.map(([file]) => path.basename(file))).not.toContain("chrome-headless-shell.exe");
});
