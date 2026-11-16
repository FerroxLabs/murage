// Resource-editor worker owner: win-sac-sign; sealed Node/builder trees owner: MAIN.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function editWindowsBuildResources(options) {
  if (Object.keys(process.env).some(key => /^AZURE_|^NODE_OPTIONS$/i.test(key))
    || !path.isAbsolute(options?.file ?? "") || options.requestedExecutionLevel != null && options.requestedExecutionLevel !== "asInvoker") throw Error("WINDOWS_RESOURCE_EDIT_REJECTED");
  const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const library = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
  await library("./out/util/resEdit.js").editWindowsResources(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error("WINDOWS_RESOURCE_EDIT_REJECTED");
    await editWindowsBuildResources(JSON.parse(process.argv[2]));
  } catch { process.stderr.write("WINDOWS_RESOURCE_EDIT_FAILED\n"); process.exitCode = 1; }
}
