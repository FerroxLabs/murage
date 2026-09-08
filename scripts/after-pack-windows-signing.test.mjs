import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import afterPack from "./after-pack.mjs";
import { verifyFuigoExecutable } from "./prepare-fuigo.mjs";

const temporaryDirectories = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-windows-signing-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  for (const name of ["fuigo", "cloudflared", "licenses"]) fs.mkdirSync(path.join(resources, name), { recursive: true });
  const executable = path.join(resources, "fuigo", "fuigo.exe");
  fs.writeFileSync(executable, "pinned fixture");
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
  return { executable, signIf, context: { appOutDir, arch: "x64", electronPlatformName: "win32", packager: { signIf } } };
}

it("verifies the pinned bytes before signing only the packaged Windows engine", async () => {
  const { context, executable, signIf } = fixture();
  await afterPack(context);
  expect(signIf).toHaveBeenCalledExactlyOnceWith(executable);
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
