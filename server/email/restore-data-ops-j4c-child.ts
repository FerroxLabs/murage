// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// J4c test child: runs as whatever uid it is spawned with. "probe LOCK" exits 0 free / 3 busy; "hold LOCK" takes the exclusive hold, prints held (or exits 4), and waits.
import { cloudDataOpsBusy, holdCloudDataOpsLock } from "../cloud-data-ops-lock.ts";
const [mode, lock] = process.argv.slice(2);
if (mode === "probe") process.exit(cloudDataOpsBusy(lock) ? 3 : 0);
const hold = holdCloudDataOpsLock(lock);
if (!hold) process.exit(4);
console.log("held");
setInterval(() => {}, 1000);
