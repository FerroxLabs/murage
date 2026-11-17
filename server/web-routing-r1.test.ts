import { expect, it } from 'vitest';
import { qwenIsolationArgs } from './drivers/acp/qwen.ts';
import { copilotSupport } from './drivers/acp/copilot.ts';
import { applyOpenCodeTurnPermission } from './drivers/acp/opencode-go.ts';
it('Qwen excludes the native page fetch', () => {
  expect(qwenIsolationArgs(['agents'], '0.25.3').join(' ')).toContain('--exclude-tools=web_fetch');
});
it('Copilot excludes native web_fetch', () => {
  expect(copilotSupport.spawnArgs({} as any, { integrations: { agents: {} } } as any).join(' ')).toContain('--excluded-tools=web_fetch');
});
it('OpenCode excludes native webfetch even with a personal allow', () => {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { webfetch: 'allow' } }) };
  applyOpenCodeTurnPermission(env);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  expect(config.permission.webfetch).toBe('deny');
  for (const agent of Object.values(config.agent) as any[]) expect(agent.permission.webfetch).toBe('deny');
});
