import { t } from '@/lib/i18n';
import { renderBrowserCopy, type BrowserCopy } from '../../shared/browser-copy';
/** Old stored cards keep their reviewed text. New cards carry catalog keys. */
export function BrowserDisclosure({lines,copy}:{lines:string[];copy?:BrowserCopy[]}){
 return <>{copy?copy.map((item,i)=><p key={i}>{renderBrowserCopy(item,t)}{i===copy.length-1?' '+t('browser.disclosure.back'):''}</p>):lines.map((line,i)=><p key={i}>{line}</p>)}</>;
}
