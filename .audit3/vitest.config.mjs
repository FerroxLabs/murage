export default {
  root: new URL('../', import.meta.url).pathname,
  test: { environment: 'node', setupFiles: ['lanes/core-fix/engine-swap/offline-setup.ts'], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000,
    include: ['server/engine-swap-round3.test.ts', 'server/engine-swap-fold.test.ts', 'server/engine-swap-round2.test.ts', 'server/reply-action-guard.test.ts', 'shared/reply-action-claims.test.ts'] },
};
