/** vitest files run under server/testing/setup.ts: HOME is a mkdtemp under os.tmpdir(), MURAGE_DATA_DIR is deleted before any
 *  import, and installSafeWipeGuard() makes every recursive fs delete refuse the account's real ~/.murage, any home, the
 *  checkout and live leases. Shared by data-safety.test.ts and temp-cleanup-guard.test.ts so the two guards agree on it. */
export const VITEST_INCLUDE: RegExp[] = [/^server\/.*\.test\.ts$/, /^electron\/.*\.test\.mjs$/, /^src\/.*\.test\.ts$/, /^shared\/.*\.test\.ts$/, /^companion\/.*\.test\.ts$/, /^scripts\/.*\.test\.mjs$/, /^tools\/.*\.test\.ts$/];

/** The test files whose temp-dir removals must go through server/testing/cleanup.ts (removeTempDir / removeTempDirSync).
 *  electron/ is left out on purpose: its suites also run under plain node --test, which cannot load a .ts helper. */
export const TEMP_CLEANUP_SCOPE: RegExp[] = [/^(?:server|src|shared|companion|tools|scripts)\/.*\.test\.(?:ts|tsx|mjs)$/];
