// Source owner: win-sac-sign; release signature proof owner: MAIN.
// Payload identity only. Always pair this with Windows' own trust verdict.
import { createHash } from "node:crypto";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw Error("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD"); };
function fields(bytes) {
  if (bytes.length < 328 || bytes.toString("ascii", 0, 2) !== "MZ") return fail();
  const pe = bytes.readUInt32LE(60), optional = pe + 24;
  if (pe < 64 || pe > bytes.length - 264 || bytes.readUInt32LE(pe) !== 0x4550
    || ![0x8664, 0xaa64].includes(bytes.readUInt16LE(pe + 4)) || bytes.readUInt16LE(pe + 20) < 240
    || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 5) return fail();
  return { checksum: optional + 64, security: optional + 144 };
}
/** Structural embedded-table check only; Windows must independently verify trust. */
export function hasEmbeddedWindowsPeSignature(bytes) {
  const f = fields(bytes), offset = bytes.readUInt32LE(f.security), size = bytes.readUInt32LE(f.security + 4);
  if (!offset && !size) return false;
  if (offset < f.security + 8 || offset % 8 || size < 8 || size % 8 || offset > bytes.length - size) return fail();
  let position = offset;
  while (position < offset + size) {
    if (position > offset + size - 8) return fail();
    const length = bytes.readUInt32LE(position);
    if (length < 8 || length > offset + size - position || bytes.readUInt16LE(position + 4) !== 0x200 || bytes.readUInt16LE(position + 6) !== 2) return fail();
    position += Math.ceil(length / 8) * 8;
  }
  if (position !== offset + size) return fail();
  return true;
}
export function unsignedWindowsPePin(bytes) {
  const f = fields(bytes);
  if (bytes.readUInt32LE(f.security) || bytes.readUInt32LE(f.security + 4)) return fail();
  return { bytes: bytes.length, sha256: sha(bytes), checksum: bytes.readUInt32LE(f.checksum) };
}
export function verifySignedWindowsPe(bytes, pin) {
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 328 || !/^[a-f0-9]{64}$/.test(pin.sha256)
    || !Number.isInteger(pin.checksum) || pin.checksum < 0 || pin.checksum > 0xffffffff) return fail();
  const f = fields(bytes), certificate = bytes.readUInt32LE(f.security), size = bytes.readUInt32LE(f.security + 4);
  const aligned = Math.ceil(pin.bytes / 8) * 8;
  if (certificate !== aligned || size < 8 || size > 1024 * 1024 || size % 8 || certificate + size !== bytes.length
    || bytes.readUInt32LE(certificate) < 8 || bytes.readUInt32LE(certificate) > size
    || bytes.readUInt16LE(certificate + 4) !== 0x200 || bytes.readUInt16LE(certificate + 6) !== 2
    || bytes.subarray(pin.bytes, aligned).some(byte => byte !== 0)) return fail();
  const original = Buffer.from(bytes.subarray(0, pin.bytes));
  original.writeUInt32LE(pin.checksum, f.checksum); original.fill(0, f.security, f.security + 8);
  if (sha(original) !== pin.sha256) return fail();
}
