// Isolated runtime files and fake children; no user's app or Signal account.
export default { test: { include: ['scripts/signal-runtime.test.mjs', 'scripts/release-workflows.test.mjs', 'scripts/signal-runtime-publish.test.mjs', 'server/channels/signal/process-host.test.ts'], environment: 'node', maxWorkers: 2 } };
