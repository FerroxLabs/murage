// SPDX-License-Identifier: AGPL-3.0-or-later
// Launcher/descriptor producer owners: Electron, installer and Cloud hosts.
// Census and consumer coverage owner: P2. External schedules have no receipts.
export interface SentinelLauncher {
 route?:"autostart"|"scan-child"|"probe";
 site:string;
 mode:"--once"|"--watch"|"--check-install";
 attach:"ipc-receipts"|"none";
 descriptorFirst:string;
}
export const SENTINEL_LAUNCHERS:readonly SentinelLauncher[]=Object.freeze([
 {site:"deploy/cloud-home/murage-sentinel.service:ExecStart",mode:"--once",attach:"none",descriptorFirst:"deploy/cloud-home/murage-sentinel.service:ExecStartPre="},
 {site:"installer/lib/sentinel.mjs:sentinelWatchSpec-definition#1",mode:"--watch",attach:"none",descriptorFirst:"installer/lib/sentinel.mjs:const written = b.writeDescriptor(next, { platform });"},
 {site:"installer/bin/murage.mjs:sentinelWatchSpec#1",mode:"--watch",attach:"none",descriptorFirst:"installer/lib/sentinel.mjs:const written = b.writeDescriptor(next, { platform });"},
 {site:"electron/sentinel-host.mjs:spawnProcess#1",mode:"--watch",attach:"ipc-receipts",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {site:"electron/sentinel-trampoline.mjs:spawn#1",mode:"--once",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {site:"electron/sentinel-schedule.mjs:sentinelInvocation#1",mode:"--once",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {site:"electron/sentinel-schedule.mjs:sentinelInvocation#2",mode:"--once",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {route:"autostart",site:"electron/sentinel-schedule.mjs:sentinelInvocation#3",mode:"--watch",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {site:"electron/sentinel-schedule.mjs:sentinelInvocation#4",mode:"--once",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
 {route:"scan-child",site:"server/sentinel/supervisor.ts:spawn#1",mode:"--once",attach:"ipc-receipts",descriptorFirst:"server/sentinel/cli.ts:const loaded = loadDescriptor(args.descriptor, { create: false });"},
 {route:"probe",site:"electron/sentinel-host.mjs:execFile#1",mode:"--check-install",attach:"none",descriptorFirst:"electron/sentinel-schedule.mjs:if (!boundary.writeDescriptor(next, { platform }).ok)"},
]);
