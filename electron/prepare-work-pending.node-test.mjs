import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { desktopStepUpLanguage } from "./step-up-locale.mjs";

const key = "recovery.downgradeWorkPending";
const words = {
  en: "Murage can't go back to the earlier version while messages or a restore are pending. Finish or cancel the pending restore first, then send or cancel any waiting messages and try again.",
  de: "Nachrichten oder eine ausstehende Wiederherstellung verhindern den Wechsel zur älteren Version. Schließe zuerst die ausstehende Wiederherstellung ab oder brich sie ab; sende oder storniere dann alle wartenden Nachrichten und versuche es erneut.",
  es: "Hay mensajes o una restauración pendiente que impiden volver a la versión anterior. Primero termina o cancela la restauración pendiente; envía o cancela los mensajes en espera y vuelve a intentarlo.",
  fr: "Des messages ou une restauration en attente empêchent le retour à la version précédente. Termine ou annule d'abord la restauration en attente ; envoie ou annule les messages en attente, puis réessaie.",
  hi: "संदेशों या लंबित बहाली के कारण पिछले संस्करण पर वापस नहीं जा सकते। पहले लंबित बहाली पूरी करें या रद्द करें; फिर प्रतीक्षा कर रहे संदेश भेजें या रद्द करें और दोबारा कोशिश करें।",
  ja: "送信待ちのメッセージまたは保留中の復元があるため、以前のバージョンに戻せません。まず保留中の復元を完了するかキャンセルしてください。その後、送信待ちのメッセージを送信またはキャンセルしてから、もう一度お試しください。",
  "pt-br": "Mensagens ou uma restauração pendente impedem a volta à versão anterior. Primeiro, conclua ou cancele a restauração pendente; envie ou cancele as mensagens em espera e tente novamente.",
  zh: "有待发送的消息或待完成的恢复，因此无法返回旧版本。请先完成或取消待处理的恢复，再发送或取消待发送的消息，然后重试。",
};

test("DG2 all eight packs pin the reason and the pending restore action", () => {
  for (const [language, text] of Object.entries(words)) {
    const pack = JSON.parse(readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8"));
    assert.equal(pack[key], text, language);
  }
});

test("DG2 the actual desktop previous-version flow shows the localized restore action", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("async function prepareForPreviousVersion() {");
  const end = main.indexOf("\n// Settings > About & updates:", start);
  assert.ok(start >= 0 && end > start);
  const helper = new URL("./prepare-work-pending.mjs", import.meta.url);
  const downgradeWorkPendingMessage = existsSync(helper) ? (await import(helper.href)).downgradeWorkPendingMessage : undefined;
  for (const [language, text] of Object.entries(words)) {
    const dialogs = [];
    let quit = 0;
    const context = {
      app: { isPackaged: true, quit: () => quit++ }, mainWindow: null,
      desktopRecoveryMode: false, desktopShutdownStarted: false, desktopDataOwner: true, desktopDataDir: "/fixture",
      dialog: { showMessageBox: async value => { dialogs.push(value); return { response: 0 }; } },
      runDesktopRecovery: async () => { throw Object.assign(new Error("fixture"), { code: "DOWNGRADE_WORK_PENDING" }); },
      noteShutdownCause: () => {}, voiceFinishingDialog: () => null,
      desktopStepUpLanguage, systemLanguage: () => "en", ownedDesktopDataDir: () => "/fixture",
      fs: { readFileSync: () => JSON.stringify({ language }) }, path: { join: () => "/fixture/config.json" },
      downgradeWorkPendingMessage,
    };
    await vm.runInNewContext(`${main.slice(start, end)}\nprepareForPreviousVersion()`, context);
    assert.equal(dialogs.length, 2);
    assert.ok(dialogs[1].detail.endsWith(text), `${language}: ${dialogs[1].detail}`);
    assert.equal(quit, 1);
  }
});

test("DG2 the packaged desktop includes each owner wording pack", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  for (const language of Object.keys(words)) assert.ok(config.includes(`  - src/locales/${language}.json\n`), language);
});
