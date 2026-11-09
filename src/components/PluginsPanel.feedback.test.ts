// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginsPanel, FLUXROUTER_BILLING_URL } from "./PluginsPanel";
import { setLocale, t } from "@/lib/i18n";

vi.mock("./LayerSlot", () => ({ useLayerContainer: () => ({ active: true }), useLayerOwner: () => null }));
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as Array<() => unknown>, api: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[i], (value: any) => { hooks.values[i] = typeof value === "function" ? value(hooks.values[i]) : value; }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    return hooks.values[i] ??= { current: initial };
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => { hooks.effects.push(fn); },
}));
vi.mock("@/state/store", () => ({ api: hooks.api, useStore: () => ({ state: { config: { flux: { configured: true } } }, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => false }));
vi.mock("@/lib/connected-apps-preload", () => ({
  cachedConnectorStatus: {}, cachedConnectorStatusAuthoritative: true, inventoryApps: {},
  isCredentialStoreUnreadable: () => false, rememberConnectedApps: vi.fn(), pendingConnectedApps: () => null, preloadConnectedApps: async () => ({ services: {}, authoritative: true, backendReady: true }),
}));
function find(node: ReactNode, predicate: (el: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement(node)) return;
  const el = node as ReactElement<any>;
  return predicate(el) ? el : find(el.props.children, predicate);
}
function render() { hooks.cursor = 0; hooks.effects = []; return PluginsPanel(); }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function mount() {
  render();
  // Run only the catalog mount effect: other effects manage unrelated DOM listeners.
  const effect = hooks.effects.find(fn => fn.toString().includes('/api/connectors/catalog/cached'))!;
  expect(effect).toBeDefined();
  const cleanup = effect() as () => void;
  await settle();
  return cleanup;
}
beforeEach(() => {
  hooks.values = [];
  hooks.api.mockReset().mockImplementation(async (path: string) => path.endsWith('/cached') ? { held: false } : path.includes('/catalog') ? {
    configured: false, cards: [], fluxBrokerEnabled: true, fluxConfigured: true,
    migration: { state: "none", legacyUntil: null, tokenError: "flux_key_budget_exhausted" },
  } : { services: {} });
  vi.stubGlobal("window", { open: vi.fn(() => null) });
});
afterEach(async () => { vi.unstubAllGlobals(); await setLocale("en"); });
it("renders an alert when the billing popup is blocked", async () => {
  await mount();
  find(render(), el => el.type === 'button' && el.props.children === t('connectedApps.flux.tokenBudgetButton'))!.props.onClick();
  await settle();
  const alert = find(render(), el => el.props.role === 'alert');
  expect(alert).toBeDefined();
  expect(renderToStaticMarkup(alert!)).toContain(t('modelSignIn.error.browser'));
  expect(window.open).toHaveBeenCalledWith('', '_blank');
});
it.each([new Error('secret=fixture-key native diagnostic'), 'secret=fixture-key raw rejection'])("localizes native billing failures without exposing %s", async cause => {
  await setLocale('de');
  const openExternal = vi.fn().mockRejectedValue(cause);
  vi.stubGlobal('window', { muragebox: { openExternal } });
  await mount();
  find(render(), el => el.type === 'button' && el.props.children === t('connectedApps.flux.tokenBudgetButton'))!.props.onClick();
  await settle();
  const alert = find(render(), el => el.props.role === 'alert');
  expect(alert?.props.children).toBe(t('modelSignIn.error.browser'));
  expect(renderToStaticMarkup(alert!)).not.toContain('fixture-key');
  expect(openExternal).toHaveBeenCalledWith(FLUXROUTER_BILLING_URL);
});

it.each(["en", "de"])("localizes a failed cached catalog read in %s while the checked catalog is pending", async locale => {
  await setLocale(locale);
  hooks.api.mockImplementation((path: string) => path.endsWith('/cached')
    ? Promise.reject(new Error('secret=fixture-cache-key')) : new Promise(() => {}));
  await mount();
  const alert = find(render(), el => el.props.role === 'alert');
  expect(alert?.props.children).toBe(t('connectedApps.cachedCatalogError'));
  if (locale !== 'en') {
    expect(alert?.props.children).not.toBe('Could not read the saved app catalog. Checking for an updated catalog.');
  }
  expect(renderToStaticMarkup(alert!)).not.toContain('fixture-cache-key');
  expect(hooks.api).toHaveBeenCalledWith('/api/connectors/catalog');
});
it.each(['checked answer', 'unmount'])("ignores a late cache failure after %s", async after => {
  let rejectCache!: (reason: unknown) => void;
  const normal = hooks.api.getMockImplementation()!;
  hooks.api.mockImplementation((path: string) => path.endsWith('/cached')
    ? new Promise((_, reject) => { rejectCache = reject; })
    : after === 'unmount' ? new Promise(() => {}) : normal(path));
  const cleanup = await mount();
  if (after === 'unmount') cleanup();
  rejectCache(new Error('late cache error'));
  await settle();
  expect(find(render(), el => el.props.role === 'alert')).toBeUndefined();
});
it("clears the cache warning when the checked catalog succeeds", async () => {
  let resolveCatalog!: (value: unknown) => void;
  hooks.api.mockImplementation((path: string) => path.endsWith('/cached')
    ? Promise.reject(new Error('cache read failed'))
    : new Promise(resolve => { resolveCatalog = resolve; }));
  await mount();
  expect(find(render(), el => el.props.role === 'alert')).toBeDefined();
  resolveCatalog({ cards: [], configured: true });
  await settle();
  expect(find(render(), el => el.props.role === 'alert')).toBeUndefined();
});
