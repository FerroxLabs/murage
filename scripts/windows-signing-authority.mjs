// Authority verification owner: win-sac-sign; enrollment, controller keys and admission owner: MAIN.
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";

export const signingDigest = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => /^[a-f0-9]{64}$/.test(value ?? "") && value !== "0".repeat(64);
const revision = value => /^[a-f0-9]{40}$/.test(value ?? "");
const id = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const fail = code => { throw Error(`WINDOWS_SIGNING_AUTHORITY_${code}`); };
export function exactSigningFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) fail("FIELDS");
}
function publicKey(value) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") fail("KEY");
    return key;
  } catch { fail("KEY"); }
}
function decode(value) {
  if (typeof value !== "string" || !value.length || value.length > 8 * 1024 * 1024
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("ENCODING");
  return Buffer.from(value, "base64");
}
/** The expected digest comes from controller deployment configuration, never an artifact or vars alone. */
export function verifyWindowsSigningAuthority(bytes, expected) {
  if (!digest(expected) || signingDigest(bytes) !== expected) fail("LOCK_DIGEST");
  const lock = JSON.parse(bytes);
  if (lock.schema !== 2 || lock.enrolled !== true) fail("NOT_ENROLLED");
  exactSigningFields(lock, ["schema", "enrolled", "image", "runner", "trees", "executables", "checker", "controllerKeys", "publisherPolicy", "egress", "launchSha256", "sourceRevision"]);
  exactSigningFields(lock.image, ["versionResourceId", "measurement"]);
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft.Compute\/galleries\/[^/]+\/images\/[^/]+\/versions\/\d+\.\d+\.\d+$/.test(lock.image.versionResourceId)
    || !digest(lock.image.measurement) || !revision(lock.sourceRevision) || !digest(lock.launchSha256)) fail("IMAGE");
  exactSigningFields(lock.runner, ["revision", "patchSha256", "treeSha256"]);
  if (!revision(lock.runner.revision) || !digest(lock.runner.patchSha256) || !digest(lock.runner.treeSha256)) fail("RUNNER");
  exactSigningFields(lock.controllerKeys, ["runAuthorization", "extractionResult"]);
  const keys = Object.values(lock.controllerKeys).map(value => {
    exactSigningFields(value, ["id", "publicKey"]);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.id)) fail("KEY");
    return publicKey(value.publicKey).export({ type: "spki", format: "der" }).toString("hex");
  });
  if (keys[0] === keys[1] || lock.controllerKeys.runAuthorization.id === lock.controllerKeys.extractionResult.id) fail("KEY_SEPARATION");
  const components = ["pwsh", "node", "signtool", "provider", "checker", "builder"];
  if (!Array.isArray(lock.trees) || components.some(name => !lock.trees.some(tree => tree.component === name))) fail("TREES");
  const roots = new Set(), treeNames = new Set();
  for (const tree of lock.trees) {
    exactSigningFields(tree, ["component", "root", "archive", "files"]);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(tree.component) || treeNames.has(tree.component)
      || !path.win32.isAbsolute(tree.root) || !tree.root.startsWith("C:\\Program Files\\MurageSigning\\")
      || path.win32.normalize(tree.root) !== tree.root
      || roots.has(tree.root.toLowerCase()) || [...roots].some(root => tree.root.toLowerCase().startsWith(`${root}\\`) || root.startsWith(`${tree.root.toLowerCase()}\\`))) fail("TREE_ROOT");
    signingRelativePath(path.win32.relative("C:\\Program Files\\MurageSigning", tree.root).replaceAll("\\", "/"));
    treeNames.add(tree.component);
    roots.add(tree.root.toLowerCase());
    exactSigningFields(tree.archive, ["version", "url", "sha256"]);
    if (!/^https:\/\//.test(tree.archive.url) || typeof tree.archive.version !== "string" || !tree.archive.version || /[*x]|latest/i.test(tree.archive.version) || !digest(tree.archive.sha256)
      || !Array.isArray(tree.files) || !tree.files.length) fail("TREE_PIN");
    const seen = new Set();
    for (const row of tree.files) {
      exactSigningFields(row, ["relativePath", "sha256"]);
      signingRelativePath(row.relativePath);
      if (!digest(row.sha256) || seen.has(row.relativePath.toLowerCase())) fail("TREE_PIN");
      seen.add(row.relativePath.toLowerCase());
    }
  }
  exactSigningFields(lock.executables, ["pwsh", "node", "signtool", "checker"]);
  for (const [name, pin] of Object.entries(lock.executables)) {
    exactSigningFields(pin, ["path", "sha256", "signer", "source"]);
    const tree = lock.trees.find(tree => tree.component === name);
    const relative = path.win32.relative(tree.root, pin.path).replaceAll("\\", "/");
    if (pin.source !== "trusted-configuration" || typeof pin.signer !== "string" || !pin.signer || !path.win32.isAbsolute(pin.path)
      || !tree.files.some(row => row.relativePath === relative && row.sha256 === pin.sha256)) fail("EXECUTABLE_PIN");
  }
  exactSigningFields(lock.checker, ["contract", "attestationSha256"]);
  if (lock.checker.contract !== "embedded-winverifytrust-v1" || !digest(lock.checker.attestationSha256)) fail("CHECKER");
  exactSigningFields(lock.publisherPolicy, ["subjectDn", "profileEku", "issuerDn", "profile"]);
  if (typeof lock.publisherPolicy.subjectDn !== "string" || !lock.publisherPolicy.subjectDn.trim()
    || typeof lock.publisherPolicy.issuerDn !== "string" || !lock.publisherPolicy.issuerDn.trim()
    || typeof lock.publisherPolicy.profileEku !== "string" || !/^\d+(?:\.\d+)+$/.test(lock.publisherPolicy.profileEku)
    || lock.publisherPolicy.profile !== "Public Trust") fail("PUBLISHER_POLICY");
  if (!Array.isArray(lock.egress) || !lock.egress.length) fail("EGRESS");
  for (const rule of lock.egress) {
    exactSigningFields(rule, ["executable", "host", "port", "purpose"]);
    if (![lock.executables.pwsh.path, lock.executables.signtool.path].includes(rule.executable)
      || !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(rule.host)
      || ![80, 443].includes(rule.port) || !["identity", "signing", "timestamp", "revocation"].includes(rule.purpose)) fail("EGRESS");
  }
  return Object.freeze({ ...lock, sha256: expected });
}
export function signingRelativePath(value) {
  if (typeof value !== "string" || value.includes("\\") || value.includes(":") || value.length > 1024
    || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$|[\x00-\x1f]/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("PATH");
  return value;
}
/** Verify exact signed bytes before parsing authority-bearing fields. */
export function verifyWindowsControllerEnvelope(bytes, key) {
  const envelope = JSON.parse(bytes);
  exactSigningFields(envelope, ["keyId", "payload", "payloadSha256", "signature"]);
  const payload = decode(envelope.payload), signature = decode(envelope.signature);
  if (envelope.keyId !== key.id || !digest(envelope.payloadSha256) || signingDigest(payload) !== envelope.payloadSha256
    || signature.length !== 64 || !verify(null, payload, publicKey(key.publicKey), signature)) fail("SIGNATURE");
  return { payload: JSON.parse(payload), sha256: envelope.payloadSha256 };
}
export const WINDOWS_SIGNING_RELEASE_VERSION = "1.0.19";
export function verifyWindowsRunAuthorization(bytes, lock, admission, now = Date.now()) {
  const { payload: run, sha256 } = verifyWindowsControllerEnvelope(bytes, lock.controllerKeys.runAuthorization);
  exactSigningFields(run, ["schema", "repositoryId", "workflowPath", "workflowSha", "sourceRevision", "version", "target", "runId", "runAttempt", "jobId", "artifactId", "outerSha256", "innerSha256", "planSha256", "sourcesSha256", "lockSha256", "launchSha256", "lease", "expiresAt", "files", "settings"]);
  const bound = ["repositoryId", "workflowPath", "workflowSha", "sourceRevision", "runId", "runAttempt", "jobId", "lease", "artifactId", "outerSha256"];
  if (run.schema !== 2 || bound.some(key => run[key] !== admission[key]) || run.lockSha256 !== lock.sha256
    || run.launchSha256 !== lock.launchSha256 || !id(run.repositoryId) || !id(run.runId) || !id(run.runAttempt) || !id(run.jobId) || !id(run.artifactId)
    || ![".github/workflows/package-win.yml", ".github/workflows/release.yml"].includes(run.workflowPath)
    || !revision(run.workflowSha) || !revision(run.sourceRevision) || run.version !== WINDOWS_SIGNING_RELEASE_VERSION || run.target !== "win32-x64"
    || !/^[a-f0-9]{64}$/.test(run.lease) || !Number.isSafeInteger(run.expiresAt) || run.expiresAt <= now || run.expiresAt - now > 30 * 60_000
    || ["outerSha256", "innerSha256", "planSha256", "sourcesSha256", "launchSha256"].some(key => !digest(run[key]))) fail("RUN_BINDING");
  if (admission.imageVersionResourceId !== lock.image.versionResourceId || admission.newOsDisk !== true || admission.unused !== true
    || admission.protectedHistory !== true || admission.inputRef !== run.sourceRevision || admission.customData !== false
    || admission.extensions !== false || admission.runCommand !== false || admission.winrm !== false || admission.autoUpdate !== false
    || !["workflow_dispatch", "push"].includes(admission.event) || admission.fork !== false
    || admission.runnerPatchSha256 !== lock.runner.patchSha256) fail("ADMISSION");
  if (!Array.isArray(run.files) || !run.files.length || run.files.length > 100_000) fail("FILES");
  const seen = new Set(); let total = 0;
  for (const row of run.files) {
    exactSigningFields(row, ["path", "sha256", "size"]);
    signingRelativePath(row.path);
    if (seen.has(row.path.toLowerCase()) || !digest(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0
      || row.size > 2 * 1024 ** 3 || (total += row.size) > 16 * 1024 ** 3) fail("FILES");
    seen.add(row.path.toLowerCase());
  }
  exactSigningFields(run.settings, ["projectDir", "configFile", "environment"]);
  if (!path.win32.isAbsolute(run.settings.projectDir) || !path.win32.isAbsolute(run.settings.configFile)
    || path.win32.extname(run.settings.configFile) !== ".json" || !run.settings.environment
    || typeof run.settings.environment !== "object" || Array.isArray(run.settings.environment)
    || Object.entries(run.settings.environment).some(([key, value]) => !/^MURAGE_[A-Z0-9_]+$/.test(key)
      || /SECRET|TOKEN|PASSWORD|CREDENTIAL|LAUNCH|PROVIDER|CHECKER|SIGNER|EXECUTABLE/.test(key) || typeof value !== "string")) fail("SETTINGS");
  return Object.freeze({ ...run, sha256 });
}
