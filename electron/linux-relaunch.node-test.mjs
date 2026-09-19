import assert from "node:assert/strict";
import test from "node:test";
import { linuxRelaunchBlocked } from "./linux-relaunch.mjs";

// What a restarted Murage would face. Electron starts the new process with
// no_new_privs set, so Chromium's setuid sandbox helper cannot run there, and
// the process needs user namespaces instead.
const system = files => ({ platform: "linux", read: file => { if (!(file in files)) throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); return files[file]; } });
const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", LABEL = "/proc/self/attr/apparmor/current", OLD_LABEL = "/proc/self/attr/current";

test("Ubuntu 24.04 without Murage's AppArmor profile cannot restart Murage", () => {
  assert.equal(linuxRelaunchBlocked(system({ [RESTRICT]: "1\n", [LABEL]: "unconfined\n" })), true);
  assert.equal(linuxRelaunchBlocked(system({ [RESTRICT]: "1\n", [OLD_LABEL]: "unconfined\n" })), true);
  // Another program's profile is not Murage's.
  assert.equal(linuxRelaunchBlocked(system({ [RESTRICT]: "1\n", [LABEL]: "murage-helper (enforce)\n" })), true);
});

test("with the profile loaded, or with no AppArmor restriction, a restart works", () => {
  assert.equal(linuxRelaunchBlocked(system({ [RESTRICT]: "1\n", [LABEL]: "murage (unconfined)\n" })), false);
  assert.equal(linuxRelaunchBlocked(system({ [RESTRICT]: "0\n", [LABEL]: "unconfined\n" })), false);
  assert.equal(linuxRelaunchBlocked(system({})), false);
});

test("a kernel with unprivileged user namespaces switched off cannot restart Murage either", () => {
  assert.equal(linuxRelaunchBlocked(system({ "/proc/sys/kernel/unprivileged_userns_clone": "0\n" })), true);
  assert.equal(linuxRelaunchBlocked(system({ "/proc/sys/user/max_user_namespaces": "0\n" })), true);
  assert.equal(linuxRelaunchBlocked(system({ "/proc/sys/kernel/unprivileged_userns_clone": "1\n", "/proc/sys/user/max_user_namespaces": "15185\n" })), false);
});

test("only Linux is checked", () => {
  for (const platform of ["darwin", "win32"]) assert.equal(linuxRelaunchBlocked({ platform, read: () => { throw Error("not read"); } }), false);
});
