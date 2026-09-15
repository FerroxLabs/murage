import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const helper = join(root, "dist-native", "backup-tools", "win32-x64", "murage-backup-age.exe");
const child = spawnSync(helper, ["--parent", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, windowsHide: true, env: { PATH: "" } });
console.log(JSON.stringify({ event: "elevated-parent-refusal", exit: child.status, stdoutBytes: child.stdout?.length, controlBytes: child.stderr?.length, error: child.error?.code }));
if (child.status !== 72 || child.stdout?.length || child.stderr?.length) process.exitCode = 1;
