import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
export function nativeFixtureBinary(target: string): Buffer {
  const bytes = Buffer.alloc(128);
  if (target.startsWith("darwin-")) { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4); }
  else if (target === "linux-x64") { Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(bytes); bytes.writeUInt16LE(0x3e, 18); }
  else { bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.write("PE\0\0", 64); bytes.writeUInt16LE(0x8664, 68); }
  return bytes;
}
function entry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512); header.write(name); header.write("0000700\0", 100); header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("        ", 148); header.write(type, 156); header.write("ustar\0", 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
export function nativeFixtureAsset(version = "1.0.9", target = "darwin-arm64", binaryTarget = target) {
  const binary = nativeFixtureBinary(binaryTarget), [platform, arch] = target.split("-");
  const archive = gzipSync(Buffer.concat([
    entry("package/package.json", Buffer.from(JSON.stringify({ name: `@fuigo/${target}`, version, os: [platform], cpu: [arch] }))),
    entry(`package/bin/${target.startsWith("win32") ? "fuigo.exe" : "fuigo"}.br`, brotliCompressSync(binary)), Buffer.alloc(1024),
  ]));
  const metadata = { name: `@fuigo/${target}`, version, os: [platform], cpu: [arch], dist: { tarball: `https://registry.npmjs.org/@fuigo/${target}/-/${target}-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` } };
  return { binary, archive, metadata };
}
