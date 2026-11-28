// Reviewed vendor assets, downloaded and hashed on 2026-09-07. Update all
// pins together and run each platform's packaged, offline browser smoke test.
// This is Chromium's headless shell, not full Chrome (which includes Widevine).
import { join } from "node:path";
import { CLOUD_BROWSER_PINS } from "./cloud-home/browser-pins.ts";
import {
  agentBrowserReleaseUrl,
  agentBrowserReleaseVersion,
  resolveAgentBrowserReleaseAsset,
} from "./browser-engine-release.ts";

export const CHROME_VERSION = "158.0.8127.88";
export const SUPPORTED_BROWSER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"] as const;
export type BrowserBundleTarget = typeof SUPPORTED_BROWSER_TARGETS[number];

const CHROME_ASSETS = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 105060087, sha256: "69320f6869c4defbbdac8b8fa83aef65dc63975e83bbd06899b75dbea5c464b3", executableSha256: "94aa2ddc006b462298814c4f4ed86f13bd834223c28e3f3d60218773a8960ccc" },
  "darwin-x64": { platform: "mac-x64", bytes: 112314759, sha256: "dc1ac31965cb2ec7794aed8c66127aceea304ae15353cd56fc4b8bde44091548", executableSha256: "408f411de4c6d9757e047c1be0812c622b360620497e271fce173db07ff4cf27" },
  "linux-x64": { platform: "linux64", bytes: 132091593, sha256: "63401333cc587645bfaeea7f0c90958b327d249251e23954a47f30112ca23d5b", executableSha256: "ff725c1ed878243206416340acd981e9f60bb8265557f927967c782cfa480db4" },
  "win32-x64": { platform: "win64", bytes: 127879225, sha256: "e935ea2d4633495b5e9ab7bc66bcd982806329c0ee9ecbafc1ac9596a3b34cdb", executableSha256: "d91b470cb8433104e63b6678793d481f8385a52bf32c3f0e6a60cb583b9d6c06" },
} as const;

export function browserBundleSpec(target: string) {
  // linux-arm64 exists only for Cloud homes (MURAGE_CLOUD_ROLE=home); there is
  // no desktop arm64 Linux browser, so the desktop table stays unchanged.
  const cloudRole = process.env.MURAGE_CLOUD_ROLE === "home";
  const homeArm = cloudRole && target === "linux-arm64";
  if (!Object.hasOwn(CHROME_ASSETS, target) && !homeArm) throw new Error(`Unsupported desktop browser target: ${target}`);
  const home = cloudRole && (target === "linux-x64" || homeArm);
  const version = home ? CLOUD_BROWSER_PINS.chromeVersion : CHROME_VERSION;
  const arm = CLOUD_BROWSER_PINS.arm64;
  const pinned = homeArm
    ? { platform: "linux-arm64", bytes: arm.chromeBytes, sha256: arm.chromeSha256, executableSha256: arm.chromeExecutableSha256 }
    : home ? { platform: "linux64", bytes: CLOUD_BROWSER_PINS.chromeBytes, sha256: CLOUD_BROWSER_PINS.chromeSha256, executableSha256: CLOUD_BROWSER_PINS.chromeExecutableSha256 } : CHROME_ASSETS[target as BrowserBundleTarget];
  const [platform, arch] = target.split("-");
  const engine = resolveAgentBrowserReleaseAsset(platform as NodeJS.Platform, arch)!;
  const suffix = platform === "win32" ? ".exe" : "";
  const directory = `chrome-headless-shell-${pinned.platform}`;
  return {
    schemaVersion: 1,
    target,
    engine: {
      version: agentBrowserReleaseVersion(engine),
      asset: engine.asset,
      url: agentBrowserReleaseUrl(engine),
      bytes: engine.bytes,
      sha256: engine.sha256,
      executable: `agent-browser${suffix}`,
    },
    chrome: {
      version,
      asset: `${directory}.zip`,
      url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${pinned.platform}/${directory}.zip`,
      bytes: pinned.bytes,
      sha256: pinned.sha256,
      executableSha256: pinned.executableSha256,
      executable: `chrome/${directory}/chrome-headless-shell${suffix}`,
      license: `chrome/${directory}/LICENSE.headless_shell`,
      about: `chrome/${directory}/ABOUT`,
    },
  };
}

/** bundleDirectory is the target's directory, e.g. Resources/browser-engine. */
export function browserBundlePaths(bundleDirectory: string, target: string) {
  const spec = browserBundleSpec(target);
  return {
    directory: bundleDirectory,
    manifest: join(bundleDirectory, "manifest.json"),
    engine: join(bundleDirectory, spec.engine.executable),
    chrome: join(bundleDirectory, spec.chrome.executable),
    licenses: join(bundleDirectory, "licenses"),
  };
}
