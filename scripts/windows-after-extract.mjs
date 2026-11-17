// Signing producer owner: win-sac-sign; trusted CI receipt owner: MAIN.
import signWindowsGepa from "./windows-gepa-signing.mjs";
import { windowsBuilderSigning } from "./windows-builder-signing.mjs";
export default async function afterExtract(context) {
  if (context.electronPlatformName !== "win32") return;
  await signWindowsGepa(context);
  await windowsBuilderSigning(context);
}
