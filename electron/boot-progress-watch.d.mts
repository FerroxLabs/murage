export const BOOT_PROGRESS_FILE: string;
export const BOOT_PROGRESS_FRESH_MS: number;
export const BOOT_STEP_STALL_MS: number;
export interface BootProgressStatus { pid: unknown; step?: string; seq?: number; updatedAt?: number; startedAt?: number }
export function readBootProgress(dataDir: string, options?: { pid?: number }): BootProgressStatus | null;
export function watchBootProgress(options: {
  dataDir: string;
  pid: number | undefined | (() => number | undefined);
  intervalMs?: number;
  read?: (dataDir: string, options: { pid?: number }) => BootProgressStatus | null;
  setTimer?: (tick: () => void, intervalMs: number) => unknown;
  clearTimer?: (timer: any) => void;
  now?: () => number;
  freshMs?: number;
  stepStallMs?: number;
  onStatus?: (status: BootProgressStatus) => void;
}): { tick(): void; status(): BootProgressStatus | null; fresh(): boolean; stop(): void };
