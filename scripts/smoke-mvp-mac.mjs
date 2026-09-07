// Explicit private preview artifact; never uses the installed user's profile.
import { _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir, userInfo } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const executablePath = resolve(process.argv[2] ?? "");
if (!/\/release-(?:mvp|private)-/.test(executablePath) || !executablePath.endsWith("/Murage.app/Contents/MacOS/Murage")) throw new Error("Explicit private preview executable required");
const scratch = mkdtempSync(join(tmpdir(), "murage-native-mvp-"));
const loginIdentity = userInfo();
const data = join(scratch, "data"), userData = join(scratch, "user-data");
mkdirSync(data); mkdirSync(userData);
writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {}, profile: { name: "MVP isolated proof" } }));
let app;
let ownedPids = [];
let nativeProcess;
try {
  app = await electron.launch({ executablePath, args: ["--user-data-dir=" + userData], timeout: 30000,
    // macOS Keychain depends on the real login home. Isolate application data,
    // not the OS identity; a fake HOME can provoke "Keychain Not Found".
    env: { PATH: process.env.PATH, HOME: homedir(), USER: loginIdentity.username,
      LOGNAME: loginIdentity.username, SHELL: loginIdentity.shell,
      MURAGE_DATA_DIR: data, MURAGE_NO_DEV_DESKTOP_SECRET: "1" } });
  nativeProcess = app.process();
  ownedPids = [nativeProcess.pid];
  const actual = await app.evaluate(({ app }) => ({ userData: app.getPath("userData"), home: app.getPath("home"), logs: app.getPath("logs"), version: app.getVersion() }));
  assert.equal(realpathSync(actual.userData), realpathSync(userData));
  assert.equal(realpathSync(actual.home), realpathSync(homedir()));
  const window = await app.firstWindow({ timeout: 30000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => document.body.innerText.includes("MVP isolated proof"), undefined, { timeout: 30000 });
  console.log(JSON.stringify({ nativeWindow: true, isolatedProfile: true, version: actual.version, userProfileRendered: true }));
  const processRows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  ownedPids = [nativeProcess.pid];
  for (let i = 0; i < ownedPids.length; i++) for (const [pid, parent] of processRows) if (parent === ownedPids[i] && !ownedPids.includes(pid)) ownedPids.push(pid);
  let timer;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native quit exceeded 20 seconds")), 20000); })]);
    assert.equal(nativeProcess.exitCode, 0);
    // Electron's close event precedes OS reaping of helper processes.
    const stillPresent = () => ownedPids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const reapDeadline = Date.now() + 3000;
    let liveOwned = stillPresent();
    while (liveOwned.length && Date.now() < reapDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      liveOwned = stillPresent();
    }
    assert.deepEqual(liveOwned, []);
    console.log(JSON.stringify({ nativeQuit: true, exitCode: nativeProcess.exitCode, ownedProcessesGone: true }));
  } finally { clearTimeout(timer); }
} finally {
  for (const pid of [...ownedPids].reverse()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
}
