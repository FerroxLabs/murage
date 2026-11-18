// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (server readiness notices). Consumer owner: recall-smoke (localized chat and room notices).
import { languageCode, t } from '@/lib/i18n';
export function recallNoticeText(text: string): string | undefined {
  if(text==='Memory is still catching up, so this reply did not use recalled memories.')return t('memoryRecall.held');
  if(text==='This reply is still being prepared, so this message was not sent. Send it again in a moment.')return t('memoryRecall.dispatchPending');
  if(text==='Could not start this reply. Send it again.')return t('memoryRecall.generic');
  if(text==="Murage couldn't start this reply. Send it again.")return t('memoryRecall.murageNotStarted');
  if(text==="Bots were not given a pinned note because its supporting replies could not be used or fully checked. Unpin it in Memory, then pin a newer one if you still want it.")return t('memoryRecall.withheldPin');
  const pin=text.match(/^(.*) pinned memory is still being prepared, so this message was not sent\. Send it again in a moment\. If this keeps happening, open Memory\.$/);
  if(pin)return t('memoryRecall.pinPending',{subject:languageCode()==='en' ? pin[1] : pin[1]==='its' ? t('browserUnavailable.thisBot') : pin[1].replace(/'s$/, '')});
  const overflow=text.match(/^(.*) has more pinned memories than Murage can check before a reply, so this message was not sent\. Unpin some in Memory\.$/);
  if(overflow)return t('memoryRecall.pinOverflow',{subject:overflow[1]});
  return undefined;
}
