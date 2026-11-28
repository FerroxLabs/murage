// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imported before the rest of the server (index.ts): the start-up note (boot-progress.ts) runs from the first module that does real work
// until listen, so no step before listen is outside it.
import { DATA_DIR } from "./config.ts";
import { bootProgressWanted, startBootProgress } from "./boot-progress.ts";
// MURAGE_BOOT_PROGRESS_INTERVAL_MS: a shorter beat for a source run that asked for the note itself (MURAGE_BOOT_PROGRESS=1, tests that watch
// a step move); the desktop shell's children always beat at the default.
const beat = process.env.MURAGE_BOOT_PROGRESS === "1" ? Number(process.env.MURAGE_BOOT_PROGRESS_INTERVAL_MS) : NaN;
if (bootProgressWanted()) startBootProgress(DATA_DIR, { step: "modules", ...(Number.isInteger(beat) && beat >= 10 && beat <= 2_000 ? { intervalMs: beat } : {}) });
