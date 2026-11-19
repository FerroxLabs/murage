// SPDX-License-Identifier: AGPL-3.0-or-later
import {isMainThread} from "node:worker_threads";
import {ensureIoMeter, installCopyMeter} from "./io-meter.ts";
installCopyMeter();
// METERORDER: the main thread loads and publishes the meter hand-off here, the first server module that does work (index.ts imports this before
// boot-progress-start and everything else). A Worker copies environment data when it is created, so one started before the hand-off can never
// receive it later and runs unmetered for its whole life (enforcement callers then fail closed with BG_ENFORCEMENT_UNAVAILABLE).
if(isMainThread)ensureIoMeter();
import {installChildProcessMeter} from "./io-child-meter.ts";
installChildProcessMeter();

import {enableDefaultSentinelCoverage} from "./sentinel-file-sampling.ts";
enableDefaultSentinelCoverage();
