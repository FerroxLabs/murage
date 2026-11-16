// Builder callback/adapter owner: win-sac-sign; release workflow consumer owner: MAIN.
import { dispatchWindowsBuilderSigning } from "./windows-builder-signing.mjs";
export default async function sign(configuration, packager) {
  if (configuration.hash !== "sha256" || configuration.isNest || configuration.resultOutputPath) throw Error("WINDOWS_SIGNING_CALLBACK_INVALID");
  await dispatchWindowsBuilderSigning(packager, configuration.path);
}
