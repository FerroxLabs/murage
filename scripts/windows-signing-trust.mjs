// Trust/policy implementation owner: win-sac-sign; measured Public Trust enrollment and Windows witness owner: MAIN.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { peSha256, readWindowsPeSnapshot, runnerWindowsPeTrust } from "./windows-pe-signing.mjs";

export function requireWindowsPublisherPolicy(verdict, policy) {
  if (policy?.profile !== "Public Trust" || typeof policy.subjectDn !== "string" || !policy.subjectDn
    || typeof policy.issuerDn !== "string" || !policy.issuerDn || !/^\d+(?:\.\d+)+$/.test(policy.profileEku ?? "")
    || verdict?.status !== "Valid" || verdict.embedded !== true || verdict.timestamp !== true
    || verdict.subjectDn !== policy.subjectDn || verdict.issuerDn !== policy.issuerDn
    || !Array.isArray(verdict.ekus) || !verdict.ekus.includes(policy.profileEku)
    || !/^[a-f0-9]{64}$/.test(verdict.leafCertificateSha256 ?? "")) throw Error("WINDOWS_SIGNING_PUBLISHER_POLICY_REJECTED");
  return verdict.leafCertificateSha256;
}

/** The verified static authority selects every tool; preparation data cannot select policy or a checker. */
export async function windowsSigningTrust(launch, { run = promisify(execFile), loadChecker = runnerWindowsPeTrust } = {}) {
  const lock = launch.signingAuthority, checker = launch.checker, pin = lock?.executables?.signtool;
  if (lock?.enrolled !== true || !lock.publisherPolicy || !pin || checker?.path !== lock.executables.checker.path
    || checker.sha256 !== lock.executables.checker.sha256 || checker.attestationSha256 !== lock.checker.attestationSha256
    || !launch.files.some(row => row.path === pin.path && row.sha256 === pin.sha256)) throw Error("WINDOWS_SIGNING_TRUST_AUTHORITY_REQUIRED");
  const env = { ...launch.environment, MURAGE_WINDOWS_TRUST_CHECKER: checker.path, MURAGE_WINDOWS_TRUST_CHECKER_SHA256: checker.sha256,
    MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION: checker.attestation, MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION_SHA256: checker.attestationSha256 };
  const trust = await loadChecker(env);
  const verifyTool = async () => {
    if (peSha256((await readWindowsPeSnapshot(pin.path)).bytes) !== pin.sha256) throw Error("WINDOWS_SIGNING_VERIFY_TOOL_REJECTED");
    const verdict = await trust.authenticode(pin.path);
    if (verdict.status !== "Valid" || verdict.embedded !== true || verdict.publisher !== pin.signer) throw Error("WINDOWS_SIGNING_VERIFY_TOOL_REJECTED");
  };
  const verifySigned = async (file, verdict) => {
    requireWindowsPublisherPolicy(verdict, lock.publisherPolicy);
    await verifyTool();
    try { await run(pin.path, ["verify", "/pa", "/all", "/v", "/tw", file],
      { shell: false, env: { ...launch.environment }, windowsHide: true, timeout: 120_000, maxBuffer: 16_384 }); }
    catch { throw Error("WINDOWS_SIGNING_SECOND_VERIFY_REJECTED"); }
    finally { await verifyTool(); }
  };
  return { authenticode: trust.authenticode, verifySigned };
}
