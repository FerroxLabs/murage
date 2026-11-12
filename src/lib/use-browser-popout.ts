import { useEffect, useState } from 'react';
import { t } from './i18n';

export function browserPopoutBot(search: string, desktopBridge: boolean): string | null {
  const query = new URLSearchParams(search);
  const bot = query.get('bot');
  return desktopBridge && query.get('surface') === 'browser-popout' && bot && /^[A-Za-z0-9_-]{1,120}$/.test(bot) ? bot : null;
}

/** The local and Cloud windows use the same renderer behavior. Pop-out bridges omit open/onState. */
export function popoutBridge() { return window.muragebox?.browserPopout ?? window.muragecloud?.browserPopout; }

/** Window state is independent of the browser's durable control state. */
export function useBrowserPopout(botId: string, inPopout: boolean) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setAvailable(false); setOpen(false); setError('');
    const bridge = popoutBridge();
    if (!bridge?.onState || inPopout) return;
    let alive = true, revision = 0;
    const unsubscribe = bridge.onState(state => {
      if (!alive || state.botId !== botId) return;
      revision++; setOpen(state.open);
    });
    void bridge.currentState().then(state => {
      if (!alive) return;
      setAvailable(state.available === true);
      if (revision === 0) setOpen(state.windows.some(item => item.botId === botId && item.open));
    }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, [botId, inPopout]);
  const toggle = async () => {
    const bridge = popoutBridge();
    if (!bridge?.open || !available || busy) return;
    setBusy(true); setError('');
    try {
      const success = await (open ? bridge.close(botId) : bridge.open(botId));
      if (!success) setError(t('browser.popoutRetry'));
    } catch { setError(t('browser.popoutRetry')); }
    finally { setBusy(false); }
  };
  return { available, open, busy, error, toggle };
}
