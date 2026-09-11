import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WORKSPACE_NATIVE_BROWSER_EXTENSIONS, WORKSPACE_NATIVE_OPEN_EXTENSIONS, createWorkspaceFileActionHandler,
  isNativeOpenableWorkspaceFile, isWorkspaceRelativeFilePath, opensInBrowser, verifiedWorkspaceNativePath,
} from "./workspace-file-actions.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const SCOPE = { botId: "bot", threadId: "thread" };
const scratchRoots = [];
function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-native-")));
  scratchRoots.push(base);
  return base;
}
test.after(() => { for (const root of scratchRoots.splice(0)) safeWipeSync(root); });

/** A workspace root with one file, plus the record the server would answer. */
function fixture({ relativePath = "notes.md", content = "# Notes" } = {}) {
  const root = join(scratch(), "workspace");
  mkdirSync(root, { recursive: true });
  const parts = relativePath.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  const file = join(root, ...parts);
  writeFileSync(file, content);
  return { root, file, relativePath, record: record(root, relativePath, file) };
}
/** Exactly what the server answers: `fingerprint` in server/artifacts.ts. */
function record(root, relativePath, file) {
  const stat = statSync(file);
  return {
    scope: SCOPE, relativePath, root, revision: "r1.test", bytes: stat.size,
    identity: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]),
  };
}

const codeOf = (action) => {
  try { action(); } catch (error) { return error.code; }
  return "ok";
};
const asyncCodeOf = async (action) => {
  try { await action(); } catch (error) { return error.code; }
  return "ok";
};

// --- the allowlist -------------------------------------------------------

test("only document, data, image and media extensions may be opened", () => {
  for (const name of ["report.md", "data.csv", "sheet.xlsx", "photo.PNG", "clip.mp4", "page.html"]) {
    assert.equal(isNativeOpenableWorkspaceFile(name), true, name);
  }
  for (const name of ["run.sh", "tool.exe", "setup.command", "lib.dylib", "bundle.app", "archive.zip", "link.webloc",
    "installer.pkg", "macro.docm", "script.js", "note", "notes.md.exe"]) {
    assert.equal(isNativeOpenableWorkspaceFile(name), false, name);
  }
  // The allowlist itself carries nothing executable or script-like.
  for (const extension of WORKSPACE_NATIVE_OPEN_EXTENSIONS) {
    assert.equal([".exe", ".sh", ".command", ".bat", ".ps1", ".js", ".mjs", ".py", ".app", ".pkg", ".dmg", ".zip", ".jar"].includes(extension), false, extension);
  }
});

test("markup that a browser would run is flagged for the warning", () => {
  for (const extension of WORKSPACE_NATIVE_BROWSER_EXTENSIONS) assert.equal(opensInBrowser(`file${extension}`), true, extension);
  assert.equal(opensInBrowser("report.pdf"), false);
  assert.equal(opensInBrowser("diagram.svg"), true);
});

test("relative paths follow the shared workspace syntax rules", () => {
  for (const value of ["notes.md", "outputs/report.html", "a/b/c/d.txt"]) assert.equal(isWorkspaceRelativeFilePath(value), true, value);
  for (const value of ["", "/etc/passwd", "../secret.md", "a/../../b.md", ".hidden/x.md", "a/.git/config",
    "a\\b.md", "c:/x.md", "a/b\u0000.md", "x".repeat(2049), `${"n".repeat(256)}.md`, 7, null]) {
    assert.equal(isWorkspaceRelativeFilePath(value), false, String(value));
  }
});

// --- the revalidation ----------------------------------------------------

test("the authorized file is rebuilt from the root and accepted unchanged", () => {
  const f = fixture({ relativePath: "outputs/report.md" });
  assert.equal(verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: SCOPE }), f.file);
});

test("a record about another file, scope or root is refused", () => {
  const f = fixture();
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: "other.md", scope: SCOPE })), "WORKSPACE_NATIVE_UNVERIFIED");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: { botId: "other", threadId: "thread" } })), "WORKSPACE_NATIVE_UNVERIFIED");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath({ ...f.record, root: "workspace" }, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_UNVERIFIED");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath({ ...f.record, identity: "" }, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_UNVERIFIED");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(null, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_UNVERIFIED");
});

test("a file rewritten after the server answered is refused", () => {
  const f = fixture();
  writeFileSync(f.file, "# Notes, changed");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_MOVED");
});

test("a file replaced by a same-size copy after the server answered is refused", () => {
  const f = fixture({ content: "abcdefgh" });
  const decoy = join(f.root, "decoy.md");
  writeFileSync(decoy, "ABCDEFGH");
  utimesSync(decoy, new Date(0), new Date(0));
  rmSync(f.file);
  renameSync(decoy, f.file);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_MOVED");
});

test("a deleted file is refused", () => {
  const f = fixture();
  rmSync(f.file);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_MOVED");
});

