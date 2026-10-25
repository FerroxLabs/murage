// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Packaged-build guard: the electron/cloud-control-plane.mjs inside the package must be byte-identical (sha256) to
// this build's own source file. electron/cloud-control-plane-prod-pin.test.mjs (a gate test) loads that source and
// proves it carries the live production pin, so together they prove the package carries it. Nothing is parsed or run.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = new URL("../electron/cloud-control-plane.mjs", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The bytes of electron/cloud-control-plane.mjs exactly as the packaged app resolves it from resources/app.asar. */
export function packagedPinBytes(resources) {
  const archive = path.join(resources, "app.asar");
  const buffer = readFileSync(archive);
  const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString("utf8"));
  const entry = header.files?.electron?.files?.["cloud-control-plane.mjs"];
  if (!entry || typeof entry !== "object" || entry.files || entry.link) throw new Error("not a regular archive member");
  // Electron reads a member from app.asar.unpacked only for a JSON boolean true; any other value means it loads the archive bytes, so those are what we hash.
  if (entry.unpacked === true) {
    const file = path.join(`${archive}.unpacked`, "electron", "cloud-control-plane.mjs");
    if (!lstatSync(file).isFile()) throw new Error("unpacked member is not a regular file");
    return readFileSync(file);
  }
  // asar writes the offset as a canonical decimal string; anything else (negative, signed, hex, exponent, padded) is refused.
  if (typeof entry.offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry.offset)) throw new Error("member offset is not a canonical decimal");
  const dataOffset = 8 + buffer.readUInt32LE(4);
  const start = dataOffset + Number(entry.offset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(entry.size) || entry.size < 0 || start < dataOffset || start + entry.size > buffer.length) throw new Error("member out of range");
  return buffer.subarray(start, start + entry.size);
}

/** afterPack entry: refuse a package whose control-plane module differs from the build's source, or is missing. */
export function validatePackagedProdPin(resources, source = SOURCE) {
  let packaged;
  try { packaged = sha256(packagedPinBytes(resources)); } catch (error) { throw new Error(`PACKAGED_PROD_PIN_MISSING: electron/cloud-control-plane.mjs (${error.message})`); }
  const expected = sha256(readFileSync(source));
  if (packaged !== expected) throw new Error(`PACKAGED_PROD_PIN_MISMATCH: packaged sha256 ${packaged} != source ${expected}`);
  return { sha256: expected };
}
