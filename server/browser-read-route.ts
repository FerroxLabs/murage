// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readWithBrowserAuthority, type EngineReadContext, type EngineReadOptions } from './browser-extension-engine-read.ts';
import { validateWebRange, WEB_FETCH_KEYS, type WebDocuments, type WebPage } from './web-documents.ts';

export const BROWSER_READ_ROUTES = ['headless', 'unified', 'extension', 'builtin'] as const;
type Route = typeof BROWSER_READ_ROUTES[number];
const hits: Record<Route, number> = { headless: 0, unified: 0, extension: 0, builtin: 0 };
/** Test-only snapshot. No page content or externally exposed endpoint. */
export function browserReadRouteHits(): Readonly<Record<Route, number>> { return { ...hits }; }
type NativePort = (input: EngineReadOptions) => Promise<EngineReadContext>;
type AcceptedTextPort = {
  documents: WebDocuments; scope: string;
  acceptedText: () => Promise<{ text: string; url: string; truncated?: boolean }>;
  authorize: () => boolean;
};
export function routeBrowserRead(route: 'builtin', input: EngineReadOptions, port: AcceptedTextPort): Promise<WebPage>;
export function routeBrowserRead(route: Exclude<Route, 'builtin'>, input: EngineReadOptions, port: EngineReadContext | NativePort): ReturnType<typeof readWithBrowserAuthority>;
export async function routeBrowserRead(route: Route, input: EngineReadOptions, port: EngineReadContext | NativePort | AcceptedTextPort) {
  validateWebRange(input, route === 'builtin' ? [] : WEB_FETCH_KEYS);
  hits[route]++;
  if (typeof port !== 'function' && 'acceptedText' in port) {
    if (!port.authorize()) throw Error('Web read is no longer active.');
    if (input.handle) return port.documents.read(port.scope, input);
    const page = await port.acceptedText();
    if (!port.authorize()) throw Error('Web read is no longer active.');
    if (page.truncated) throw Error('Browser returned an incomplete document. No saved copy was accepted.');
    return port.documents.save(port.scope, page.text, page.url, input);
  }
  const context = typeof port === 'function' ? await port(input) : port;
  return readWithBrowserAuthority(input, context);
}

/** The single native capture path, used by both managed and attached Chrome.
 * Recheck authority after each engine await, including URL equality. */
export function nativeReadPort(client: { request(method: string, params?: Record<string, unknown>): Promise<unknown> }, authority: (() => void) | { check: () => Promise<unknown>; current: () => boolean }, documents: WebDocuments, scope: string): NativePort {
  const authorized = typeof authority === "function" ? authority : authority.check;
  const current = typeof authority === "function" ? () => { authority(); return true; } : authority.current;
  return async input => {
    const field = async (name: string, key: 'url' | 'result', args: Record<string, unknown> = {}) => {
      const reply = await client.request('tools/call', { name, arguments: args }) as {
        isError?: boolean; structuredContent?: { response?: { success?: boolean; truncated?: boolean; data?: Record<string, unknown> } };
      };
      await authorized();
      const response = reply?.structuredContent?.response, data = response?.data;
      if (reply?.isError || response?.success !== true || response.truncated || data?.truncated || typeof data?.[key] !== 'string') throw Error('Browser returned an incomplete document. No saved copy was accepted.');
      return data[key] as string;
    };
    await authorized();
    const currentUrl = input.handle ? 'https://saved.invalid' : input.url ?? await field('agent_browser_get_url', 'url');
    return {
      documents, scope, currentUrl, direct: true, fenceOrigin: new URL(currentUrl).origin,
      // The converter rechecks synchronous authority after each of its awaits.
      authorize: current,
      admitUrl: async () => { await authorized(); },
      activeHtml: async () => {
        const html = await field('agent_browser_eval', 'result', { script: 'document.documentElement.outerHTML' });
        if (await field('agent_browser_get_url', 'url') !== currentUrl) throw Error('Browser page changed during reading.');
        return html;
      },
    };
  };
}
