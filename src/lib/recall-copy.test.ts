// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (readiness wording). Consumer owner: recall-smoke (localized notices).
import { afterEach, expect, it } from 'vitest';
import { setLocale } from './i18n';
import { recallNoticeText } from './recall-copy';
afterEach(async()=>{await setLocale('en');});
for(const locale of ['en','de','es','fr','hi','ja','pt-br','zh'])it(`recall notices stay in step in ${locale}`,async()=>{
 await setLocale(locale);
 for(const line of ['Memory is still catching up, so this reply did not use recalled memories.',"Fixture's pinned memory is still being prepared, so this message was not sent. Send it again in a moment. If this keeps happening, open Memory.",'This reply is still being prepared, so this message was not sent. Send it again in a moment.','Could not start this reply. Send it again.','Fixture has more pinned memories than Murage can check before a reply, so this message was not sent. Unpin some in Memory.']){
  const text=recallNoticeText(line);expect(text).toBeTruthy();expect(text).not.toMatch(/memoryRecall\.|\{subject\}|\u2014/);
 }
});
