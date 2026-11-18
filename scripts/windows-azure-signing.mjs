// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped, through electron-builder's
// Azure Trusted Signing manager. Owner of this check: release build (after-pack); owner of the secrets: MAIN.
// electron-builder itself does not check the Azure environment before it starts packaging, so this refuses first:
// a Windows package is never produced without the Azure signer selected and its three credentials present.
export const AZURE_SIGNING_ENV = Object.freeze(["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]);
export const WINDOWS_PUBLISHER = "Ferrox Labs, LLC";
const text = value => typeof value === "string" && value.trim().length > 0;

/** Throws unless the effective builder config signs Windows with Azure Trusted Signing as our publisher, and nothing else. */
export function assertAzureSigningConfig(config) {
  const win = config?.win, azure = win?.azureSignOptions;
  if (config?.forceCodeSigning !== true || !azure || typeof azure !== "object"
    || azure.publisherName !== WINDOWS_PUBLISHER
    || !/^https:\/\/[a-z0-9.-]+\.codesigning\.azure\.net\/?$/.test(azure.endpoint ?? "")
    || !text(azure.codeSigningAccountName) || !text(azure.certificateProfileName)
    || win.signtoolOptions !== undefined || win.signExecutable === false || win.signAndEditExecutable === false
    || win.verifyUpdateCodeSignature === false) throw new Error("WINDOWS_SIGNING_CONFIG_MISMATCH");
  return azure;
}

/** Throws, naming only the variable names, unless every Azure signing credential is present. */
export function assertAzureSigningEnv(env = process.env) {
  const missing = AZURE_SIGNING_ENV.filter(key => !text(env[key]));
  if (missing.length) throw new Error(`WINDOWS_AZURE_SIGNING_ENV_REQUIRED: ${missing.join(", ")}`);
}

/** The one admission a Windows package needs before any file is signed. */
export function assertAzureSigning(config, env = process.env) {
  const azure = assertAzureSigningConfig(config);
  assertAzureSigningEnv(env);
  return azure;
}
