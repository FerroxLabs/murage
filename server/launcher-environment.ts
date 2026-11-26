// SPDX-License-Identifier: AGPL-3.0-or-later

/** Keep turn settings, loader options and credentials out of a launcher until its gate releases. */
export function launcherEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["SystemRoot", "SYSTEMDRIVE", "TEMP", "TMP"]) if (typeof base[key] === "string") env[key] = base[key];
  return env;
}
