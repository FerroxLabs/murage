import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/channels/signal/park*.test.ts', 'server/connector-set-aside.test.ts'], fileParallelism: false, setupFiles: ["server/testing/setup.ts"] } });
