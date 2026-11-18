// Exercise only the documented isolated fake-engine verification launcher.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
const output = process.argv[2];
if (!output) throw Error("usage: node fixture-smoke.mjs <evidence-dir>");
mkdirSync(output, { recursive: true });
const launcher = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-murage.ts", "launch"], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "", info;
launcher.stderr.on("data", chunk => { stderr += chunk; });
try {
  info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("fixture startup deadline")), 180_000);
    launcher.stdout.on("data", chunk => {
      stdout += chunk;
      try { const value = JSON.parse(stdout); if (value.ok && value.url && value.dataDir) { clearTimeout(timer); resolve(value); } } catch { /* incomplete JSON */ }
    });
    launcher.once("exit", code => { clearTimeout(timer); reject(Error(`fixture exited: ${code}`)); });
    launcher.once("error", error => { clearTimeout(timer); reject(error); });
  });
  writeFileSync(join(output, "launch.json"), JSON.stringify(info, null, 2) + "\n");
  const doctor = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-murage.ts", "doctor", "--url", info.url], { env: { ...process.env, MURAGE_DATA_DIR: info.dataDir }, stdio: ["ignore", "pipe", "pipe"] });
  let result = "", diagnostics = "";
  doctor.stdout.on("data", chunk => { result += chunk; });
  doctor.stderr.on("data", chunk => { diagnostics += chunk; });
  const [code] = await once(doctor, "close");
  writeFileSync(join(output, "doctor.json"), result);
  writeFileSync(join(output, "doctor.stderr.log"), diagnostics);
  if (code !== 0 || JSON.parse(result).ok !== true) throw Error("isolated fixture doctor failed");
} finally {
  const ended = once(launcher, "close");
  if (launcher.exitCode === null && launcher.signalCode === null) { launcher.kill("SIGINT"); await ended; }
  if (info?.logPath && existsSync(info.logPath)) copyFileSync(info.logPath, join(output, "server.log"));
  writeFileSync(join(output, "launcher.stderr.log"), stderr);
  if (info && existsSync(info.dataDir)) throw Error("fixture data directory was not cleaned");
}
process.stdout.write("isolated fake-engine fixture doctor PASS; owned child and data cleaned\n");
