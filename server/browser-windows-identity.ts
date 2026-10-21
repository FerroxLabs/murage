// These original Windows images have no certificate table. Authenticode adds
// only a trailing certificate and updates the checksum/security-directory
// fields. Restore those exact pinned fields, then hash EVERY original byte.
// Windows itself validates the signature; this is not signature verification.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { browserBundleSpec } from "./browser-bundle-release.ts";
import { ADDON_VERSION } from "./engine-exclusion.ts";
export const WINDOWS_BROWSER_PUBLISHER = "Ferrox Labs, LLC";
export type UnsignedPePin = { bytes: number; sha256: string; checksum: number };
const bundle = browserBundleSpec("win32-x64");
export const WINDOWS_BROWSER_IMAGE_PINS = {
  engine: { bytes: bundle.engine.bytes, sha256: bundle.engine.sha256, checksum: 13824246 },
  chrome: { bytes: 209473024, sha256: bundle.chrome.executableSha256, checksum: 0 },
} satisfies Record<string, UnsignedPePin>;

export function verifyWindowsBrowserImage(bytes: Buffer, pin: UnsignedPePin): { signed: boolean } {
  const fail = () => { throw new Error("Windows browser image differs from its pinned original"); };
  if (bytes.length === pin.bytes && createHash("sha256").update(bytes).digest("hex") === pin.sha256) return { signed: false };
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 256 || bytes.length <= pin.bytes || bytes.length > pin.bytes + 1024 * 1024 || bytes.toString("ascii", 0, 2) !== "MZ") return fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > pin.bytes - 264 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) return fail();
  const optional = pe + 24, optionalBytes = bytes.readUInt16LE(pe + 20);
  if (optionalBytes < 240 || optional + optionalBytes > pin.bytes || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 5) return fail();
  const checksum = optional + 64, security = optional + 112 + 4 * 8;
  const certificate = bytes.readUInt32LE(security), certificateBytes = bytes.readUInt32LE(security + 4);
  if (certificate !== pin.bytes || certificate % 8 || certificateBytes < 8 || certificateBytes % 8 || certificateBytes !== bytes.length - certificate) return fail();
  const certificateLength = bytes.readUInt32LE(certificate);
  if (certificateLength < 8 || certificateLength > certificateBytes || bytes.readUInt16LE(certificate + 4) !== 0x200 || bytes.readUInt16LE(certificate + 6) !== 2) return fail();
  const original = Buffer.from(bytes.subarray(0, pin.bytes));
  original.writeUInt32LE(pin.checksum, checksum); original.fill(0, security, security + 8);
  if (createHash("sha256").update(original).digest("hex") !== pin.sha256) return fail();
  return { signed: true };
}

export function requireBrowserSignature(result: unknown): void {
  if (!result || typeof result !== "object" || !("status" in result) || !("publisher" in result)
    || result.status !== "Valid" || result.publisher !== WINDOWS_BROWSER_PUBLISHER) {
    // What Windows answered (Valid, UnknownError, NotSigned...), for the log.
    const status = result && typeof result === "object" && "status" in result && typeof result.status === "string" ? result.status.slice(0, 40) : "unreadable";
    throw Object.assign(new Error("Windows browser requires a valid Ferrox Labs signature"), { signatureStatus: status === "Valid" ? "publisher" : status });
  }
}
/** The packaged native check (engine-exclusion.node's authenticode: WinVerifyTrust on a worker thread). */
export interface NativeAuthenticode { authenticode(path: string): Promise<unknown> }
const nativeChecks = new Map<string, NativeAuthenticode | null>();
/** The app's own addon in `resourcesPath`, when it is there and has the check; null otherwise. Looked for once per folder. */
export function nativeAuthenticodeIn(resourcesPath: string | undefined): NativeAuthenticode | null {
  if (process.platform !== "win32" || typeof resourcesPath !== "string" || !resourcesPath) return null;
  const file = join(resourcesPath, "engine-exclusion.node");
  if (nativeChecks.has(file)) return nativeChecks.get(file)!;
  let found: NativeAuthenticode | null = null;
  try {
    const addon = createRequire(import.meta.url)(file) as { authenticode?: unknown; version?: unknown };
    if (typeof addon?.authenticode === "function" && typeof addon.version === "function" && addon.version() === ADDON_VERSION) found = addon as NativeAuthenticode;
  } catch { found = null; }
  nativeChecks.set(file, found);
  return found;
}
/** Windows' own answer for each file: Valid and the exact Ferrox Labs publisher, or a refusal. */
export async function verifyWindowsSignaturesNatively(native: NativeAuthenticode, files: string[]): Promise<void> {
  for (const file of files) requireBrowserSignature(await native.authenticode(file));
}
/** Windows' own answer (WinVerifyTrust in the packaged engine-exclusion addon) for every file. There is no other check: without the
 * addon (a source checkout or build machine without a build) this refuses, it never starts PowerShell instead (murage-releases #1). */
export async function verifyWindowsBrowserSignatures(files: string[], _systemRoot = "C:\\Windows", native: NativeAuthenticode | null = nativeAuthenticodeIn(process.env.MURAGE_RESOURCES_PATH)): Promise<void> {
  if (!native) throw Object.assign(new Error("Windows signature check needs Murage's native helper (engine-exclusion.node). Reinstall Murage to repair it."), { signatureStatus: "helper-missing" });
  return verifyWindowsSignaturesNatively(native, files);
}
