import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BACKUP_PROGRESS_STEPS, openBackupProgressWindow } from "./backup-progress-window.mjs";

function fakeWindow() {
  const scripts = [];
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = { executeJavaScript: async code => { scripts.push(code); } }; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    isDestroyed() { return false; }
    close() { this.closed = true; }
  }
  return { BrowserWindow, scripts };
}

it("shows real stages in order, ignores repeats and steps backwards, and closes", async () => {
  const { BrowserWindow, scripts } = fakeWindow();
  const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron", skin: "light" });
  expect(progress.window.file.endsWith("progress.html")).toBe(true);
  expect(progress.window.options.closable).toBe(false);
  progress.stage("references"); progress.stage("capture"); progress.stage("capture"); progress.stage("references"); progress.stage("nonsense"); progress.stage("artifact-readback"); progress.stage("return");
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(scripts.map(code => Number(/setBackupProgress\((\d)/.exec(code)[1]))).toEqual([1, 2, 3, 4]);
  progress.close(); expect(progress.window.closed).toBe(true);
  expect(Object.values(BACKUP_PROGRESS_STEPS)).toEqual([1, 2, 3, 4]);
});

it("the first armed backup opens the screen before the capture and the capture reports each stage", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  expect(main.indexOf("openBackupProgressWindow({BrowserWindow")).toBeGreaterThan(0);
  expect(main.indexOf("openBackupProgressWindow({BrowserWindow")).toBeLessThan(main.indexOf("backupScheduleHost.resumeOffline()"));
  expect(main).toContain("reportProgress:name=>backupProgress?.stage(name)");
  const host = readFileSync(new URL("./backup-schedule-host.mjs", import.meta.url), "utf8");
  for (const name of ["references", "capture", "artifact-readback", "return"]) expect(host).toContain(`stage("${name}")`);
  const html = readFileSync(new URL("./recovery/progress.html", import.meta.url), "utf8");
  expect(html).toContain("Setting up your first backup");
  expect(readFileSync(new URL("./recovery/progress.css", import.meta.url), "utf8")).toContain("prefers-reduced-motion");
});
