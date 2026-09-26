export interface BackupSkipped { count: number; items: Array<{ path: string; reason: string }>; bots?: Record<string, string> }
export function backupSkippedLines(skipped: unknown): string[];
