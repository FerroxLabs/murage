// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Checked mirror of src/locales: main does not load the renderer catalogues.
const WORDS = {
  en: ["New task for Chief", "Open Needs you", "Pause automations", "Needs you: {count}"],
  de: ["Neue Aufgabe für Chief", "Braucht dich öffnen", "Automatisierungen pausieren", "Braucht dich: {count}"],
  es: ["Nueva tarea para Chief", "Abrir Te necesita", "Pausar automatizaciones", "Te necesita: {count}"],
  fr: ["Nouvelle tâche pour Chief", "Ouvrir À toi", "Mettre les automatisations en pause", "À toi : {count}"],
  hi: ["Chief के लिए नया काम", "आपकी ज़रूरत है खोलें", "ऑटोमेशन रोकें", "आपकी ज़रूरत है: {count}"],
  ja: ["Chiefに新しいタスクを依頼", "「対応待ち」を開く", "自動処理を一時停止", "対応待ち: {count}"],
  "pt-br": ["Nova tarefa para Chief", "Abrir Precisa de você", "Pausar automações", "Precisa de você: {count}"],
  zh: ["给Chief分配新任务", "打开需要你处理", "暂停自动化", "需要你处理：{count}"],
};
export const BADGE_SURFACE_KEYS = Object.freeze([
  "badgeSurfaces.newChief", "badgeSurfaces.openNeedsYou", "badgeSurfaces.pauseAutomations", "badgeSurfaces.needsYouCount",
]);
export function badgeSurfaceText(language, key, values = {}) {
  const index = BADGE_SURFACE_KEYS.indexOf(key);
  const pack = Object.hasOwn(WORDS, language) ? WORDS[language] : WORDS.en;
  return (pack[index] ?? "").replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
