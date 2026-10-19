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

export const CHROME_VERSION = "152.0.7977.82";
export const SUPPORTED_BROWSER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"] as const;
export type BrowserBundleTarget = typeof SUPPORTED_BROWSER_TARGETS[number];

const CHROME_ASSETS = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 97760996, sha256: "1615f063c894aa824fd55c89f8f05e9904f63cce0c95d0cbce7394d77884fba5", executableSha256: "ac18537fb2bc2b72b0440893b6ea5d4ef3bacc6220b1e9a1693c73f8b1045fbe" },
  "darwin-x64": { platform: "mac-x64", bytes: 102895824, sha256: "c903707292c6aaed7c6e572c0bb5e6645454e45d9e0e6db27e876b18e9165f31", executableSha256: "2faefd55d4e47764956e31e338d362a1e794037fa772a426ffd510f122f33f19" },
  "linux-x64": { platform: "linux64", bytes: 119454769, sha256: "0ca12ea26b502a83e32db334a17883c315348845efc071d908de7a6d94a97eff", executableSha256: "1301a5024fef1d58c4cfbde5d44794cb18c5b2cbbe4f3c64f81cc4eaa683c45f" },
  "win32-x64": { platform: "win64", bytes: 119768220, sha256: "86fb1fa7fbbda65f6f1572062c358803e61a6e6d9489e6619b37a61d609fa845", executableSha256: "ec0744f041cb6c35c439c85a5ac42d77b507838cd59cac005e25114025336c98" },
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
