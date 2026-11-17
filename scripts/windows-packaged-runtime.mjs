// Packaged smoke producer owner: win-sac-sign; final Windows/SAC proof consumer owner: MAIN.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { windowsBuilderSigning } from "./windows-builder-signing.mjs";
import { verifyWindowsPeRecords } from "./windows-sac-inventory.mjs";
import { loadEngineExclusionResource } from "./engine-exclusion-resource.mjs";
import { proveAnchoredReadResource } from "./anchored-read-resource.mjs";
import { ADDON_VERSION as ENGINE_EXCLUSION_ADDON_VERSION } from "../server/engine-exclusion.ts";
import { nativeAuthenticodeIn, verifyWindowsBrowserSignatures } from "../server/browser-windows-identity.ts";

/** Called after builder's final signing boundary. No package code is trusted
 * to establish its own provenance, including the packaged signature checker. */
export async function smokeWindowsPackagedRuntime(context) {
  const state = await windowsBuilderSigning(context);
  await verifyWindowsPeRecords(state.appOutDir, state.sources, state.records, state.trust);
  const resources = path.join(state.appOutDir, "resources");
  const electron = path.join(state.appOutDir, `${context.packager.appInfo?.productFilename ?? "Murage"}.exe`);
  const arch = state.target.slice("win32-".length);
  const exclusion = path.join(resources, "engine-exclusion.node");
  console.log(`signed engine-exclusion addon: ${loadEngineExclusionResource(exclusion, "win32", arch, ENGINE_EXCLUSION_ADDON_VERSION,
    (command, args, env) => execFileSync(command, args, { timeout: 240000, env: { ...process.env, ...env } }), electron)}`);
  console.log(proveAnchoredReadResource(path.join(resources, "anchored-read.node"), electron));
  const packagedNative = nativeAuthenticodeIn(resources);
  if (!packagedNative) throw Error("Packaged Windows signature check needs the engine-exclusion addon (version " + ENGINE_EXCLUSION_ADDON_VERSION + ")");
  const native = { ...packagedNative, verifySigned: state.trust.verifySigned, async authenticode(file) {
    const observed = await packagedNative.authenticode(file), approved = await state.trust.authenticode(file);
    if (["status", "publisher", "embedded", "timestamp"].some(key => observed[key] !== approved[key])) throw Error("WINDOWS_SIGNING_CHECKERS_DISAGREE");
    return approved;
  } };
  await verifyWindowsPeRecords(state.appOutDir, state.sources, state.records, native);
  const executables = state.records.filter(record => record.disposition === "signed").map(record => path.join(state.appOutDir, record.path));
  await verifyWindowsBrowserSignatures(executables, process.env.SystemRoot, native);
  return native;
}
