import { expect, it, vi } from 'vitest';
const admission = vi.hoisted(() => {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), blocked: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() };
});
vi.mock('./browser-sandbox.ts', () => ({ ensureBrowserSandboxAccess: async () => { admission.enter(); await admission.blocked; } }));
import { createNativeBrowser } from './browser-native-relay.ts';
import { ownedCloseCli } from './browser-owned-close.ts';
it('T17 late native preparation cannot spawn after close acknowledgement', async () => {
  const native = createNativeBrowser({ command: '/nonexistent/must-not-spawn-after-close', args: [], env: { AGENT_BROWSER_SOCKET_DIR: '/nonexistent/murage-fixture', AGENT_BROWSER_SESSION: 'race' } });
  const command = native.command(['open', 'about:blank']);
  const outcome = command.catch(error => error);
  const close = vi.spyOn(ownedCloseCli, 'run').mockResolvedValue({ code: 0, stdout: JSON.stringify({
    launchId: null, closed: true, path: 'not_running', groupExhausted: true,
    treeExhausted: false, outsideSeen: 0, unconfirmed: null,
  }) });
  try {
    await admission.entered; await native.close(); admission.release();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await outcome).toMatchObject({ code: 'browser_closing' });
  } finally { admission.release(); close.mockRestore(); }
});
