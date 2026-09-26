// Types for the tests that drive the real desktop schedule host from TypeScript.
export declare const BACKUP_SCHEDULE_BINDINGS_KEY: string;
export declare function setUpBackupsRequest(args: unknown[]): { existingKey: boolean } | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function createBackupScheduleHost(host: Record<string, any>): any;
export declare function captureFailureDiagnostic(stage: string, error: unknown): { stage: string; code: string; path?: string };
