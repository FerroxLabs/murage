// Fixture producer owner: win-sac-sign; production enrollment consumer: MAIN.
import { generateKeyPairSync, sign } from "node:crypto";
import { signingDigest } from "../windows-signing-authority.mjs";
export function signingAuthorityFixture() {
  const runKey = generateKeyPairSync("ed25519"), extractionKey = generateKeyPairSync("ed25519");
  const hash = value => signingDigest(Buffer.from(value));
  const names = ["pwsh", "node", "signtool", "provider", "checker", "builder"];
  const trees = names.map(component => ({ component, root: `C:\\Program Files\\MurageSigning\\${component}`,
    archive: { version: "1.2.3", url: `https://packages.example.invalid/${component}.zip`, sha256: hash(`${component} archive`) },
    files: [{ relativePath: `${component}.exe`, sha256: hash(component) }, { relativePath: "runtime.dll", sha256: hash(`${component} runtime`) }] }));
  const executables = Object.fromEntries(["pwsh", "node", "signtool", "checker"].map(name => [name, {
    path: `${trees.find(row => row.component === name).root}\\${name}.exe`, sha256: hash(name), signer: "Fixture Vendor", source: "trusted-configuration",
  }]));
  const key = (id, pair) => ({ id, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const lock = { schema: 2, enrolled: true,
    image: { versionResourceId: "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.Compute/galleries/fixture/images/signing/versions/1.2.3", measurement: hash("image") },
    runner: { revision: "a".repeat(40), patchSha256: hash("patch"), treeSha256: hash("runner") }, trees, executables,
    checker: { contract: "embedded-winverifytrust-v1", attestationSha256: hash("attestation") },
    controllerKeys: { runAuthorization: key("run", runKey), extractionResult: key("extraction", extractionKey) },
    publisherPolicy: { subjectDn: "CN=Fixture Publisher,O=Fixture", profileEku: "1.2.3.4.5", issuerDn: "CN=Fixture Issuer", profile: "Public Trust" },
    egress: [{ executable: executables.pwsh.path, host: "identity.example.invalid", port: 443, purpose: "identity" }],
    launchSha256: hash("launch"), sourceRevision: "b".repeat(40) };
  const now = 1_800_000_000_000;
  const admission = { repositoryId: "10", workflowPath: ".github/workflows/package-win.yml", workflowSha: "c".repeat(40), sourceRevision: "d".repeat(40),
    runId: "20", runAttempt: "1", jobId: "30", artifactId: "40", outerSha256: hash("outer"), lease: hash("lease"),
    imageVersionResourceId: lock.image.versionResourceId, newOsDisk: true, unused: true, protectedHistory: true, inputRef: "d".repeat(40),
    customData: false, extensions: false, runCommand: false, winrm: false, autoUpdate: false, event: "workflow_dispatch", fork: false, runnerPatchSha256: lock.runner.patchSha256 };
  const bytes = () => Buffer.from(JSON.stringify(lock));
  const run = { schema: 2, ...Object.fromEntries(["repositoryId", "workflowPath", "workflowSha", "sourceRevision", "runId", "runAttempt", "jobId", "artifactId", "outerSha256", "lease"].map(key => [key, admission[key]])),
    version: "1.0.19", target: "win32-x64", innerSha256: hash("inner"), planSha256: hash("plan"), sourcesSha256: hash("sources"),
    lockSha256: signingDigest(bytes()), launchSha256: lock.launchSha256, expiresAt: now + 60_000,
    files: [{ path: "builder.json", sha256: hash("config"), size: 2 }],
    settings: { projectDir: "C:\\SigningInput", configFile: "C:\\SigningInput\\builder.json", environment: {} } };
  const envelope = (value = run, pair = runKey, keyId = "run") => {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.from(JSON.stringify({ keyId, payload: payload.toString("base64"), payloadSha256: signingDigest(payload), signature: sign(null, payload, pair.privateKey).toString("base64") }));
  };
  return { lock, run, admission, now, bytes, envelope, extractionKey, hash };
}
