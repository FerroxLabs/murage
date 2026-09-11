// Where a human spec, its Playwright config and its evidence are allowed to
// live: MURAGE_E2E_DATA_DIR, explicitly, or nothing runs.
//
// There is deliberately no fallback. Every human rig wipes its data dir at
// module load or before the harness binds, and a fallback is exactly the path
// that resolves somewhere nobody chose when the variable is unset or inherited
// (2026-09-11 21:05: the developer's live ~/.murage lost its contents while
// eight lanes ran specs on this machine). The value must also pass the
// safe-wipe admission rules — under the OS temp dir or with a *scratch*,
// *evidence* or *.e2e* segment, never a home or a Murage data directory — so
// a wrong value fails here, before anything is created or deleted.
import { resolve } from "node:path";

import { assertSafeToWipe } from "../../server/testing/safe-wipe.mjs";

/** The lane's scratch data dir. Throws without MURAGE_E2E_DATA_DIR. */
export function laneDataDir(purpose = "human specs never use ~/.murage"): string {
  const raw = process.env.MURAGE_E2E_DATA_DIR;
  if (!raw) {
    throw new Error(
      `MURAGE_E2E_DATA_DIR is required — ${purpose}. Point it at a lane scratch directory `
      + "(for example <lanes>/.e2e/<LANE> or $TMPDIR/murage-e2e); it is wiped, so it must be under the OS temp dir "
      + "or carry a *scratch*, *evidence* or *.e2e* path segment, and it can never be a Murage data directory.",
    );
  }
  // Admission only: the previous run's harness may still hold this directory
  // (reuseExistingServer), which is the wipe's problem, not the config's.
  return assertSafeToWipe(resolve(raw), { checkLeases: false }).path;
}
