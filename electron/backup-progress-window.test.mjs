import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BACKUP_PROGRESS_STEPS, backupProgressKind, openBackupProgressWindow } from "./backup-progress-window.mjs";

function fakeWindow() {
  const scripts = [];
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = { executeJavaScript: async code => { scripts.push(code); } }; }
    loadFile(file, options) { this.file = file; this.loadOptions = options; return Promise.resolve(); }
    isDestroyed() { return Boolean(this.destroyed); }
    on() {}
    close() { this.closed = true; }
    destroy() { this.destroyed = true; }
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
  // The app tears it down with destroy(): close() on a closable:false window is ignored (RC6, backup-offline-return.test.mjs).
  progress.close(); expect(progress.window.destroyed).toBe(true); expect(progress.window.closed).toBeUndefined();
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
  // 1.0.7: the page no longer says "first backup" for every backup.
  expect(html).toContain("Backing up your workspace");
  expect(html).not.toContain("Setting up your first backup");
  expect(main).toContain("kind:backupProgressKind(backupScheduleHost.internalStatus())");
  const script = readFileSync(new URL("./recovery/progress.js", import.meta.url), "utf8");
  for (const words of ["Setting up your first backup", "Backing up your workspace", "Backing up before the update"]) expect(script).toContain(words);
  expect(readFileSync(new URL("./recovery/progress.css", import.meta.url), "utf8")).toContain("prefers-reduced-motion");
});

it("1.0.7: the heading follows the kind of backup, and anything unreadable reads as an ordinary backup", () => {
  const verified = { lastVerified: { jobId: "a".repeat(64) } };
  expect(backupProgressKind({ job: { occurrence: "3:manual:x" } })).toBe("first");
  expect(backupProgressKind({ ...verified, job: { occurrence: "3:manual:x" } })).toBe("backup");
  expect(backupProgressKind({ ...verified, job: { occurrence: "3:daily:2026-10-26" } })).toBe("backup");
  expect(backupProgressKind({ job: { occurrence: "3:upgrade:update-1:h" } })).toBe("update");
  expect(backupProgressKind(null)).toBe("backup");
  expect(backupProgressKind({ ...verified, job: { occurrence: 7 } })).toBe("backup");
  for (const [kind, shown] of [["first", "first"], ["update", "update"], ["backup", "backup"], ["<script>", "backup"], [undefined, "backup"]]) {
    const { BrowserWindow } = fakeWindow();
    const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron", kind });
    expect(progress.window.loadOptions).toEqual({ query: { kind: shown } });
  }
});
