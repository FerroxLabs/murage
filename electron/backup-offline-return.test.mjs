import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openBackupProgressWindow } from "./backup-progress-window.mjs";
import { BACKUP_QUIT_GRACE_MS, OFFLINE_BACKUP_CEILING_MS, offlineCeilingFor, createBackupReturn, quitForRelaunch, runOfflineBackup } from "./backup-offline-return.mjs";

// A fake Electron that behaves like the real one where RC5 went wrong: a
// window made with closable:false ignores close() on macOS, a "close"
// listener that calls preventDefault() cancels that window's close AND the
// app's quit, and app.relaunch() only starts a new copy once the process
// really exits. destroy() closes without a close event. (The fake in
// backup-progress-window.test.mjs ignores all of this, which is how the
// stuck window shipped.)
function fakeElectron({ platform = "darwin" } = {}) {
  const windows = new Set(), events = [];
  const closeEvent = win => { let prevented = false; for (const fn of win.listeners.close ?? []) fn({ preventDefault() { prevented = true; } }); return prevented; };
  class BrowserWindow {
    constructor(options) { this.options = options; this.closable = options.closable !== false; this.listeners = {}; this.destroyed = false; windows.add(this); this.webContents = { executeJavaScript: async () => {} }; }
    on(name, fn) { (this.listeners[name] ??= []).push(fn); }
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    close() { if (this.destroyed) return; if (!this.closable && platform === "darwin") return; if (!closeEvent(this)) this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; windows.delete(this); events.push("window-destroyed"); }
  }
  const app = {
    relaunches: 0, exitCode: null, quits: 0,
    relaunch() { this.relaunches++; events.push("relaunch-armed"); },
    quit() {
      this.quits++; if (this.exitCode !== null) return;
      for (const win of [...windows]) { if (closeEvent(win)) { events.push("quit-cancelled"); return; } win.destroy(); }
      this.exitCode = 0; events.push("exited");
    },
    exit(code) { if (this.exitCode === null) { this.exitCode = code; events.push("forced-exit"); } },
  };
  // Murage is open again when the process ended with exactly one relaunch armed.
  const reopened = () => app.exitCode === 0 && app.relaunches === 1;
  return { BrowserWindow, app, events, windows, reopened };
}
function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; pending.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    fire: ms => { for (const timer of pending.filter(t => t.ms === ms && !t.cleared)) { timer.cleared = true; timer.fn(); } },
    pending,
  };
}
// The desktop wiring of main.mjs, with the fake Electron behind it.
function desktop({ platform, cleanupFails = 0, abandonFails = false } = {}) {
  const electron = fakeElectron({ platform }), timers = manualTimers();
  let progress = openBackupProgressWindow({ BrowserWindow: electron.BrowserWindow, baseDir: "/app/electron" });
  const win = progress.window;
  let shutdown = false, cleanups = 0, backupModeShown = 0, abandoned = 0;
  const returnToWorkspace = createBackupReturn({
    app: electron.app, setTimer: timers.setTimer,
    cleanup: async () => { shutdown = true; cleanups++; if (cleanups <= cleanupFails) throw Error("cleanup unconfirmed"); },
    relaunch: () => electron.app.relaunch(),
    takeProgress: () => { const taken = progress; progress = null; return taken; },
  });
  const run = runFn => runOfflineBackup({
    run: runFn, abandon: () => { abandoned++; if (abandonFails) throw Error("BACKUP_HANDOFF_CHANGED"); }, returnToWorkspace,
    shutdownStarted: () => shutdown,
    showBackupMode: () => { backupModeShown++; new electron.BrowserWindow({ title: "Backup mode" }); },
    destroyProgress: () => { const taken = progress; progress = null; taken?.destroy(); },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { ...electron, timers, win, returnToWorkspace, run, counts: () => ({ cleanups, backupModeShown, abandoned }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("the fake honours closable:false: the RC5 sequence leaves the app running with no relaunch", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const { BrowserWindow, app, events, reopened } = fakeElectron({ platform });
    const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron" });
    app.relaunch(); app.quit(); // the old relaunch:"normal"
    expect(events).toContain("quit-cancelled");
    expect(reopened()).toBe(false);
    progress.window.close(); // the old catch: close() on a non-closable window
    expect(progress.window.isDestroyed()).toBe(false);
  }
});

it("the progress window stays non-closable for the person, and the app's destroy() always removes it", () => {
  const { BrowserWindow } = fakeElectron({ platform: "win32" });
  const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron" });
  expect(progress.window.options.closable).toBe(false);
  progress.window.close(); expect(progress.window.isDestroyed()).toBe(false);
  progress.destroy(); expect(progress.window.isDestroyed()).toBe(true);
  progress.destroy(); progress.close(); // idempotent
});

for (const platform of ["darwin", "win32", "linux"]) {
  it(`${platform}: a successful backup destroys the window before quitting and reopens once`, async () => {
    const d = desktop({ platform });
    const outcome = await d.run(async () => { await d.returnToWorkspace(); return { verified: true }; }); // the host's success path
    expect(outcome).toBe("verified");
    expect(d.win.isDestroyed()).toBe(true);
    expect(d.events.indexOf("window-destroyed")).toBeLessThan(d.events.indexOf("exited"));
    expect(d.events).not.toContain("quit-cancelled");
    expect(d.reopened()).toBe(true);
  });

  it(`${platform}: a failed backup reopens once, and the error after the host's relaunch never strands it`, async () => {
    const d = desktop({ platform });
    const outcome = await d.run(async () => { await d.returnToWorkspace().catch(() => {}); throw Error("BACKUP_SCHEDULE_REVIEW_REQUIRED"); });
    expect(outcome).toBe("failed");
    expect(d.win.isDestroyed()).toBe(true);
    expect(d.reopened()).toBe(true);
    expect(d.counts().backupModeShown).toBe(0);
  });

  it(`${platform}: a backup past the ceiling is given up, recorded and reopens`, async () => {
    const d = desktop({ platform });
    const result = d.run(() => new Promise(() => {})); // a capture that never returns
    await settle();
    expect(d.reopened()).toBe(false);
    d.timers.fire(OFFLINE_BACKUP_CEILING_MS);
    expect(await result).toBe("timed-out");
    expect(d.counts().abandoned).toBe(1);
    expect(d.win.isDestroyed()).toBe(true);
    expect(d.reopened()).toBe(true);
  });
}

it("a quit that is still held after the grace period exits, so the relaunch fires", async () => {
  const d = desktop({ platform: "darwin" });
  new d.BrowserWindow({ closable: false }).on("close", event => event.preventDefault()); // anything else that cancels the quit
  await d.run(async () => { await d.returnToWorkspace(); });
  expect(d.events).toContain("quit-cancelled");
  expect(d.reopened()).toBe(false);
  d.timers.fire(BACKUP_QUIT_GRACE_MS);
  expect(d.events).toContain("forced-exit");
  expect(d.reopened()).toBe(true);
});

it("success and failure both asking to return arm one relaunch, never two copies", async () => {
  const d = desktop();
  await Promise.all([d.returnToWorkspace(), d.returnToWorkspace()]);
  await d.run(async () => { await d.returnToWorkspace(); throw Error("late"); });
  expect(d.app.relaunches).toBe(1);
  expect(d.counts().cleanups).toBe(1);
});

it("r33 a failed host return waits for trusted Retry before reopening", async () => {
  const d = desktop({ cleanupFails: 1 });
  const outcome = await d.run(async () => { try { await d.returnToWorkspace(); } catch(error) { throw Object.assign(error,{code:"BACKUP_UPGRADE_CLEANUP_FAILED"}); } });
  expect(outcome).toBe("cleanup-failed");
  expect(d.counts().cleanups).toBe(1);
  expect(d.reopened()).toBe(false);
  await d.returnToWorkspace({retry:true});
  expect(d.counts().cleanups).toBe(2);
  expect(d.reopened()).toBe(true);
});

it("cleanup that never confirms leaves a window open (Backup mode page), never a closed app with no window", async () => {
  const d = desktop({ cleanupFails: 99 });
  const outcome = await d.run(async () => { await d.returnToWorkspace().catch(() => {}); throw Error("BACKUP_SCHEDULE_REVIEW_REQUIRED"); });
  expect(outcome).toBe("backup-mode");
  expect(d.win.isDestroyed()).toBe(true);
  expect(d.app.exitCode).toBe(null);
  expect([...d.windows].map(win => win.options.title)).toEqual(["Backup mode"]);
});

it("a run refused before anything closed shows the Backup mode page and removes the progress window", async () => {
  const d = desktop();
  const outcome = await d.run(async () => { throw Error("BACKUP_BUSY"); });
  expect(outcome).toBe("backup-mode");
  expect(d.counts().backupModeShown).toBe(1);
  expect(d.win.isDestroyed()).toBe(true);
  expect(d.app.relaunches).toBe(0);
});

it("a ceiling whose give-up could not be recorded stays open on the Backup mode page, so the backup is not armed again", async () => {
  const d = desktop({ abandonFails: true });
  const result = d.run(() => new Promise(() => {}));
  await settle(); d.timers.fire(OFFLINE_BACKUP_CEILING_MS);
  expect(await result).toBe("backup-mode");
  expect(d.app.relaunches).toBe(0);
  expect(d.win.isDestroyed()).toBe(true);
  expect([...d.windows].map(win => win.options.title)).toEqual(["Backup mode"]);
});

it("Return to workspace pressed again and again on a page whose cleanup keeps failing arms one relaunch at most", async () => {
  const d = desktop({ cleanupFails: 3 });
  for (let press = 0; press < 3; press++) await expect(d.returnToWorkspace({retry:true})).rejects.toThrow();
  expect(d.app.relaunches).toBe(0);
  await d.returnToWorkspace({retry:true}); await d.returnToWorkspace();
  expect(d.app.relaunches).toBe(1);
  expect(d.reopened()).toBe(true);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const retry = main.slice(main.indexOf("    retry: async () => {"), main.indexOf("    openDiagnostics: async () =>"));
  expect(retry).toContain("await returnToWorkspaceAfterBackup({retry:true,prepare:");
  expect(retry).toContain("await explicitBackupReturn(backupScheduleHost,returnToWorkspaceAfterBackup);");
  expect(retry).not.toContain("relaunchDesktop(");
});

it("quitForRelaunch destroys, quits, then bounds the wait", () => {
  const { app, BrowserWindow, events } = fakeElectron();
  const timers = manualTimers();
  const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron" });
  app.relaunch(); quitForRelaunch({ app, progress, setTimer: timers.setTimer });
  expect(events).toEqual(["relaunch-armed", "window-destroyed", "exited"]);
  expect(timers.pending.map(t => t.ms)).toEqual([BACKUP_QUIT_GRACE_MS]);
});

it("the ceiling is at least 35 minutes and follows the budget: the worker's 30 s, and room for checks and cleanup", () => {
  expect(OFFLINE_BACKUP_CEILING_MS).toBe(35 * 60_000);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  expect(main).toContain("parameters.maxDurationMs>MAX_BACKUP_DURATION_MS");
  expect(main).toContain("ceilingMs:backupScheduleHost.offlineCeilingMs()");
  expect(main).toContain("timeoutMs:parameters.maxDurationMs+30_000");
  expect(OFFLINE_BACKUP_CEILING_MS).toBeGreaterThan(30 * 60_000 + 30_000);
  expect(offlineCeilingFor(30 * 60_000)).toBe(35 * 60_000);
  expect(offlineCeilingFor(10 * 60_000)).toBe(35 * 60_000);
  expect(offlineCeilingFor(79 * 60_000)).toBe(84 * 60_000);
  expect(offlineCeilingFor(undefined)).toBe(35 * 60_000);
});

it("main.mjs routes every backup-mode ending through the bounded return", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  expect(main).toContain(`if(mode==="normal")return returnToWorkspaceAfterBackup();`);
  expect(main).toContain("void runOfflineBackup({");
  expect(main).toContain("abandon:()=>backupScheduleHost.abandonOffline()");
  // The old ending that skipped recovery once shutdown had started is gone.
  expect(main).not.toContain(`if(!desktopShutdownStarted)showDesktopRecovery("BACKUP_REQUESTED");}finally{backupProgress?.close()`);
  // The failure notice still follows the reopen.
  expect(main).toContain("void desktopStartup.then(announceLastBackupFailure)");
});

it("T12c shared authority owns the destination before synchronous reentry and retries rejection", async () => {
  const {createReturnAuthority}=await import("./backup-offline-return.mjs");
  const authority=createReturnAuthority(),app={quit(){},exit(){}},destinations=[];
  let finish,joined,prepares=0;
  const cleanup=new Promise(resolve=>{finish=resolve;});
  const common={app,authority,cleanup:()=>{joined=normal();return cleanup;},relaunch:d=>destinations.push(d),takeProgress:()=>null,setTimer:()=>{}};
  const landed=createBackupReturn(common),normal=createBackupReturn(common);
  const first=landed({prepare:()=>{prepares++;return {kind:"landed",version:"2.0.0"};}});
  expect(joined).toBe(first);expect(normal({prepare:()=>{throw Error("must join");}})).toBe(first);
  finish();await first;expect(destinations).toEqual([{kind:"landed",version:"2.0.0"}]);expect(prepares).toBe(1);
});

for(const rejectCleanup of [false,true])it(`T11 T15 BF-3 joined Quit ${rejectCleanup?"rejects":"resolves"} with a real vetoing progress wrapper`,async()=>{
  const {createReturnAuthority,joinExplicitQuit}=await import("./backup-offline-return.mjs");
  const authority=createReturnAuthority(),e=fakeElectron(),timers=manualTimers();
  let progress=openBackupProgressWindow({BrowserWindow:e.BrowserWindow,baseDir:"/fixture"}),finish,reject;
  const win=progress.window,order=[];
  const cleanup=new Promise((yes,no)=>{finish=yes;reject=no;});
  const takeProgress=()=>{const p=progress;progress=null;return p;};
  const onFailure=error=>{takeProgress()?.destroy();order.push({error:error.message,revoked:authority.userQuitRequested,destroyed:win.isDestroyed()});};
  const options={app:e.app,authority,cleanup:()=>cleanup,takeProgress,onFailure,setTimer:timers.setTimer,relaunch:()=>e.app.relaunch()};
  const returning=createBackupReturn(options)();
  const quitting=joinExplicitQuit(options);
  const results=Promise.allSettled([returning,quitting]);
  if(rejectCleanup)reject(Error("owned writer did not close"));else finish();
  await results;
  expect(progress).toBe(null);expect(win.isDestroyed()).toBe(true);expect(e.app.relaunches).toBe(0);
  expect(e.events.filter(x=>x==="window-destroyed")).toHaveLength(1);
  if(rejectCleanup){expect(order).toHaveLength(2);expect(order.every(x=>x.destroyed&&x.revoked&&x.error==="owned writer did not close")).toBe(true);expect(timers.pending).toHaveLength(0);timers.fire(5000);expect(e.app.exitCode).toBe(null);}
  else {expect(timers.pending).toHaveLength(1);expect((await returning).status).toBe("stopped");}
});

it('F10 explicit Quit grace log never promises reopening',async()=>{
 const {joinExplicitQuit,createReturnAuthority}=await import('./backup-offline-return.mjs');
 const lines=[],timers=[];
 await joinExplicitQuit({app:{quit(){},exit(){}},authority:createReturnAuthority(),cleanup:async()=>{},scheduleExit:fn=>fn(),setTimer:fn=>timers.push(fn),log:line=>lines.push(line)});
 timers.forEach(fn=>fn());expect(lines).toHaveLength(1);expect(lines[0]).not.toMatch(/reopen/);
});

it('BF-3: automatic returns share a rejected post-shutdown attempt, while explicit Return retries once',async()=>{
 let shutdown=false,fail=true,cleanups=0,relaunches=0,release;
 const back=createBackupReturn({app:{quit(){},exit(){}},shutdownStarted:()=>shutdown,
   cleanup:async()=>{cleanups++;shutdown=true;if(fail)throw Error('cleanup');await new Promise(resolve=>{release=resolve;});},
   relaunch:()=>{relaunches++;},takeProgress:()=>null,setTimer:()=>0});
 const first=back();await expect(first).rejects.toThrow('cleanup');expect(back()).toBe(first);await expect(back()).rejects.toThrow('cleanup');expect(cleanups).toBe(1);
 fail=false;const retry=back.retry();expect(back.retry()).toBe(retry);expect(back()).toBe(retry);release();await retry;
 await back.retry();expect(cleanups).toBe(2);expect(relaunches).toBe(1);
});

it('BF-3: a pre-shutdown retry that is still pending remains shared with explicit Return',async()=>{
 let count=0,release;const back=createBackupReturn({app:{quit(){},exit(){}},cleanup:async()=>{if(++count===1)throw Error('early');await new Promise(resolve=>{release=resolve;});},relaunch(){},takeProgress:()=>null,setTimer:()=>0});
 await expect(back()).rejects.toThrow('early');const second=back();expect(back.retry()).toBe(second);expect(count).toBe(2);release();await second;
});
