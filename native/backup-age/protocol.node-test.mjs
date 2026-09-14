import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createControlProtocol, encodeRequest, limits, safePath } from "./protocol.mjs";

const nonce = "01234567-89ab-cdef-0123-456789abcdef";
const key = `AGE-SECRET-KEY-1${"A".repeat(58)}\n`;
const request = { nonce, operation: "decrypt", parentPid: 123, parentDirectory: "C:\\Private Ω\\stage parent", ciphertext: "C:\\Private Ω\\archive.age", maxBytes: 1024 };
const frame = (event, ...fields) => Buffer.from(["1", nonce, event, ...fields].join("\t") + "\n");
const prepared = frame("PREPARED", "123", "a".repeat(32), "999", "123", "b".repeat(32));

test("request is exact-length UTF-8 metadata and separate identity bytes", () => {
  const encoded = encodeRequest(request, key); const delimiter = encoded.header.indexOf(10);
  const size = Number(encoded.header.subarray(0, delimiter).toString());
  assert.equal(encoded.header.length - delimiter - 1, size);
  const fields = encoded.header.subarray(delimiter + 1).toString().split("\n");
  assert.equal(fields.length, 10); assert.equal(fields[4], request.parentDirectory);
  assert.equal(Number(fields[6]), encoded.key.length); assert.equal(encoded.key.toString(), key);
  assert.equal(encoded.header.includes(Buffer.from(key)), false);
  // A coalesced OS read must still be bounded by the declared sizes. The exact
  // native reader makes these three reads; START cannot become part of the key.
  const next = frame("START"); const combined = Buffer.concat([encoded.header, encoded.key, next]);
  const keyAt = delimiter + 1 + size;
  assert.equal(combined.subarray(keyAt, keyAt + Number(fields[6])).toString(), key);
  assert.deepEqual(combined.subarray(keyAt + Number(fields[6])), next);
});

test("private-stage has no key or ciphertext and uses the same bounded request", () => {
  const encoded = encodeRequest({ ...request, operation: "private-stage", ciphertext: "" });
  assert.equal(encoded.key.length, 0);
  assert.throws(() => encodeRequest({ ...request, operation: "private-stage" }, key));
});

test("rejects namespace, traversal, reparse-capable ambiguous and reserved path spellings", () => {
  for (const path of ["\\\\server\\share", "\\\\?\\C:\\foo", "C:/foo", "C:foo", "C:\\", "C:\\a\\..\\b", "C:\\a:stream", "C:\\NUL.txt", "C:\\LPT¹", "C:\\conout$", "C:\\a.", "C:\\a ", "C:\\a\nfile", "C:\\a\x7ffile", "C:\\a\\", `C:\\${"x".repeat(256)}`]) {
    assert.equal(safePath(path), false, JSON.stringify(path));
    assert.throws(() => encodeRequest({ ...request, ciphertext: path }, key));
  }
  assert.equal(safePath(request.ciphertext), true);
});

test("rejects malformed request identity, nonce, operation and numeric limits", () => {
  for (const patch of [{ operation: "exec" }, { nonce: nonce.toUpperCase() }, { nonce: "x" }, { parentPid: 0 }, { parentPid: 2 ** 32 }, { maxBytes: 0 }, { maxBytes: limits.bytes + 1 }, { timeoutMs: 1800001 }, { closeTimeoutMs: 30001 }, { timeoutMs: NaN }, { parentDirectory: "C:\\bad\tpath" }]) assert.throws(() => encodeRequest({ ...request, ...patch }, key));
  for (const identity of ["", key + "extra", key + key, key.trim(), "AGE-SECRET-KEY-1bad\n", `${key.trim()}\r\n`]) assert.throws(() => encodeRequest(request, identity));
});

test("decrypt lifecycle requires exact START, child closure, RELEASE, receipt and helper closure", () => {
  const p = createControlProtocol(nonce, "decrypt");
  assert.throws(() => createControlProtocol(nonce, "decrypt").command("START"));
  for (const byte of prepared) p.receive(Buffer.from([byte]));
  assert.equal(p.state, "prepared");
  assert.equal(p.command("START"), frame("START").toString());
  p.receive(frame("CHILD_CLOSED", "0", "0")); p.command("RELEASE");
  p.receive(frame("RELEASED", "c".repeat(64)));
  assert.deepEqual(p.close(0), { guardsClosed: true, helperClosed: true });
  assert.throws(() => p.command("RELEASE")); assert.throws(() => p.receive(prepared));
});

