// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Overloaded-machine mode (SCALE-PLAN section 5): <loops> processes that each keep a core
// busy, plus a balloon that holds <gb> GB of touched memory so the page cache and the
// server compete for what is left of the container's memory limit. Container use only.
//   node load.mjs <loops> <gb> <pidfile>     (stops when the parent rig kills the pids)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [loops = "4", gb = "0", pidFile = "/tmp/scale-load.pids"] = process.argv.slice(2);
const pids = [];
for (let i = 0; i < Number(loops); i++) {
  const child = spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore", detached: false });
  pids.push(child.pid);
}
if (Number(gb) > 0) {
  const child = spawn(process.execPath, ["--max-old-space-size=256", "-e", `
    const held = []; const chunk = 256 * 1024 * 1024;
    for (let n = 0; n < Math.round(${Number(gb)} * 4); n++) { const b = Buffer.allocUnsafe(chunk); b.fill(n & 255); held.push(b); }
    // touch a page of every MB now and then, so the balloon stays resident
    setInterval(() => { for (const b of held) for (let i = 0; i < b.length; i += 1 << 20) b[i]++; }, 5000);
  `], { stdio: "ignore", detached: false });
  pids.push(child.pid);
}
writeFileSync(pidFile, pids.join("\n"));
console.log(`LOAD loops=${loops} balloonGb=${gb} pids=${pids.join(",")}`);
setInterval(() => {}, 1 << 30);
