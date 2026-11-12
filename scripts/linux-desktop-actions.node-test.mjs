// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { bindLinuxDesktopActions } from "./linux-desktop-actions.mjs";
// Keep the changed catalogue/config assertions in this plain-Node regression run.
import "../electron/badge-surface-copy.node-test.mjs";

const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
const tasks = ["new-chief", "needs-you", "pause"];
const hookPath = config.match(/^beforePack: (.+)$/m)?.[1];
assert.ok(hookPath, "the package must install the action generation hook");
const { default: beforePack } = await import(new URL(`../${hookPath}`, import.meta.url));

// Read only the string mapping used by linux.desktop, without a YAML dependency.
// Like builder 26.15.3, this fixture only emits desktopActions, not actions.
function configuredDesktop() {
  const source = config.split("  desktop:\n")[1].split("\ndeb:")[0];
  const result = { entry: {}, desktopActions: {} };
  let group, action;
  for (const line of source.split("\n")) {
    const section = line.match(/^    (\w+):$/);
    if (section) { group = section[1]; continue; }
    const id = line.match(/^      ([a-z-]+):$/);
    if (id && group === "desktopActions") {
      action = result.desktopActions[id[1]] = {};
      continue;
    }
    const pair = line.match(/^( {6}| {8})("[^"]+"|[^ :]+): (.+)$/);
    if (!pair) continue;
    const scalar = value => value.startsWith('"') ? JSON.parse(value) : value;
    if (pair[1].length === 6 && group === "entry") result.entry[scalar(pair[2])] = scalar(pair[3]);
    if (pair[1].length === 8 && group === "desktopActions") action[scalar(pair[2])] = scalar(pair[3]);
  }
  return result;
}

function builderFixture() {
  const calls = [];
  const helper = {
    async computeDesktopEntry(options, exec, extra) {
      assert.equal(this, helper, "the hook retains the builder receiver");
      calls.push({ options, exec, extra });
      const groups = {
        "Desktop Entry": { ...options.desktop.entry, Exec: exec, ...extra },
        ...Object.fromEntries(Object.entries(options.desktop.desktopActions)
          .map(([id, fields]) => [`Desktop Action ${id}`, fields])),
      };
      return Object.entries(groups).map(([name, fields]) => `[${name}]\n`
        + Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join("")).join("\n");
    },
  };
  return { helper, calls, context: { electronPlatformName: "linux", targets: [
    { name: "appImage", helper }, { name: "deb", helper },
  ] } };
}

function commands(desktop) {
  const result = {};
  let group;
  for (const line of desktop.split("\n")) {
    if (/^\[.+\]$/.test(line)) { group = line.slice(1, -1); result[group] = undefined; }
    if (line.startsWith("Exec=")) result[group] = line.slice(5);
  }
  return result;
}

// A desktop-launcher fixture: resolve the executable first, then interpret a
// recording executable in a VM. No shell, Electron, installed apps or live data.
function launch(command, searchPath, launches) {
  const tokens = command.match(/"[^"]*"|\S+/g).map(token => token.replace(/^"|"$/g, ""));
  const executable = tokens.shift();
  const resolved = path.isAbsolute(executable) ? executable
    : searchPath.map(directory => path.join(directory, executable)).find(file => existsSync(file));
  assert.ok(resolved && existsSync(resolved), `Executable cannot be resolved: ${executable}`);
  vm.runInNewContext(readFileSync(resolved, "utf8"), {
    record: (...args) => launches.push(args), executable: resolved,
    argv: tokens.filter(token => token !== "%U"),
  });
}

test("AppImage-only integration resolves all actions with no PATH alias, even beside another package", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "murage-desktop-actions-"));
  t.after(() => safeWipeSync(root));
  const appImage = path.join(root, "My Apps", "Murage.AppImage");
  const bin = path.join(root, "bin");
  mkdirSync(path.dirname(appImage));
  mkdirSync(bin);
  writeFileSync(appImage, 'record("appimage", executable, ...argv);\n');
  assert.equal(existsSync(path.join(bin, "murage")), false);
  const { helper, context, calls } = builderFixture();
  beforePack(context);
  const embedded = await helper.computeDesktopEntry({ desktop: configuredDesktop() }, "AppRun %U");
  const embeddedCommands = commands(embedded);
  assert.equal(embeddedCommands["Desktop Entry"], "AppRun %U");
  for (const task of tasks) assert.equal(embeddedCommands[`Desktop Action ${task}`], `AppRun --murage-task=${task}`);
  // Integration relocates the embedded AppRun target to the installed image.
  // A hard-coded murage action would survive this relocation and fail to launch.
  const installed = embedded.replace(/^Exec=AppRun(?= |$)/gm, () => `Exec="${appImage}"`);
  const desktopFile = path.join(root, "Murage.desktop");
  writeFileSync(desktopFile, installed);
  const entries = commands(readFileSync(desktopFile, "utf8"));
  const launches = [];
  const runAll = () => {
    launch(entries["Desktop Entry"], [bin], launches);
    for (const task of tasks) launch(entries[`Desktop Action ${task}`], [bin], launches);
  };
  runAll();
  writeFileSync(path.join(bin, "murage"), 'record("other-package", executable, ...argv);\n');
  runAll();
  const expected = [["appimage", appImage], ...tasks.map(task => ["appimage", appImage, `--murage-task=${task}`])];
  assert.deepEqual(launches, [...expected, ...expected]);
  assert.equal(calls.length, 1);
});

