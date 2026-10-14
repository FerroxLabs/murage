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
import { parseUpgradeState } from "../shared/upgrade-contract.mjs";

export const MEMORY_UPGRADE_STATUS_FILE = "memory-upgrade-status.json";
const BLOCKED_CODES = new Set(["MEMORY_MIGRATION_DISK_SPACE", "MEMORY_SCHEMA_NEWER", "MEMORY_MIGRATION_FAILED"]);
const PHASES = new Set(["checking", "copying", "migrating", "indexing", "converting", "repairing", "reclaiming", "message-index", "search-index"]);
const STEPS = new Set(["tables", "indexes", "backfill", "validating", "committing"]);
const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The upgrade reading a note or a 503 health body carries (`upgrade`, shared/upgrade-contract.mjs), parsed: { ok: true, state } or { ok: false, reason }.
 * A server that predates the contract has none ("legacy"): the screens then show activity only. This module does not word anything. */
export function cleanUpgrade(raw) { return raw && typeof raw === "object" && raw.upgrade !== undefined ? parseUpgradeState(raw.upgrade) : { ok: false, reason: "legacy" }; }

/** A note-shaped status from the server's 503 health body (the answer while the server thread is busy). The shell uses it when the note
 * cannot be read: a missing or unwritable note must not blank the screen. */
export function statusFromHealth(body, now = Date.now()) {
  if (!body || body.upgrading !== true) return null;
  const upgrade = cleanUpgrade(body);
  const state = upgrade.ok ? upgrade.state : null;
  return { state: "upgrading", phase: undefined, startedAt: undefined, updatedAt: now, done: state?.step.done, total: state?.step.total, upgrade };
}

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
    done: num(raw.done),
    total: num(raw.total),
    step: STEPS.has(raw.step) ? raw.step : undefined,
    upgrade: cleanUpgrade(raw),
    stepElapsedMs: num(raw.stepElapsedMs),
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

/** 0..100 for the splash bar's key: the server's own launch-wide figure (never backwards within a launch), or the copy's growth; null when there is nothing to measure. */
export function memoryUpgradeProgress(status, dataDir, size = (file) => statSync(file).size) {
  if (!status || status.state !== "upgrading") return null;
  const state = status.upgrade?.ok ? status.upgrade.state : null;
  if (state && typeof state.overall === "number" && state.launch !== "unknown") return Math.max(1, Math.min(99, Math.floor(state.overall * 100)));
  if (status.phase !== "copying" || !status.copyBytes || !status.partialName) return null;
  try { return Math.max(1, Math.min(94, Math.floor((size(path.join(dataDir, status.partialName)) / status.copyBytes) * 100))); } catch { return null; }
}

/** "1.3 GB" / "640 MB", rounded up so freeing exactly that much is enough. */
export function describeBytes(bytes) {
  const mb = Math.max(1, Math.ceil(bytes / 1048576));
  return mb >= 1024 ? `${(Math.ceil(bytes / 107374182.4) / 10).toFixed(1)} GB` : `${mb} MB`;
}

