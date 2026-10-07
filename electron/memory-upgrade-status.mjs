// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first start after an update upgrades the memory tables inside
// messages.db. The server child does that before it listens, in one
// synchronous call, so it cannot report progress itself. It leaves a small
// note (server/memory/upgrade-status.ts writes it) that this module reads,
// and the desktop shell shows "Upgrading your memory" from it, or says why the
// upgrade could not run. English plus the seven shipped languages; any other
// system language gets English.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const MEMORY_UPGRADE_STATUS_FILE = "memory-upgrade-status.json";
const BLOCKED_CODES = new Set(["MEMORY_MIGRATION_DISK_SPACE", "MEMORY_SCHEMA_NEWER", "MEMORY_MIGRATION_FAILED"]);
const PHASES = new Set(["checking", "copying", "migrating"]);
const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The note, validated, or null. `pid` must be the child that is starting now:
 * a note left by an earlier launch is never shown as this launch's state. */
export function readMemoryUpgradeStatus(dataDir, { pid } = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path.join(dataDir, MEMORY_UPGRADE_STATUS_FILE), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  if (raw.state !== "upgrading" && raw.state !== "blocked") return null;
  if (pid !== undefined && raw.pid !== pid) return null;
  if (raw.state === "blocked" && !BLOCKED_CODES.has(raw.code)) return null;
  const partialName = typeof raw.partialName === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(raw.partialName) ? raw.partialName : undefined;
  return {
    state: raw.state,
    code: raw.state === "blocked" ? raw.code : undefined,
    phase: PHASES.has(raw.phase) ? raw.phase : undefined,
    startedAt: num(raw.startedAt),
    updatedAt: num(raw.updatedAt),
    copyBytes: num(raw.copyBytes),
    needBytes: num(raw.needBytes),
    freeBytes: num(raw.freeBytes),
    shortBytes: num(raw.shortBytes),
    newerVersion: num(raw.newerVersion),
    partialName,
  };
}

/** Removes the note (and a temp file its writer left) once the child that wrote
 * it is gone. A stopped or blocked start must not leave it behind: 0.1.61 and
 * earlier do not know the name, and their backups pause on unknown files. */
export function clearMemoryUpgradeStatus(dataDir) {
  try {
    for (const name of readdirSync(dataDir)) {
      if (name === MEMORY_UPGRADE_STATUS_FILE || /^memory-upgrade-status\.json\.\d+\.tmp$/.test(name)) rmSync(path.join(dataDir, name), { force: true });
    }
  } catch { /* absent folder or file */ }
}

/** 0..100 while the copy grows, null when there is nothing to measure yet. */
export function memoryUpgradeProgress(status, dataDir, size = (file) => statSync(file).size) {
  if (!status || status.state !== "upgrading") return null;
  if (status.phase === "migrating") return 95;
  if (status.phase !== "copying" || !status.copyBytes || !status.partialName) return status.phase === "checking" ? 0 : null;
  try { return Math.max(1, Math.min(94, Math.floor((size(path.join(dataDir, status.partialName)) / status.copyBytes) * 100))); } catch { return 1; }
}

/** "1.3 GB" / "640 MB", rounded up so freeing exactly that much is enough. */
export function describeBytes(bytes) {
  const mb = Math.max(1, Math.ceil(bytes / 1048576));
  return mb >= 1024 ? `${(Math.ceil(bytes / 107374182.4) / 10).toFixed(1)} GB` : `${mb} MB`;
}

