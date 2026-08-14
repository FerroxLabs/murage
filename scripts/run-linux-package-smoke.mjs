import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixName = "omb-linux-smoke-runtime-";
for (const lane of ["x11", "wayland"]) {
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
        ...(lane === "wayland" ? { OMB_SMOKE_WAYLAND: "1" } : {}),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[run-linux-package-smoke] ${lane} runtime kept at ${runtimeDirectory}`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
