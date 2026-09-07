// A dependency of the `mobile` project, not a test of anything.
//
// `dist/` is a build artefact that survives across branches and can easily
// predate the change under test — "run it if dist/ exists" would happily
// exercise a bundle from last week. Wave 2's mobile pass starts the companion
// sidecar, which serves the *built* UI rather than Vite's dev server, so the
// bundle has to be rebuilt from the working tree before that project runs.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { test } from "@playwright/test";
import { REPO_ROOT, SCRATCH_DATA_DIR } from "./rig";
import { e2eEnvironment } from "../../scripts/e2e-environment.mjs";

test("vite build", () => {
  test.setTimeout(300_000);
  execFileSync(process.execPath, [join(REPO_ROOT, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: REPO_ROOT,
    env: e2eEnvironment(process.env, SCRATCH_DATA_DIR),
    stdio: "inherit",
  });
});
