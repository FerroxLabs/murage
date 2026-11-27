import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserBundlePaths, browserBundleSpec, CHROME_VERSION, SUPPORTED_BROWSER_TARGETS } from "../server/browser-bundle-release.ts";
import { resolveAgentBrowserReleaseAsset } from "../server/browser-engine-release.ts";
import { BROWSER_LICENSE_FILES, browserExtractionCommand, bundleInventory, parsePrepareBrowserArgs, releaseBytes, stageBrowserTarget, targetsForPreparation, verifyAssetBytes, verifyBrowserBundle, verifyBundleInventory } from "./prepare-browser.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const fixtures = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "omb-browser-prepare-test-")); fixtures.push(root); return root; }
afterEach(() => { vi.unstubAllGlobals(); for (const root of fixtures.splice(0)) removeTempDirSync(root); });

describe("pinned desktop browser preparation", () => {
  it("pins the exact headless vendor archives for only shipped targets", () => {
    expect(CHROME_VERSION).toBe("158.0.8127.36");
    expect(SUPPORTED_BROWSER_TARGETS).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    const pins = {
      "darwin-arm64": [105057133, "c24d40a3786322ff3a5e3ac6eed162226cbaf07ebe468715407827226b0f8897"],
      "darwin-x64": [112306247, "e0c5d07d8f5bcc5bdd5ef370e7daf3770856b585fcc9eecf441c7e3bb2e3d1cf"],
      "linux-x64": [132087165, "2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a"],
      "win32-x64": [127876264, "9655950dfeddf565561cd64cfe8ee716ccd6482fa3798503b632219efc65a71e"],
    };
    for (const target of SUPPORTED_BROWSER_TARGETS) {
      const spec = browserBundleSpec(target);
      expect([spec.chrome.bytes, spec.chrome.sha256]).toEqual(pins[target]);
      expect(spec.chrome.url).toMatch(/^https:\/\/storage.googleapis.com\/chrome-for-testing-public\/158\.0\.8127\.36\/[^/]+\/chrome-headless-shell-[^/]+\.zip$/);
      const [platform, arch] = target.split("-");
      const engine = resolveAgentBrowserReleaseAsset(platform, arch);
      expect(spec.engine).toMatchObject({ bytes: engine.bytes, sha256: engine.sha256, asset: engine.asset });
      expect(spec.chrome.license).toMatch(/LICENSE\.headless_shell$/);
    }
  });

  it("chooses host targets and rejects unsupported/cross-directory inputs", () => {
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64" })).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64", current: true })).toEqual(["darwin-arm64"]);
    expect(targetsForPreparation({ platform: "win32", arch: "x64" })).toEqual(["win32-x64"]);
    expect(targetsForPreparation({ target: "linux-x64" })).toEqual(["linux-x64"]);
    for (const target of ["linux-arm64", "win32-arm64", "../darwin-arm64", "freebsd-x64"]) expect(() => browserBundleSpec(target)).toThrow(/Unsupported/);
    expect(() => targetsForPreparation({ platform: "linux", arch: "arm64" })).toThrow(/Unsupported/);
  });

  it("has stable resource-relative paths on every platform", () => {
    const root = join("app", "resources", "browser-engine");
    for (const target of SUPPORTED_BROWSER_TARGETS) {
      const spec = browserBundleSpec(target);
      const paths = browserBundlePaths(root, target);
      expect(paths.engine).toBe(join(root, target.startsWith("win32") ? "agent-browser.exe" : "agent-browser"));
      expect(paths.chrome).toBe(join(root, spec.chrome.executable));
      expect(paths.manifest).toBe(join(root, "manifest.json"));
    }
  });

  it("accepts only explicit and unambiguous CLI modes", () => {
    expect(parsePrepareBrowserArgs(["--current"])).toEqual({ current: true });
    expect(parsePrepareBrowserArgs(["--target", "linux-x64"])).toEqual({ current: false, target: "linux-x64" });
    for (const args of [["--all"], ["--current", "--current"], ["--current", "--target", "linux-x64"], ["--target"], ["--target", "../../tmp"]]) expect(() => parsePrepareBrowserArgs(args)).toThrow();
  });

  it("uses Windows' ZIP-capable system tar instead of Git Bash's GNU tar", () => {
    expect(browserExtractionCommand("a.zip", "out", { platform: "win32", systemRoot: "D:\\Windows" })).toEqual({ file: "D:\\Windows\\System32\\tar.exe", args: ["-xf", "a.zip", "-C", "out"] });
    expect(browserExtractionCommand("a.zip", "out", { platform: "darwin" })).toEqual({ file: "unzip", args: ["-q", "a.zip", "-d", "out"] });
  });

  it("treats a tampered cache entry as a miss and repairs it, still failing closed on a bad download", async () => {
    const root = fixture();
    const bytes = Buffer.from("reviewed fixture");
    const asset = { asset: "fixture.zip", url: "https://invalid.example/fixture", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    writeFileSync(join(root, asset.asset), bytes);
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetch);
    // A cache entry that verifies is still served from disk, never refetched.
    await expect(releaseBytes(asset, root)).resolves.toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
    // Same-size tampering used to throw straight out of releaseBytes, which
    // wedged every later build until somebody deleted the file by hand. It is
    // a cache miss: the pinned download repairs the entry.
    writeFileSync(join(root, asset.asset), Buffer.alloc(bytes.length));
    await expect(releaseBytes(asset, root)).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, asset.asset))).toEqual(bytes);
    // Self-healing is not leniency: a download that also fails the pin throws.
    writeFileSync(join(root, asset.asset), Buffer.alloc(bytes.length));
    fetch.mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length)));
    await expect(releaseBytes(asset, root)).rejects.toThrow(/SHA-256/);
    expect(() => verifyAssetBytes(bytes.subarray(1), asset)).toThrow(/size/);
  });

  it.skipIf(process.platform === "win32")("publishes the cache entry by rename, so nothing partial or redirected wears the pinned name", async () => {
    const root = fixture();
    const cache = join(root, "cache"); mkdirSync(cache);
    const bytes = Buffer.from("reviewed fixture");
    const asset = { asset: "fixture.zip", url: "https://invalid.example/fixture", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched");
    // A symlink planted under the pinned name is what a direct write follows.
    symlinkSync(outside, join(cache, asset.asset));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    await expect(releaseBytes(asset, cache)).resolves.toEqual(bytes);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(lstatSync(join(cache, asset.asset)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(cache, asset.asset))).toEqual(bytes);
    // No half-written temporary is left wearing a name a later build reads.
    expect(readdirSync(cache)).toEqual([asset.asset]);
  });

  it("detects modified, missing and unexpected resource files", () => {
    const root = fixture();
    mkdirSync(join(root, "chrome"));
    writeFileSync(join(root, "chrome", "resource.pak"), "fixture");
    const inventory = bundleInventory(root);
    expect(() => verifyBundleInventory(root, inventory)).not.toThrow();
    writeFileSync(join(root, "chrome", "resource.pak"), "changed");
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/modified/);
    rmSync(join(root, "chrome", "resource.pak"));
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/incomplete/);
    writeFileSync(join(root, "extra"), "unexpected");
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/modified/);
  });

  it.skipIf(process.platform === "win32")("preserves internal symlinks but rejects escaping vendor paths", () => {
    const root = fixture();
    writeFileSync(join(root, "library"), "contents");
    symlinkSync("library", join(root, "current"));
    expect(bundleInventory(root)).toContainEqual({ path: "current", kind: "symlink", target: "library" });
    symlinkSync("..", join(root, "escape"));
    expect(() => bundleInventory(root)).toThrow(/escapes/);
  });

  it("rejects incomplete and incompatible manifests", () => {
    const root = fixture();
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow();
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...browserBundleSpec("linux-x64"), files: [] }));
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow(/pinned release/);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...browserBundleSpec("darwin-arm64"), files: [] }));
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow();
  });

  it("keeps an earlier complete stage untouched when cached inputs are invalid", async () => {
    const root = fixture();
    const destination = join(root, "dist-native", "browser", "linux-x64");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "existing"), "previous complete bundle");
    const cache = join(root, "cache"); mkdirSync(cache);
    const spec = browserBundleSpec("linux-x64");
    writeFileSync(join(cache, spec.engine.asset), "bad");
    writeFileSync(join(cache, spec.chrome.asset), "bad");
    // An invalid cache entry is re-downloaded now; a download that also fails
    // verification keeps the failure local to this run.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad")));
    await expect(stageBrowserTarget(root, "linux-x64", { cacheDirectory: cache })).rejects.toThrow(/verification/);
    expect(readFileSync(join(destination, "existing"), "utf8")).toBe("previous complete bundle");
  });

  it("ships exact upstream engine and embedded axe notices, not the dashboard license", () => {
    for (const name of BROWSER_LICENSE_FILES) expect(readFileSync(new URL(`../third_party/browser/${name}`, import.meta.url)).length).toBeGreaterThan(100);
    expect(readFileSync(new URL("../third_party/browser/agent-browser-LICENSE.txt", import.meta.url), "utf8")).toContain("Apache License");
  });
});
