import { createHash as actualHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserBundleSpec } from "./browser-bundle-release.ts";

const mock = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), hashes: new Map<string, string>(), signature: vi.fn(), changed: false, closed: [] as number[], opened: [] as string[] }));
vi.mock("node:child_process", () => ({ spawnSync: mock.signature }));
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  return { ...real, createHash: (...args: Parameters<typeof real.createHash>) => {
    const hash = real.createHash(...args), digest = hash.digest.bind(hash);
    hash.digest = ((encoding: "hex") => { const result = digest(encoding); return mock.hashes.get(result) ?? result; }) as typeof hash.digest;
    return hash;
  } };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const stat = () => ({ dev: 1, ino: 2, size: 100, mtimeMs: 1, ctimeMs: mock.changed ? 2 : 1, isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false });
  return { ...real, realpathSync: (p: string) => p, lstatSync: stat, fstatSync: stat,
    openSync: (p: string) => { mock.opened.push(p); return mock.opened.length - 1; }, closeSync: (fd: number) => mock.closed.push(fd),
    readFileSync: (fd: number) => { const bytes = mock.bytes.get(mock.opened[fd]); if (!bytes) throw new Error("missing fixture"); return bytes; } };
});
import { MAC_BROWSER_PAYLOADS, verifyMacBrowserImage, verifyPackagedMacBrowser } from "./browser-macos-identity.ts";

const root = "/fixture/Murage.app/Contents/Resources", directory = `${root}/browser-engine`;
const spec = browserBundleSpec("darwin-arm64");
const images = new Map<keyof typeof MAC_BROWSER_PAYLOADS, Buffer>();
// Synthetic Mach-O layouts use the exact production descriptor offsets. Only
// their independently calculated fixture digest is mapped to the vendor pin;
// mutated payloads still use real SHA-256 and must be refused.
for (const image of ["engine", "chrome"] as const) {
  const p = MAC_BROWSER_PAYLOADS[image], bytes = Buffer.alloc(p.signatureOffset + 32);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  const s = p.signatureCommand, l = p.linkeditCommand;
  bytes.writeUInt32LE(0x1d, s); bytes.writeUInt32LE(16, s + 4); bytes.writeUInt32LE(p.signatureOffset, s + 8); bytes.writeUInt32LE(32, s + 12);
  bytes.writeUInt32LE(0x19, l); bytes.writeUInt32LE(72, l + 4); bytes.write("__LINKEDIT", l + 8, "ascii");
  bytes.writeBigUInt64LE(32n, l + 32); bytes.writeBigUInt64LE(BigInt(p.signatureOffset), l + 40); bytes.writeBigUInt64LE(32n, l + 48);
  bytes.writeUInt32LE(1, l + 56); bytes.writeUInt32LE(1, l + 60);
  const t = p.signatureOffset;
  bytes.writeUInt32BE(0xfade0cc0, t); bytes.writeUInt32BE(28, t + 4); bytes.writeUInt32BE(1, t + 8); bytes.writeUInt32BE(20, t + 16); bytes.writeUInt32BE(8, t + 24);
  const payload = Buffer.from(bytes.subarray(0, t)); payload.writeUInt32LE(0, s + 12); payload.writeBigUInt64LE(0n, l + 32); payload.writeBigUInt64LE(0n, l + 48);
  mock.hashes.set(actualHash("sha256").update(payload).digest("hex"), p.payloadSha256);
  images.set(image, bytes);
}
beforeEach(() => {
  mock.changed = false; mock.opened.length = 0; mock.closed.length = 0;
  mock.signature.mockReset().mockReturnValue({ status: 0 });
  mock.bytes.clear();
  mock.bytes.set(`${directory}/manifest.json`, Buffer.from(JSON.stringify({ ...spec, files: [
    { path: spec.engine.executable, kind: "file", bytes: spec.engine.bytes, sha256: spec.engine.sha256 },
    { path: spec.chrome.executable, kind: "file", bytes: 166887216, sha256: spec.chrome.executableSha256 },
  ] })));
  mock.bytes.set(`${directory}/${spec.engine.executable}`, images.get("engine")!);
  mock.bytes.set(`${directory}/${spec.chrome.executable}`, images.get("chrome")!);
});
describe("arm64 packaged browser identity", () => {
  for (const image of ["engine", "chrome"] as const) it(`${image}: permits only signing-size changes, rejects payload/tail/offset changes`, () => {
    const bytes = images.get(image)!, p = MAC_BROWSER_PAYLOADS[image];
    expect(verifyMacBrowserImage(bytes, image)).toBe(true);
    for (const offset of [100, p.signatureCommand + 8, p.linkeditCommand + 56, p.signatureOffset]) {
      const original = bytes[offset]; bytes[offset] ^= 1;
      try { expect(verifyMacBrowserImage(bytes, image)).toBe(false); } finally { bytes[offset] = original; }
    }
    const original = bytes.readBigUInt64LE(p.linkeditCommand + 32);
    bytes.writeBigUInt64LE(original + 4096n, p.linkeditCommand + 32);
    try { expect(verifyMacBrowserImage(bytes, image)).toBe(true); } finally { bytes.writeBigUInt64LE(original, p.linkeditCommand + 32); }
  });
  it("binds a nested Electron helper to its owning app and verifies all three fixed signatures", () => {
    expect(verifyPackagedMacBrowser(root, "/fixture/Murage.app/Contents/Frameworks/Murage Helper.app/Contents/MacOS/Murage Helper")).toBe(true);
    expect(mock.signature.mock.calls.map(call => call[1].at(-1))).toEqual(["/fixture/Murage.app", `${directory}/${spec.engine.executable}`, `${directory}/${spec.chrome.executable}`]);
    for (const call of mock.signature.mock.calls) expect(call[1]).toContain('=anchor apple generic and certificate leaf[subject.OU] = "PX6SP9GPWJ"');
    expect(mock.closed).toHaveLength(3);
  });
  it("refuses an external executable, wrong app, and changed manifest without signing", () => {
    expect(verifyPackagedMacBrowser(root, "/usr/bin/node")).toBe(false);
    expect(verifyPackagedMacBrowser(root.replace("Murage.app", "Other.app"), "/usr/bin/node")).toBe(false);
    mock.bytes.set(`${directory}/manifest.json`, Buffer.from("{}"));
    expect(verifyPackagedMacBrowser(root, "/fixture/Murage.app/Contents/MacOS/Murage")).toBe(false);
    expect(mock.signature).not.toHaveBeenCalled(); expect(mock.closed).toHaveLength(1);
  });
  it("refuses app or either tool signature failure and closes every observation", () => {
    for (const failure of [0, 1, 2]) {
      mock.closed.length = 0; mock.opened.length = 0; mock.signature.mockReset();
      let n = 0; mock.signature.mockImplementation(() => ({ status: n++ === failure ? 1 : 0 }));
      expect(verifyPackagedMacBrowser(root, "/fixture/Murage.app/Contents/MacOS/Murage")).toBe(false);
      expect(mock.closed).toHaveLength(3);
    }
  });
  it("refuses replacement during signature verification", () => {
    mock.signature.mockImplementation(() => { mock.changed = true; return { status: 0 }; });
    expect(verifyPackagedMacBrowser(root, "/fixture/Murage.app/Contents/MacOS/Murage")).toBe(false);
    expect(mock.closed).toHaveLength(3);
  });
});
