// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// English Help: every catalogue under src/locales/en-help, gathered in one
// read-only table. These words are help only, so they stay out of the first
// paint: this module is reached only through the help copy store
// (src/lib/help-copy-store.ts), which only the help chunk loads
// (src/first-paint.test.ts, HelpHost.lazy.test.ts). Nothing here is merged
// into the English pack or any other pack: a Help key is read from this table
// in English and from that language's Help pack otherwise. Every file in
// en-help/ is listed here (help-copy-store.test.ts fails on one left out).
import screens from "@/locales/en-help/screens.json";

/** A key of the Help partition (type only, erased at build). */
export type HelpKey = keyof typeof screens;

export const enHelp: Readonly<Record<string, string>> = Object.freeze({ ...screens });
