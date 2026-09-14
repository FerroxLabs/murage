import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['server/installation-backup-encryption.test.ts','server/installation-encrypted-backup.test.ts'],setupFiles:['server/testing/setup.ts'],fileParallelism:false,testTimeout:20000,hookTimeout:30000}});
