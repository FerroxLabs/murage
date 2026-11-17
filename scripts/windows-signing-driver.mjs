// Driver, provider and producer registrations owner: win-sac-sign; sealed runner and trusted launch configuration owner: MAIN.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyWindowsSigningLaunch } from "./windows-signing-launch.mjs";

/** Invoked only by the verified absolute node in the launch contract. Capture
 * and erase credentials before importing builder, hooks or third-party code. */
export async function runWindowsSigningDriver({ env = process.env } = {}) {
  const credentials = {};
  for (const key of Object.keys(env)) if (/^AZURE_/i.test(key)) { credentials[key] = env[key]; delete env[key]; }
  const credentialKeys = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
  if (Object.keys(credentials).length !== 3 || credentialKeys.some(key => !credentials[key])) throw Error("WINDOWS_SIGNING_CREDENTIALS_REQUIRED");
  const launchContract = { file: env.MURAGE_WINDOWS_SIGNING_LAUNCH, sha256: env.MURAGE_WINDOWS_SIGNING_LAUNCH_SHA256 };
  const launch = await verifyWindowsSigningLaunch(launchContract.file, launchContract.sha256);
  if (launch.schema !== 2) throw Error("WINDOWS_SIGNING_RUN_AUTHORIZATION_REQUIRED");
  if (path.resolve(process.execPath) !== path.resolve(launch.node) || path.resolve(fileURLToPath(import.meta.url)) !== path.resolve(launch.driver)) {
    throw Error("WINDOWS_SIGNING_DRIVER_EXECUTABLE_MISMATCH");
  }
  const settings = launch.driverSettings;
  if (!settings || !path.isAbsolute(settings.projectDir ?? "") || !path.isAbsolute(settings.configFile ?? "")
    || !path.isAbsolute(settings.producerModule ?? "") || !launch.files.some(file => file.path === settings.producerModule)
    || !launch.runAuthorization.files.some(file => path.join(launch.runRoot, ...file.path.split("/")) === settings.configFile) || !settings.environment
    || Object.entries(settings.environment).some(([key, value]) => !/^MURAGE_[A-Z0-9_]+$/.test(key) || /SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(key) || typeof value !== "string")) {
    throw Error("WINDOWS_SIGNING_DRIVER_CONFIG_REQUIRED");
  }
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, launch.environment, settings.environment, { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  // The CLI uses the real process environment. No ambient preload/discovery or
  // Azure credentials survive into any dynamic module or ordinary descendant.
  const { validateWindowsSigningConfig, readWindowsSigningBuilderConfig, WINDOWS_SIGNER_CONFIG } = await import("./windows-signing-config.mjs");
  const configPin = launch.runAuthorization.files.find(row => path.join(launch.runRoot, ...row.path.split("/")) === settings.configFile);
  const config = await readWindowsSigningBuilderConfig(settings.configFile, configPin.sha256, { projectDir: settings.projectDir, env, files: launch.files });
  const { azureWindowsPeSigner } = await import("./windows-azure-signer.mjs");
  const { windowsSigningTrust } = await import("./windows-signing-trust.mjs");
  const { beginWindowsSigningSession } = await import("./windows-signing-session.mjs");
  const { readWindowsBuildPlan, windowsStageReceiptConsumer } = await import("./windows-stage-receipts.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url), fromBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const fromLibrary = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
  const { verifyWindowsBuilderDispatch } = await import("./windows-builder-contract.mjs");
  verifyWindowsBuilderDispatch(fromLibrary);
  const identity = { target: "win32-x64", sourceRevision: env.MURAGE_BUILD_COMMIT,
    version: fromLibrary(path.join(settings.projectDir, "package.json")).version, runId: settings.runId, runAttempt: settings.runAttempt };
  const plan = await readWindowsBuildPlan(env.MURAGE_WINDOWS_BUILD_PLAN, env.MURAGE_WINDOWS_BUILD_PLAN_SHA256, identity);
  const { windowsSigningDriverReceipt } = await import("./windows-signing-receipt.mjs");
  const graph = await windowsSigningDriverReceipt(launch, launchContract.sha256, plan);
  const producerModule = await import(pathToFileURL(settings.producerModule).href);
  const prepared = producerModule.windowsPreparedProducerFiles(plan, launch.runRoot, launch.runAuthorization.files);
  const producers = await producerModule.registerWindowsBuildProducers(plan, { directory: env.MURAGE_WINDOWS_BUILD_RECEIPTS, toolFiles: launch.files, prepared, session: graph });
  const receipts = windowsStageReceiptConsumer(plan, producers, graph);
  const sign = azureWindowsPeSigner(WINDOWS_SIGNER_CONFIG, { env: { ...env, ...credentials }, launchContract });
  const trust = await windowsSigningTrust(launch);
  const session = { sign, receipts, trust, graph };
  const end = beginWindowsSigningSession(session);
  let restoreAdapters;
  try {
    // Validation precedes even the WinPackager constructor; recheck the actual
    // effective config at the factory boundary after builder's own resolution.
    const { Packager, Platform, build } = fromLibrary("./out/index.js");
    const { WinPackager } = fromLibrary("./out/winPackager.js");
    const options = { projectDir: settings.projectDir, config: settings.configFile, publish: "never", targets: Platform.WINDOWS.createTarget(["nsis", "zip"]),
      platformPackagerFactory(info, platform) {
        if (platform !== Platform.WINDOWS) throw Error("WINDOWS_SIGNING_TARGET_REJECTED");
        if (session.gepa) {
          info.config.extraMetadata = config.extraMetadata;
          info.config.win.extraResources = config.win.extraResources;
          Object.assign(info.metadata, config.extraMetadata);
        }
        validateWindowsSigningConfig(info.config, { projectDir: settings.projectDir, env });
        return new WinPackager(info);
      } };
    if (config.extraMetadata?.murageGepaManifests) {
      const { windowsBuildAdapters } = await import("./windows-build-adapters.mjs");
      session.adapters = await windowsBuildAdapters(launch, plan, producers, receipts, graph, trust, sign, { launchContract });
      restoreAdapters = session.adapters.install(fromLibrary);
      const { default: signWindowsGepa } = await import("./windows-gepa-signing.mjs");
      const gepa = await signWindowsGepa({ electronPlatformName: "win32", arch: "x64", outDir: path.resolve(settings.projectDir, config.directories?.output ?? "dist"),
        packager: { config, projectDir: settings.projectDir, platformSpecificBuildOptions: config.win } });
      session.gepa = config.extraMetadata.murageWindowsPeGepa;
      session.metadata = config.extraMetadata;
      await graph.freeze("gepa", async () => {
        const { verifyFrozenWindowsPe } = await import("./windows-pe-signing.mjs");
        for (const source of gepa.sources) await verifyFrozenWindowsPe(path.join(gepa.directory, source.path.slice("resources/gepa-worker/".length)), source,
          gepa.records.find(row => row.path === source.path), trust);
        return Object.fromEntries(gepa.records.map(row => [row.path, row.finalSha256]));
      });
    }
    const artifacts = await graph.package("app", async () => {
      await session.adapters?.prepareTransientResources();
      return build(options, new Packager(options));
    });
    receipts.assertComplete();
    if (session.adapters) {
      const { finalizeWindowsBuild } = await import("./windows-build-finalize.mjs");
      await finalizeWindowsBuild({ session, artifacts, launch, receiptFile: env.MURAGE_WINDOWS_DRIVER_RECEIPT });
    }
    graph.assertComplete();
  } finally {
    restoreAdapters?.();
    end(); for (const key of credentialKeys) delete credentials[key];
    await verifyWindowsSigningLaunch(launchContract.file, launchContract.sha256);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runWindowsSigningDriver(); }
  catch { process.stderr.write("WINDOWS_SIGNING_DRIVER_FAILED\n"); process.exitCode = 1; }
}
