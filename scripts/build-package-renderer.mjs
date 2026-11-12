// The complete TypeScript projects are required by CI on Ubuntu/Windows (16 GB).
// Mac runners have 7 GB: package the same renderer without a duplicate typecheck.
import { spawnSync } from "node:child_process";
const args = process.platform === "darwin" ? ["exec", "vite", "build"] : ["build"];
const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
  stdio: "inherit", shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
