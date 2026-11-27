// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 N2 bootprog: the words for the inner step a slow start is in. The server's start-up note (server/boot-progress.ts) names a fixed
// step id and a sequence number; the shell reads it for its wait (boot-progress-watch.mjs) and, after the first 5 s, the start screen shows
// one quiet line from it: "Step 37 · Opening your memory". The step id is never shown (plain words only, designs/MURAGE-UX-BAR.md): it is
// placed in one of ten families by its prefix, in the eight shipped languages. A fast start never shows it.
import { memoryUpgradeLocale } from "./memory-upgrade-status.mjs";

/** How long a start runs before the start screen names its inner step: a fast start looks as before. */
export const BOOT_STEP_SHOW_AFTER_MS = 5_000;

// first match wins: the note's step id (sanitised to [A-Za-z0-9._:-] by the server) to a family
const FAMILIES = [
  [/^database\.wal\b/, "wal"],
  [/^(database\.memory|validateMemorySchema)\b/, "memory"],
  [/^migrate\./, "update"],
  [/^database\./, "conversations"],
  [/^teams\./, "teams"],
  [/^(store|projects)\./, "projects"],
  [/^routines\./, "routines"],
  [/^(channels|sends|venue)\./, "messages"],
  [/^skillSweep\b/, "skills"],
];

export const BOOT_STEP_TEXT = Object.freeze({
  en: { step: "Step", wal: "Finishing what was saved last time", memory: "Opening your memory", update: "Updating your data for this version", conversations: "Opening your conversations",
    teams: "Loading your teams", projects: "Loading your projects", routines: "Loading your routines", messages: "Checking your messages", skills: "Checking your skills", other: "Getting things ready" },
  de: { step: "Schritt", wal: "Zuletzt Gespeichertes wird abgeschlossen", memory: "Dein Gedächtnis wird geöffnet", update: "Deine Daten werden für diese Version aktualisiert", conversations: "Deine Unterhaltungen werden geöffnet",
    teams: "Deine Teams werden geladen", projects: "Deine Projekte werden geladen", routines: "Deine Routinen werden geladen", messages: "Deine Nachrichten werden geprüft", skills: "Deine Skills werden angesehen", other: "Alles wird vorbereitet" },
  es: { step: "Paso", wal: "Terminando lo que se guardó la última vez", memory: "Abriendo tu memoria", update: "Actualizando tus datos para esta versión", conversations: "Abriendo tus conversaciones",
    teams: "Cargando tus equipos", projects: "Cargando tus proyectos", routines: "Cargando tus rutinas", messages: "Revisando tus mensajes", skills: "Revisando tus habilidades", other: "Preparando todo" },
  fr: { step: "Étape", wal: "Fin de ce qui a été enregistré la dernière fois", memory: "Ouverture de ta mémoire", update: "Mise à jour de tes données pour cette version", conversations: "Ouverture de tes conversations",
    teams: "Chargement de tes équipes", projects: "Chargement de tes projets", routines: "Chargement de tes routines", messages: "Vérification de tes messages", skills: "Examen de tes compétences", other: "Préparation de tout" },
  hi: { step: "चरण", wal: "पिछली बार सहेजा गया काम पूरा हो रहा है", memory: "आपकी मेमोरी खुल रही है", update: "आपका डेटा इस वर्शन के लिए अपडेट हो रहा है", conversations: "आपकी बातचीत खुल रही है",
    teams: "आपकी टीमें लोड हो रही हैं", projects: "आपके प्रोजेक्ट लोड हो रहे हैं", routines: "आपके रूटीन लोड हो रहे हैं", messages: "आपके संदेश देखे जा रहे हैं", skills: "आपके स्किल देखे जा रहे हैं", other: "सब कुछ तैयार हो रहा है" },
  ja: { step: "ステップ", wal: "前回保存した内容を仕上げています", memory: "メモリを開いています", update: "このバージョン用にデータを更新しています", conversations: "会話を開いています",
    teams: "チームを読み込んでいます", projects: "プロジェクトを読み込んでいます", routines: "ルーティンを読み込んでいます", messages: "メッセージを確認しています", skills: "スキルを確認しています", other: "準備しています" },
  pt: { step: "Etapa", wal: "Concluindo o que foi salvo da última vez", memory: "Abrindo sua memória", update: "Atualizando seus dados para esta versão", conversations: "Abrindo suas conversas",
    teams: "Carregando suas equipes", projects: "Carregando seus projetos", routines: "Carregando suas rotinas", messages: "Conferindo suas mensagens", skills: "Conferindo suas habilidades", other: "Preparando tudo" },
  zh: { step: "步骤", wal: "正在完成上次保存的内容", memory: "正在打开你的记忆", update: "正在为此版本更新你的数据", conversations: "正在打开你的对话",
    teams: "正在加载你的团队", projects: "正在加载你的项目", routines: "正在加载你的例行任务", messages: "正在检查你的消息", skills: "正在检查你的技能", other: "正在准备" },
});

/** The family of a step id ("other" for anything not listed). */
export function bootStepFamily(step) {
  const id = typeof step === "string" ? step : "";
  for (const [pattern, family] of FAMILIES) if (pattern.test(id)) return family;
  return "other";
}

/** The start screen's line for one reading of the note (boot-progress-watch.mjs readBootProgress), or null: no note, no step number, or a
 * start still inside its first BOOT_STEP_SHOW_AFTER_MS. */
export function bootStepLine(status, { language, sinceMs = 0 } = {}) {
  if (!status || !Number.isInteger(status.seq) || !(sinceMs >= BOOT_STEP_SHOW_AFTER_MS)) return null;
  const table = BOOT_STEP_TEXT[memoryUpgradeLocale(language)] ?? BOOT_STEP_TEXT.en;
  return `${table.step} ${status.seq} · ${table[bootStepFamily(status.step)]}`;
}
