// Bootstrap owner: win-sac-sign; fixed installed config, pipe service and admission owner: MAIN.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { exactSigningFields, verifyWindowsSigningAuthority, verifyWindowsRunAuthorization } from "./windows-signing-authority.mjs";
import { windowsSigningBoundary } from "./windows-signing-boundary.mjs";
import { launchWindowsSigningDriver } from "./windows-signing-launch.mjs";

export const WINDOWS_SIGNING_BOOTSTRAP_CONFIG = "C:\\Program Files\\MurageSigning\\controller\\bootstrap.json";
export async function readWindowsSigningRunContext({ read = readFile, now = Date.now() } = {}) {
  const config = JSON.parse(await read(WINDOWS_SIGNING_BOOTSTRAP_CONFIG));
  exactSigningFields(config, ["lockFile", "lockSha256", "runAuthorizationFile", "launchFile", "launchSha256", "admission"]);
  for (const key of ["lockFile", "runAuthorizationFile", "launchFile"]) {
    if (!path.win32.isAbsolute(config[key] ?? "") || !config[key].startsWith("C:\\Program Files\\MurageSigning\\")
      || path.win32.normalize(config[key]) !== config[key]) throw Error("WINDOWS_SIGNING_BOOTSTRAP_REJECTED");
  }
  const lock = verifyWindowsSigningAuthority(await read(config.lockFile), config.lockSha256);
  const run = verifyWindowsRunAuthorization(await read(config.runAuthorizationFile), lock, config.admission, now);
  if (config.launchSha256 !== lock.launchSha256) throw Error("WINDOWS_SIGNING_BOOTSTRAP_REJECTED");
  return { config, lock, run };
}
export async function runWindowsSigningBootstrap() {
  if (process.platform !== "win32" || Object.keys(process.env).some(key => /^AZURE_/i.test(key))) throw Error("WINDOWS_SIGNING_BOOTSTRAP_REJECTED");
  // This service-written file is sealed before this process starts, outside the artifact roots.
  const { config, lock, run } = await readWindowsSigningRunContext();
  const boundary = windowsSigningBoundary({ lease: run.lease, launchSha256: lock.launchSha256, runAuthorizationSha256: run.sha256 });
  try { return await launchWindowsSigningDriver({ contractFile: config.launchFile, expected: lock.launchSha256, boundary }); }
  finally { boundary.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runWindowsSigningBootstrap(); }
  catch { process.stderr.write("WINDOWS_SIGNING_BOOTSTRAP_REJECTED\n"); process.exitCode = 1; }
}
