import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_ROOT } from "../proxy-paths.ts";

let packageVersion: string | null | undefined;
/** The running build's version: MURAGE_APP_VERSION, else the package's. Null when neither is known,
 * and a caller that skips work on "same version as last time" then does the work. */
export function runningAppVersion(): string | null {
  const fromEnv = process.env.MURAGE_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  if (packageVersion === undefined) {
    try { const version = JSON.parse(readFileSync(join(SERVER_ROOT, "..", "package.json"), "utf8")).version; packageVersion = typeof version === "string" && version ? version : null; }
    catch { packageVersion = null; }
  }
  return packageVersion;
}