test("a symlinked file, a symlinked parent folder and a hard link are refused", { skip: process.platform === "win32" }, () => {
  const base = scratch();
  const outside = join(base, "private.md");
  writeFileSync(outside, "private");

  const linked = fixture();
  rmSync(linked.file);
  symlinkSync(outside, linked.file);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(linked.record, { relativePath: linked.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_LINKED");

  const nested = fixture({ relativePath: "docs/report.md" });
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "report.md"), "private");
  safeWipeSync(join(nested.root, "docs"));
  symlinkSync(elsewhere, join(nested.root, "docs"));
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(nested.record, { relativePath: nested.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_LINKED");

  const hard = fixture();
  rmSync(hard.file);
  linkSync(outside, hard.file);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(hard.record, { relativePath: hard.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_LINKED");
});

test("a directory in the file's place is refused", () => {
  const f = fixture();
  rmSync(f.file);
  mkdirSync(f.file);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath(f.record, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_NOT_FILE");
});

test("a non-canonical or vanished root is refused", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const alias = join(scratch(), "alias");
  symlinkSync(f.root, alias);
  assert.equal(codeOf(() => verifiedWorkspaceNativePath({ ...f.record, root: alias }, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_ROOT");
  assert.equal(codeOf(() => verifiedWorkspaceNativePath({ ...f.record, root: join(f.root, "gone") }, { relativePath: f.relativePath, scope: SCOPE })), "WORKSPACE_NATIVE_ROOT");
});

// --- the handler ---------------------------------------------------------

function handler(overrides = {}) {
  const calls = { authorize: [], opened: [], revealed: [], confirmed: 0 };
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  window.webContents.mainFrame = { url: "http://127.0.0.1:8799/", detached: false };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const handle = createWorkspaceFileActionHandler({
    window: () => window,
    origin: () => "http://127.0.0.1:8799",
    authorize: async (input) => { calls.authorize.push(input); return overrides.record ?? null; },
    confirmBrowserOpen: async () => { calls.confirmed++; return overrides.confirm ?? true; },
    openPath: async (file) => { calls.opened.push(file); return overrides.openError ?? ""; },
    revealPath: (file) => { calls.revealed.push(file); },
    ...overrides.deps,
  });
  return { handle, event, window, calls };
}

test("an untrusted sender is refused before anything else", async () => {
  const f = fixture();
  const h = handler({ record: f.record });
  const foreign = { sender: { isDestroyed: () => false, mainFrame: {} }, senderFrame: {} };
  assert.equal(await asyncCodeOf(() => h.handle(foreign, SCOPE, f.relativePath, "open")), "NATIVE_SENDER_UNTRUSTED");
  assert.deepEqual(h.calls.authorize, []);
});

test("a malformed scope, path or action never reaches the server", async () => {
  const f = fixture();
  const h = handler({ record: f.record });
  for (const [scope, relativePath, action] of [
    [SCOPE, "../escape.md", "open"],
    [SCOPE, f.relativePath, "delete"],
    [{ botId: "bot" }, f.relativePath, "open"],
    [{ botId: "bot", threadId: "thread", extra: 1 }, f.relativePath, "open"],
    [{ botId: "bot/../x", threadId: "thread" }, f.relativePath, "open"],
    [SCOPE, "", "reveal"],
  ]) {
    assert.equal(await asyncCodeOf(() => h.handle(h.event, scope, relativePath, action)), "WORKSPACE_NATIVE_REQUEST", String(relativePath));
  }
  assert.deepEqual(h.calls.authorize, []);
});

test("opening a type outside the allowlist is refused without a server call", async () => {
  const h = handler();
  assert.equal(await asyncCodeOf(() => h.handle(h.event, SCOPE, "build.sh", "open")), "WORKSPACE_NATIVE_TYPE");
  assert.deepEqual(h.calls.authorize, []);
});

test("reveal works for any type, and opens nothing", async () => {
  const f = fixture({ relativePath: "build.sh", content: "echo hi" });
  const h = handler({ record: f.record });
  await h.handle(h.event, SCOPE, "build.sh", "reveal");
  assert.deepEqual(h.calls.revealed, [f.file]);
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.authorize, [{ scope: SCOPE, relativePath: "build.sh" }]);
});

test("an allowlisted file is opened after the server authorizes it", async () => {
  const f = fixture();
  const h = handler({ record: f.record });
  await h.handle(h.event, SCOPE, f.relativePath, "open");
  assert.deepEqual(h.calls.opened, [f.file]);
  assert.equal(h.calls.confirmed, 0);
});

test("HTML asks first, and a cancelled warning opens nothing", async () => {
  const f = fixture({ relativePath: "report.html", content: "<h1>Report</h1>" });
  const cancelled = handler({ record: f.record, confirm: false });
  await cancelled.handle(cancelled.event, SCOPE, f.relativePath, "open");
  assert.equal(cancelled.calls.confirmed, 1);
  assert.deepEqual(cancelled.calls.opened, []);

  const accepted = handler({ record: f.record, confirm: true });
  await accepted.handle(accepted.event, SCOPE, f.relativePath, "open");
  assert.deepEqual(accepted.calls.opened, [f.file]);
});

test("a revealed HTML file is not warned about and is not opened", async () => {
  const f = fixture({ relativePath: "report.html", content: "<h1>Report</h1>" });
  const h = handler({ record: f.record });
  await h.handle(h.event, SCOPE, f.relativePath, "reveal");
  assert.equal(h.calls.confirmed, 0);
  assert.deepEqual(h.calls.revealed, [f.file]);
});

test("the server's refusal is surfaced and nothing is opened", async () => {
  const h = handler({ deps: { authorize: async () => { throw new Error("Private setup and memory files are not opened here."); } } });
  await assert.rejects(() => h.handle(h.event, SCOPE, "notes.md", "open"), /Private setup and memory files/);
  assert.deepEqual(h.calls.opened, []);
});

test("a file that changed between the server's answer and the OS call is not opened", async () => {
  const f = fixture();
  const h = handler({ record: f.record });
  writeFileSync(f.file, "changed after the answer");
  assert.equal(await asyncCodeOf(() => h.handle(h.event, SCOPE, f.relativePath, "open")), "WORKSPACE_NATIVE_MOVED");
  assert.deepEqual(h.calls.opened, []);
});

test("an operating-system failure to open is reported", async () => {
  const f = fixture();
  const h = handler({ record: f.record, openError: "no handler" });
  assert.equal(await asyncCodeOf(() => h.handle(h.event, SCOPE, f.relativePath, "open")), "WORKSPACE_NATIVE_OS");
});
