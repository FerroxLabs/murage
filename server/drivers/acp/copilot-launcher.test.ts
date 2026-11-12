import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { CopilotMcpConfig } from './copilot-mcp-config.ts';
it('writes private per-thread launcher files containing only this turns scoped tools and refreshes credentials', async () => {
  const config = await CopilotMcpConfig.create();
  let path = '';
  try {
    path = config.prepare('../thread-a', [{ name: 'agents', command: 'node', args: ['proxy.ts'], env: [{ name: 'TOKEN', value: 'fake-first' }] }]);
    const read = () => JSON.parse(readFileSync(path, 'utf8'));
    expect(read()).toEqual({ mcpServers: { agents: { type: 'local', command: 'node', args: ['proxy.ts'], env: { TOKEN: 'fake-first' }, tools: ['*'] } } });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).uid).toBe(process.getuid!());
      expect(statSync(dirname(path)).uid).toBe(process.getuid!());
    }
    const other = config.prepare('thread-b', []);
    expect(other).not.toBe(path);
    expect(JSON.parse(readFileSync(other, 'utf8'))).toEqual({ mcpServers: {} });
    const refreshed = config.prepare('../thread-a', [{ name: 'agents', command: 'node', args: [], env: [{ name: 'TOKEN', value: 'fake-refreshed' }] }]);
    expect(refreshed).not.toBe(path);
    const readRefreshed = () => JSON.parse(readFileSync(refreshed, 'utf8'));
    expect(readRefreshed().mcpServers.agents.env).toEqual({ TOKEN: 'fake-refreshed' });
    expect(Object.keys(readRefreshed())).toEqual(['mcpServers']);
    expect(read().mcpServers.agents.env).toEqual({ TOKEN: 'fake-first' });
  } finally { await config.dispose(); }
  expect(existsSync(path)).toBe(false);
});
