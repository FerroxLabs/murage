// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings' and the model picker's words (1.0.19, SETTINGS-ENGINES-1019 8.1).
// They are shown only inside Settings or the picker's dialog, so they stay out
// of the first paint: this module is imported only by the Settings chunk
// (SettingsModal.tsx) and the picker dialog (ModelPickerDialog.tsx), both lazy
// (SettingsCopy.lazy.test.ts, first-paint.test.ts). Loading it adds them to the
// English pack, so t() answers them like any other key, and a language pack
// that carries them still wins (the other seven packs translate them like any
// en.json string: scripts/generate-locale.mjs reads this pack as English).
// Keys never overlap en.json (locale-copy.test.ts). The same pattern as
// help-screen-copy.ts.
import { en } from "@/locales";
import settings from "@/locales/en-settings/settings.json";
import picker from "@/locales/en-settings/picker.json";

Object.assign(en, settings, picker);
