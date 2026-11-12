import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { FUIGO_ASSETS, FUIGO_VERSION } from "./prepare-fuigo.mjs";
import { fillFuigoPin, reviewedHashes, verifyPackage } from "./fill-fuigo-pin.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = "1234567890abcdef1234567890abcdef12345678";
const sha = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const digest = bytes => sha("sha256", bytes);
const receipt = "scripts/fuigo-1.0.43-provenance.json";
const files = ["scripts/prepare-fuigo.mjs", "scripts/prepare-fuigo.test.mjs", receipt, "deploy/cloud-home/LICENSES.md", "pnpm-lock.yaml"];

function binary(target) {
  const bytes = Buffer.alloc(128);
  if (target.startsWith("linux")) {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 0xb7 : 0x3e, 18);
  } else if (target.startsWith("darwin")) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(0x40, 0x3c); bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(target.endsWith("arm64") ? 0xaa64 : 0x8664, 0x44);
  }
  return bytes;
}

function tar(entries) {
  const chunks = [];
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name); header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = 48; header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function fixture() {
  const packages = new Map(), responses = new Map();
  for (const target of ["wrapper", ...Object.keys(FUIGO_ASSETS)]) {
    const name = target === "wrapper" ? "fuigo" : `@fuigo/${target}`;
    const manifest = { name, version: FUIGO_VERSION };
    if (target === "wrapper") manifest.optionalDependencies = Object.fromEntries(Object.values(FUIGO_ASSETS).map(asset => [asset.package, FUIGO_VERSION]));
    else { const [platform, arch] = target.split("-"); manifest.os = [platform]; manifest.cpu = [arch]; }
    const entries = { "package/package.json": JSON.stringify(manifest) };
    if (target !== "wrapper") entries[`package/bin/${target.startsWith("win32") ? "fuigo.exe" : "fuigo"}.br`] = brotliCompressSync(binary(target));
    const archive = tar(entries);
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${FUIGO_VERSION}.tgz`;
    const meta = { ...manifest, gitHead: source, dist: { tarball, integrity: `sha512-${sha("sha512", archive, "base64")}`, shasum: sha("sha1", archive) } };
    packages.set(target, { meta, archive });
    responses.set(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${FUIGO_VERSION}`, Buffer.from(JSON.stringify(meta)));
    responses.set(tarball, archive);
  }
  const fetcher = vi.fn(async url => {
    expect(responses.has(url), `unexpected request: ${url}`).toBe(true);
    return new Response(responses.get(url));
  });
  return { packages, responses, fetcher };
}

