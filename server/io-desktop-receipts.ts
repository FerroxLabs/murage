// SPDX-License-Identifier: AGPL-3.0-or-later
// Attach transport owner: electron/sentinel-host.mjs via server/index.ts IPC.
// Server receiver owner: P2; retained names preserve the existing IPC boundary.
export {sentinelIoCovered as desktopIoCovered,sentinelIoReceiver as desktopIoReceiver} from "./sentinel-io-coverage.ts";
