// Pauses the OS jobs that start the Murage executable on a timer, for the
// moments an update replaces it (fablehunt-1020q item 9).
//
// macOS: the closed-app backup LaunchAgent com.murage.backup.<id>
// (electron/backup-closed-jobs.mjs) execs Contents/MacOS/Murage every 60 s.
// If launchd starts it while ShipIt is swapping the bundle, Gatekeeper can
// say "Murage is damaged". The job is booted out of launchd just before
// quitAndInstall; its plist stays on disk, so the next sign-in loads it again
// even if nothing else runs. The Sentinel agent is not touched here: since
// 1.0.20 every start retires it (sentinel-schedule.mjs suspendMac).
//
// Windows: the Sentinel task \FerroxLabs\Murage\Sentinel\<id> runs Murage.exe
// every 2 minutes, which the silent NSIS update must replace. It is disabled
// and its running instance ended just before quitAndInstall.
//
// The paused jobs are written to a marker file first. resume() puts back
// exactly what the marker names: on an install that stalls, fails or is
// called off, and at the next start, whichever version that is. No prompt:
// both are the user's own jobs, changed with their own commands.
import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const BACKUP_PLIST = /^(com\.murage\.backup\.[a-f0-9]{64})\.plist$/;
const SENTINEL_TASK = /^\\FerroxLabs\\Murage\\Sentinel\\[0-9a-f]{16,64}$/;
const MARKER_LIMIT = 65536;

function defaultRun(file, args) {
  try {
    execFileSync(file, [...args], withHideInherit({ stdio: "ignore", timeout: 10_000, windowsHide: true }));
    return 0;
  } catch (error) {
    return Number.isInteger(error?.status) ? error.status : -1;
  }
}

function ownedFile(file, uid) {
  const stat = lstatSync(file);
  return stat.isFile() && (uid === undefined || stat.uid === uid) && !(stat.mode & 0o022);
}

export function createUpdateLaunchPause({
  platform = process.platform, uid = process.getuid?.(), home, markerPath,
  windowsTasks = () => [], env = process.env, run = defaultRun, log = () => {},
} = {}) {
  const launchctl = "/bin/launchctl";
  const schtasks = path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "schtasks.exe");
  const agents = home ? path.join(home, "Library", "LaunchAgents") : null;

  function macJobs() {
    if (!agents || !Number.isSafeInteger(uid) || uid <= 0) return [];
    let names;
    try { names = readdirSync(agents); } catch { return []; }
    const jobs = [];
    for (const name of names) {
      const match = BACKUP_PLIST.exec(name);
      if (!match) continue;
      const plist = path.join(agents, name);
      try { if (ownedFile(plist, uid)) jobs.push({ kind: "launchd", label: match[1], plist }); } catch { /* gone or unreadable: not ours to touch */ }
    }
    return jobs;
  }
  function winJobs() {
    let tasks;
    try { tasks = windowsTasks(); } catch { return []; }
    return [...new Set(Array.isArray(tasks) ? tasks : [])].filter(task => typeof task === "string" && SENTINEL_TASK.test(task)).map(task => ({ kind: "task", task }));
  }
  function readMarker() {
    try {
      const text = readFileSync(markerPath, "utf8");
      if (Buffer.byteLength(text) > MARKER_LIMIT) return [];
      // A marker written by hand for the 1.0.19 -> 1.0.20 update (RELEASE-STEP) may carry a UTF-8 BOM.
      const value = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (value?.version !== 1 || !Array.isArray(value.jobs)) return [];
      return value.jobs.filter(job =>
        (platform === "darwin" && job?.kind === "launchd" && BACKUP_PLIST.test(path.basename(job.plist ?? "")) && path.dirname(job.plist) === agents && job.label === BACKUP_PLIST.exec(path.basename(job.plist))[1])
        || (platform === "win32" && job?.kind === "task" && SENTINEL_TASK.test(job.task ?? "")));
    } catch { return []; }
  }

  /** Synchronous: it runs between the last admission check and quitAndInstall. Never throws. */
  function pause() {
    if (!markerPath) return [];
    const jobs = platform === "darwin" ? macJobs() : platform === "win32" ? winJobs() : [];
    if (!jobs.length) return [];
    const key = job => job.label ?? job.task;
    const earlier = readMarker().filter(job => !jobs.some(current => key(current) === key(job)));
    const recorded = [...earlier, ...jobs];
    // Marker first: a crash between here and resume still finds what to put back.
    try { writeFileSync(markerPath, JSON.stringify({ version: 1, jobs: recorded }), { mode: 0o600 }); }
    catch { log("update launch pause: marker not written; jobs left running"); return []; }
    const paused = [];
    for (const job of jobs) {
      if (job.kind === "launchd") {
        const code = run(launchctl, ["bootout", `gui/${uid}/${job.label}`]);
        log(`update launch pause: ${job.label} bootout ${code}`);
        if (code === 0) paused.push(job);
      } else {
        const code = run(schtasks, ["/Change", "/TN", job.task, "/DISABLE"]);
        run(schtasks, ["/End", "/TN", job.task]);
        log(`update launch pause: ${job.task} disable ${code}`);
        if (code === 0) paused.push(job);
      }
    }
    // Only a job this pause took down is put back: one that was not loaded
    // (turned off, or already down) stays as it was.
    const kept = [...earlier, ...paused];
    try {
      if (kept.length) writeFileSync(markerPath, JSON.stringify({ version: 1, jobs: kept }), { mode: 0o600 });
      else rmSync(markerPath, { force: true });
    } catch { /* the wider first record stays; resume of a job that was not loaded is refused by the OS */ }
    return paused;
  }

  /** Puts back what pause() recorded, then removes the marker. Never throws. */
  function resume() {
    if (!markerPath) return [];
    const jobs = readMarker();
    const failed = [];
    for (const job of jobs) {
      if (job.kind === "launchd") {
        // 0 loaded; 5 (EIO) / 17 / 37 already loaded. The job is due again either way.
        try { if (!ownedFile(job.plist, uid)) continue; } catch { continue; }
        const code = run(launchctl, ["bootstrap", `gui/${uid}`, job.plist]);
        if (![0, 5, 17, 37].includes(code)) failed.push(job);
        log(`update launch pause: ${job.label} bootstrap ${code}`);
      } else {
        const code = run(schtasks, ["/Change", "/TN", job.task, "/ENABLE"]);
        // A task that no longer exists (removed by its own reconcile) is done with.
        if (code !== 0 && run(schtasks, ["/Query", "/TN", job.task]) === 0) failed.push(job);
        log(`update launch pause: ${job.task} enable ${code}`);
      }
    }
    try {
      if (failed.length) writeFileSync(markerPath, JSON.stringify({ version: 1, jobs: failed }), { mode: 0o600 });
      else rmSync(markerPath, { force: true });
    } catch { /* the next start tries again */ }
    return jobs;
  }
  return Object.freeze({ pause, resume });
}
