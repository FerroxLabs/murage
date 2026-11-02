// Types for the tests that read the desktop's backup notices from TypeScript.
export interface BackupResultNotice { key: string; title: string; body: string }
export declare function backupResultNotice(status: unknown, announcedKey: string | null, folderName?: string | null): BackupResultNotice | null;
export declare function announceBackupResult(input: { status: unknown; folderName?: string | null; userData: string; showNotice?: (notice: BackupResultNotice) => void }): BackupResultNotice | null;
export declare function backupFailureNotice(status: unknown, announcedKey: string | null, folderName?: string | null): { body: Record<string, unknown>; key: string | null };
export declare function announceBackupFailure(input: { status: unknown; folderName?: string | null; userData: string; post: (body: unknown) => Promise<unknown>; showNotice?: (sentence: string) => void }): Promise<Record<string, unknown> | null>;
export declare function readAnnouncedFailure(userData: string): string | null;
export declare function writeAnnouncedFailure(userData: string, key: string): void;
export declare function backupStopCommitted(state: unknown): boolean;
export declare function serialAnnouncer<T>(announce: () => Promise<T>): () => Promise<T>;
