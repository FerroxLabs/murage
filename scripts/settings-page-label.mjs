// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one reader of the sidebar word for a Settings page, shared by build-capabilities.mjs and build-capability-db.mjs so
// neither can drift from settingsPageLabel() in src/lib/settings-sections.ts: the plain English kept in V10_ENGLISH for the
// ids v10 added (no locale key), else settings.page.<id>, where WORDS_OF maps an id onto an older page's words (Rules is
// Bot defaults, Messaging is Messaging apps).
export function settingsPageWords(sectionsSource, en) {
  const v10 = sectionsSource.indexOf("const V10_ENGLISH");
  const english = new Map([...(v10 < 0 ? "" : sectionsSource.slice(v10).split("};")[0]).matchAll(/^\s*([A-Za-z]+): \{ label: "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const wordsOf = new Map([...(sectionsSource.match(/const WORDS_OF[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "").matchAll(/([A-Za-z]+): "([A-Za-z]+)"/g)].map((m) => [m[1], m[2]]));
  return {
    /** The label settingsPageLabel(id) renders, or undefined when neither source has one. */
    label: (id) => english.get(id) ?? en[`settings.page.${wordsOf.get(id) ?? id}`],
    /** The older settings.section.<id> word (the docs may still use it), under the same mapping. */
    legacy: (id) => (english.has(id) ? undefined : en[`settings.section.${wordsOf.get(id) ?? id}`]),
    /** The label settingsSectionLabel(id) renders (aliases keep a settings.section.<id> word), under the same mapping. */
    section: (id) => english.get(id) ?? en[`settings.section.${wordsOf.get(id) ?? id}`],
    describeSection: (id) => `neither V10_ENGLISH nor settings.section.${wordsOf.get(id) ?? id}`,
    describe: (id) => `neither V10_ENGLISH nor settings.page.${wordsOf.get(id) ?? id}`,
  };
}