const TEXT = {
  en: { space: "Murage needs more free disk space to upgrade your memory. Free up at least {amount}, then open Murage again. Nothing has been changed.", newer: "Your data was last opened by a newer version of Murage. Install the latest version of Murage to open it.", failed: "Murage paused while updating your memory. Your conversations and memory are still there. Open Murage again and it carries on, or restore a backup.", timeout: "Murage stopped at the time it allows for this step. Open Murage again and it carries on from the last step it finished. If this happens twice, the reason is in {log}." },
  de: { space: "Murage braucht mehr freien Speicherplatz, um dein Gedächtnis zu aktualisieren. Gib mindestens {amount} frei und öffne Murage dann erneut. Es wurde nichts verändert.", newer: "Deine Daten wurden zuletzt mit einer neueren Version von Murage geöffnet. Installiere die neueste Version von Murage, um sie zu öffnen.", failed: "Murage hat die Aktualisierung deines Gedächtnisses pausiert. Deine Unterhaltungen und dein Gedächtnis sind weiterhin da. Öffne Murage erneut, dann geht es weiter, oder stelle ein Backup wieder her.", timeout: "Murage ist bei der Zeitgrenze für diesen Schritt stehen geblieben. Öffne Murage erneut, dann geht es beim letzten abgeschlossenen Schritt weiter. Wenn das zweimal passiert, steht der Grund in {log}." },
  es: { space: "Murage necesita más espacio libre en disco para actualizar tu memoria. Libera al menos {amount} y vuelve a abrir Murage. No se ha cambiado nada.", newer: "Tus datos se abrieron por última vez con una versión más reciente de Murage. Instala la última versión de Murage para abrirlos.", failed: "Murage hizo una pausa mientras actualizaba tu memoria. Tus conversaciones y tu memoria siguen ahí. Vuelve a abrir Murage y continuará, o restaura una copia de seguridad.", timeout: "Murage se detuvo en el tiempo que permite para este paso. Vuelve a abrir Murage y continuará desde el último paso que terminó. Si ocurre dos veces, el motivo está en {log}." },
  fr: { space: "Murage a besoin de plus d'espace disque libre pour mettre ta mémoire à niveau. Libère au moins {amount}, puis rouvre Murage. Rien n'a été modifié.", newer: "Tes données ont été ouvertes en dernier par une version plus récente de Murage. Installe la dernière version de Murage pour les ouvrir.", failed: "Murage a fait une pause pendant la mise à jour de ta mémoire. Tes conversations et ta mémoire sont toujours là. Rouvre Murage et il reprendra, ou restaure une sauvegarde.", timeout: "Murage s'est arrêté au temps qu'il accorde à cette étape. Rouvre Murage et il reprendra à la dernière étape terminée. Si cela se reproduit, la raison se trouve dans {log}." },
  hi: { space: "आपकी मेमोरी अपग्रेड करने के लिए Murage को और खाली डिस्क जगह चाहिए। कम से कम {amount} खाली करें, फिर Murage को दोबारा खोलें। कुछ भी नहीं बदला गया है।", newer: "आपका डेटा आखिरी बार Murage के नए संस्करण से खोला गया था। इसे खोलने के लिए Murage का नवीनतम संस्करण इंस्टॉल करें।", failed: "Murage ने आपकी मेमोरी का अपडेट रोक दिया। आपकी बातचीत और मेमोरी अब भी मौजूद हैं। Murage को दोबारा खोलें, यह आगे बढ़ेगा, या कोई बैकअप पुनर्स्थापित करें।", timeout: "Murage इस चरण के लिए अनुमत समय पर रुक गया। Murage को दोबारा खोलें, यह आख़िरी पूरे हुए चरण से आगे बढ़ेगा। अगर ऐसा दो बार हो, तो कारण {log} में है।" },
  ja: { space: "メモリをアップグレードするには、ディスクの空き容量がさらに必要です。{amount}以上の空きを作ってから Murage をもう一度開いてください。何も変更されていません。", newer: "このデータは、より新しいバージョンの Murage で最後に開かれました。開くには最新バージョンの Murage をインストールしてください。", failed: "Murage はメモリの更新を一時停止しました。会話とメモリはそのまま残っています。Murage をもう一度開くと続きから進みます。バックアップを復元することもできます。", timeout: "Murage はこのステップに許された時間で止まりました。Murage をもう一度開くと、最後に完了したステップから続きます。2回続く場合は、理由が {log} にあります。" },
  pt: { space: "O Murage precisa de mais espaço livre em disco para atualizar sua memória. Libere pelo menos {amount} e abra o Murage de novo. Nada foi alterado.", newer: "Seus dados foram abertos por último por uma versão mais recente do Murage. Instale a versão mais recente do Murage para abri-los.", failed: "O Murage fez uma pausa ao atualizar sua memória. Suas conversas e sua memória continuam aqui. Abra o Murage de novo e ele continua, ou restaure um backup.", timeout: "O Murage parou no tempo que permite para esta etapa. Abra o Murage de novo e ele continua a partir da última etapa concluída. Se acontecer duas vezes, o motivo está em {log}." },
  zh: { space: "Murage 需要更多可用磁盘空间来升级你的记忆。请至少腾出 {amount},然后重新打开 Murage。没有任何内容被更改。", newer: "你的数据上次是由更新版本的 Murage 打开的。请安装最新版本的 Murage 来打开它。", failed: "Murage 在更新记忆时暂停了。你的对话和记忆仍然都在。请重新打开 Murage,它会继续,或恢复备份。", timeout: "Murage 在此步骤允许的时间处停了下来。请重新打开 Murage,它会从上一个完成的步骤继续。如果发生两次,原因记录在 {log}。" },
};

/** A system language such as "pt-BR" or "ja" to a table key; English when unknown. */
export function memoryUpgradeLocale(language) {
  const code = String(language ?? "").toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(TEXT, code) ? code : "en";
}

