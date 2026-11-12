import { afterEach, describe, expect, it, vi } from 'vitest';
const controlState = vi.hoisted(() => ({ held: false, available: true, helpOpen: false }));
vi.mock('./control-client.ts', () => ({ createControlClient: () => ({ state: async () => controlState }) }));
import { callTool } from './drivers/browser-proxy.ts';
import { WebDocuments } from './web-documents.ts';
import { readWithBrowserAuthority } from './browser-extension-engine-read.ts';
import { droidSupport } from './drivers/acp/droid.ts';

afterEach(() => { controlState.available = true; vi.useRealTimers(); });
describe('G-WEB review regressions', () => {
  it('P1-1 revalidates the host capability for every saved range', async () => {
    let revoked = false;
    const host = vi.fn(async () => { if (revoked) throw Error('capability revoked'); return { url: 'https://a.test', text: 'complete saved page', truncated: false }; });
    const first = JSON.parse(((await callTool('browser_read', { length: 3 }, host)).content[0] as { text: string }).text);
    revoked = true;
    await expect(callTool('browser_read', { handle: first.handle, offset: 3 }, host)).rejects.toThrow('revoked');
    expect(host).toHaveBeenCalledTimes(2);
  });
  it('P1-1 refuses saved text when control verification is unavailable', async () => {
    const host = async () => ({ url: 'https://a.test', text: 'private tail', truncated: false });
    const first = JSON.parse(((await callTool('browser_read', { length: 3 }, host)).content[0] as { text: string }).text);
    controlState.available = false;
    const result = await callTool('browser_read', { handle: first.handle, offset: 3 }, host);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('vate tail');
  });
  it('P1-2 reauthorizes A after the current tab moves to allowed B', async () => {
    const ctx = { documents: new WebDocuments(), currentUrl: 'https://a.test/page', activeHtml: async () => '<p>private tail</p>', authorize: () => true, admitUrl: vi.fn(async (_url: string) => {}) };
    const first = await readWithBrowserAuthority({ length: 3 }, ctx);
    ctx.currentUrl = 'https://b.test';
    ctx.admitUrl.mockImplementation(async url => { if (new URL(url).origin === 'https://a.test') throw Error('Never'); });
    await expect(readWithBrowserAuthority({ handle: first.structuredContent.handle, offset: 3 }, ctx)).rejects.toThrow();
  });
  it('P2 expires idle documents without another read or save', () => {
    vi.useFakeTimers();
    const documents = new WebDocuments();
    documents.save('bot/thread', 'idle secret', 'https://a.test');
    vi.advanceTimersByTime(3_660_000);
    expect((documents as any).entries.size).toBe(0);
  });
  it.each(['index', 'full'] as const)('P2 keeps complete llms %s source behind a filtered view', async llms => {
    const source = '# Intro\nSource context\n\n# Keep\n- [Keep](https://a.test/keep)\n\n# Tail\nGuarantee fine print checkout';
    const ctx = { documents: new WebDocuments(), currentUrl: 'https://a.test', activeHtml: async () => '', authorize: () => true, admitUrl: async () => {}, fetch: vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/markdown' } })) as typeof fetch };
    const view = await readWithBrowserAuthority({ llms, filter: 'Keep' }, ctx);
    expect(view.structuredContent.source_handle).toMatch(/^w-/);
    const full = await readWithBrowserAuthority({ handle: view.structuredContent.source_handle }, ctx);
    expect(full.structuredContent.content).toBe(source);
  });
  it('P1-3 Droid removes native FetchUrl when agents are mounted', () => {
    const args = droidSupport.spawnArgs({} as any, { integrations: { agents: { command: 'fixture', args: [] } } } as any);
    expect(args).toContain('--remove-tools');
    expect(args).toContain('FetchUrl');
  });
});
