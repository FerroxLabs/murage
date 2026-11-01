// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help panel's words for each screen. They are help only, so they stay out
// of the first paint: this module is reached only through screen-envelope.ts,
// which only the help chunk loads (HelpHost.lazy.test.ts). Loading it adds them
// to the English pack, so hx() and t() answer them like any other key, and a
// language pack that carries them still wins. Keys never overlap the pack
// (locale-copy.test.ts).
import { en } from "@/locales";
import screens from "@/locales/en-help/screens.json";

Object.assign(en, screens);