const TEXT = {
  en: { title: "Upgrading your memory", body: "This can take a minute. Murage opens when it is done. Please keep this window open.", space: "Murage needs more free disk space to upgrade your memory. Free up at least {amount}, then open Murage again. Nothing has been changed.", newer: "Your data was last opened by a newer version of Murage. Install the latest version of Murage to open it.", failed: "Murage could not finish upgrading your memory. Nothing has been changed. Open Murage again, or restore a backup." },
  de: { title: "Dein Gedächtnis wird aktualisiert", body: "Das kann eine Minute dauern. Murage öffnet sich, sobald es fertig ist. Bitte lass dieses Fenster geöffnet.", space: "Murage braucht mehr freien Speicherplatz, um dein Gedächtnis zu aktualisieren. Gib mindestens {amount} frei und öffne Murage dann erneut. Es wurde nichts verändert.", newer: "Deine Daten wurden zuletzt mit einer neueren Version von Murage geöffnet. Installiere die neueste Version von Murage, um sie zu öffnen.", failed: "Murage konnte die Aktualisierung deines Gedächtnisses nicht abschließen. Es wurde nichts verändert. Öffne Murage erneut oder stelle ein Backup wieder her." },
  es: { title: "Actualizando tu memoria", body: "Esto puede tardar un minuto. Murage se abrirá cuando termine. Mantén esta ventana abierta.", space: "Murage necesita más espacio libre en disco para actualizar tu memoria. Libera al menos {amount} y vuelve a abrir Murage. No se ha cambiado nada.", newer: "Tus datos se abrieron por última vez con una versión más reciente de Murage. Instala la última versión de Murage para abrirlos.", failed: "Murage no pudo terminar de actualizar tu memoria. No se ha cambiado nada. Vuelve a abrir Murage o restaura una copia de seguridad." },
  fr: { title: "Mise à niveau de votre mémoire", body: "Cela peut prendre une minute. Murage s'ouvrira dès que ce sera terminé. Gardez cette fenêtre ouverte.", space: "Murage a besoin de plus d'espace disque libre pour mettre votre mémoire à niveau. Libérez au moins {amount}, puis rouvrez Murage. Rien n'a été modifié.", newer: "Vos données ont été ouvertes en dernier par une version plus récente de Murage. Installez la dernière version de Murage pour les ouvrir.", failed: "Murage n'a pas pu terminer la mise à niveau de votre mémoire. Rien n'a été modifié. Rouvrez Murage ou restaurez une sauvegarde." },
  hi: { title: "आपकी मेमोरी अपग्रेड हो रही है", body: "इसमें एक मिनट लग सकता है। पूरा होने पर Murage खुल जाएगा। कृपया यह विंडो खुली रहने दें।", space: "आपकी मेमोरी अपग्रेड करने के लिए Murage को और खाली डिस्क जगह चाहिए। कम से कम {amount} खाली करें, फिर Murage को दोबारा खोलें। कुछ भी नहीं बदला गया है।", newer: "आपका डेटा आखिरी बार Murage के नए संस्करण से खोला गया था। इसे खोलने के लिए Murage का नवीनतम संस्करण इंस्टॉल करें।", failed: "Murage आपकी मेमोरी का अपग्रेड पूरा नहीं कर सका। कुछ भी नहीं बदला गया है। Murage को दोबारा खोलें या कोई बैकअप पुनर्स्थापित करें।" },
  ja: { title: "メモリをアップグレードしています", body: "1分ほどかかることがあります。完了すると Murage が開きます。このウィンドウは開いたままにしてください。", space: "メモリをアップグレードするには、ディスクの空き容量がさらに必要です。{amount}以上の空きを作ってから Murage をもう一度開いてください。何も変更されていません。", newer: "このデータは、より新しいバージョンの Murage で最後に開かれました。開くには最新バージョンの Murage をインストールしてください。", failed: "Murage はメモリのアップグレードを完了できませんでした。何も変更されていません。Murage をもう一度開くか、バックアップを復元してください。" },
  pt: { title: "Atualizando sua memória", body: "Isso pode levar um minuto. O Murage abre quando terminar. Mantenha esta janela aberta.", space: "O Murage precisa de mais espaço livre em disco para atualizar sua memória. Libere pelo menos {amount} e abra o Murage de novo. Nada foi alterado.", newer: "Seus dados foram abertos por último por uma versão mais recente do Murage. Instale a versão mais recente do Murage para abri-los.", failed: "O Murage não conseguiu terminar de atualizar sua memória. Nada foi alterado. Abra o Murage de novo ou restaure um backup." },
  zh: { title: "正在升级你的记忆", body: "这可能需要一分钟。完成后 Murage 会自动打开。请保持此窗口打开。", space: "Murage 需要更多可用磁盘空间来升级你的记忆。请至少腾出 {amount},然后重新打开 Murage。没有任何内容被更改。", newer: "你的数据上次是由更新版本的 Murage 打开的。请安装最新版本的 Murage 来打开它。", failed: "Murage 未能完成记忆升级。没有任何内容被更改。请重新打开 Murage,或恢复备份。" },
};

/** A system language such as "pt-BR" or "ja" to a table key; English when unknown. */
export function memoryUpgradeLocale(language) {
  const code = String(language ?? "").toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(TEXT, code) ? code : "en";
}

/** The sentence the recovery page shows when the upgrade could not run. */
export function memoryUpgradeBlockedSentence(status, language) {
  const text = TEXT[memoryUpgradeLocale(language)];
  if (status?.code === "MEMORY_MIGRATION_DISK_SPACE") return text.space.replace("{amount}", describeBytes(status.shortBytes ?? status.needBytes ?? 0));
  if (status?.code === "MEMORY_SCHEMA_NEWER") return text.newer;
  return text.failed;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The start-up screen: a self-contained data page like the error page, with a
 * progress bar the shell moves by setting `#bar` width (see setMemoryUpgradeProgressScript). */
export function buildMemoryUpgradePage({ language, percent } = {}) {
  const text = TEXT[memoryUpgradeLocale(language)];
  const width = percent === null || percent === undefined ? 8 : Math.max(2, Math.min(100, percent));
  return "data:text/html;charset=utf-8," + encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(text.title)}</title><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div role="status" aria-live="polite" style="text-align:center;max-width:360px;padding:0 16px"><h2 style="font-weight:600;margin:0 0 8px">${escapeHtml(text.title)}</h2><p style="color:#fcfcfc99;line-height:1.5;margin:0 0 20px">${escapeHtml(text.body)}</p><div style="height:6px;border-radius:3px;background:#fcfcfc22;overflow:hidden"><div id="bar" style="height:100%;width:${width}%;background:#fcfcfc;transition:width .4s"></div></div></div></body>`,
  );
}

export const setMemoryUpgradeProgressScript = (percent) => `(()=>{const b=document.getElementById("bar");if(b)b.style.width=${JSON.stringify(`${Math.max(2, Math.min(100, Number(percent) || 2))}%`)}})()`;

/** Polls the note while the child boots. `onUpdate(status|null, percent)` fires on
 * every change; `stop()` ends it. `active()` is true while an upgrade is running,
 * which the boot probe uses to keep waiting past its normal budget. */
export function watchMemoryUpgrade({ dataDir, pid, onUpdate, intervalMs = 400, read = readMemoryUpgradeStatus, progress = memoryUpgradeProgress, setTimer = setInterval, clearTimer = clearInterval }) {
  let last = "";
  let current = null;
  const tick = () => {
    const status = read(dataDir, { pid: typeof pid === "function" ? pid() : pid });
    current = status;
    const percent = progress(status, dataDir);
    const key = JSON.stringify([status?.state, status?.code, status?.phase, percent]);
    if (key !== last) { last = key; try { onUpdate(status, percent); } catch { /* a screen glitch never blocks startup */ } }
  };
  const timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  return { active: () => current?.state === "upgrading", status: () => current, stop: () => clearTimer(timer), tick };
}
