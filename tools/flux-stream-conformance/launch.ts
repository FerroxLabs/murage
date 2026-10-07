// Builds the suite into dist/flux-stream-conformance/ and runs it, forwarding
// the arguments and the exit code. Behind the package scripts:
//   pnpm flux-stream:conformance -- <run.mjs flags>
//   pnpm flux-stream:owner-replay -- <bake-off run dir> <recording dir>
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { buildSuite } from "./build.ts";

const [which, ...rest] = process.argv.slice(2);
if (which !== "run" && which !== "owner-replay") {
  process.stderr.write("usage: launch.ts run|owner-replay [args]\n");
  process.exit(2);
}
const { outDir } = await buildSuite();
// pnpm forwards the `--` that separates its own flags from the script's
const args = rest[0] === "--" ? rest.slice(1) : rest;
const result = spawnSync(process.execPath, [join(outDir, `${which}.mjs`), ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
