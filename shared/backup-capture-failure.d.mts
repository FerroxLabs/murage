export interface BackupCaptureFailure { readonly stage: string; readonly code: string; readonly path?: string }
export const BACKUP_CAPTURE_STAGES: readonly string[];
export const BACKUP_CAPTURE_CODES: readonly string[];
export function normalizeCaptureFailure(input: unknown): BackupCaptureFailure | null;
/** A catalogue lookup such as src/lib/i18n t(key, params). Declared as a method so a function over a narrower key
 * type (LocaleKey) can be passed. */
export type BackupTranslate = { lookup(key: string, params?: Record<string, string | number>): string }["lookup"];
export const BACKUP_SENTENCE_KEYS: {
  readonly capture: Readonly<Record<"BACKUP_STARTED_AS_ADMINISTRATOR", "backup.stopped.administrator">>;
  readonly wait: Readonly<Record<"space" | "data" | "dataUnknown" | "spaceUnknown" | "drive" | "busy" | "interrupted", string>>;
};
export const BACKUP_WHOLE_SENTENCE_CODES: readonly string[];
export function backupSentenceKey(code: unknown): string | null;
export function backupNoticeSentence(notice: { sentence?: unknown; code?: unknown } | null | undefined, translate?: BackupTranslate): string;
export function captureFailureSentence(input: unknown, options?: { folderName?: string; translate?: BackupTranslate }): string;
export function backupFolderMissingReason(folderName?: string): string;
export function captureFailurePath(value: unknown): string | undefined;
export function captureFailureReason(code: unknown, path?: unknown): string;
export interface BackupCaptureCause {
  readonly step?: string; readonly errno?: string; readonly syscall?: string; readonly code?: string; readonly innerCode?: string;
  readonly tool?: string; readonly exitCode?: number; readonly signal?: string; readonly toolStep?: string;
  readonly stderr?: string; readonly message?: string; readonly name?: string;
}
export function redactCauseText(value: unknown, max?: number): string | undefined;
export function normalizeCaptureCause(input: unknown): BackupCaptureCause | null;
export function describeCaptureError(error: unknown, step?: string): BackupCaptureCause | null;
export function skippedDisplayPath(value: unknown): string | undefined;
export type BackupUnavailableReason = "tool" | "closing";
export const BACKUP_UNAVAILABLE_SENTENCES: Readonly<Record<BackupUnavailableReason, string>>;
export const BACKUP_UNAVAILABLE_CODES: readonly string[];
export function backupUnavailableCode(reason: unknown): string | null;
export function reviewCaptureFailure(error: string | undefined): { stage: string; code: string };

export type BackupWaitCause = "space" | "drive" | "busy" | "interrupted";
export const BACKUP_WAIT_CAUSES: Readonly<Record<string, BackupWaitCause>>;
export function backupWaitCause(code: unknown): BackupWaitCause | null;
export function backupFailureClass(code: unknown): "wait" | "review";
export const BACKUP_WAIT_TRIGGERS: Readonly<Record<BackupWaitCause, string>>;
export function backupWaitDelayMs(attempts: number): number;
export function backupSizeWords(bytes: unknown): string | null;
export const BACKUP_WAIT_SENTENCES: Readonly<Record<BackupWaitCause | "spaceUnknown" | "data" | "dataUnknown", string>>;
export function backupWaitSentence(wait: unknown, translate?: BackupTranslate): string;

export function delayForStops(stops: number): number;
