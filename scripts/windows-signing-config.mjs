// Configuration/driver owner: win-sac-sign; production configuration consumer: MAIN.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_BROWSER_PUBLISHER } from "../server/browser-windows-identity.ts";

export const WINDOWS_SIGNER_CONFIG = Object.freeze({ publisherName: WINDOWS_BROWSER_PUBLISHER,
  endpoint: "https://eus.codesigning.azure.net", codeSigningAccountName: "ferrox-labs-signing", certificateProfileName: "ferroxlabs" });
export const WINDOWS_CUSTOM_SIGNER = "./scripts/windows-builder-custom-sign.mjs";
const callback = fileURLToPath(new URL("./windows-builder-custom-sign.mjs", import.meta.url));
const forbiddenEnvironment = /^(?:WIN_)?CSC_|^SIGNTOOL_|^USE_SYSTEM_SIGNCODE|^WIN_CSC_LINK$/i;
export const WINDOWS_BUILDER_HOOKS = Object.freeze(Object.fromEntries(Object.entries({
  beforePack: "signal-packaging.mjs", afterExtract: "windows-after-extract.mjs", afterPack: "after-pack.mjs",
  afterSign: "windows-hide-package-manifest.mjs", afterAllArtifactBuild: "offline-update-metadata.mjs",
}).map(([name, file]) => [name, fileURLToPath(new URL(file, import.meta.url))])));

/** Read authenticated JSON before builder can discover or execute a config.
 * Every executable hook comes from the static sealed tree, never run data. */
export async function readWindowsSigningBuilderConfig(file, expected, { projectDir, env, files } = {}) {
  const reject = () => { throw Error("WINDOWS_SIGNING_BUILDER_CONFIG_REJECTED"); };
  if (!path.isAbsolute(file ?? "") || path.extname(file) !== ".json" || !/^[a-f0-9]{64}$/.test(expected ?? "")) reject();
  const { peSha256, readWindowsPeSnapshot } = await import("./windows-pe-signing.mjs");
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) reject();
  const config = JSON.parse(bytes);
  if (!config || Array.isArray(config) || config.extends !== null || config.publish !== null || config.npmRebuild !== false
    || config.nodeGypRebuild !== false || config.buildDependenciesFromSource !== false || !Array.isArray(files) || !files.some(row => row.path === callback)
    || ["beforeBuild", "appxManifestCreated", "msiProjectCreated", "artifactBuildStarted", "artifactBuildCompleted", "onNodeModuleFile"].some(key => config[key] != null)) reject();
  for (const [name, target] of Object.entries(WINDOWS_BUILDER_HOOKS)) {
    if (config[name] !== target || !files.some(row => row.path === target)) reject();
  }
  return validateWindowsSigningConfig(config, { projectDir, env });
}

/** Validate the RESOLVED config, including extends and CLI options, before any
 * WinPackager is constructed. Hostile overrides are errors, never repaired. */
export function validateWindowsSigningConfig(config, { projectDir = process.cwd(), env = process.env } = {}) {
  const win = config?.win, tool = win?.signtoolOptions;
  if (!win || Object.hasOwn(win, "azureSignOptions") || !tool || typeof tool.sign !== "string"
    || path.resolve(projectDir, tool.sign) !== callback || tool.publisherName !== WINDOWS_BROWSER_PUBLISHER
    || JSON.stringify(tool.signingHashAlgorithms) !== '["sha256"]'
    || Object.keys(tool).some(key => !["sign", "publisherName", "signingHashAlgorithms"].includes(key))
    || [config, win].some(scope => ["cscLink", "cscKeyPassword", "certificateFile", "certificatePassword", "certificateSubjectName", "certificateSha1"].some(key => Object.hasOwn(scope, key)))
    || Object.hasOwn(win, "signExts")
    || ["script", "customNsisBinary", "customNsisResources"].some(key => config.nsis?.[key] != null)
    || win.signExecutable === false || win.signAndEditExecutable === false || config.forceCodeSigning !== true
    || win.verifyUpdateCodeSignature === false || env.CSC_IDENTITY_AUTO_DISCOVERY !== "false"
    || Object.entries(env).some(([key, value]) => forbiddenEnvironment.test(key) && key !== "CSC_IDENTITY_AUTO_DISCOVERY" && value)) {
    throw Error("WINDOWS_SIGNING_EFFECTIVE_CONFIG_REJECTED");
  }
  return config;
}

export function takeWindowsSigningCredentials(env = process.env) {
  const credentials = {};
  for (const key of Object.keys(env)) {
    if (/^AZURE_/i.test(key)) { credentials[key] = env[key]; delete env[key]; }
  }
  // Unknown Azure settings must never alter credential discovery in the child.
  if (Object.keys(credentials).some(key => !["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].includes(key))
    || ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].some(key => !credentials[key])) {
    throw Error("WINDOWS_SIGNING_CREDENTIALS_REQUIRED");
  }
  return Object.freeze(credentials);
}

export function credentialFreeWindowsEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^AZURE_|^INPUT_|TOKEN|PASSWORD|SECRET|CREDENTIAL|CSC_/i.test(key)));
}
