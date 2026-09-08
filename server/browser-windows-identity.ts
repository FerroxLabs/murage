// These original Windows images have no certificate table. Authenticode adds
// only a trailing certificate and updates the checksum/security-directory
// fields. Restore those exact pinned fields, then hash EVERY original byte.
// Windows itself validates the signature; this is not signature verification.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { browserBundleSpec } from "./browser-bundle-release.ts";
export const WINDOWS_BROWSER_PUBLISHER = "Ferrox Labs, LLC";
// A pwsh parent may pass PowerShell 7 modules through Node to Windows
// PowerShell 5.1. Load only this child shell's own trusted built-in modules.
export const WINDOWS_BROWSER_POWERSHELL_SETUP = String.raw`$env:PSModulePath=$PSHOME+'\Modules'; $ErrorActionPreference='Stop'; `;
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
    || result.status !== "Valid" || result.publisher !== WINDOWS_BROWSER_PUBLISHER) throw new Error("Windows browser requires a valid Ferrox Labs signature");
}
export function windowsBrowserSignatureScript(files: string[]): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return WINDOWS_BROWSER_POWERSHELL_SETUP + `$result=@(foreach($file in @(${files.map(quote).join(",")})){ $sig=Get-AuthenticodeSignature -LiteralPath $file; $publisher=if($sig.SignerCertificate){$sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}; @{status=[string]$sig.Status;publisher=$publisher} }); ConvertTo-Json -InputObject $result -Compress`;
}
export async function verifyWindowsBrowserSignatures(files: string[], systemRoot = "C:\\Windows"): Promise<void> {
  const script = windowsBrowserSignatureScript(files);
  const output = await new Promise<string>((done, fail) => execFile(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20_000, maxBuffer: 8192 }, (error, stdout, stderr) => error ? fail(new Error(`Windows browser signature verification failed (code ${error.code ?? "unknown"}, signal ${error.signal ?? "none"}): ${stderr.trim().slice(0, 2048)}`)) : done(stdout)));
  const results: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(results) || results.length !== files.length) throw new Error("Windows browser signature receipt is incomplete");
  for (const result of results) requireBrowserSignature(result);
}
