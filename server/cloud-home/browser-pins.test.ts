// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { browserBundleSpec, SUPPORTED_BROWSER_TARGETS } from "../browser-bundle-release.ts";
import { resolveAgentBrowserReleaseAsset } from "../browser-engine-release.ts";
import { CLOUD_BROWSER_PINS } from "./browser-pins.ts";

afterEach(() => vi.unstubAllEnvs());

it("stages and resolves the same reviewed browser assets on Linux homes only", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const desktop = Object.fromEntries(SUPPORTED_BROWSER_TARGETS.map(target => [target, browserBundleSpec(target)]));
  const musl = resolveAgentBrowserReleaseAsset("linux", "x64", true);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const spec = browserBundleSpec("linux-x64");
  expect(spec.engine).toMatchObject({ version: CLOUD_BROWSER_PINS.agentVersion, bytes: CLOUD_BROWSER_PINS.agentBytes, sha256: CLOUD_BROWSER_PINS.agentSha256, url: CLOUD_BROWSER_PINS.agentUrl });
  expect(spec.chrome).toMatchObject({ version: CLOUD_BROWSER_PINS.chromeVersion, bytes: CLOUD_BROWSER_PINS.chromeBytes, sha256: CLOUD_BROWSER_PINS.chromeSha256, executableSha256: CLOUD_BROWSER_PINS.chromeExecutableSha256 });
  expect(spec.chrome.url).toContain(`/${CLOUD_BROWSER_PINS.chromeVersion}/linux64/`);
  expect(resolveAgentBrowserReleaseAsset("linux", "x64")).toMatchObject({ version: spec.engine.version, sha256: spec.engine.sha256 });
  expect(resolveAgentBrowserReleaseAsset("linux", "x64", true)).toEqual(musl);
  for (const target of SUPPORTED_BROWSER_TARGETS.filter(target => target !== "linux-x64")) expect(browserBundleSpec(target)).toEqual(desktop[target]);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(browserBundleSpec("linux-x64")).toEqual(desktop["linux-x64"]);
});

it("resolves linux-arm64 browser assets for homes only, from the arm64 pins", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(() => browserBundleSpec("linux-arm64")).toThrow(/Unsupported/);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const arm = CLOUD_BROWSER_PINS.arm64;
  const spec = browserBundleSpec("linux-arm64");
  expect(spec.engine).toMatchObject({ version: CLOUD_BROWSER_PINS.agentVersion, bytes: arm.agentBytes, sha256: arm.agentSha256, url: arm.agentUrl, asset: "agent-browser-linux-arm64" });
  expect(spec.chrome).toMatchObject({ version: CLOUD_BROWSER_PINS.chromeVersion, bytes: arm.chromeBytes, sha256: arm.chromeSha256, executableSha256: arm.chromeExecutableSha256, executable: "chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell" });
  expect(spec.chrome.url).toBe(`https://storage.googleapis.com/chrome-for-testing-public/${CLOUD_BROWSER_PINS.chromeVersion}/linux-arm64/chrome-headless-shell-linux-arm64.zip`);
  expect(resolveAgentBrowserReleaseAsset("linux", "arm64")).toMatchObject({ sha256: arm.agentSha256 });
  expect(arm.agentUrl).toContain(`/v${CLOUD_BROWSER_PINS.agentVersion}/`);
});
