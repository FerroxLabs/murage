// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundles server/drivers/codex-hook.ts the way scripts/bundle-server.mjs ships it in the packaged server, for the packaged hook
// proofs (prove-codex-hook-packaged-mac.mjs). A bare `esbuild --format=esm` bundle cannot load: codex-hook.ts imports the Windows
// hide installer (win-hide-child-process.cjs, which calls require and reads __filename) and murage-exec.ts (which reads its shell
// wrapper beside the bundle at load). So the same three things the server bundle has: the createRequire banner, the external
// relocated installer, and the murage-exec runtime siblings.
import { build } from "esbuild";
import { chmodSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { windowsHideImport } from "../shared/win-hide-child-process.mjs";
import { windowsHideBundlePlugin } from "./windows-hide-bundle-plugin.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
// the same banner bundle-server.mjs gives the server bundle (bundled CommonJS still requires Node built-ins)
export const CODEX_HOOK_BANNER = windowsHideImport + 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);';
// bundle-server.mjs RUNTIME_SIBLINGS for drivers/murage-exec.ts
const SIBLINGS = [{ file: "murage-exec", mode: 0o755 }, { file: "murage-exec.shapes", mode: 0o644 }];

/** Writes the bundle to `outfile` (its folder also receives shared/ and the murage-exec siblings) and returns `outfile`. */
export async function bundleCodexHook(outfile) {
  await build({
    entryPoints: [join(repo, "server/drivers/codex-hook.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile,
    banner: { js: CODEX_HOOK_BANNER },
    logLevel: "error",
    plugins: [windowsHideBundlePlugin()],
  });
  for (const { file, mode } of SIBLINGS) {
    const target = join(dirname(outfile), file);
    copyFileSync(join(repo, "server/drivers", file), target);
    chmodSync(target, mode);
  }
  return outfile;
}

/** The proof's new-shape verdict for a hook run with no stdin: a block. Every block writes "Murage blocked this call" to stderr;
 *  a tool call is then denied by exit 2 or by a deny JSON on stdout with exit 0 (Codex honours a printed deny only on exit 0). The
 *  deny's own reason is the fixed frame from hook-control.ts (H1a), so the stdout reason is not matched. */
export const HOOK_BLOCK_LINE = "Murage blocked this call";
export const blockedWithoutInput = ({ code, stdout, stderr }) =>
  stderr.includes(HOOK_BLOCK_LINE) && (code === 2 || (code === 0 && stdout.includes('"permissionDecision":"deny"')));
