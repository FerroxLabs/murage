// Generated-helper worker owner: win-sac-sign; sealed launch/checker and tool enrollment owner: MAIN.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyWindowsSigningLaunch } from "./windows-signing-launch.mjs";
import { windowsSigningTrust } from "./windows-signing-trust.mjs";
import { verifyFrozenWindowsPe } from "./windows-pe-signing.mjs";

export async function executeWindowsNsisHelper({ file, pin, record, launchContract }, { env = process.env, run = promisify(execFile) } = {}) {
  if (process.platform !== "win32" || Object.keys(env).some(key => /^AZURE_|^NODE_OPTIONS$/i.test(key))
    || !path.isAbsolute(file ?? "") || pin?.component !== "nsis-helper") throw Error("WINDOWS_NSIS_HELPER_REJECTED");
  const launch = await verifyWindowsSigningLaunch(launchContract?.file, launchContract?.sha256);
  const trust = await windowsSigningTrust(launch);
  await verifyFrozenWindowsPe(file, pin, record, trust);
  await run(file, [], { shell: false, cwd: path.dirname(file), env: { ...env, __COMPAT_LAYER: "RunAsInvoker" },
    windowsHide: true, timeout: 120_000, maxBuffer: 16_384 });
  await verifyFrozenWindowsPe(file, pin, record, trust);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error("WINDOWS_NSIS_HELPER_REJECTED");
    await executeWindowsNsisHelper(JSON.parse(process.argv[2]));
  } catch { process.stderr.write("WINDOWS_NSIS_HELPER_FAILED\n"); process.exitCode = 1; }
}
