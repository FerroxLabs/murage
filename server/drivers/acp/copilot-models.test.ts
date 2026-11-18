import { expect, it, vi } from 'vitest';
vi.mock('./core.ts', () => ({ createAcpDriver: (support: unknown) => support }));
vi.mock('./custom-model-catalog.ts', () => ({
  discoverAcpModels: vi.fn(), DISCOVERY_CLIENT_NAME: 'murage-model-discovery',
  AcpDiscoveryRpcError: class extends Error { code: unknown; rpcMessage: string; constructor(code: unknown, message: string) { super(message); this.code = code; this.rpcMessage = message; } },
}));
import { discoverAcpModels, AcpDiscoveryRpcError } from './custom-model-catalog.ts';
import { copilotModelLabel, copilotSignedIn, copilotSupport, resolveCopilotModels } from './copilot.ts';
import { SessionModelControls } from './session-model-controls.ts';

it('keeps premium multipliers and discovers live per-model effort without a startup probe', async () => {
  const catalog = { default: 'auto', options: [{ id: 'auto', label: 'Auto' }, { id: 'deep', label: 'Deep · 2x', variants: [{ id: 'max', label: 'Max' }] }] };
  vi.mocked(discoverAcpModels).mockResolvedValue(catalog);
  expect(copilotSupport.resolveModelsOnCreate).toBe(false);
  await copilotSupport.isAuthenticated({ HOME: '/isolated-unused' }, { cli: 'fake' } as never);
  expect(discoverAcpModels).not.toHaveBeenCalled();
  expect(await resolveCopilotModels({ HOME: '/isolated-models' }, { cli: 'fake' })).toEqual(catalog);
  expect(copilotModelLabel({ id: 'deep', label: 'Deep' }, { configOptions: [{ id: 'model', type: 'select', options: [{ value: 'deep', _meta: { copilotUsage: '2x' } }] }] })).toBe('Deep · 2x');
  expect(copilotSupport.install?.command).toBeUndefined();
});
it('uses an empty discovery for explicit sign-in checks, sharing its result', async () => {
  vi.mocked(discoverAcpModels).mockClear().mockResolvedValue({ default: 'auto', options: [{ id: 'auto', label: 'Auto' }] });
  const env = { HOME: '/isolated-login' };
  expect(await copilotSignedIn(env, { cli: 'fake' })).toBe(true);
  expect(await copilotSignedIn(env, { cli: 'fake' })).toBe(true);
  expect(discoverAcpModels).toHaveBeenCalledTimes(1);
  expect(discoverAcpModels).toHaveBeenCalledWith(env, 'fake', ['--acp', '--stdio'], expect.objectContaining({ variants: false }));
  vi.mocked(discoverAcpModels).mockRejectedValue(new AcpDiscoveryRpcError(-32000, 'Not signed in'));
  expect(await copilotSignedIn({ HOME: '/isolated-expired' }, { cli: 'fake' })).toBe(false);
});
it('falls back to offered Auto and accepts its unset value without weakening explicit model confirmation', async () => {
  const config = (currentValue?: string) => ({ configOptions: [{ id: 'model', type: 'select', currentValue, options: [{ value: 'auto' }, { value: 'deep' }] }] });
  expect(copilotSupport.fallbackModel!(config(), 'withdrawn')).toBe('auto');
  expect(copilotSupport.fallbackModel!({}, 'withdrawn')).toBeNull();
  let state: any = config('deep');
  let model = 'auto';
  const c = new SessionModelControls({ selection: copilotSupport.selectModel, variants: true, displayName: 'Copilot', model: () => model, reportedModel: () => model, state: () => state, store: x => { state = x; }, report: () => {} });
  await expect(c.select(async (_m, _p, _t, receive) => { receive?.(config()); return config(); }, 's', 100)).resolves.toBe('auto');
  model = 'deep';
  await expect(c.select(async () => ({}), 's', 100)).rejects.toThrow('did not switch to deep');
});

it('keeps premium annotations inside the shared ACP label bound', () => {
  const session = (usage: string) => ({ configOptions: [{ id: 'model', type: 'select', options: [{ value: 'deep', _meta: { copilotUsage: usage } }] }] });
  const boundary = { id: 'deep', label: 'x'.repeat(256) };
  expect(copilotModelLabel(boundary, session('2x'))).toHaveLength(256);
  expect(copilotModelLabel(boundary, session('2x'))).toBe(boundary.label);
  expect(copilotModelLabel({ id: 'deep', label: 'Deep' }, session('9'.repeat(256) + 'x'))).toBe('Deep');
  expect(copilotModelLabel({ id: 'deep', label: 'x'.repeat(251) }, session('2x'))).toHaveLength(256);
});
