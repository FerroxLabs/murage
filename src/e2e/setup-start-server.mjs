// start-server.mjs, plus the one thing the first-run specs need it to carry.
//
// `e2eEnvironment` is a strict allowlist — a fixture environment, not a copy
// of a developer's shell — so a mode variable cannot simply be exported
// before Playwright runs. These specs are ABOUT an engine that cannot
// answer, so the mode has to reach the CLI, and this is the smallest way to
// say so: the shared builder still decides everything else, including HOME,
// PATH and the data dir.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eEnvironment } from "../../scripts/e2e-environment.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const mode = process.argv[2];
if (mode !== "harness" && mode !== "ui") throw new Error("fixture mode must be harness or ui");
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir) throw new Error("MURAGE_DATA_DIR is required for the first-run fixture");

const fixtureMode = process.env.MURAGE_SETUP_FIXTURE_MODE;
if (!fixtureMode) throw new Error("MURAGE_SETUP_FIXTURE_MODE is required — it says what the engine does with a turn");

const env = { ...e2eEnvironment(process.env, resolve(dataDir)), FAKE_ACP_MODE: fixtureMode };
mkdirSync(env.HOME, { recursive: true });
const args = mode === "harness"
  ? ["--experimental-strip-types", join(root, "scripts/dev-server.mjs")]
  : [join(root, "node_modules/vite/bin/vite.js"), "--strictPort"];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 0); });
