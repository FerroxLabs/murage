// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { badgeCountFor, createBadgeSurfaces, parseMurageTask, routeMurageTask } from "./badge-surfaces.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const ids = ["new-chief", "needs-you", "pause"];
const labels = ["New task for Chief", "Open Needs you", "Pause automations"];
function rig(platform, origin = "new", t) {
  let prefs = notifySurfaceDefaults(origin, platform);
  const calls = [], tasks = [], icon = { isEmpty: () => false };
  const win = { isDestroyed: () => false, setOverlayIcon: (...args) => calls.push(["overlay", ...args]) };
  const app = {
    setBadgeCount: count => calls.push(["count", count]),
    setUserTasks: value => calls.push(["tasks", value]),
    dock: { setMenu: value => calls.push(["menu", value]), setBadge: value => calls.push(["dock-badge", value]) },
  };
  const surfaces = createBadgeSurfaces({ app, Menu: { buildFromTemplate: template => template }, platform,
    prefs: () => prefs, onTask: id => tasks.push(id), t, window: () => win, overlayIcon: () => icon });
  return { surfaces, calls, tasks, icon, win, prefs, setPrefs: value => { prefs = value; } };
}

test("count modes select their own input and refuse non-finite or unknown values", () => {
  assert.equal(badgeCountFor({ mode: "unread", unread: 7.9, needsYou: 2 }), 7);
  assert.equal(badgeCountFor({ mode: "needs-you", unread: 7, needsYou: 2.9 }), 2);
  for (const value of [-5, -0, NaN, Infinity, -Infinity, undefined, null, "9", {}, 1n]) {
    for (const mode of ["unread", "needs-you"]) assert.equal(badgeCountFor({ mode, unread: value, needsYou: value }), 0);
  }
  assert.equal(badgeCountFor({ mode: "unknown", unread: 9, needsYou: 9 }), 0);
  assert.equal(badgeCountFor(), 0);
});

test("upgrade keeps the old badge calls, Windows descriptions and unread ceiling", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const r = rig(platform, "upgrade");
    for (const [unread, count] of [[0, 0], [1, 1], [8, 8], [1001, 999]]) {
      r.calls.length = 0;
      r.surfaces.apply({ unread, needsYou: 2 });
      assert.deepEqual(r.calls, platform === "win32"
        ? [["overlay", count ? r.icon : null, count ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations"]]
        : [["count", count]]);
    }
  }
});

test("needs-you follows summary counts; badge off clears each platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const r = rig(platform);
    r.surfaces.apply({ unread: 8, needsYou: 3 });
    assert.deepEqual(r.calls, platform === "win32" ? [["overlay", r.icon, "Needs you: 3"]] : [["count", 3]]);
    r.calls.length = 0;
    r.prefs.surfaces.badge = false;
    r.surfaces.apply({ unread: 8, needsYou: 3 });
    assert.deepEqual(r.calls, platform === "win32" ? [["overlay", null, "Needs you: 0"]] : [["count", 0]]);
  }
});

test("Windows handles a missing window or empty icon; unknown prefs clear the badge", () => {
  const r = rig("win32");
  r.surfaces.apply({ needsYou: 3 }, null);
  r.win.isDestroyed = () => true;
  r.surfaces.apply({ needsYou: 3 });
  assert.deepEqual(r.calls, []);
  r.win.isDestroyed = () => false;
  r.icon.isEmpty = () => true;
  r.surfaces.apply({ needsYou: 3 });
  assert.deepEqual(r.calls, [["overlay", null, "Needs you: 3"]]);
  const linux = rig("linux");
  linux.setPrefs(null);
  linux.surfaces.apply({ unread: 8, needsYou: 3 });
  assert.deepEqual(linux.calls, [["count", 0]]);
});

