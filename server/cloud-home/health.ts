import { cloudHomeCopy } from "./copy.ts";
import { readFileSync } from "node:fs";
import { uiHealth, type UiState } from "./ui-canary.ts";

export const CLOUD_HOME_PROTOCOL = 1;
export function cloudHealthVersion(): { serverVersion: string; protocol: number; role?: "home" } {
  // tsconfig.server emits index.js one level below the packaged root too.
  let raw: string;
  try { raw = readFileSync(new URL("../package.json", import.meta.url), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8"); }
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)) throw new Error(cloudHomeCopy.cloudServerVersionIsUnavailable);
  return { serverVersion: pkg.version, protocol: CLOUD_HOME_PROTOCOL, ...(process.env.MURAGE_CLOUD_ROLE === "home" ? { role: "home" as const } : {}) };
}

/** What an unsigned visitor to a Cloud home may learn: exactly app, door, ui, uiAt and instance; never version, protocol or role.
 *  door names the entry protocol this build speaks; it discloses nothing the /enter page does not. */
export function publicHealthBody(): { app: "murage"; door: "v2"; ownerFactor: 1; ui?: UiState; uiAt?: number | null; instance?: string } {
  return { app: "murage", door: "v2", ownerFactor: 1, ...uiHealth() };
}
