// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-TRUST-V2 seed barrier inside a Cloud turn's namespace. Python launcher only (Linux): the rest of the
// Cloud seed contract is in folder-trust-v2-seeds-cloud.test.ts and runs everywhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "./testing/cleanup.ts";
import { launcherRig, type Rig } from "./cloud-home/engine-launch-fixture.ts";

const onPosix = describe.skipIf(process.platform === "win32");
let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-seed-barrier-"); });
afterEach(() => { rig.dispose(); });

onPosix("the Cloud seed is on disk before the engine can start", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-seed-barrier-")); });
  afterEach(() => removeTempDirSync(dir));
  const setup = () => {
    const source = join(dir, "seed"), home = join(dir, "home");
    writeFileSync(source, "seed bytes");
    mkdirSync(home);
    return { source, home };
  };

  it("syncs the file, publishes it, then syncs the directory that holds the new name", () => {
    const { source, home } = setup();
    const out = rig.py(`
import stat
events = []
real_fsync, real_replace = os.fsync, os.replace
def fsync(fd):
    events.append("dir-fsync" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file-fsync")
    return real_fsync(fd)
def replace(a, b):
    events.append("replace")
    return real_replace(a, b)
os.fsync, os.replace = fsync, replace
m.write_fuigo_seed(sys.argv[2], sys.argv[3])
print(",".join(events))`, source, home);
    expect(out.trim().split(",")).toEqual(["file-fsync", "replace", "dir-fsync"]);
    expect(readFileSync(join(home, "trusted_folders.toml"), "utf8")).toBe("seed bytes");
  });

  it("a directory sync that fails fails the turn and leaves no seed behind", () => {
    const { source, home } = setup();
    expect(() => rig.py(`
import stat
real = os.fsync
def fsync(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode): raise OSError("fixture directory sync")
    return real(fd)
os.fsync = fsync
m.write_fuigo_seed(sys.argv[2], sys.argv[3])`, source, home)).toThrow(/fixture directory sync/u);
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(join(home, "trusted_folders.toml"))).toBe(false);
  });
});
