// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenMausBot v0.1.54; see data-dir-lease.mjs and LICENSE/NOTICE.
export interface DataDirLease {
  readonly ownerPid: number;
  readonly delegated: boolean;
  release(): boolean;
}
export interface OwnedDataDirLease extends DataDirLease {
  readonly delegated: false;
  utilityServerLeaseEnvironment(): Readonly<Record<string, string>>;
}
export interface DelegatedDataDirLease extends DataDirLease {
  readonly delegated: true;
}
export declare class DataDirLeaseError extends Error {
  readonly name: "DataDirLeaseError";
  readonly code: string;
  constructor(code: string);
}
/** Use canonicalDataDir consistently for subsequent I/O when accepting raw
 * aliases; do not lexically re-normalize a symlink/../ path afterward. */
export declare function dataDirLeasePaths(dataDir: string): Readonly<{
  canonicalDataDir: string;
  leasePath: string;
  childLeasePath: string;
}>;
export declare function acquireDataDirLease(dataDir: string): OwnedDataDirLease;
export declare function acquireDataDirLeaseForProcess(
  dataDir: string,
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): OwnedDataDirLease | DelegatedDataDirLease;
