import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixName = "omb-linux-smoke-runtime-";
for (const lane of [
  { name: "x11", wayland: false, hardDeath: false },
  { name: "wayland", wayland: true, hardDeath: false },
  { name: "x11-hard-death", wayland: false, hardDeath: true },
]) {
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), prefixName));
  if (
    path.dirname(runtimeDirectory) !== path.resolve(tmpdir()) ||
    !path.basename(runtimeDirectory).startsWith(prefixName)
  ) {
    throw new Error(`[run-linux-package-smoke] unexpected temporary path: ${runtimeDirectory}`);
  }

  chmodSync(runtimeDirectory, 0o700);
  const result = spawnSync(
    "dbus-run-session",
    ["--", "xvfb-run", "-a", process.execPath, path.join(root, "scripts", "smoke-linux-package.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDirectory,
        OMB_SMOKE_WAYLAND: lane.wayland ? "1" : "0",
        OMB_SMOKE_HARD_DEATH: lane.hardDeath ? "1" : "0",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[run-linux-package-smoke] ${lane.name} runtime kept at ${runtimeDirectory}`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
