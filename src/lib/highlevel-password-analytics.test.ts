// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), has_opted_out_capturing: () => false }));
vi.mock('posthog-js', () => ({ default: client }));
vi.mock('./native-shell', () => ({ inNativeShell: () => false }));
vi.mock('./analytics-active', () => ({ watchActiveDays() {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
it('R10/R11 analytics startup cannot enable session replay, input snapshots, exception or console capture', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'fixture-public-write-key');
  vi.stubGlobal('navigator', { userAgent: 'Electron fixture' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  const analytics = await import('./analytics'); analytics.initAnalytics();
  await vi.waitFor(() => expect(client.init).toHaveBeenCalledOnce());
  expect(client.init.mock.calls[0]![1]).toMatchObject({ autocapture: false, disable_session_recording: true, capture_exceptions: false, enable_recording_console_log: false });
});
