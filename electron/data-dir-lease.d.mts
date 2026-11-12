// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenMausBot v0.1.54; see data-dir-lease.mjs and LICENSE/NOTICE.
export interface DataDirLease {
  readonly ownerPid: number;
  readonly delegated: boolean;
  release(): boolean;
}
export interface ExitedServerChild {
  readonly pid: number;
  readonly code: number | null;
}
export interface OwnedDataDirLease extends DataDirLease {
  release(options?: { exitedChildren?: readonly ExitedServerChild[] }): boolean;
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

export declare function dataDirIdentity(canonical: string, platform?: NodeJS.Platform): string;
export declare function bootSession(): string | null;
export declare function uptimeMs(): number | null;
export declare function linuxProcStat(pid: number): [string, string] | null;
export declare function processIsAlive(pid: number): boolean;
export declare function probeProcessStartSync(pid: number): string | null;

export declare function currentDataDirLeaseEpoch(dataDir: string): string | null;

export declare function validProcessStart(value: unknown, platform?: NodeJS.Platform): boolean;
export declare function localHost(): string;
export declare function sameMachine(record: {host:string;boot?:string|null}, host?:string, boot?:string|null): boolean;
export declare function validBoot(value:unknown): boolean;
export declare function validUptime(value:unknown): boolean;
export declare function provedOwnerReboot(owner: {boot?:string|null;uptime?:number|null}, boot?:string|null, uptimeValue?:number|null): boolean;