test("menus use exactly three allowlisted tasks on their own platform and clear when off", () => {
  for (const platform of ["win32", "darwin", "linux", "unknown"]) {
    const r = rig(platform);
    r.surfaces.refreshMenu();
    if (platform === "win32") {
      assert.deepEqual(r.calls, [["tasks", ids.map((id, index) => ({ program: process.execPath,
        arguments: `--murage-task=${id}`, iconPath: process.execPath, iconIndex: 0,
        title: labels[index], description: labels[index] }))]]);
    } else if (platform === "darwin") {
      assert.equal(r.calls.length, 1);
      assert.equal(r.calls[0][0], "menu");
      assert.deepEqual(r.calls[0][1].map(item => item.label), labels);
      for (const item of r.calls[0][1]) item.click();
      assert.deepEqual(r.tasks, ids);
    } else assert.deepEqual(r.calls, []);
    r.calls.length = 0;
    r.prefs.badgeMenu = false;
    r.surfaces.refreshMenu();
    assert.deepEqual(r.calls, platform === "win32" ? [["tasks", []]] : platform === "darwin" ? [["menu", []]] : []);
  }
});

test("labels use injected translations with English fallbacks", () => {
  const r = rig("darwin", "new", key => key === "badgeSurfaces.newChief" ? "Neue Aufgabe für Chief" : key);
  r.surfaces.refreshMenu();
  assert.deepEqual(r.calls[0][1].map(item => item.label), ["Neue Aufgabe für Chief", ...labels.slice(1)]);
  const broken = rig("win32", "new", () => { throw new Error("missing"); });
  broken.surfaces.refreshMenu();
  assert.deepEqual(broken.calls[0][1].map(item => item.title), labels);
});

test("task argv is a first-argument strict allowlist and never evaluates text", () => {
  const table = [
    ...ids.map(id => [["murage", `--murage-task=${id}`], id]),
    [["--murage-task=nope"], null], [["--murage-task"], null],
    [["--murage-task=new-chief;rm"], null], [[`--murage-task=${"x".repeat(100000)}`], null],
    [["--murage-task=new-chief", "--murage-task=pause"], "new-chief"],
    [["--murage-task=nope", "--murage-task=pause"], null],
    [["--murage-task", "--murage-task=pause"], null],
    [["--murage-task=", "pause"], null], [["--murage-task=pause "], null],
    [["--murage-task-extra=pause"], null], [[null, 42, "--murage-task=pause"], "pause"],
    [null, null], [undefined, null], ["--murage-task=pause", null], [{}, null], [[], null],
  ];
  for (const [argv, expected] of table) assert.equal(parseMurageTask(argv), expected);
  const hostile = new Proxy([], { get() { throw new Error("bad argv"); } });
  assert.equal(parseMurageTask(hostile), null);
});

test("routing rechecks the menu preference and calls exactly one matching handler", async () => {
  for (const task of [...ids, "nope", "toString", null, undefined]) {
    for (const badgeMenuOn of [true, false, undefined, "true"]) {
      const calls = [];
      await routeMurageTask({ task, badgeMenuOn, open: () => calls.push("open"),
        newChiefTask: () => calls.push("new-chief"), openNeedsYou: () => calls.push("needs-you"), pauseAutomations: () => calls.push("pause") });
      assert.deepEqual(calls, ids.includes(task) ? [badgeMenuOn === true ? task : "open"] : []);
    }
  }
});

test("main second-instance dispatches tasks and preserves the backup-only early return", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf('app.on("second-instance"'), source.indexOf("// Packaged: the harness server"));
  assert.match(body, /parseMurageTask\(commandLine\)/);
  assert.match(source, /dispatchBadgeTask\(parseMurageTask\(process.argv\)\)/);
  let handler;
  const calls = [];
  vm.runInNewContext(body, {
    app: { on: (_name, callback) => { handler = callback; } },
    CLOSED_DUE_FLAG: "--backup", CLOSED_DESCRIPTOR_FLAG: "--descriptor",
    doorLinkFromCommandLine: () => null, packageUrlFromCommandLine: () => null,
    reopenUpdateRecoveryIfNeeded: () => false, parseMurageTask, dispatchBadgeTask: task => calls.push(task),
    BrowserWindow: { getAllWindows: () => [] }, activateExistingWindow: () => calls.push("activate"), deliverPackageInstall: () => {},
  });
  handler(null, ["--backup", "--murage-task=pause"]);
  assert.deepEqual(calls, []);
  handler(null, ["--murage-task=needs-you"]);
  assert.deepEqual(calls, ["needs-you"]);
  calls.length = 0;
  handler(null, ["--murage-task=nope"]);
  assert.deepEqual(calls, ["activate"]);
});
