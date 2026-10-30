// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help panel's words. They live in src/locales/en-ux/l4a.json (lane
// prefix ux.l4a.*), which L-COPY-A's loader merges into the English pack, so
// t() answers them, translations included. The screens index names its copy
// by key at run time, so this takes a plain string and shows a missing key as
// itself instead of crashing the panel.
import { t } from "@/lib/i18n";
import { en, type LocaleKey } from "@/locales";

export function hx(key: string, params?: Record<string, string | number>): string {
  return Object.hasOwn(en, key) ? t(key as LocaleKey, params) : key;
}

/** The modifier key as an owner reads it in a sentence ("Cmd K", "Ctrl K"). */
export function modWord(mac: boolean): string {
  return mac ? "Cmd" : "Ctrl";
}