test("private-stage skips START and child status; release still requires observed zero exit", () => {
  const p = createControlProtocol(nonce, "private-stage");
  p.receive(frame("PREPARED", "0", "0".repeat(32), "0", "123", "b".repeat(32)));
  p.command("RELEASE"); p.receive(frame("RELEASED", "-"));
  assert.throws(() => p.close(72));
});

test("wrong nonce, parser input, native diagnostics and extra fields never enter control results", () => {
  for (const bad of [Buffer.from(prepared.toString().replace(nonce, "f".repeat(36))), Buffer.from(key), Buffer.from("native error C:\\private\n"), frame("PREPARED", "123", "a".repeat(32), "1", "123", "b".repeat(32), "extra"), Buffer.from("1\t" + nonce + "\tPREPARED\r\n"), frame("UNKNOWN"), frame("CHILD_CLOSED", "0")]) {
    const p = createControlProtocol(nonce, "decrypt"); assert.throws(() => p.receive(bad));
  }
});

test("duplicate/out-of-order child status and nonzero child exit fail closed", () => {
  for (const code of ["1", "-1", "00", "4294967296"]) {
    const p = createControlProtocol(nonce, "decrypt"); p.receive(prepared); p.command("START");
    assert.throws(() => p.receive(frame("CHILD_CLOSED", code, "0")));
  }
  const p = createControlProtocol(nonce, "decrypt"); p.receive(prepared);
  assert.throws(() => p.receive(prepared)); assert.equal(p.state, "failed"); assert.throws(() => p.command("START"));
  const q = createControlProtocol(nonce, "decrypt"); q.receive(prepared); q.command("START"); q.receive(frame("CHILD_CLOSED", "0", "0"));
  assert.throws(() => q.receive(frame("CHILD_CLOSED", "0", "0")));
});

test("CANCEL is terminal at every live phase and never authorizes cleanup", () => {
  for (let phase = 0; phase < 5; phase++) {
    const p = createControlProtocol(nonce, "decrypt");
    if (phase > 0) p.receive(prepared); if (phase > 1) p.command("START");
    if (phase > 2) p.receive(frame("CHILD_CLOSED", "0", "0")); if (phase > 3) p.command("RELEASE");
    p.command("CANCEL"); assert.throws(() => p.close(0)); assert.throws(() => p.command("CANCEL")); assert.throws(() => p.receive(frame("RELEASED", "c".repeat(64))));
  }
});

test("truncated, oversized and trailing control data fail without a closure result", () => {
  for (const bytes of [Buffer.alloc(limits.frame + 1, 65), Buffer.alloc(limits.control + 1, 65)]) assert.throws(() => createControlProtocol(nonce, "decrypt").receive(bytes));
  const p = createControlProtocol(nonce, "decrypt"); p.receive(prepared.subarray(0, prepared.length - 1)); assert.throws(() => p.close(0));
  const q = createControlProtocol(nonce, "decrypt"); q.receive(prepared); q.command("START"); q.receive(frame("CHILD_CLOSED", "0", "0")); q.command("RELEASE");
  assert.throws(() => q.receive(Buffer.concat([frame("RELEASED", "c".repeat(64)), Buffer.from("extra")])));
});

