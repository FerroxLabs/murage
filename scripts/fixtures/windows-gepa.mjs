// Synthetic PE headers only; no native execution or Authenticode proof.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGepaManifest } from "../../native/gepa/create-manifest.mjs";
import { GEPA_RESOURCE_LICENSES } from "../../server/gepa-resource.ts";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./windows-pe-signing.mjs";

export function windowsGepaFixture(directory, receipt, { signed = false } = {}) {
  const header = signed ? appendPeFixtureCertificate(unsignedPeFixture()) : unsignedPeFixture();
  const images = ["gepa-worker.exe", "_internal/python313.dll", "_internal/_socket.pyd", "_internal/native-image.bin"];
  for (const name of images) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, header, { mode: 0o755 });
  }
  for (const name of GEPA_RESOURCE_LICENSES) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "Synthetic license fixture.");
  }
  const { manifestSha256 } = createGepaManifest(directory, "win32-x64", receipt);
  return { hash: manifestSha256, images: images.map(name => path.join(directory, name)) };
}

export function windowsGepaMetadataArchive(resources, hash) {
  const metadata = Buffer.from(JSON.stringify({ murageGepaManifests: { "win32-x64": hash } }));
  const json = Buffer.from(JSON.stringify({ files: { "package.json": { size: metadata.length, offset: "0" } } }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4); json.copy(padded);
  const header = Buffer.alloc(8); header.writeUInt32LE(padded.length + 4); header.writeUInt32LE(json.length, 4);
  const size = Buffer.alloc(8); size.writeUInt32LE(4); size.writeUInt32LE(header.length + padded.length, 4);
  writeFileSync(path.join(resources, "app.asar"), Buffer.concat([size, header, padded, metadata]));
}
