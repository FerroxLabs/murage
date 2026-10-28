// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one bundled boundary the Electron host loads (1.0.9, GAP-SENTINEL-109 sections 3.3, 6.4 and 11 lane C):
// scripts/bundle-server.mjs emits it as dist-server/health/host-boundary.js, and electron/sentinel-host.mjs imports
// that file from the packaged resources. It re-exports the SAME producer root/publication code the server uses (so the
// desktop never carries its own copy of the `health/` rules), the descriptor writer and guards from the scanner, and
// the scanner's registration proof (checkInstall). Nothing here starts a server, opens the live database, loads a
// driver or reads credentials.
export { HealthPublisher, startHealthProducer, stopHealthProducer, publishWindows, type HealthRootState, type ProducerRuntime } from "./publisher.ts";
export { HealthCounters } from "./counters.ts";
export { backupOutcome, createBackupStatusProducer } from "./backup-status.ts";
export { HEALTH_DIR, HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
export { sentinelInstallationId } from "../../shared/sentinel-installation.mjs";
export {
  DESCRIPTOR_FILE, DESCRIPTOR_VERSION, OUTPUT_PARENT,
  defaultOutputRoot, ensureOutputRoot, loadDescriptor, sourcePaths, validateDescriptor, writeDescriptor,
  type SentinelDescriptor,
} from "../sentinel/paths.ts";
export { checkInstall, registrationMatches, type RegistrationState, type CheckInstallReport } from "../sentinel/cli.ts";
export { EXIT } from "../sentinel/supervisor.ts";
export { currentUserSid } from "../sentinel/win-acl.ts";
