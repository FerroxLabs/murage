import { t } from '@/lib/i18n';
import { RotateCcw } from 'lucide-react';
export function BrowserCloseFailure({ botName, pending, onRestart }: { botName: string; pending: boolean; onRestart: () => void }) {
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary">
    {t('browser.closeFailed',{name:botName})}
    <button disabled={pending} onClick={onRestart} className="mt-2 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={14} />{t("browser.BrowserCloseFailure.1")}</button>
  </div>;
}
