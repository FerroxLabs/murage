// Authority tests owner: win-sac-sign; real controller/Windows admission witness owner: MAIN.
import { expect, it } from "vitest";
import { signingAuthorityFixture } from "./fixtures/windows-signing-authority.mjs";
import { signingDigest, verifyWindowsSigningAuthority, verifyWindowsRunAuthorization, verifyWindowsControllerEnvelope } from "./windows-signing-authority.mjs";
const enrolled = f => verifyWindowsSigningAuthority(f.bytes(), signingDigest(f.bytes()));
it("authenticates an enrolled whole-tree lock and controller-bound run, with separate extraction key", () => {
  const f = signingAuthorityFixture(), lock = enrolled(f);
  expect(verifyWindowsRunAuthorization(f.envelope(), lock, f.admission, f.now)).toMatchObject(f.run);
  expect(() => verifyWindowsControllerEnvelope(f.envelope(), lock.controllerKeys.extractionResult)).toThrow("SIGNATURE");
});
export const lockViolations = [
  ["unenrolled", f => { f.lock.enrolled = false; }],
  ["unknown authority field", f => { f.lock.approved = true; }],
  ["image latest", f => { f.lock.image.versionResourceId = f.lock.image.versionResourceId.replace("1.2.3", "latest"); }],
  ["zero image digest", f => { f.lock.image.measurement = "0".repeat(64); }],
  ["runner revision", f => { f.lock.runner.revision = "main"; }],
  ["same controller key", f => { f.lock.controllerKeys.extractionResult.publicKey = f.lock.controllerKeys.runAuthorization.publicKey; }],
  ["same key id", f => { f.lock.controllerKeys.extractionResult.id = "run"; }],
  ["missing tree", f => { f.lock.trees.pop(); }],
  ["duplicate component", f => { f.lock.trees.push({ ...f.lock.trees[3], root: "C:\\Program Files\\MurageSigning\\extra" }); }],
  ["noncanonical root", f => { f.lock.trees[0].root += "\\..\\pwsh"; }],
  ["overlapping trees", f => { f.lock.trees[1].root = `${f.lock.trees[0].root}\\child`; }],
  ["writable root", f => { f.lock.trees[0].root = "C:\\Temp\\pwsh"; }],
  ["empty tree", f => { f.lock.trees[0].files = []; }],
  ["case collision", f => { f.lock.trees[0].files.push({ ...f.lock.trees[0].files[0], relativePath: "PWSH.exe" }); }],
  ["wildcard version", f => { f.lock.trees[0].archive.version = "7.x"; }],
  ["nonstring version", f => { f.lock.trees[0].archive.version = 7; }],
  ["package digest used as executable pin", f => { f.lock.executables.pwsh.sha256 = f.lock.trees[0].archive.sha256; }],
  ["preparation executable selector", f => { f.lock.executables.pwsh.source = "preparation"; }],
  ["missing checker attestation", f => { f.lock.checker.attestationSha256 = ""; }],
  ["test profile", f => { f.lock.publisherPolicy.profile = "Public Trust Test"; }],
  ["missing full subject", f => { f.lock.publisherPolicy.subjectDn = ""; }],
  ["nonstring subject", f => { f.lock.publisherPolicy.subjectDn = 1; }],
  ["missing issuer", f => { f.lock.publisherPolicy.issuerDn = ""; }],
  ["missing EKU", f => { f.lock.publisherPolicy.profileEku = ""; }],
  ["wildcard egress", f => { f.lock.egress[0].host = "*.azure.net"; }],
  ["direct IP egress", f => { f.lock.egress[0].host = "192.0.2.1"; }],
  ["node egress", f => { f.lock.egress[0].executable = f.lock.executables.node.path; }],
];
it.each(lockViolations)("refuses lock %s", (_name, mutate) => {
  const f = signingAuthorityFixture(); mutate(f); expect(() => enrolled(f)).toThrow();
});
it("rejects a changed lock even if its internal fields remain valid", () => {
  const f = signingAuthorityFixture(), expected = signingDigest(f.bytes()); f.lock.sourceRevision = "e".repeat(40);
  expect(() => verifyWindowsSigningAuthority(f.bytes(), expected)).toThrow("LOCK_DIGEST");
});
export const runViolations = [
  ...["1.0.20", "1.0.21", "v1.0.19", "1.0.19-test"].map(version => [version, f => { f.run.version = version; }]),
  ["nonstring identity", f => { f.run.repositoryId = f.admission.repositoryId = 10; }],
  ["array environment", f => { f.run.settings.environment = []; }],
  ...["repositoryId", "workflowPath", "workflowSha", "sourceRevision", "runId", "runAttempt", "jobId", "artifactId", "outerSha256", "lease"].map(key => [key, f => { f.run[key] = "wrong"; }]),
  ...["newOsDisk", "unused", "protectedHistory"].map(key => [key, f => { f.admission[key] = false; }]),
  ...["customData", "extensions", "runCommand", "winrm", "autoUpdate", "fork"].map(key => [key, f => { f.admission[key] = true; }]),
  ...["pull_request", "pull_request_target", "workflow_run"].map(event => [event, f => { f.admission.event = event; }]),
  ...["imageVersionResourceId", "inputRef", "runnerPatchSha256"].map(key => [key, f => { f.admission[key] = "wrong"; }]),
  ["expired", f => { f.run.expiresAt = f.now; }],
  ["long-lived", f => { f.run.expiresAt = f.now + 31 * 60_000; }],
  ["unknown field", f => { f.run.signedHere = true; }],
  ["lock rebase", f => { f.run.lockSha256 = f.hash("other lock"); }],
  ["launch rebase", f => { f.run.launchSha256 = f.hash("other launch"); }],
  ["duplicate path", f => { f.run.files.push({ ...f.run.files[0], path: "BUILDER.json" }); }],
  ...["../escape", "C:/absolute", "dir/file:ads", "CON.txt", "dir/trailing.", "dir\\file"].map(name => [name, f => { f.run.files[0].path = name; }]),
  ["oversize", f => { f.run.files[0].size = 3 * 1024 ** 3; }],
  ["executable config", f => { f.run.settings.configFile = "C:\\SigningInput\\config.mjs"; }],
  ["provider pin from preparation", f => { f.run.settings.environment.MURAGE_WINDOWS_SIGNER_RECEIPT_SHA256 = f.hash("replacement"); }],
  ["credential in settings", f => { f.run.settings.environment.MURAGE_SECRET = "fixture"; }],
];
it.each(runViolations)("refuses run %s", (_name, mutate) => {
  const f = signingAuthorityFixture(), lock = enrolled(f); mutate(f);
  expect(() => verifyWindowsRunAuthorization(f.envelope(), lock, f.admission, f.now)).toThrow();
});
it.each(["payload", "digest", "signature", "key", "extra", "wrong-key"])("refuses envelope %s before interpreting settings", mode => {
  const f = signingAuthorityFixture(), lock = enrolled(f), value = JSON.parse(f.envelope());
  if (mode === "payload") value.payload = Buffer.from("not json").toString("base64");
  if (mode === "digest") value.payloadSha256 = f.hash("wrong");
  if (mode === "signature") value.signature = Buffer.alloc(64).toString("base64");
  if (mode === "key") value.keyId = "unreviewed";
  if (mode === "extra") value.approved = true;
  const bytes = mode === "wrong-key" ? f.envelope(f.run, f.extractionKey) : Buffer.from(JSON.stringify(value));
  expect(() => verifyWindowsRunAuthorization(bytes, lock, f.admission, f.now)).toThrow();
});

it("D2 V pins this train to the reviewed literal 1.0.19", async () => {
  const { WINDOWS_SIGNING_RELEASE_VERSION } = await import("./windows-signing-authority.mjs");
  expect(WINDOWS_SIGNING_RELEASE_VERSION).toBe("1.0.19");
});
