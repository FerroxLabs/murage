// SPDX-License-Identifier: AGPL-3.0-or-later
// J5b rig parent for murage-home.service: a root process that applies the BUILT homeChildExit (server/cloud-home/supervisor.ts): a child exit of 75
// restarts the child only; any other exit (a SIGKILL included) ends this unit, so systemd restarts murage-home and murage-control stops with it (F-10).
// Run: node home-harness-supervisor.mjs <path to the built supervisor.js> <path to home-events-harness.mjs>
import { spawn } from "node:child_process";
const [, , supervisorModule, harness] = process.argv;
const { homeChildExit } = await import(supervisorModule);
function launch() {
  const child = spawn(process.execPath, [harness], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    const verdict = homeChildExit(code ?? 1, signal);
    if (verdict && verdict.restart === true) launch(); else process.exit(code ?? 1);
  });
}
launch();
