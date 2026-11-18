// Launch validation/provider owner: win-sac-sign; isolated runner, sealing and credential broker owner: MAIN.
// This module is part of the bootstrap's pinned tree. Use only Node builtins:
// dependency loading must never precede private credential capture in the driver.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WINDOWS_SIGNING_RELEASE_VERSION } from "./windows-signing-authority.mjs";

const digest = value => /^[a-f0-9]{64}$/.test(value ?? "");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw Error("WINDOWS_SIGNING_LAUNCH_REJECTED"); };
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
export function windowsSigningLaunchScript(node, driver) {
  return `$ErrorActionPreference = 'Stop'\n& '${node.replaceAll("'", "''")}' --max-old-space-size=4300 '${driver.replaceAll("'", "''")}'\nexit $LASTEXITCODE\n`;
}
async function regular(file) {
  // Reject reparse/symlink ancestors as well as a substituted final file.
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === path.resolve(file) ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) fail();
    if (current === path.dirname(current)) break;
  }
  return readFile(file);
}

/** expected comes from trusted runner configuration, NEVER a preparation step
 * output, GITHUB_ENV/GITHUB_PATH or a receipt discovered beside staged files. */
export async function verifyWindowsSigningLaunch(file, expected, { measureExecutable = measureWindowsSigningExecutable, assertIsolatedAndSealed, readRunContext } = {}) {
  if (!path.isAbsolute(file ?? "") || !digest(expected)) fail();
  const bytes = await regular(file);
  if (sha256(bytes) !== expected) fail();
  let contract = JSON.parse(bytes);
  if (![1, 2].includes(contract.schema) || !Array.isArray(contract.roots) || !contract.roots.length
    || contract.roots.some(root => !path.isAbsolute(root))
    || contract.roots.some((root, i) => contract.roots.some((other, j) => i !== j && (root === other || within(root, other))))
    || !Array.isArray(contract.files) || !contract.files.length) fail();
  const receiptPin = contract.files.find(row => row.path === contract.providerReceipt);
  if (!receiptPin || !path.isAbsolute(receiptPin.path) || !digest(receiptPin.sha256)) fail();
  const receiptBytes = await regular(receiptPin.path);
  if (sha256(receiptBytes) !== receiptPin.sha256) fail();
  const providerFiles = new Set((JSON.parse(receiptBytes).files ?? []).map(row => row.path));
  const files = new Map();
  for (const entry of contract.files) {
    if (!path.isAbsolute(entry.path ?? "") || !digest(entry.sha256) || files.has(entry.path.toLowerCase())
      || !contract.roots.some(root => within(root, entry.path))) fail();
    files.set(entry.path.toLowerCase(), entry);
    if (sha256(await regular(entry.path)) !== entry.sha256) {
      if (providerFiles.has(entry.path)) throw Error("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
      fail();
    }
  }
  // An unlisted DLL/module beside a pinned executable is executable input too.
  const observed = new Set();
  const walk = async (directory, depth = 0) => {
    if (depth > 64) fail();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (!entry.isFile() || !files.has(child.toLowerCase())) fail();
      else observed.add(child.toLowerCase());
    }
  };
  for (const root of contract.roots) await walk(root);
  if (observed.size !== files.size) fail();
  for (const key of ["pwsh", "node", "driver", "launchScript", "providerReceipt"]) {
    if (!path.isAbsolute(contract[key] ?? "") || !files.has(contract[key].toLowerCase())) fail();
  }
  if ((await regular(contract.launchScript)).toString("utf8") !== windowsSigningLaunchScript(contract.node, contract.driver)) fail();
  if (!Array.isArray(contract.path) || !contract.path.length || !Array.isArray(contract.modulePath) || !contract.modulePath.length) fail();
  for (const directory of [...contract.path, ...contract.modulePath]) {
    if (!path.isAbsolute(directory) || !contract.roots.some(root => directory === root || within(root, directory))
      || !filesHasDirectory(files, directory)) fail();
  }
  // Only fixed OS/runtime locations are inherited by the trusted bootstrap.
  // No command files, user homes/profiles, package-manager config or preload vars.
  const environment = contract.environment ?? {};
  const allowed = new Set(["SystemRoot", "WINDIR", "TEMP", "TMP"]);
  if (Object.entries(environment).some(([key, value]) => !allowed.has(key) || typeof value !== "string" || !path.isAbsolute(value))) fail();
  if (contract.schema === 2) {
    const read = readRunContext ?? (await import("./windows-signing-bootstrap.mjs")).readWindowsSigningRunContext;
    const { lock, run, config } = await read();
    if (config.launchFile !== file || lock.launchSha256 !== expected || !path.isAbsolute(contract.runRoot ?? "")
      || contract.roots.some(root => root === contract.runRoot || within(root, contract.runRoot) || within(contract.runRoot, root))
      || run.settings.projectDir !== contract.runRoot || !within(contract.runRoot, run.settings.configFile)
      || run.settings.environment.MURAGE_BUILD_COMMIT !== run.sourceRevision
      || run.settings.environment.MURAGE_WINDOWS_BUILD_PLAN_SHA256 !== run.planSha256) fail();
    for (const tree of lock.trees) for (const row of tree.files) {
      const target = path.join(tree.root, ...row.relativePath.split("/"));
      if (!files.has(target.toLowerCase()) || files.get(target.toLowerCase()).sha256 !== row.sha256) fail();
    }
    for (const name of ["pwsh", "node"]) if (["source", "path", "sha256", "signer"].some(key => contract.executables?.[name]?.[key] !== lock.executables[name]?.[key])) fail();
    const runFiles = new Map();
    let packageVersion;
    for (const row of run.files) {
      const target = path.join(contract.runRoot, ...row.path.split("/"));
      const content = await regular(target);
      if (!within(contract.runRoot, target) || content.length !== row.size || sha256(content) !== row.sha256) fail();
      runFiles.set(target.toLowerCase(), row);
      if (row.path === "package.json") packageVersion = JSON.parse(content).version;
    }
    if (run.version !== WINDOWS_SIGNING_RELEASE_VERSION || packageVersion !== run.version) fail();
    if (!runFiles.has(run.settings.configFile.toLowerCase())) fail();
    const checkRun = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) { if ((await lstat(target)).isSymbolicLink()) fail(); await checkRun(target); }
        else if (!entry.isFile() || !runFiles.delete(target.toLowerCase())) fail();
      }
    };
    await checkRun(contract.runRoot);
    if (runFiles.size) fail();
    contract = { ...contract, publisherPolicy: lock.publisherPolicy, signingAuthority: lock, runAuthorization: run,
      driverSettings: { ...contract.driverSettings, ...run.settings, runId: run.runId, runAttempt: run.runAttempt,
        environment: { ...contract.driverSettings?.environment, ...run.settings.environment } } };
  }
  const launch = Object.freeze({ ...contract, providerReceiptSha256: files.get(contract.providerReceipt.toLowerCase()).sha256,
    environment: Object.freeze({ ...environment,
    PATH: contract.path.join(path.delimiter), PSModulePath: contract.modulePath.join(path.delimiter), NODE_OPTIONS: "" }) });
  await assertIsolatedAndSealed?.(launch);
  for (const name of ["pwsh", "node"]) {
    const pin = contract.executables?.[name];
    if (!pin || pin.source !== "trusted-configuration" || pin.path !== contract[name]
      || !path.win32.isAbsolute(pin.path) || path.win32.basename(pin.path).toLowerCase() !== `${name}.exe`
      || !digest(pin.sha256) || files.get(pin.path.toLowerCase()).sha256 !== pin.sha256
      || typeof pin.signer !== "string" || !pin.signer
      || Object.keys(pin).some(key => !["source", "path", "sha256", "signer"].includes(key))) fail();
    const measured = await measureExecutable(pin.path, contract);
    if (measured.status !== "Valid" || measured.embedded !== true || measured.publisher !== pin.signer
      || measured.userWritable !== false || sha256(await regular(pin.path)) !== pin.sha256) fail();
  }
  return launch;
}
async function measureWindowsSigningExecutable(target, contract) {
  const checker = contract.checker;
  if (process.platform !== "win32" || !checker || !path.isAbsolute(checker.path ?? "")
    || !digest(checker.sha256) || !contract.files.some(row => row.path === checker.path && row.sha256 === checker.sha256)
    || sha256(await regular(checker.path)) !== checker.sha256) fail();
  const { verifyWindowsCheckerAttestation } = await import("./windows-checker-contract.mjs");
  await verifyWindowsCheckerAttestation(checker.attestation, checker.attestationSha256, checker.sha256);
  // Only the independently pinned native checker runs before pwsh admission.
  const { stdout } = await promisify(execFile)(checker.path, ["--launch", target], {
    env: { SystemRoot: contract.environment?.SystemRoot, WINDIR: contract.environment?.WINDIR },
    shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 16_384,
  });
  if (sha256(await regular(checker.path)) !== checker.sha256) fail();
  return JSON.parse(stdout);
}
function filesHasDirectory(files, directory) {
  return [...files.values()].some(file => within(directory, file.path));
}

