import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = {}; context.globalThis = context;
vm.runInNewContext(readFileSync(new URL("./recovery/messages.js", import.meta.url), "utf8"), context);
const { messages, captureMessages, fallback, sentence } = context.murageRecoveryMessages;

test("backup folder permissions and invalid key locations have plain actionable copy", () => {
  for (const action of [undefined, "backup", "backup-encrypted"]) {
    assert.equal(sentence("BACKUP_FOLDER_NOT_WRITABLE", { action }), "Murage can't write a file the backup needs. Choose a backup folder you can write to, or fix the permissions on that folder and on the folder that holds Murage's data.");
    assert.equal(sentence("BACKUP_RECOVERY_KEY_LOCATION_INVALID", { action }), "That location can't be used. Choose another folder; nothing was saved.");
  }
  assert.equal(sentence("BACKUP_STATE_SAVE_FAILED"), "Murage could not save its backup state. Check free disk space and folder permissions, then choose Return to workspace again.");
});

// Every refusal code the recovery path can raise, read from the code that
// raises it, so a new one without a sentence fails here.
function raisedCodes() {
  const root = new URL("..", import.meta.url);
  const files = [
    ...readdirSync(new URL("server/", root)).filter(name => /^installation-.*\.ts$/.test(name) && !name.includes(".test.")).map(name => new URL(`server/${name}`, root)),
    ...readdirSync(new URL("electron/", root)).filter(name => /^installation-recovery-.*\.mjs$/.test(name) && !name.includes("test")).map(name => new URL(`electron/${name}`, root)),
    new URL("scripts/installation-recovery-worker.ts", root), new URL("electron/backup-mode.mjs", root),
  ];
  const codes = new Set();
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(/(?:fail|refuse|Error)\("([A-Z][A-Z0-9]*_[A-Z0-9_]+)"|code: ?"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g)) codes.add(match[1] ?? match[2]);
  for (const test of ["PRIVATE_CREDENTIAL_CANARY", "PRIVATE_ERROR_CANARY"]) codes.delete(test);
  return [...codes];
}

test("every recovery refusal has its own plain sentence", () => {
  const missing = raisedCodes().filter(code => !Object.hasOwn(messages, code));
  assert.deepEqual(missing, []);
});

test("no sentence shows a code, tool jargon, an em dash or safe", () => {
  for (const text of [...Object.values(messages), ...Object.values(captureMessages), fallback]) {
    assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+|age-keygen|fidelity|—|\bsaf(?:e|ely)\b/i, text);
    assert.match(text, /\.$/, text);
  }
  assert.equal(sentence("SOMETHING_NEW"), fallback);
  assert.match(sentence("AGE_PROCESS_FAILED"), /recovery key/);
});

// 1.0.6: the one name a restore refuses is its own record, never a damaged file,
// and the sentence says what to choose instead.
test("a backup holding Murage's own restore notes is named as that, not as damaged", () => {
  const text = sentence("RESERVED_RESTORE_COMPONENT", { action: "restore-encrypted-new" });
  assert.match(text, /restore notes/);
  assert.match(text, /nothing was restored/);
  assert.match(text, /Choose a backup file Murage made/);
  assert.doesNotMatch(text, /damaged or incomplete/);
});

// 0.1.60 audit A-03: making a backup from the Backup mode page can stop with
// codes the restore side uses too. It must never read as a failed restore.
test("a failed backup on the Backup mode page is never described as a restore", async () => {
  const { BACKUP_CAPTURE_CODES } = await import("../shared/backup-capture-failure.mjs");
  for (const action of ["backup", "backup-encrypted"]) for (const code of [...BACKUP_CAPTURE_CODES, "UNSAFE_SNAPSHOT_ENTRY", "NONPORTABLE_SNAPSHOT_PATH"]) {
    assert.doesNotMatch(sentence(code, { action, backupMode: true }), /nothing was restored|backup file is damaged|choose another backup|restore in one go/i, `${action}: ${code}`);
  }
  // The same codes during a restore keep the restore wording.
  assert.match(sentence("UNSAFE_ARCHIVE_PATH", { action: "restore-encrypted-new" }), /nothing was restored/);
});

test("a sentence names the item in the data folder when the refusal has one, and nothing else", () => {
  assert.match(sentence("UNSAFE_SNAPSHOT_ENTRY", { action: "backup", path: "channels/slack/odd" }), /The item is channels\/slack\/odd in Murage's data folder\.$/);
  for (const path of ["/Users/sam/.ssh/id_rsa", "C:\\Users\\sam", "../outside", "~/x", "a\nb"]) assert.doesNotMatch(sentence("UNSAFE_SNAPSHOT_ENTRY", { action: "backup", path }), /The item is/);
});

// 0.1.60 audit IPC-L3: the retry button reads "Return to workspace" only in
// Backup mode; the ordinary recovery window calls it "Retry startup".
test("the ownership sentence names the button each window shows", () => {
  const html = readFileSync(new URL("./recovery/index.html", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("./recovery/renderer.js", import.meta.url), "utf8");
  assert.match(html, /data-action="retry">Retry startup</);
  assert.match(renderer, /"Return to workspace":"Retry startup"/);
  assert.match(sentence("RECOVERY_OWNERSHIP_REQUIRED", { backupMode: false }), /choose Retry startup\.$/);
  assert.match(sentence("RECOVERY_OWNERSHIP_REQUIRED", { backupMode: true }), /choose Return to workspace\.$/);
});

// 0.1.60 audit A-01: what a backup left out is listed in the same words on
// the Backup mode page and the Backups page.
test("skipped items read the same on the Backup mode page and the Backups page", async () => {
  const { backupSkippedLines } = await import("../shared/backup-skipped.mjs");
  const samples = [
    { count: 3, items: [{ path: "workspaces/mira/site/node_modules", reason: "rebuildable" }, { path: "workspaces/mira/notes 10:30.md", reason: "unreadable" }, { path: "attachments/x", reason: "special" }], bots: { mira: "Mira" } },
    { count: 1200, items: [{ path: "workspaces/b1/photos/a.jpg", reason: "file-limit" }], bots: {} },
    { count: 1, items: [{ path: "workspaces/b1/linked", reason: "linked-folder" }] },
    { count: 2, items: [{ path: "config.json.bak-20260918-openaicompat", reason: "unrecognised" }, { path: "env copy", reason: "unrecognised" }] },
    null, { count: 0, items: [] },
  ];
  for (const sample of samples) assert.deepEqual([...context.murageRecoveryMessages.skippedLines(sample)], backupSkippedLines(sample));
  // 1.0.4: a name Murage does not recognise is left out, and the line says only that, and where it is.
  assert.deepEqual(backupSkippedLines(samples[3]), [
    "Skipped 2 items in Murage's data folder: config.json.bak-20260918-openaicompat (not recognised by Murage, so the backup leaves it out; it stays where it is, so move it somewhere you keep your files if it matters), env copy (not recognised by Murage, so the backup leaves it out; it stays where it is, so move it somewhere you keep your files if it matters).",
    "Everything else was backed up.",
  ]);
  for (const line of samples.flatMap(sample => backupSkippedLines(sample))) assert.doesNotMatch(line, /current file is backed up|[Kk]ept in the backup|\b(?:un)?safe(?:ty)?\b/);
  assert.deepEqual(backupSkippedLines(samples[0]), [
    "Skipped 2 items in Mira's folder: site/node_modules (installed packages or a cache, reinstall them after a restore), notes 10:30.md (couldn't be read).",
    "Skipped 1 item in Murage's data folder: attachments/x (not a regular file).",
    "Everything else was backed up.",
  ]);
  for (const line of samples.flatMap(sample => backupSkippedLines(sample))) assert.doesNotMatch(line, /—|[A-Z]{2,}_[A-Z_]+/);
});
