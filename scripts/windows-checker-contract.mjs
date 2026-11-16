// Contract implementation owner: win-sac-sign; authenticated checker build and approval owner: MAIN.
import path from "node:path";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
const digest = value => /^[a-f0-9]{64}$/.test(value ?? "");
export async function verifyWindowsCheckerAttestation(file, expected, binarySha256) {
  if (!file || !path.isAbsolute(file) || !digest(expected) || !digest(binarySha256)) throw Error("WINDOWS_CHECKER_ATTESTATION_REQUIRED");
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) throw Error("WINDOWS_CHECKER_ATTESTATION_HASH_MISMATCH");
  const data = JSON.parse(bytes);
  if (data.schema !== 1 || data.component !== "windows-trust-checker" || data.binarySha256 !== binarySha256
    || !/^[a-f0-9]{40}$/.test(data.sourceRevision ?? "") || !digest(data.sourceSha256)
    || !data.toolchain || !digest(data.toolchain.sha256) || typeof data.toolchain.version !== "string" || !data.toolchain.version
    || !Array.isArray(data.tools) || !data.tools.length || data.tools.some(tool => !digest(tool.sha256) || !tool.component)
    || data.contract !== "embedded-winverifytrust-v1") throw Error("WINDOWS_CHECKER_ATTESTATION_INVALID");
  return data;
}
export function parseWindowsCheckerVerdict(stdout) {
  const verdict = JSON.parse(stdout);
  if (!verdict || !["Valid", "NotSigned", "HashMismatch", "NotTrusted", "UnknownError"].includes(verdict.status)
    || typeof verdict.embedded !== "boolean" || typeof verdict.timestamp !== "boolean" || typeof verdict.publisher !== "string"
    || verdict.publisher.length > 511 || (verdict.status === "Valid" && (!verdict.embedded || !verdict.publisher))) {
    throw Error("WINDOWS_CHECKER_VERDICT_INVALID");
  }
  return verdict;
}
