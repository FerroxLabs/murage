// Trusted transport metadata only. Never forward headers, bodies, cookies or console values.
export function scopedCdpEvent(method, params, tab) {
  const pick = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
  const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  const url = raw => { try { const value = new URL(raw); return value.origin === tab.origin ? value.origin + value.pathname : ''; } catch { return ''; } };
  switch (method) {
    case 'Page.frameNavigated':
      if (!params.frame || params.frame.parentId) return null;
      return { frame: { ...pick(params.frame, ['id', 'loaderId', 'mimeType']), securityOrigin: tab.origin, url: url(params.frame.url) } };
    case 'Page.frameStartedLoading': case 'Page.frameStoppedLoading':
      return params.frameId === tab.frameId ? pick(params, ['frameId']) : null;
    // A JavaScript dialog blocks its page. The text is the page's own words and is capped; no URL leaves.
    case 'Page.javascriptDialogOpening':
      return { ...pick(params, ['type', 'hasBrowserHandler']), message: text(params.message, 500), url: '', ...(params.defaultPrompt !== undefined ? { defaultPrompt: text(params.defaultPrompt, 200) } : {}) };
    case 'Page.javascriptDialogClosed': return pick(params, ['result']);
    case 'Page.loadEventFired': case 'Page.domContentEventFired': return pick(params, ['timestamp']);
    case 'Page.lifecycleEvent': return params.frameId === tab.frameId ? pick(params, ['frameId', 'loaderId', 'name', 'timestamp']) : null;
    case 'Runtime.executionContextCreated': {
      const c = params.context;
      if (!c || c.auxData?.frameId !== tab.frameId) return null;
      return { context: { ...pick(c, ['id', 'name']), origin: url(c.origin), auxData: pick(c.auxData, ['frameId', 'isDefault', 'type']) } };
    }
    case 'Runtime.executionContextDestroyed': return tab.contextIds?.has(params.executionContextId) ? pick(params, ['executionContextId']) : null;
    case 'Runtime.executionContextsCleared': return {};
    case 'Network.requestWillBeSent':
      return { ...pick(params, ['requestId', 'loaderId', 'frameId', 'timestamp', 'type']), request: { url: url(params.request?.url), method: typeof params.request?.method === 'string' ? params.request.method : 'GET' } };
    case 'Network.responseReceived':
      return { ...pick(params, ['requestId', 'timestamp', 'type']), response: { ...pick(params.response, ['status', 'mimeType']), url: url(params.response?.url) } };
    case 'Network.loadingFinished': return pick(params, ['requestId', 'timestamp']);
    case 'Network.loadingFailed': return { ...pick(params, ['requestId', 'timestamp', 'canceled']), errorText: 'Network request failed' };
    default: return null;
  }
}
