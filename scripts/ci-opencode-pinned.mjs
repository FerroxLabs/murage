import { spawnSync } from 'node:child_process';
// The engine CI lane must supply the exact externally provisioned binary.
// The test itself verifies its version and digest before any ACP exchange.
if (!process.env.MURAGE_OPENCODE_PINNED_BIN) {
  process.stderr.write('MURAGE_OPENCODE_PINNED_BIN is required for the pinned engine gate.\n');
  process.exit(1);
}
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'server/drivers/acp/opencode-pinned-catalog.test.ts', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
