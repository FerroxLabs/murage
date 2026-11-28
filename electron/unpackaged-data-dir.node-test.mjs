// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An unpackaged start (npm run dev) used to die in ownedDesktopDataDir(). It may now use MURAGE_DEV_DATA_DIR, and only that,
// never when packaged and never the real data folders. The ACTUAL functions are cut out of electron/main.mjs and run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dataDirLeasePaths } from "./data-dir-lease.mjs";

const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const first = Math.min(...["function unpackagedDevDataDir", "function ownedDesktopDataDir"].map((m) => source.indexOf(m)).filter((i) => i >= 0));
const last = source.indexOf("function trackOwnedServerChild(", first);
assert.ok(first >= 0 && last > first, "actual main wiring exists");
const text = source.slice(first, last);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-data-dir-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, "home"), userData = path.join(root, "userData"), realData = path.join(root, "home", ".murage");
fs.mkdirSync(realData, { recursive: true }); fs.mkdirSync(userData, { recursive: true });

function owned({ packaged = false, env = {}, owner = null, dataDir = null, platform = "linux" }) {
  const app = { isPackaged: packaged, getPath: (name) => (name === "home" ? home : userData) };
  const run = new Function("app", "process", "path", "fs", "dataDirLeasePaths", `let desktopDataOwner=arguments[5], desktopDataDir=arguments[6]; ${text}; return ownedDesktopDataDir();`);
  return run(app, { env, platform }, path, fs, dataDirLeasePaths, owner, dataDir);
}
const REFUSAL = /does not own this installation/;

test("unpackaged with MURAGE_DEV_DATA_DIR: the start gets that folder", () => {
  const dev = path.join(root, "dev-a");
  let got;
  assert.doesNotThrow(() => { got = owned({ env: { MURAGE_DEV_DATA_DIR: dev } }); }, "an unpackaged start with the dev folder must not die");
  assert.equal(fs.existsSync(dev), true, "the dev folder is created");
  assert.equal(got, fs.realpathSync(dev));
});

test("unpackaged without the variable (or with an empty or relative one) still refuses", () => {
  assert.throws(() => owned({ env: {} }), REFUSAL);
  assert.throws(() => owned({ env: { MURAGE_DEV_DATA_DIR: "" } }), REFUSAL);
  assert.throws(() => owned({ env: { MURAGE_DEV_DATA_DIR: "relative/dev" } }), REFUSAL);
});

test("a packaged build ignores the variable", () => {
  const dev = path.join(root, "dev-packaged");
  assert.throws(() => owned({ packaged: true, env: { MURAGE_DEV_DATA_DIR: dev } }), REFUSAL);
  assert.equal(fs.existsSync(dev), false);
  assert.equal(owned({ packaged: true, env: { MURAGE_DEV_DATA_DIR: dev }, owner: {}, dataDir: "/owned/canonical" }), "/owned/canonical");
});

test("the variable never points at, inside or above the real data folders", () => {
  const link = path.join(root, "link-to-real");
  fs.symlinkSync(realData, link);
  fs.mkdirSync(path.join(root, "custom-data"), { recursive: true });
  const recovered = path.join(userData, "recovered-installations", "inst-1", "data");
  for (const target of [realData, userData, link, path.join(root, "custom-data"), recovered, path.join(link, "sub", "deeper"), path.join(realData, "..dev"), path.join(root, "custom-data", "x"), root, home]) {
    assert.throws(() => owned({ env: { MURAGE_DEV_DATA_DIR: target, MURAGE_DATA_DIR: path.join(root, "custom-data") } }), /must not be, hold or sit inside a real data folder/, target);
  }
  assert.equal(fs.existsSync(recovered), false, "a refused folder is never created");
});

test("every unpackaged-reachable caller goes through ownedDesktopDataDir(); the variable is read in one place", () => {
  assert.ok([...source.matchAll(/ownedDesktopDataDir\(\)/g)].length >= 10, "the startup callers are plain calls to ownedDesktopDataDir()");
  assert.equal([...source.matchAll(/process\.env\.MURAGE_DEV_DATA_DIR/g)].length, 1, "one reader, inside unpackagedDevDataDir");
  assert.equal(source.indexOf("process.env.MURAGE_DEV_DATA_DIR") > source.indexOf("function unpackagedDevDataDir"), true);
  assert.equal(source.indexOf("process.env.MURAGE_DEV_DATA_DIR") < source.indexOf("function ownedDesktopDataDir"), true);
});

test("MURAGE_DATA_DIR is canonicalized like the packaged owner: a symlink before .. cannot hide the live folder", () => {
  const live = path.join(root, "live");
  fs.mkdirSync(path.join(live, "child"), { recursive: true });
  const hop = path.join(root, "hop");
  fs.symlinkSync(path.join(live, "child"), hop);
  // The packaged owner resolves hop first, so hop/../data is live/data; a plain path.resolve would say root/data.
  assert.throws(() => owned({ env: { MURAGE_DEV_DATA_DIR: path.join(live, "data"), MURAGE_DATA_DIR: `${hop}/../data` } }), /must not be, hold or sit inside a real data folder/);
  assert.equal(fs.existsSync(path.join(live, "data")), false, "a refused folder is never created");
});

test("a case-insensitive platform: ~/.MURAGE (any case) is the real ~/.murage and is refused; a case-sensitive one still allows it", () => {
  for (const platform of ["darwin", "win32"]) {
    for (const target of [path.join(home, ".MURAGE"), path.join(home, ".Murage", "sub"), path.join(root, "HOME")]) {
      assert.throws(() => owned({ platform, env: { MURAGE_DEV_DATA_DIR: target } }), /must not be, hold or sit inside a real data folder/, `${platform} ${target}`);
    }
    assert.equal(fs.existsSync(path.join(home, ".MURAGE")), false, "a refused folder is never created");
  }
  assert.doesNotThrow(() => owned({ platform: "linux", env: { MURAGE_DEV_DATA_DIR: path.join(root, "other-case", ".MURAGE") } }));
});
