// SPDX-License-Identifier: AGPL-3.0-or-later
// Declarations for shared/sentinel-installation.mjs: the opaque Sentinel installation id (1.0.9).
export const SENTINEL_INSTALLATION_DOMAIN: "murage-sentinel-installation-v1";
export function sentinelInstallationIdOf(canonicalDataDir: string): string;
export function sentinelInstallationId(dataDir: string): string | null;
