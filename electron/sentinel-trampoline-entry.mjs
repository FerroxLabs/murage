// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imported FIRST by electron/main.mjs. A Windows Sentinel task launch (electron/sentinel-trampoline.mjs) runs the
// scanner once and exits here, before any other module of the app is evaluated. Every other launch passes through.
import { isTrampolineLaunch, runTrampoline } from "./sentinel-trampoline.mjs";

if (isTrampolineLaunch(process.argv) && !process.env.ELECTRON_RUN_AS_NODE) process.exit(runTrampoline());
