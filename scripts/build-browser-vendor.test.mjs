import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { README_NOTICE_PHRASES, STDIO_PATCH_PACKAGE_VERSION, VENDOR_SETS, VENDOR_TARGETS, parseVendorBuildArgs, reportedEngineVersion, stampPackageVersion, vendorAssetName, vendorAssetUrl, vendorTag, vendorVersion, verifyReadmeNotice, verifyVendorPatch } from "./build-browser-vendor.mjs";
import { checkVendorEngineOutput, pinnedDesktopAsset } from "./check-vendor-engine-version.mjs";
import { cloudHomeReleaseAsset, agentBrowserVersionOutputAccepted } from "../server/browser-engine-release.ts";

const browser = (name) => readFileSync(new URL(`../third_party/browser/${name}`, import.meta.url));

describe("reviewed browser vendor build (omb.2, Windows omb.3)", () => {
  it("pins every patch to its committed bytes and refuses changed bytes", () => {
    const token = browser("patches/murage-control-token.fix1.patch");
    expect(() => verifyVendorPatch("token036", token)).not.toThrow();
    expect(() => verifyVendorPatch("token036", Buffer.concat([token, Buffer.from("\n")]))).toThrow(/SHA-256/);
    expect(() => verifyVendorPatch("token0381", browser("patches/murage-control-token.v0381.patch"))).not.toThrow();
    expect(() => verifyVendorPatch("stdio", browser("agent-browser-windows-stdio.patch"))).not.toThrow();
    const noConsole = browser("patches/murage-windows-no-console.patch");
    expect(() => verifyVendorPatch("noconsole", noConsole)).not.toThrow();
    expect(() => verifyVendorPatch("noconsole", Buffer.concat([noConsole, Buffer.from("\n")]))).toThrow(/SHA-256/);
  });

  it("the no-console patch mentions the expected files and flag", () => {
    const text = browser("patches/murage-windows-no-console.patch").toString("utf8");
    for (const site of ["cdp/chrome.rs", "cdp/lightpanda.rs", "recording.rs", "providers.rs", "stream/dashboard.rs", "stream/chat.rs", "webdriver/appium.rs"]) expect(text).toContain(`b/cli/src/native/${site}`);
    expect(text).toContain("0x0800_0000"); // CREATE_NO_WINDOW
    expect(text).toContain("hide_std(&mut cmd)");
  });

  it("Windows alone is revision omb.3; every other target stays omb.2", () => {
    expect(vendorVersion("0.36.0", "win32-x64")).toBe("0.36.0-omb.3");
    expect(vendorTag("0.36.0", "win32-x64")).toBe("browser-engine-v0.36.0-omb.3");
    for (const target of VENDOR_SETS["0.36.0"].targets.filter((t) => t !== "win32-x64")) expect(vendorVersion("0.36.0", target)).toBe("0.36.0-omb.2");
    expect(vendorVersion("0.38.1", "linux-x64")).toBe("0.38.1-omb.2");
  });

  it("applies the stdio patch before the control-token patch on Windows only", () => {
    expect(VENDOR_SETS["0.36.0"].patches("win32-x64")).toEqual(["stdio", "token036", "noconsole"]);
    for (const target of VENDOR_SETS["0.36.0"].targets.filter((t) => t !== "win32-x64")) expect(VENDOR_SETS["0.36.0"].patches(target)).toEqual(["token036"]);
    expect(VENDOR_SETS["0.38.1"].patches("linux-x64")).toEqual(["token0381"]);
  });

  it("covers all seven desktop targets and the two Cloud home targets", () => {
    expect([...VENDOR_SETS["0.36.0"].targets].sort()).toEqual(Object.keys(VENDOR_TARGETS).sort());
    expect(VENDOR_SETS["0.38.1"].targets).toEqual(["linux-arm64", "linux-x64"]);
    expect(vendorAssetName("0.36.0", "win32-x64")).toBe("agent-browser-win32-x64-0.36.0-omb.3.exe");
    expect(vendorAssetUrl("0.38.1", "linux-x64")).toBe("https://github.com/FerroxLabs/murage/releases/download/browser-engine-v0.38.1-omb.2/agent-browser-linux-x64-0.38.1-omb.2");
  });

  it("parses only a full, absolute, known invocation", () => {
    expect(parseVendorBuildArgs(["--set", "0.36.0", "--target", "linux-x64", "--output", "/tmp/new"])).toEqual({ set: "0.36.0", target: "linux-x64", output: "/tmp/new" });
    expect(() => parseVendorBuildArgs(["--set", "0.38.1", "--target", "darwin-arm64", "--output", "/tmp/new"])).toThrow(/does not build/);
    expect(() => parseVendorBuildArgs(["--set", "0.36.0", "--target", "linux-x64", "--output", "relative"])).toThrow(/Usage/);
  });

  it("the Windows build reports its own vendor revision, derived from the vendor set", () => {
    expect(reportedEngineVersion("0.36.0", "win32-x64")).toBe("0.36.0-omb.3");
    expect(reportedEngineVersion("0.36.0", "linux-x64")).toBe("0.36.0");
    expect(reportedEngineVersion("0.38.1", "linux-x64")).toBe("0.38.1");
    const cargoToml = `[package]\nname = "agent-browser"\nversion = "${STDIO_PATCH_PACKAGE_VERSION}"\nedition = "2021"\n`;
    expect(stampPackageVersion(cargoToml, STDIO_PATCH_PACKAGE_VERSION, "0.36.0-omb.9")).toContain('name = "agent-browser"\nversion = "0.36.0-omb.9"\n');
    expect(() => stampPackageVersion("no package here", STDIO_PATCH_PACKAGE_VERSION, "x")).toThrow(/exactly one/);
    expect(() => stampPackageVersion(cargoToml + cargoToml, STDIO_PATCH_PACKAGE_VERSION, "x")).toThrow(/exactly one/);
    // the inherited patch still carries the text the build replaces
    expect(browser("agent-browser-windows-stdio.patch").toString("utf8")).toContain(`+version = "${STDIO_PATCH_PACKAGE_VERSION}"`);
  });

  it("smoke version gate: an engine Murage would refuse never passes (omb.1 Windows regression)", () => {
    const win = { set: "0.36.0", target: "win32-x64" };
    expect(() => checkVendorEngineOutput({ ...win, output: "agent-browser 0.36.0-omb.1" })).toThrow(/launch check would refuse/);
    expect(() => checkVendorEngineOutput({ ...win, output: "agent-browser 0.36.0" })).toThrow(/expected "agent-browser 0.36.0-omb.3"/);
    expect(() => checkVendorEngineOutput({ ...win, output: "agent-browser 0.36.0-omb.2" })).toThrow(/launch check would refuse/);
    expect(() => checkVendorEngineOutput({ ...win, output: "agent-browser 0.36.0-omb.3" })).not.toThrow();
    expect(() => checkVendorEngineOutput({ set: "0.36.0", target: "linux-musl-x64", output: "agent-browser 0.36.0" })).not.toThrow();
    expect(() => checkVendorEngineOutput({ set: "0.36.0", target: "linux-x64", output: "agent-browser 0.36.0-omb.1" })).toThrow();
    expect(() => checkVendorEngineOutput({ set: "0.38.1", target: "linux-x64", output: "agent-browser 0.38.1" })).not.toThrow();
    // the same comparison the launch check runs, on the pinned Windows asset
    expect(agentBrowserVersionOutputAccepted("agent-browser 0.36.0-omb.1", pinnedDesktopAsset("win32-x64"))).toBe(false);
    expect(agentBrowserVersionOutputAccepted(`agent-browser ${pinnedDesktopAsset("win32-x64").version}`, pinnedDesktopAsset("win32-x64"))).toBe(true);
  });

  it("pin gate: the README carries the Apache-2.0 modification notice and the no-longer-Vercel statement", () => {
    expect(() => verifyReadmeNotice(readFileSync(new URL("../third_party/browser/README.md", import.meta.url), "utf8"))).not.toThrow();
    for (const phrase of README_NOTICE_PHRASES) expect(() => verifyReadmeNotice("unrelated text")).toThrow(/missing the required notice/);
    expect(() => verifyReadmeNotice(readFileSync(new URL("../third_party/browser/README.md", import.meta.url), "utf8").replace("no longer the official Vercel", ""))).toThrow(/no longer the official Vercel/);
  });
});

for (const [set, plan] of Object.entries(VENDOR_SETS)) {
  for (const target of plan.targets) {
    it(`every vendor build's declared output passes Murage's launch check: ${set} ${target}`, () => {
      const asset = set === "0.36.0" ? pinnedDesktopAsset(target) : cloudHomeReleaseAsset(target === "linux-arm64" ? "arm64" : "x64");
      expect(agentBrowserVersionOutputAccepted(`agent-browser ${reportedEngineVersion(set, target)}`, asset)).toBe(true);
      expect(agentBrowserVersionOutputAccepted(`agent-browser ${set}-omb.1`, asset)).toBe(false);
    });
  }
}
it("checks the Cloud arm64 smoke output and refuses old revisions", () => {
  const build = { set: "0.38.1", target: "linux-arm64" };
  expect(() => checkVendorEngineOutput({ ...build, output: "agent-browser 0.38.1" })).not.toThrow();
  for (const output of ["agent-browser 0.38.1-omb.1", "agent-browser 0.37.0"]) {
    expect(() => checkVendorEngineOutput({ ...build, output })).toThrow();
  }
});
