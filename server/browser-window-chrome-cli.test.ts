import { removeTempDirSync } from "./testing/cleanup.ts";
import { expect, it, vi } from 'vitest';
import { windowChromeCheck } from './browser-window-chrome-cli.ts';
import type { createWindowChromeResolver, WindowChromeResult } from './browser-window-chrome.ts';
import { WINDOW_CHROME_VALIDATED } from './browser-window-validated.ts';
it('the maintainer check defaults to local and only --download authorizes the download', async () => {
  const resolve = vi.fn(async (): Promise<WindowChromeResult> => ({ cause: 'not_installed', detail: 'Pop out view is ready.' })), download = vi.fn(async (): Promise<WindowChromeResult> => ({ cause: 'not_installed', detail: 'Pop out view is ready.' }));
  const factory = vi.fn((_options?: Parameters<typeof createWindowChromeResolver>[0]) => ({ resolve, download }));
  expect(await windowChromeCheck(['--window-chrome-check'], { env: {}, factory })).toHaveProperty('cause'); expect(resolve).toHaveBeenCalledWith({ mode: 'local' }); expect(download).not.toHaveBeenCalled();
  await windowChromeCheck(['--window-chrome-check', '--prepare'], { env: {}, factory }); expect(resolve).toHaveBeenLastCalledWith({ mode: 'prepare' });
  await windowChromeCheck(['--window-chrome-check', '--download'], { env: {}, factory }); expect(download).toHaveBeenCalledWith(expect.objectContaining({ ownerRequested: true }));
});
it('refuses Cloud before loading a test list or invoking the resolver', async () => {
  const factory = vi.fn(), readList = vi.fn();
  expect(await windowChromeCheck(['--window-chrome-check', '--validated', 'test.json'], { env: { MURAGE_CLOUD_ROLE: 'home' }, factory, readList })).toHaveProperty('cause', 'cloud_home'); expect(factory).not.toHaveBeenCalled(); expect(readList).not.toHaveBeenCalled();
});
it('accepts only a complete validated file and never modifies shipped eligibility', async () => {
  const resolve = vi.fn(async (): Promise<WindowChromeResult> => ({ cause: 'not_installed', detail: '' })), factory = vi.fn((_options?: Parameters<typeof createWindowChromeResolver>[0]) => ({ resolve, download: resolve }));
  await windowChromeCheck(['--window-chrome-check', '--validated', 'test.json'], { env: {}, factory, readList: () => JSON.stringify(WINDOW_CHROME_VALIDATED) });
  expect(factory.mock.calls[0][0]?.validated).toEqual(WINDOW_CHROME_VALIDATED);
  await expect(windowChromeCheck(['--window-chrome-check', '--validated', 'bad.json'], { env: {}, factory, readList: () => '{}' })).rejects.toThrow();
  await expect(windowChromeCheck(['--window-chrome-check', '--wat'], { env: {}, factory })).rejects.toThrow();
});
it('runs the source maintainer command before any server or data initialization', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dataDir = mkdtempSync(join(tmpdir(), 'window-chrome-cli-'));
  try {
    const output = execFileSync(process.execPath, ['--experimental-strip-types', 'server/index.ts', '--window-chrome-check'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MURAGE_DATA_DIR: dataDir, DISPLAY: '', WAYLAND_DISPLAY: '' } });
    expect(JSON.parse(output)).toHaveProperty('cause'); expect(readdirSync(dataDir)).toEqual([]);
  } finally { removeTempDirSync(dataDir); }
});
