import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eEnvironment } from "../../scripts/e2e-environment.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const mode = process.argv[2];
if (mode !== "harness" && mode !== "ui") throw new Error("fixture mode must be harness or ui");
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir) throw new Error("MURAGE_DATA_DIR is required for the human fixture");
const env = e2eEnvironment(process.env, resolve(dataDir));
mkdirSync(env.HOME, { recursive: true });
const args = mode === "harness"
  ? ["--experimental-strip-types", join(root, "scripts/dev-server.mjs")]
  : [join(root, "node_modules/vite/bin/vite.js"), "--strictPort"];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 0); });
