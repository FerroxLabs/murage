import assert from "node:assert/strict";
import test from "node:test";
import { buildBackupHelper } from "./build-backup-helper.mjs";

function fixture(overrides = {}) {
  const calls = [], directories = [];
  const options = { platform: "win32", arch: "x64", env: {}, root: "C:\\fixture root", exists: () => true,
    mkdir: (...args) => directories.push(args), exec: (...args) => { calls.push(args); return calls.length === 1 ? "C:\\Visual Studio\r\n" : Buffer.alloc(0); }, ...overrides };
  return { calls, directories, run: () => buildBackupHelper(options) };
}
test("fixed Windows compiler command builds only the backup adapter, without running it", () => {
  const f = fixture(); assert.equal(f.run(), "C:\\fixture root\\dist-native\\backup-tools\\win32-x64\\murage-backup-age.exe");
  assert.equal(f.calls.length, 2); assert.equal(f.directories.length, 1);
  const [, args, options] = f.calls[1]; assert.equal(options.cwd, "C:\\fixture root");
  assert.match(args[3], /native\\backup-age\\transport\.cpp/); assert.match(args[3], /Advapi32\.lib Bcrypt\.lib$/);
  assert.match(args[3], /\/std:c\+\+20/); assert.doesNotMatch(args[3], /capture\.cpp|VssApi|signtool|powershell/i);
});
test("non-Windows or unsupported architecture refuses before tool lookup or writes", () => {
  for (const overrides of [{ platform: "darwin" }, { arch: "arm64" }]) { const f = fixture(overrides); assert.throws(f.run, /Windows x64/); assert.equal(f.calls.length, 0); assert.equal(f.directories.length, 0); }
});
test("missing or unsafe toolchain refuses before compilation", () => {
  const missing = fixture({ exists: () => false }); assert.throws(missing.run, /build tools/); assert.equal(missing.calls.length, 0);
  for (const value of ["", "C:\\VS%BAD%", "C:\\VS\"bad", "C:\\VS\nsecond"]) {
    let calls = 0; const f = fixture({ exec: () => { calls++; return value; } }); assert.throws(f.run, /safely/); assert.equal(calls, 1); assert.equal(f.directories.length, 0);
  }
});
test("compiler failure or missing output never reports a successful build", () => {
  let calls = 0; const failed = fixture({ exec: () => { if (++calls === 1) return "C:\\VS"; throw Error("compiler failed"); } }); assert.throws(failed.run, /compiler failed/);
  const absent = fixture({ exists: file => !file.endsWith("murage-backup-age.exe") }); assert.throws(absent.run, /did not produce/);
});
