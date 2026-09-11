import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "murage-recovery-window-"));
try {
  const result = await promisify(execFile)(electron, [fileURLToPath(new URL("./smoke-desktop-recovery.mjs", import.meta.url))], {
    env: { ...process.env, MURAGE_RECOVERY_SMOKE_DIR: scratch },
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  process.stdout.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  process.exitCode = 1;
} finally {
  // execFile settles only after this exact child closes. Never rely on
  // Electron app.exit() to emit the normal quit cleanup event.
  safeWipeSync(scratch);
}
