import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { README_NOTICE_PHRASES, VENDOR_SETS, VENDOR_TARGETS, parseVendorBuildArgs, vendorAssetName, vendorAssetUrl, verifyReadmeNotice, verifyVendorPatch } from "./build-browser-vendor.mjs";

const browser = (name) => readFileSync(new URL(`../third_party/browser/${name}`, import.meta.url));

describe("reviewed browser vendor build (omb.2)", () => {
  it("pins every patch to its committed bytes and refuses changed bytes", () => {
    const token = browser("patches/murage-control-token.fix1.patch");
    expect(() => verifyVendorPatch("token036", token)).not.toThrow();
    expect(() => verifyVendorPatch("token036", Buffer.concat([token, Buffer.from("\n")]))).toThrow(/SHA-256/);
    expect(() => verifyVendorPatch("token0381", browser("patches/murage-control-token.v0381.patch"))).not.toThrow();
    expect(() => verifyVendorPatch("stdio", browser("agent-browser-windows-stdio.patch"))).not.toThrow();
  });

  it("applies the stdio patch before the control-token patch on Windows only", () => {
    expect(VENDOR_SETS["0.36.0"].patches("win32-x64")).toEqual(["stdio", "token036"]);
    for (const target of VENDOR_SETS["0.36.0"].targets.filter((t) => t !== "win32-x64")) expect(VENDOR_SETS["0.36.0"].patches(target)).toEqual(["token036"]);
    expect(VENDOR_SETS["0.38.1"].patches("linux-x64")).toEqual(["token0381"]);
  });

  it("covers all seven desktop targets and the two Cloud home targets", () => {
    expect([...VENDOR_SETS["0.36.0"].targets].sort()).toEqual(Object.keys(VENDOR_TARGETS).sort());
    expect(VENDOR_SETS["0.38.1"].targets).toEqual(["linux-arm64", "linux-x64"]);
    expect(vendorAssetName("0.36.0", "win32-x64")).toBe("agent-browser-win32-x64-0.36.0-omb.2.exe");
    expect(vendorAssetUrl("0.38.1", "linux-x64")).toBe("https://github.com/FerroxLabs/murage/releases/download/browser-engine-v0.38.1-omb.2/agent-browser-linux-x64-0.38.1-omb.2");
  });

  it("parses only a full, absolute, known invocation", () => {
    expect(parseVendorBuildArgs(["--set", "0.36.0", "--target", "linux-x64", "--output", "/tmp/new"])).toEqual({ set: "0.36.0", target: "linux-x64", output: "/tmp/new" });
    expect(() => parseVendorBuildArgs(["--set", "0.38.1", "--target", "darwin-arm64", "--output", "/tmp/new"])).toThrow(/does not build/);
    expect(() => parseVendorBuildArgs(["--set", "0.36.0", "--target", "linux-x64", "--output", "relative"])).toThrow(/Usage/);
  });

  it("pin gate: the README carries the Apache-2.0 modification notice and the no-longer-Vercel statement", () => {
    expect(() => verifyReadmeNotice(readFileSync(new URL("../third_party/browser/README.md", import.meta.url), "utf8"))).not.toThrow();
    for (const phrase of README_NOTICE_PHRASES) expect(() => verifyReadmeNotice("unrelated text")).toThrow(/missing the required notice/);
    expect(() => verifyReadmeNotice(readFileSync(new URL("../third_party/browser/README.md", import.meta.url), "utf8").replace("no longer the official Vercel", ""))).toThrow(/no longer the official Vercel/);
  });
});
