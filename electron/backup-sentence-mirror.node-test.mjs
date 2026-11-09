// WIN-BACKUP-RT-1018: the Electron main process shows the whole-sentence backup codes in the person's language, from a
// checked mirror of src/locales/<locale>.json (the main process does not load the renderer packs): the recovery
// window's Backup mode reason, its refusal sentence, and the desktop notification.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BACKUP_SENTENCE_KEYS, captureFailureSentence } from "../shared/backup-capture-failure.mjs";
import { backupSentenceMirror, backupSentenceWords, updateRecoveryWords } from "./update-recovery-copy.mjs";
import { announceBackupFailure, backupFailureNoticeSentence } from "./backup-failure-notice.mjs";

const LOCALES = ["en", "de", "es", "fr", "pt-br", "ja", "zh", "hi"];
const CODE = "BACKUP_STARTED_AS_ADMINISTRATOR";
const catalogue = locale => JSON.parse(readFileSync(new URL(`../src/locales/${locale}.json`, import.meta.url), "utf8"));
const en = catalogue("en"), de = catalogue("de");
const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from);
  assert.ok(from > -1 && to > from, `main.mjs holds ${start}`);
  return main.slice(from, to);
}

test("the mirror equals the locale catalogue byte for byte, for every mapped code in every shipped locale", () => {
  assert.deepEqual(Object.keys(backupSentenceMirror).sort(), [...LOCALES].sort());
  const hashes = JSON.parse(readFileSync(new URL("../src/locales/source-hashes.json", import.meta.url), "utf8"));
  for (const locale of LOCALES) {
    const pack = catalogue(locale);
    assert.deepEqual(Object.keys(backupSentenceMirror[locale]), Object.keys(BACKUP_SENTENCE_KEYS.capture), locale);
    for (const [code, key] of Object.entries(BACKUP_SENTENCE_KEYS.capture)) {
      assert.equal(backupSentenceWords(locale)[code], pack[key], `${locale} ${code}`);
      assert.equal(updateRecoveryWords(locale)[code], pack[key], `${locale} ${code} reaches the recovery window`);
      // Its source-hash row is written in every translated locale, against today's English.
      if (locale !== "en") assert.equal(hashes.locales[locale][key], createHash("sha256").update(en[key]).digest("hex"), `${locale} ${key} hash`);
    }
  }
  assert.equal(backupSentenceWords("pt-BR")[CODE], catalogue("pt-br")["backup.stopped.administrator"]);
  assert.equal(backupSentenceWords("de-AT")[CODE], de["backup.stopped.administrator"]);
  assert.equal(backupSentenceWords("xx")[CODE], en["backup.stopped.administrator"]);
});

test("Backup mode reason: Run as administrator in German and in English, a whole sentence", () => {
  const body = between("  let captureFailure = null, backupError = null", "  const recovery = openInstallationRecoveryWindow(");
  const reason = locale => new Function("backupScheduleHost", "updateRecoveryWords", "app", "descriptor", "reasonCode", "captureFailureSentence", body + ";return reason;")(
    { internalStatus: () => ({ phase: "needs-review", captureFailure: { stage: "precondition", code: CODE } }) },
    updateRecoveryWords, { getLocale: () => locale }, { updatePause: false }, "BACKUP_REQUESTED", captureFailureSentence);
  assert.equal(reason("de"), `${de["backup.stopped.administrator"]} You are in Backup mode. Your bots, schedules and messaging apps are paused while you are here. Restore a backup or make one, or choose Return to workspace.`);
  assert.equal(reason("en"), `${en["backup.stopped.administrator"]} You are in Backup mode. Your bots, schedules and messaging apps are paused while you are here. Restore a backup or make one, or choose Return to workspace.`);
});

test("refusal sentence: the recovery page takes the translated entry main sends, English stays the fallback", () => {
  const renderer = readFileSync(new URL("./recovery/renderer.js", import.meta.url), "utf8");
  const line = renderer.split("\n").find(text => text.startsWith("const recoveryMessage = "));
  assert.ok(line, "renderer.js recoveryMessage");
  const context = {};
  vm.runInNewContext(readFileSync(new URL("./recovery/messages.js", import.meta.url), "utf8"), context);
  vm.runInNewContext(`${line}; globalThis.recoveryMessage = recoveryMessage;`, context);
  const say = (locale, messages) => context.recoveryMessage({ error: CODE, context: { updateMessages: messages ?? updateRecoveryWords(locale) } });
  assert.equal(say("de"), de["backup.stopped.administrator"]);
  assert.equal(say("en"), en["backup.stopped.administrator"]);
  assert.equal(say("en", {}), en["backup.stopped.administrator"], "with nothing from main, the English map says the same English");
  assert.match(main, /context: \{ reason, returnRevoked:descriptor\.returnRevoked===true, updateMessages:words,/);
});

test("desktop notification: the mirrored sentence for the app's locale, the server's English otherwise", async () => {
  const english = en["backup.stopped.administrator"];
  assert.equal(backupFailureNoticeSentence(CODE, english, backupSentenceWords("de")), de["backup.stopped.administrator"]);
  assert.equal(backupFailureNoticeSentence(CODE, english, backupSentenceWords("en")), english);
  assert.equal(backupFailureNoticeSentence("BACKUP_FILE_IN_USE", "server words", backupSentenceWords("de")), "server words");
  assert.equal(backupFailureNoticeSentence(CODE, english, undefined), english);
  const userData = mkdtempSync(path.join(tmpdir(), "murage-notice-"));
  try {
    const shown = [];
    await announceBackupFailure({ status: { phase: "needs-review", enabled: true, job: { id: "job-1" }, captureFailure: { stage: "precondition", code: CODE } }, userData,
      post: async () => ({ reported: true, sentence: english }), showNotice: sentence => shown.push(sentence), words: backupSentenceWords("de") });
    assert.deepEqual(shown, [de["backup.stopped.administrator"]]);
  } finally { safeWipeSync(userData); }
  assert.match(main, /post:body=>harnessJson\("\/api\/backup-failure-notice",body\),words:backupSentenceWords\(app\.getLocale\?\.\(\)\),/);
});
