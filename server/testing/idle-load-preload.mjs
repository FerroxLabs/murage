// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// For a test that spawns the server: report the computer as idle to the owner-first gate (owner-first.ts, system-load.ts).
// An automatic run (a webhook delivery, a schedule) is held back while the whole machine is overloaded, for up to
// OWNER_FIRST_MAX_DEFER_MS (120 s). A test that waits seconds for such a run to start is then timing the CI runner's load, not
// the product. The server reads load through node:os (loadavg and cpus times); this answers both as an idle machine, so the gate
// admits on its other reasons only (an owner turn, typing, a start in flight), which the test controls itself.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const idleCpu = { model: "idle", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 1, irq: 0 } };
os.loadavg = () => [0, 0, 0];
os.cpus = () => [idleCpu];
syncBuiltinESMExports();