const native = readFileSync(new URL("./transport.cpp", import.meta.url), "utf8");
test("native source uses deny-write/delete guards, NTFS and reparse/link admission", () => {
  assert.match(native, /directory \? FILE_READ_ATTRIBUTES \| FILE_LIST_DIRECTORY : GENERIC_READ/);
  assert.match(native, /FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.doesNotMatch(native, /FILE_SHARE_WRITE|FILE_SHARE_DELETE|ShellExecute|runas|chmod\(/);
  assert.match(native, /GetDriveTypeW[\s\S]*DRIVE_FIXED/); assert.match(native, /std::wstring\(fsName\) == L"NTFS"/);
  assert.match(native, /nNumberOfLinks == 1/); assert.match(native, /FileIdInfo/);
});

test("native source creates and verifies the private ACL before PREPARED", () => {
  assert.match(native, /D:P\(A;OICI;FA;;;SY\)/); assert.match(native, /CreateDirectoryW\(p.c_str\(\), &security\)/);
  assert.match(native, /SE_DACL_PROTECTED/); assert.match(native, /acl->AceCount == 2/);
  assert.match(native, /EqualSid\(target, system\)/); assert.match(native, /EqualSid\(target, current\)/);
  assert.ok(native.indexOf("auto stage = privateStage") < native.indexOf('control.send("PREPARED'));
});

test("native source fixes executable and argv, pins digest, assigns job before resume, inherits guards", () => {
  assert.match(native, /parent_path\(\) \/ L"age.exe"/); assert.match(native, /hash\(tool.h\) == ageDigest/);
  assert.match(native, /--decrypt --identity - --output -/); assert.match(native, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(native, /for \(HANDLE guard : guards\) inherited.push_back\(duplicate\(guard\)\)/);
  assert.match(native, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.ok(native.indexOf("AssignProcessToJobObject(child.job.h") < native.indexOf("ResumeThread(child.thread.h"));
  assert.match(native, /CREATE_SUSPENDED/); assert.match(native, /wchar_t environment\[2\] = \{0, 0\}/);
});

test("native source separates key/control, drains age diagnostics and binds actual parent and SID", () => {
  assert.match(native, /input.exact\(bytes.data\(\), size\)/);
  assert.match(native, /writeAll\(keyPipe.write.h, secret.bytes.data\(\), secret.size\)/);
  assert.match(native, /SecureZeroMemory\(secret.bytes.data/);
  assert.match(native, /drain\(errPipe.read, false, errClosed\)/);
  assert.match(native, /e.th32ParentProcessID == expected/); assert.match(native, /user == sid\(parentToken.h\)/);
  assert.match(native, /!elevation.TokenIsElevated/);
  assert.ok(native.indexOf('control.expect(input, "START")') < native.indexOf("const auto result = decrypt("));
  assert.ok(native.indexOf('control.expect(input, "RELEASE")') < native.indexOf("source.close(); sourcePins.clear()"));
  assert.match(native, /control.expect\(input, "RELEASE"\);\s+input.finish\(\);/);
  assert.match(native, /ReadFile\(h, &extra, 1, &n, nullptr\)/);
  assert.match(native, /\(okay && n == 0\) \|\| \(!okay && GetLastError\(\) == ERROR_BROKEN_PIPE\)/);
  assert.ok(native.indexOf("source.close(); sourcePins.clear()") < native.indexOf('control.send("RELEASED'));
});

test("CHILD_CLOSED byte barrier waits for delayed stdout and rejects invalid counts", async () => {
  const p = createControlProtocol(nonce, "decrypt", 1024); p.receive(prepared); p.command("START");
  p.plaintext(2); p.receive(frame("CHILD_CLOSED", "0", "5"));
  assert.equal(p.plaintextComplete, false);
  await new Promise(resolve => setImmediate(resolve)); // stderr delivered ahead of the final stdout chunk.
  assert.equal(p.plaintextComplete, false); p.plaintext(3); assert.equal(p.plaintextComplete, true);
  p.command("RELEASE");
  for (const count of ["-1", "01", "1.5", "1025", "NaN", "999999999999999"]) {
    const q = createControlProtocol(nonce, "decrypt", 1024); q.receive(prepared); q.command("START");
    assert.throws(() => q.receive(frame("CHILD_CLOSED", "0", count)));
  }
  const early = createControlProtocol(nonce, "decrypt"); early.receive(prepared); early.command("START"); early.receive(frame("CHILD_CLOSED", "0", "1"));
  assert.throws(() => early.command("RELEASE"));
  const over = createControlProtocol(nonce, "decrypt"); over.receive(prepared); over.command("START"); over.receive(frame("CHILD_CLOSED", "0", "1"));
  assert.throws(() => over.plaintext(2));
  assert.match(native, /return \{code, total\}/);
  assert.match(native, /CHILD_CLOSED\\t0\\t" \+ std::to_string\(result.bytes\)/);
});