/** The trusted runner calls this before releasing credentials. The required
 * boundary callback must enforce fresh-runner isolation, immutable tree ACLs,
 * command-file isolation and signing-only egress; a JSON claim cannot do so. */
export async function launchWindowsSigningDriver({ contractFile, expected, boundary, measureExecutable }) {
  if (Object.keys(process.env).some(key => /^AZURE_/i.test(key))
    || typeof boundary?.assertIsolatedAndSealed !== "function" || typeof boundary?.release !== "function") fail();
  let launch = await verifyWindowsSigningLaunch(contractFile, expected, { measureExecutable,
    assertIsolatedAndSealed: launch => boundary.assertIsolatedAndSealed(launch) });
  launch = await verifyWindowsSigningLaunch(contractFile, expected, { measureExecutable });
  try {
    // MAIN RULING 1115-WINSAC-F: the service starts the child; bootstrap never receives credentials.
    const result = await boundary.release({ launchSha256: expected });
    if (!result || Object.keys(result).sort().join(",") !== "exitCode,receiptSha256" || result.exitCode !== 0
      || !digest(result.receiptSha256)) fail();
    return result;
  } catch { throw Error("WINDOWS_SIGNING_DRIVER_FAILED"); }
  finally {
    await verifyWindowsSigningLaunch(contractFile, expected, { measureExecutable });
  }
}
