// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T4a positive control (CONTRACTS-B R25): loads the test-hooks addon named by MURAGE_ENGINE_EXCLUSION_PATH and commits one heap bug on
// purpose. The debug CRT hook must end this process with exit code 86. Never run outside the child process of the native test.
import { createRequire } from "node:module";
const addon = createRequire(import.meta.url)(process.env.MURAGE_ENGINE_EXCLUSION_PATH);
addon.anchorTestHeapCanary(process.argv[2]);
console.log("canary returned without ending the process");
