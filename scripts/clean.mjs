import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeWipe } from "../server/testing/safe-wipe.mjs";

// Generated outputs live inside the repository; `within` admits only paths
// strictly under it, and a data directory is refused before that.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "electron/resources/speech-helper",
  "electron/resources/Murage Speech.app",
];

await Promise.all(
  generatedPaths.map((path) => safeWipe(join(root, path), { within: root })),
);