/** The sentence the recovery page shows when the upgrade could not run. */
export function memoryUpgradeBlockedSentence(status, language, { logPath = "server.log" } = {}) {
  const text = TEXT[memoryUpgradeLocale(language)];
  if (status?.code === "MEMORY_MIGRATION_TIMEOUT") return text.timeout.replace("{log}", logPath);
  if (status?.code === "MEMORY_MIGRATION_DISK_SPACE") return text.space.replace("{amount}", describeBytes(status.shortBytes ?? status.needBytes ?? 0));
  if (status?.code === "MEMORY_SCHEMA_NEWER") return text.newer;
  return text.failed;
}

/** Bytes of the copy written so far (the partial file beside the data), or null when there is nothing to measure. */
export function copiedBytes(status, dataDir, size = (file) => statSync(file).size) {
  if (!status || status.state !== "upgrading" || status.phase !== "copying" || !status.partialName) return null;
  try { return size(path.join(dataDir, status.partialName)); } catch { return null; }
}

/** How long a note may sit unchanged and still count as the upgrade making progress. */
export const UPGRADE_PROGRESS_FRESH_MS = 60_000;

/** Polls the note while the child boots. `onUpdate(status|null, percent)` fires on every change; `onLife` on a heartbeat with no new figure; `onReading`
 * on every look, changed or not (the screen's clock needs to hear a missed one too); `stop()` ends it. `active()` is true while an upgrade is running,
 * which the boot probe uses to keep waiting past its normal budget. */
export function watchMemoryUpgrade({ dataDir, pid, onUpdate, onLife, onReading, intervalMs = 400, read = readMemoryUpgradeStatus, progress = memoryUpgradeProgress, setTimer = setInterval, clearTimer = clearInterval, now = Date.now, freshMs = UPGRADE_PROGRESS_FRESH_MS }) {
  let last = "";
  let current = null;
  // When the child last showed life: a new note (its own updatedAt moved) or a different figure
  // (the copy grew). Measured on THIS clock, so a child with a wrong clock still counts.
  let movedAt = null;
  let seen = "";
  const tick = () => {
    const status = read(dataDir, { pid: typeof pid === "function" ? pid() : pid });
    current = status;
    const percent = progress(status, dataDir);
    // every field the screen shows is part of the key, so a change in any of them reaches the screen (a heartbeat alone does not)
    const u = status?.upgrade?.ok ? status.upgrade.state : null;
    const key = JSON.stringify([status?.state, status?.code, status?.phase, status?.step, percent, status?.upgrade?.ok ?? null, u && [u.launch, u.stage, u.phase, u.overall, u.step, u.eta, u.keepOpen, u.counts, u.held, u.complete, u.checking]]);
    const life = JSON.stringify([key, status?.updatedAt, status?.done, u?.heartbeatAt, u?.seq]);
    const moved = status?.state === "upgrading" && life !== seen;
    if (moved) { seen = life; movedAt = now(); }
    if (key !== last) { last = key; try { onUpdate?.(status, percent); } catch { /* a screen glitch never blocks startup */ } }
    // a heartbeat with no new figure: the screen still hears it (the time left is judged from reading to reading)
    else if (moved && onLife) { try { onLife(status, percent); } catch { /* as above */ } }
    if (onReading) { try { onReading(status, percent); } catch { /* as above */ } }
  };
  const timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  // the server's 503 health answer, used when the note cannot be read (missing or unwritable): the screen keeps moving from it
  const feed = (body) => {
    if (read(dataDir, { pid: typeof pid === "function" ? pid() : pid })) return;
    const fed = statusFromHealth(body, now());
    if (!fed) return;
    current = fed;
    const percent = progress(fed, dataDir);
    const u = fed.upgrade?.ok ? fed.upgrade.state : null;
    const key = JSON.stringify(["fed", u && [u.launch, u.phase, u.overall, u.step, u.eta, u.keepOpen], percent]);
    if (key !== last) { last = key; movedAt = now(); try { onUpdate?.(fed, percent); } catch { /* as above */ } }
    if (onReading) { try { onReading(fed, percent); } catch { /* as above */ } }
  };
  return { feed, active: () => current?.state === "upgrading", fresh: () => current?.state === "upgrading" && movedAt !== null && now() - movedAt <= freshMs, status: () => current, stop: () => clearTimer(timer), tick };
}