test("shared builder helper binds each target independently and is wrapped only once", async () => {
  const { helper, context, calls } = builderFixture();
  beforePack(context);
  const wrapped = helper.computeDesktopEntry;
  beforePack(context);
  const options = { desktop: configuredDesktop() };
  // A stale target-specific command must be replaced as well.
  options.desktop.desktopActions.pause.Exec = "murage --murage-task=pause";
  const [appImage, deb] = await Promise.all([
    helper.computeDesktopEntry(options, "AppRun %U", { "X-AppImage-Version": "1.0.19" }),
    helper.computeDesktopEntry(options, '"/opt/My Murage/murage" --profile=work %U'),
  ]);
  for (const [desktop, target] of [[appImage, "AppRun"], [deb, '"/opt/My Murage/murage" --profile=work']]) {
    const entries = commands(desktop);
    for (const task of tasks) assert.equal(entries[`Desktop Action ${task}`], `${target} --murage-task=${task}`);
    assert.equal(Object.keys(entries).length, 4);
  }
  assert.equal(helper.computeDesktopEntry, wrapped);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options, options);
  assert.deepEqual(calls[0].extra, { "X-AppImage-Version": "1.0.19" });
  assert.match(appImage, /^X-AppImage-Version=1.0.19$/m);
  assert.doesNotMatch(deb, /X-AppImage-Version/);
});

test("incomplete desktop output or a changed builder helper refuses packaging", async () => {
  const { helper } = builderFixture();
  const desktop = await helper.computeDesktopEntry({ desktop: configuredDesktop() }, "AppRun %U");
  assert.throws(() => bindLinuxDesktopActions(desktop.replace("Exec=AppRun %U\n", "")), /one launch command/);
  assert.throws(() => bindLinuxDesktopActions(desktop.replace("Exec=AppRun %U", "Exec=AppRun %U\nExec=other")), /one launch command/);
  assert.throws(() => bindLinuxDesktopActions(desktop.replace("[Desktop Action pause]", "[Desktop Action unknown]")), /missing or repeated: pause/);
  assert.throws(() => bindLinuxDesktopActions(`${desktop}\n[Desktop Action pause]\nName=Pause\n`), /missing or repeated: pause/);
  assert.throws(() => beforePack({ electronPlatformName: "linux", targets: [{ name: "deb" }] }), /generation changed/);
});
