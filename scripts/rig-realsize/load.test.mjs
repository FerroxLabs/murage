// Owner: rig-realsize lane. load.sh is the rig's CPU/IO pressure. It must stop exactly the processes one run started and
// nothing else: an earlier rig stopped the load by signalling every pid listed in a file that outlives the run, so a
// recycled pid could take down an unrelated process. These cases run the real script.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const LOAD = join(dirname(fileURLToPath(import.meta.url)), "load.sh");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return true; await new Promise((r) => setTimeout(r, 100)); } return check(); };
const exited = (child) => new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once("exit", (code) => resolve(code)));
const cleanup = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "rig-load-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
/** The way rig.mts starts it: its own process group, stdin a pipe the starter holds. */
const startLoad = (dir) => {
  const child = spawn("sh", [LOAD, join(dir, "work"), "2", "1"], { stdio: ["pipe", "pipe", "inherit"], detached: true });
  cleanup.push(() => child.stdin.destroy());
  // reached with burners still running only when load.sh itself is broken (the mutant): do not leave them behind
  cleanup.push(() => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone, as it should be */ } });
  return child;
};
const firstLine = (stream) => new Promise((resolve) => { let text = ""; stream.on("data", (chunk) => { text += chunk; if (text.includes("\n")) resolve(text.split("\n")[0]); }); stream.on("end", () => resolve(text)); });

it("closing the starter's pipe stops the whole load group, and a pid left in an old pid file is never touched", async () => {
  const dir = scratch();
  // an unrelated process whose pid sits in a stale load.pids from "an earlier run" in the same evidence folder
  const bystander = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  cleanup.push(() => bystander.kill());
  writeFileSync(join(dir, "load.pids"), `${bystander.pid}\n`);
  const load = startLoad(dir);
  expect(await firstLine(load.stdout)).toMatch(new RegExp(`^load: portable cpu=2 io=1 group=${load.pid}$`));
  expect(alive(-load.pid)).toBe(true);
  load.stdin.end();
  expect(await exited(load)).toBe(0);
  expect(await until(() => !alive(-load.pid))).toBe(true);
  expect(alive(bystander.pid)).toBe(true);
}, 40_000);

it("the load also stops when its starter is killed outright, with no chance to clean up", async () => {
  const dir = scratch();
  const starter = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const load = spawn("sh", [${JSON.stringify(LOAD)}, ${JSON.stringify(join(dir, "work"))}, "2", "1"], { stdio: ["pipe", "ignore", "inherit"], detached: true });
    console.log(load.pid); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => starter.kill("SIGKILL"));
  const group = Number(await firstLine(starter.stdout));
  cleanup.push(() => { try { process.kill(-group, "SIGTERM"); } catch { /* already gone, as it should be */ } });
  expect(group).toBeGreaterThan(1);
  expect(await until(() => alive(-group))).toBe(true);
  await new Promise((r) => setTimeout(r, 500));
  starter.kill("SIGKILL");
  expect(await until(() => !alive(-group))).toBe(true);
}, 40_000);

it("refuses to start burners when it is not the leader of its own process group", async () => {
  const dir = scratch();
  const child = spawn("sh", [LOAD, join(dir, "work"), "1", "0"], { stdio: ["pipe", "ignore", "pipe"] });
  cleanup.push(() => child.kill());
  let err = ""; child.stderr.on("data", (chunk) => { err += chunk; });
  expect(await exited(child)).toBe(2);
  expect(err).toContain("refusing to start burners");
}, 20_000);
