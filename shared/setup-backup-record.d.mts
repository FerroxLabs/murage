export declare const SETUP_BACKUP_FILE_NAME: "setup-backup.json";
export declare const SETUP_BACKUP_MAX_BYTES: number;
export interface SetupBackupRecord { version: 2; owed: boolean; ending: "verified" | "off" | null; at: number }
export type SetupBackupRecordRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "record"; record: SetupBackupRecord };
export declare function parseSetupBackupRecord(text: string): SetupBackupRecord | null;
export declare function readSetupBackupRecord(dataDir: string): SetupBackupRecordRead;
