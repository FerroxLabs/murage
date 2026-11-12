export function installWindowsHide(cp: typeof import('node:child_process'), syncExports: () => void): void;
export const windowsHidePrelude: string;
export const windowsHideImport: string;
export function withHideInherit<const T extends import('node:child_process').SpawnOptions | import('node:worker_threads').WorkerOptions | null | undefined>(options: T): T;

export function stripNodeOptionsExceptHide(value: string | undefined, platform?: NodeJS.Platform): string;
