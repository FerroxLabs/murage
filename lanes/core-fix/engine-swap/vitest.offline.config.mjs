const root = new URL("../../../", import.meta.url).pathname;
export default {
  root,
  resolve: { alias: { "@": `${root}src` } },
  test: {
    environment: "node",
    setupFiles: [new URL("./offline-setup.ts", import.meta.url).pathname],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    include: [
      "server/room-dispatcher.test.ts", "server/engine-swap-round2.test.ts", "server/engine-swap-audit.test.ts", "server/engine-swap-fold.test.ts",
      "src/components/engine-swap-notes.test.ts", "scripts/action-guard-sample.test.mjs",
      "server/reply-action-guard.test.ts", "server/engine-swap-core.test.ts",
      "shared/reply-action-claims.test.ts", "shared/chat-engine-notes.test.ts",
      "server/turn-context.test.ts", "server/external-context-delivery.test.ts",
      "server/memory/reveal-capture.test.ts", "server/memory/long-thread-replay.test.ts",
      "server/direct-replay-without-memory.test.ts", "src/lib/activity-runs.test.ts",
      "server/comms-visibility.test.ts",
    ],
  },
};
