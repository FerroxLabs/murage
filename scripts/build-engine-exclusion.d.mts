export const RELEASE_CL_FLAGS: readonly string[];
export const TEST_HOOKS_CL_FLAGS: readonly string[];
export function buildEngineExclusion(options?: { platform?: string; testHooks?: boolean; allArch?: boolean; clFlags?: string[]; environmentFile?: string; headerDirectory?: string; outputRoot?: string; env?: NodeJS.ProcessEnv; exec?: unknown }): unknown;
