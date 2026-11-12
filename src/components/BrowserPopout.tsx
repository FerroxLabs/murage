import { useEffect } from 'react';
import { BrowserStoreProvider, useStore } from '@/state/store';
import { t } from '@/lib/i18n';
import { UnifiedBrowserPanel } from './UnifiedBrowserPanel';
export { browserPopoutBot } from '@/lib/use-browser-popout';

function BrowserPopoutView({ botId }: { botId: string }) {
  const { state } = useStore();
  const bot = state.bots.find(item => item.id === botId);
  useEffect(() => { if (bot) document.title = `${bot.name} · Browser`; }, [bot?.name]);
  return <main className="h-dvh overflow-y-auto bg-app p-3 text-ink sm:p-5">
    {bot ? <UnifiedBrowserPanel bot={bot} size="expanded" popout /> : <p role="status">{state.connected ? t('browser.popoutMissing') : t('settings.timeZone.loading')}</p>}
  </main>;
}

export function BrowserPopout({ botId }: { botId: string }) {
  return <BrowserStoreProvider key={botId} botId={botId}><BrowserPopoutView botId={botId} /></BrowserStoreProvider>;
}
