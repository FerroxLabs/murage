// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings' own words (the lazy pack src/locales/en-settings/settings.json, loaded with the Settings chunk by
// lib/settings-copy.ts). `t` is typed over en.json alone, so a key that lives in the lazy pack is read through `sw`.
// Every new Settings string goes in the lazy pack (SettingsCopy.lazy.test.ts) and is read with sw().
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

export function sw(key: string, params?: Record<string, string | number>): string {
  return t(key as LocaleKey, params);
}
