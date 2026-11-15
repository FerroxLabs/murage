import { browserCopy } from '../shared/browser-copy.ts';
import type { AgentBrowserSpec } from './browser-engine.ts';
import type { UnifiedBrowserController } from './browser-control.ts';
type Binding = { key: string; spec: AgentBrowserSpec };
/** Prepare happens in the binder. Publication is one synchronous gated step;
 * teardown waits and disposal never run while the session gate is held. */
export async function registerBrowserBinding<P extends { close(): Promise<void> }>(o: {
  controller: UnifiedBrowserController; botId: string; memo: string; key: string; spec: AgentBrowserSpec;
  fresh: () => boolean; bindings: Map<string, Binding>; proxies?: Map<string, P>; prepared?: P;
  publish?: () => void;
}): Promise<Binding> {
  const binding: Binding = { key: o.key, spec: o.spec };
  try {
    for (let round = 0; round < 3; round++) {
      await o.controller.waitForTeardown(o.key);
      const published = await o.controller.sessionGate.run([o.key], token => {
        if (!o.fresh()) throw Object.assign(new Error(browserCopy("browser.server.browser-binding-registration.1")), { status: 409, code: 'revision_changed' });
        const state = o.controller.holdState(o.key);
        if (state?.closing || state?.forgetting) return false;
        const oldBinding = o.bindings.get(o.memo), oldProxy = o.proxies?.get(o.botId);
        let rollback: (() => void) | undefined;
        try {
          rollback = o.controller.registerLocked(token, o.key, o.spec, o.botId);
          if (o.prepared) o.proxies?.set(o.botId, o.prepared);
          o.bindings.set(o.memo, binding); o.publish?.(); return true;
        } catch (error) {
          if (o.bindings.get(o.memo) === binding) { if (oldBinding) o.bindings.set(o.memo, oldBinding); else o.bindings.delete(o.memo); }
          if (o.prepared && o.proxies?.get(o.botId) === o.prepared) { if (oldProxy) o.proxies.set(o.botId, oldProxy); else o.proxies.delete(o.botId); }
          rollback?.();
          throw error;
        }
      });
      if (published) return binding;
    }
    throw Object.assign(new Error(browserCopy("browser.server.browser-binding-registration.2")), { status: 409, code: 'browser_closing' });
  } finally {
    if (o.prepared && o.proxies?.get(o.botId) !== o.prepared) await o.prepared.close().catch(() => {});
  }
}
