// Fill only after publication. Never execute downloaded code or install scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { executableTarget, verifySha256 } from "./prepare-cloudflared.mjs";
import { FUIGO_ASSETS, FUIGO_VERSION, FUIGO_REGISTRY } from "./prepare-fuigo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = `scripts/fuigo-${FUIGO_VERSION}-provenance.json`;
const PENDING = "FILL-AT-NPM";
const sha = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

export function reviewedHashes(args) {
  if (args.length !== 3 || !args.every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Usage: scripts/fill-fuigo-pin.sh <linux> <win> <darwin> (three lowercase executable SHA-256 values)");
  }
  return Object.fromEntries(["linux-x64", "win32-x64", "darwin-arm64"].map((target, i) => [target, args[i]]));
}

// Read exact regular entries without extracting paths or following links.
function entries(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 });
  const out = new Map();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.toString("utf8", start, end).replace(/\0.*$/s, "").trim();
    const name = field(0, 100), sizeText = field(124, 136);
    assert.match(sizeText, /^[0-7]+$/, "invalid tar size");
    const size = parseInt(sizeText, 8);
    const expectedChecksum = parseInt(field(148, 156), 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(expectedChecksum, actualChecksum, "tar header checksum");
    assert(at + 512 + size <= tar.length, "truncated tar");
    if (name === "package/package.json" || /^package\/bin\/fuigo(?:\.exe)?\.br$/.test(name)) {
      assert(!field(345, 500), "unexpected tar prefix");
      assert(header[156] === 0 || header[156] === 48, "expected regular tar entry");
      assert(!out.has(name), "duplicate tar entry");
      out.set(name, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export function verifyPackage(meta, archive, target, expectedBinary, source) {
  const name = target === "wrapper" ? "fuigo" : `@fuigo/${target}`;
  const tarball = `${FUIGO_REGISTRY}/${name}/-/${name.split("/").at(-1)}-${FUIGO_VERSION}.tgz`;
  assert.equal(meta.name, name, "npm package name");
  assert.equal(meta.version, FUIGO_VERSION, "npm package version");
  assert.equal(meta.dist?.tarball, tarball, "npm archive URL");
  assert.match(meta.dist.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "npm integrity format");
  assert.equal(meta.dist.integrity, `sha512-${sha("sha512", archive, "base64")}`, "npm integrity mismatch");
  assert.match(meta.dist.shasum, /^[a-f0-9]{40}$/, "npm shasum format");
  assert.equal(meta.dist.shasum, sha("sha1", archive), "npm shasum mismatch");
  if (meta.gitHead !== undefined) assert.equal(meta.gitHead, source, "npm source commit mismatch");
  const files = entries(archive);
  const manifest = JSON.parse(files.get("package/package.json")?.toString() ?? "null");
  assert.equal(manifest?.name, name, "archive package name");
  assert.equal(manifest.version, FUIGO_VERSION, "archive package version");
  const row = { target, name, version: FUIGO_VERSION, tarball, tarballSha256: sha("sha256", archive), integrity: meta.dist.integrity, shasum: meta.dist.shasum };
  if (target === "wrapper") {
    const expected = Object.fromEntries(Object.values(FUIGO_ASSETS).map(asset => [asset.package, FUIGO_VERSION]));
    assert.deepEqual(meta.optionalDependencies, expected, "wrapper npm dependencies");
    assert.deepEqual(manifest.optionalDependencies, expected, "wrapper archive dependencies");
    row.optionalDependencies = expected;
  } else {
    const [platform, arch] = target.split("-");
    assert(manifest.os?.includes(platform) && manifest.cpu?.includes(arch), "archive platform identity");
    const compressed = files.get(`package/bin/${platform === "win32" ? "fuigo.exe" : "fuigo"}.br`);
    assert(compressed, "missing compressed executable");
    const binary = brotliDecompressSync(compressed, { maxOutputLength: 1024 * 1024 * 1024 });
    // The shared staging parser deliberately does not support PE ARM64 yet.
    if (target === "win32-arm64") {
      assert.equal(binary.toString("ascii", 0, 2), "MZ");
      const pe = binary.readUInt32LE(0x3c);
      assert.equal(binary.toString("binary", pe, pe + 4), "PE\0\0");
      assert.equal(binary.readUInt16LE(pe + 4), 0xaa64);
    } else assert.equal(executableTarget(binary), target, "executable architecture");
    row.binarySha256 = sha("sha256", binary);
    if (expectedBinary !== undefined) verifySha256(binary, expectedBinary, `${target} reviewed executable`);
  }
  return row;
}

export function fillSource(text, packages) {
  for (const row of packages.filter(item => item.target !== "wrapper")) {
    const block = new RegExp(`("${row.target}": (?:Object\\.freeze\\()?\\{[^}]*?tarballSha256: ")([^"]+)(",\\s*binarySha256: ")([^"]+)(")`);
    const match = block.exec(text);
    assert(match, `missing pin block: ${row.target}`);
    assert(match[2] === PENDING || match[2] === row.tarballSha256, `${row.target} archive pin changed`);
    assert(match[4] === PENDING || match[4] === row.binarySha256, `${row.target} executable pin changed`);
    text = text.replace(block, (_, a, _oldArchive, b, _oldBinary, c) => `${a}${row.tarballSha256}${b}${row.binarySha256}${c}`);
  }
  return text;
}

export async function fillFuigoPin(args, {
  root = ROOT,
  fetcher = fetch,
  refreshLock = () => execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--offline"], { cwd: root, stdio: "inherit" }),
} = {}) {
  const reviewed = reviewedHashes(args); // Validate before any I/O.
  assert.notEqual(process.platform, "darwin", "fill on an isolated Linux build host");
  const get = async url => {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
    assert(response.ok, `npm request failed: ${url} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  };
  const current = JSON.parse(readFileSync(join(root, RECEIPT), "utf8"));
  assert.equal(current.version, FUIGO_VERSION);
  const packages = [], inputs = [];
  let source;
  for (const target of ["wrapper", ...Object.keys(FUIGO_ASSETS)]) {
    const name = target === "wrapper" ? "fuigo" : `@fuigo/${target}`;
    const meta = JSON.parse((await get(`${FUIGO_REGISTRY}/${name.replace("/", "%2f")}/${FUIGO_VERSION}`)).toString());
    if (target === "wrapper") {
      assert.match(meta.gitHead, /^[a-f0-9]{40}$/, "wrapper source commit required");
      source = meta.gitHead;
    }
    // Use our exact URL, never a URL supplied by unverified metadata.
    const url = `${FUIGO_REGISTRY}/${name}/-/${name.split("/").at(-1)}-${FUIGO_VERSION}.tgz`;
    const archive = await get(url);
    const previous = current.packages.find(row => row.target === target);
    const row = verifyPackage(meta, archive, target, reviewed[target], source);
    for (const key of ["tarballSha256", "binarySha256", "integrity", "shasum"]) {
      if (previous?.[key] !== undefined && previous[key] !== PENDING) assert.equal(row[key], previous[key], `${target} ${key} changed`);
    }
    packages.push(row);
    inputs.push({ meta, archive, target });
  }
  assert(current.source === PENDING || current.source === source, "source changed");
  const writes = new Map();
  for (const file of ["scripts/prepare-fuigo.mjs", "scripts/prepare-fuigo.test.mjs"]) {
    let text = fillSource(readFileSync(join(root, file), "utf8"), packages);
    if (file.endsWith("prepare-fuigo.mjs")) text = text.replace(/report gitHead (?:FILL-AT-NPM|[a-f0-9]{40})/, `report gitHead ${source}`);
    writes.set(file, text);
  }
  const proof = { ...current, status: "filled", source, verificationBasis: "Exact-version npm integrity, shasum and package identity verified; three reviewed executable digests matched. No native execution; release qualification remains owed.", packages };
  writes.set(RECEIPT, `${JSON.stringify(proof, null, 2)}\n`);
  const licenses = readFileSync(join(root, "deploy/cloud-home/LICENSES.md"), "utf8")
    .replace(/source and receipts pending in scripts\/fuigo-1\.0\.43-provenance\.json \(FILL-AT-NPM\)/, `release source ${source}; receipts in scripts/fuigo-1.0.43-provenance.json`)
    .replace(/(\| Fuigo 1\.0\.43 \| @fuigo\/linux-arm64 tarball )\S+(; executable )\S+/, (_, a, b) => {
      const row = packages.find(item => item.target === "linux-arm64");
      return `${a}${row.tarballSha256}${b}${row.binarySha256}`;
    });
  writes.set("deploy/cloud-home/LICENSES.md", licenses);
  // Keep a rollback copy, including the lockfile, until re-verification succeeds.
  const originals = new Map([...writes.keys(), "pnpm-lock.yaml"].map(file => [file, readFileSync(join(root, file))]));
  try {
    for (const [file, text] of writes) writeFileSync(join(root, file), text);
    refreshLock();
    const filled = JSON.parse(readFileSync(join(root, RECEIPT), "utf8"));
    assert.deepEqual(filled, proof, "written receipt changed");
    for (const file of writes.keys()) assert.equal(readFileSync(join(root, file), "utf8"), writes.get(file), `written pin changed: ${file}`);
    for (const { meta, archive, target } of inputs) {
      const row = filled.packages.find(item => item.target === target);
      assert.deepEqual(verifyPackage(meta, archive, target, row.binarySha256, source), row, "filled checksum re-verification");
    }
  } catch (error) {
    for (const [file, bytes] of originals) writeFileSync(join(root, file), bytes);
    throw error;
  }
  return proof;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await fillFuigoPin(process.argv.slice(2));
  console.log(`Fuigo ${FUIGO_VERSION}: all pins filled and re-verified; lockfile refreshed. Run the container tests and native qualification gates.`);
}
