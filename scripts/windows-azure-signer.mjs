// Signing producer owner: win-sac-sign; production credential/reputation owner: MAIN.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadWindowsSigningProvider } from "./windows-signing-provider.mjs";
import { verifyWindowsSigningLaunch } from "./windows-signing-launch.mjs";
import { WINDOWS_BROWSER_PUBLISHER } from "../server/browser-windows-identity.ts";
// Same Azure TrustedSigning provider and account as electron-builder. Policy,
// source verification and native trust remain exclusively in signPinnedWindowsPe.
export function azureWindowsPeSigner(options, { platform = process.platform, env = process.env, run = promisify(execFile),
  measureExecutable,
  launchContract = { file: env.MURAGE_WINDOWS_SIGNING_LAUNCH, sha256: env.MURAGE_WINDOWS_SIGNING_LAUNCH_SHA256 } } = {}) {
  if (platform !== "win32" || options.publisherName !== WINDOWS_BROWSER_PUBLISHER) throw Error("WINDOWS_SAC_PUBLISHER_CONFIG_MISMATCH");
  return async file => {
    const launch = await verifyWindowsSigningLaunch(launchContract.file, launchContract.sha256, { measureExecutable });
    const providerEnv = { MURAGE_WINDOWS_SIGNER_RECEIPT: launch.providerReceipt,
      MURAGE_WINDOWS_SIGNER_RECEIPT_SHA256: launch.providerReceiptSha256 };
    const provider = await loadWindowsSigningProvider(providerEnv);
    if (![provider.entry, ...provider.files.map(row => row.path)].every(file => launch.files.some(row => row.path === file))) {
      throw Error("WINDOWS_SIGNING_LAUNCH_REJECTED");
    }
    // The pinned action invocation gets exactly one file from common PE policy.
    // Never inherit folder, recursion or trace inputs from the surrounding CI.
    // No inherited PATH, profiles, preload flags, credential-discovery settings
    // or unrelated CI secrets. Only the pinned child receives private credentials.
    const signingEnv = { ...launch.environment };
    for (const key of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) {
      if (env[key] !== undefined) signingEnv[key] = env[key];
    }
    Object.assign(signingEnv, provider.defaults, { LOCALAPPDATA: provider.localAppData, INPUT_ENDPOINT: options.endpoint, INPUT_SIGNING_ACCOUNT_NAME: options.codeSigningAccountName,
      INPUT_CERTIFICATE_PROFILE_NAME: options.certificateProfileName, INPUT_FILES: file,
      INPUT_FILE_DIGEST: "SHA256", INPUT_TIMESTAMP_DIGEST: "SHA256", INPUT_TIMESTAMP_RFC3161: "http://timestamp.acs.microsoft.com",
      INPUT_EXCLUDE_AZURE_CLI_CREDENTIAL: "true" });
    try {
      await run(launch.pwsh, ["-NoProfile", "-NonInteractive", "-File", provider.entry],
        { env: signingEnv, cwd: path.dirname(launch.pwsh), shell: false, windowsHide: true, timeout: 300_000, maxBuffer: 16_384 });
    } catch { throw Error("WINDOWS_SIGNING_PROVIDER_EXECUTION_FAILED"); }
    finally {
      for (const key of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) delete signingEnv[key];
      await loadWindowsSigningProvider(providerEnv);
      await verifyWindowsSigningLaunch(launchContract.file, launchContract.sha256, { measureExecutable });
    }
    return true;
  };
}
