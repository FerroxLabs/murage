export class DataDirMigrationError extends Error {
  readonly name: "DataDirMigrationError";
  readonly code: "PERSISTED_STATE_RECOVERY_REQUIRED";
  readonly filePath: string;
  readonly reason: "unreadable" | "invalid-shape" | "migration-failed";
  readonly readErrorCode?: string;
  constructor(filePath: string, reason: "unreadable" | "invalid-shape" | "migration-failed", error?: unknown);
}

export function migrateLegacyDataDirectory(options: {
  dataDir: string;
  legacyDataDir: string;
  enabled: boolean;
}): boolean;
