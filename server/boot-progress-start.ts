// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imported before the rest of the server (index.ts): the start-up note (boot-progress.ts) runs from the first module that does real work
// until listen, so no step before listen is outside it.
import { DATA_DIR } from "./config.ts";
import { bootProgressWanted, startBootProgress } from "./boot-progress.ts";
if (bootProgressWanted()) startBootProgress(DATA_DIR, { step: "modules" });
