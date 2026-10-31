import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BACKUP_PROGRESS_STEPS, backupProgressKind, backupWorkerView, openBackupProgressWindow } from "./backup-progress-window.mjs";
import { BACKUP_WORKER_STEPS } from "../shared/backup-progress.mjs";
import vm from "node:vm";

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

it("1.0.12: every worker step has a place on the bar, always inside the capture's stretch of it", () => {
  let previous = 25;
  for (const step of BACKUP_WORKER_STEPS) {
    const start = backupWorkerView({ step }), end = backupWorkerView({ step, done: 5, total: 5 });
    expect(start, step).not.toBeNull();
    expect(start.percent).toBeGreaterThanOrEqual(previous);
    expect(end.percent).toBeGreaterThanOrEqual(start.percent);
    expect(end.percent).toBeLessThanOrEqual(75);
    previous = end.percent;
  }
  expect(backupWorkerView({ step: "nonsense" })).toBeNull();
  expect(backupWorkerView(null)).toBeNull();
  expect(backupWorkerView({ step: "__proto__" })).toBeNull();
});

it("1.0.12: Checking lights up when the worker's own check starts, and a note from an earlier step can't move it back", async () => {
  const { BrowserWindow, scripts } = fakeWindow();
  const progress = openBackupProgressWindow({ BrowserWindow, baseDir: "/app/electron", skin: "light" });
  progress.stage("references"); progress.stage("capture");
  progress.worker({ step: "encrypt", elapsedMs: 1, done: 10, total: 100 });
  progress.worker({ step: "readback", elapsedMs: 2, done: 0, total: 100 });
  progress.stage("artifact-readback");
  progress.worker({ step: "encrypt", elapsedMs: 3, done: 90, total: 100 });
  progress.stage("return");
  progress.worker({ step: "publish", elapsedMs: 4 });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(scripts.filter(code => code.includes("setBackupProgress")).map(code => Number(/setBackupProgress\((\d)/.exec(code)[1]))).toEqual([1, 2, 3, 4]);
  expect(scripts.filter(code => code.includes("setBackupDetail"))).toHaveLength(2);
  progress.destroy();
  expect(() => progress.worker({ step: "readback", elapsedMs: 9 })).not.toThrow();
});

function progressPage() {
  const nodes = {};
  const node = id => (nodes[id] ??= { textContent: "", style: {}, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
  const context = { URLSearchParams, Object, Math, Number, String, document: { title: "", readyState: "complete", documentElement: { dataset: {} }, addEventListener() {}, getElementById: node, querySelectorAll: () => [] } };
  context.window = { location: { search: "" } };
  vm.runInNewContext(readFileSync(new URL("./recovery/progress.js", import.meta.url), "utf8"), context);
  return { window: context.window, node };
}

it("1.0.12: the window words each phase in plain terms, with real numbers where it has them, and the bar never goes back", () => {
  const { window, node } = progressPage();
  window.setBackupProgress(2, "dark");
  expect(node("fill").style.width).toBe("25%");
  const show = note => { window.setBackupDetail(backupWorkerView(note)); return node("detail").textContent; };
  expect(show({ step: "database-copy", done: 1, total: 2 })).toBe("Copying your database");
  expect(show({ step: "inventory" })).toBe("Getting your files ready");
  expect(show({ step: "encrypt", done: 3_100_000_000, total: 9_300_000_000 })).toBe("Encrypting 3.1 of 9.3 GB");
  expect(node("bar").attributes["aria-valuetext"]).toBe("Encrypting 3.1 of 9.3 GB");
  expect(node("fill").style.width).toBe("48%");
  window.setBackupProgress(3, "dark");
  expect(show({ step: "readback", done: 3_100_000_000, total: 9_300_000_000 })).toBe("Checking 3.1 of 9.3 GB");
  expect(show({ step: "readback-hash" })).toBe("Checking your backup");
  // Windows checks through its helper: no byte count, the words still work.
  expect(show({ step: "readback" })).toBe("Checking your backup");
  expect(node("fill").style.width).toBe("73%");
  window.setBackupProgress(4, "dark");
  expect(node("detail").textContent).toBe("");
  expect(node("fill").style.width).toBe("100%");
  window.setBackupDetail({ phase: "constructor" });
  window.setBackupDetail(null);
  expect(node("detail").textContent).toBe("");
});

it("1.0.12: the opening words say a large workspace takes a while", () => {
  const html = readFileSync(new URL("./recovery/progress.html", import.meta.url), "utf8");
  expect(html).toContain("This can take a while on a large workspace.");
  expect(html).not.toContain("a moment");
});
