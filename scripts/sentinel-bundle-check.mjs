// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Sentinel packaging guard (1.0.9, GAP-SENTINEL-109 sections 3.1 and 11 lane C). scripts/bundle-server.mjs bundles
// server/sentinel/cli.ts to dist-server/sentinel/cli.js and server/health/host-boundary.ts to
// dist-server/health/host-boundary.js, then hands esbuild's metafile here; any problem fails the build.
//
//  - The scanner bundle may inline only the scanner, the shared health contract and node built-ins: never server
//    startup, the live database opener, a driver, credential-bearing config, memory, the producers, or any package
//    from node_modules, and it imports no network module.
//  - The host boundary may inline the producers, but never server startup, the database opener, drivers, memory or
//    config, and no network module either.
//  - Neither bundle may read a file from beside itself at run time that the package would not ship: the scanner entry
//    is copied out of the app (to a versioned file in the Sentinel output root), so it has to be self-contained.

export const SENTINEL_CLI_OUTPUT = "dist-server/sentinel/cli.js";
export const HOST_BOUNDARY_OUTPUT = "dist-server/health/host-boundary.js";

const NETWORK_IMPORTS = [/^(node:)?https?$/, /^(node:)?net$/, /^(node:)?tls$/, /^(node:)?dgram$/, /^(node:)?http2$/, /^(node:)?dns$/, /^undici/, /^ws$/];
const SERVER_STARTUP = [/^server\/index\.ts$/, /^server\/database\.ts$/, /^server\/drivers\//, /^server\/config/, /^server\/memory\//];
const RULES = Object.freeze({
  [SENTINEL_CLI_OUTPUT]: {
    forbiddenInputs: [...SERVER_STARTUP, /^server\/health\//, /(^|\/)node_modules\//],
    allowedInputs: [/^server\/sentinel\//, /^shared\/health-protocol\.mjs$/],
  },
  [HOST_BOUNDARY_OUTPUT]: {
    forbiddenInputs: SERVER_STARTUP,
    allowedInputs: null,
  },
});

const normalize = value => String(value).split("\\").join("/");

/** Finds a metafile output by its repository-relative path (esbuild keys them relative to the working directory). */
function findOutput(metafile, wanted) {
  for (const [key, meta] of Object.entries(metafile?.outputs ?? {})) {
    const path = normalize(key);
    if (path === wanted || path.endsWith(`/${wanted}`)) return meta;
  }
  return null;
}

/** Problems with the two Sentinel bundles in an esbuild metafile (empty when both are acceptable). */
export function sentinelBundleProblems(metafile) {
  const problems = [];
  for (const [output, rule] of Object.entries(RULES)) {
    const meta = findOutput(metafile, output);
    if (!meta) { problems.push(`${output}: missing from the build`); continue; }
    for (const raw of Object.keys(meta.inputs ?? {})) {
      const input = normalize(raw).replace(/^(\.\.\/)+/, "");
      if (rule.forbiddenInputs.some(pattern => pattern.test(input))) problems.push(`${output}: inlines forbidden ${input}`);
      else if (rule.allowedInputs && !rule.allowedInputs.some(pattern => pattern.test(input))) problems.push(`${output}: inlines unexpected ${input}`);
    }
    for (const entry of meta.imports ?? []) {
      if (!entry.external) continue;
      const spec = normalize(entry.path);
      if (NETWORK_IMPORTS.some(pattern => pattern.test(spec))) problems.push(`${output}: imports network module ${spec}`);
      else if (!/^node:/.test(spec) && output === SENTINEL_CLI_OUTPUT) problems.push(`${output}: imports non-built-in ${spec}`);
    }
  }
  return problems;
}

/** Throws with every problem listed (the bundle script's gate). */
export function assertSentinelBundles(metafile) {
  const problems = sentinelBundleProblems(metafile);
  if (problems.length) throw new Error(`bundle-server: Sentinel bundles are not self-contained:\n${problems.join("\n")}`);
}