function copyFixture() {
  const directory = mkdtempSync(join(tmpdir(), "murage-fill-fuigo-"));
  for (const file of files) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(root, file), path);
  }
  // Keep these tests usable after the real fill has replaced the repository pins.
  for (const file of files.slice(0, 2)) {
    const path = join(directory, file);
    writeFileSync(path, readFileSync(path, "utf8").replace(/((?:tarballSha256|binarySha256): ")[a-f0-9]{64}/g, "$1FILL\x2dAT-NPM"));
  }
  const path = join(directory, receipt), proof = JSON.parse(readFileSync(path, "utf8"));
  proof.source = "FILL\x2dAT-NPM"; proof.status = "FILL\x2dAT-NPM";
  for (const row of proof.packages) for (const key of ["tarballSha256", "binarySha256", "integrity", "shasum"]) if (key in row) row[key] = "FILL\x2dAT-NPM";
  writeFileSync(path, JSON.stringify(proof));
  return directory;
}

const suppliedLinux = digest(binary("linux-x64"));
const hashes = [suppliedLinux, digest(binary("win32-x64")), digest(binary("darwin-arm64"))];

describe("fill Fuigo 1.0.43 after npm publication", () => {
  it("validates exactly three real digests before any network or write", async () => {
    const fetcher = vi.fn();
    for (const args of [[], ["FILL\x2dAT-NPM", ...hashes.slice(1)], ["bad", ...hashes.slice(1)], [...hashes, hashes[0]]]) {
      expect(() => reviewedHashes(args)).toThrow(/Usage/);
      await expect(fillFuigoPin(args, { fetcher })).rejects.toThrow(/Usage/);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => execFileSync("bash", [join(root, "scripts/fill-fuigo-pin.sh"), "bad"], { stdio: "pipe" })).toThrow();
  });

  it("accepts a matching reviewed executable digest", () => {
    const { meta, archive } = fixture().packages.get("linux-x64");
    expect(verifyPackage(meta, archive, "linux-x64", suppliedLinux, source).binarySha256).toBe(digest(binary("linux-x64")));
  });

  it.each(["linux-x64", "win32-x64", "darwin-arm64"])("rejects a deliberate wrong checksum for %s", async target => {
    const { meta, archive } = fixture().packages.get(target);
    expect(() => verifyPackage(meta, archive, target, "0".repeat(64), source)).toThrow(/SHA-256 verification/);
  });

  it("fills both source tables and the receipt, re-verifies bytes, and is repeatable", async () => {
    const directory = copyFixture(), { fetcher } = fixture();
    const refreshLock = vi.fn(() => writeFileSync(join(directory, "pnpm-lock.yaml"), "fixture refreshed lock\n"));
    try {
      const proof = await fillFuigoPin(hashes, { root: directory, fetcher, refreshLock });
      expect(proof).toMatchObject({ version: "1.0.43", source, status: "filled", nativeExecutablesRun: false });
      expect(proof.packages).toHaveLength(7);
      expect(refreshLock).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(14);
      for (const file of files.slice(0, 2)) {
        const text = readFileSync(join(directory, file), "utf8");
        for (const row of proof.packages.filter(item => item.target !== "wrapper")) {
          expect(text).toContain(`tarballSha256: "${row.tarballSha256}"`);
          expect(text).toContain(`binarySha256: "${row.binarySha256}"`);
        }
      }
      const reread = JSON.parse(readFileSync(join(directory, receipt), "utf8"));
      expect(reread).toEqual(proof);
      expect(await fillFuigoPin(hashes, { root: directory, fetcher, refreshLock })).toEqual(proof);
    } finally { safeWipeSync(directory); }
  });

  it("a wrong supplied value fails without changing any file or refreshing the lock", async () => {
    const directory = copyFixture(), { fetcher } = fixture(), refreshLock = vi.fn();
    const before = files.map(file => readFileSync(join(directory, file), "utf8"));
    try {
      await expect(fillFuigoPin(["0".repeat(64), ...hashes.slice(1)], { root: directory, fetcher, refreshLock })).rejects.toThrow(/SHA-256 verification/);
      expect(files.map(file => readFileSync(join(directory, file), "utf8"))).toEqual(before);
      expect(refreshLock).not.toHaveBeenCalled();
    } finally { safeWipeSync(directory); }
  });

  it("refreshes an isolated lockfile offline with package scripts disabled", async () => {
    const directory = copyFixture(), { fetcher } = fixture();
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fuigo-pin-fixture", private: true,
      scripts: { postinstall: "node -e \"throw new Error('install scripts must not run')\"" },
    }));
    writeFileSync(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
    try {
      expect(await fillFuigoPin(hashes, { root: directory, fetcher })).toMatchObject({ status: "filled" });
      expect(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion:");
    } finally { safeWipeSync(directory); }
  });

  it.each(["integrity", "identity", "dependencies", "architecture"])("rejects wrong %s even with an authentic npm receipt", failure => {
    const { meta, archive } = fixture().packages.get("linux-x64");
    if (failure === "integrity") meta.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    if (failure === "identity") meta.version = "1.0.42";
    if (failure === "dependencies") {
      const wrapper = fixture().packages.get("wrapper");
      wrapper.meta.optionalDependencies["@fuigo/linux-x64"] = "1.0.42";
      expect(() => verifyPackage(wrapper.meta, wrapper.archive, "wrapper", undefined, source)).toThrow(/dependencies/);
      return;
    }
    if (failure === "architecture") {
      const wrong = tar({ "package/package.json": JSON.stringify({ name: meta.name, version: FUIGO_VERSION, os: ["linux"], cpu: ["x64"] }), "package/bin/fuigo.br": brotliCompressSync(binary("darwin-arm64")) });
      meta.dist.integrity = `sha512-${sha("sha512", wrong, "base64")}`; meta.dist.shasum = sha("sha1", wrong);
      expect(() => verifyPackage(meta, wrong, "linux-x64", undefined, source)).toThrow(/architecture/);
      return;
    }
    expect(() => verifyPackage(meta, archive, "linux-x64", undefined, source)).toThrow();
  });

  it.each(["lock failure", "written checksum changed"])("rolls back source, receipts and lock on %s", async failure => {
    const directory = copyFixture(), { fetcher } = fixture();
    const before = files.map(file => readFileSync(join(directory, file), "utf8"));
    const refreshLock = () => {
      writeFileSync(join(directory, "pnpm-lock.yaml"), "changed lock\n");
      if (failure === "lock failure") throw new Error("fixture lock failed");
      const path = join(directory, receipt), proof = JSON.parse(readFileSync(path, "utf8"));
      proof.packages.find(row => row.target === "linux-x64").binarySha256 = "0".repeat(64);
      writeFileSync(path, JSON.stringify(proof));
    };
    try {
      await expect(fillFuigoPin(hashes, { root: directory, fetcher, refreshLock })).rejects.toThrow();
      expect(files.map(file => readFileSync(join(directory, file), "utf8"))).toEqual(before);
    } finally { safeWipeSync(directory); }
  });
});
