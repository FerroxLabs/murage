import { expect, it } from 'vitest';
import { canOfferOwnBrowser, browserFailure } from './browser-choice-eligibility.ts';
for(const code of ['browser_extension_setup_required','host_offline','incompatible_capabilities','update_murage','binding_capacity','chrome_closed','debugging_off','allow_not_given','direct_reserved'])it(`EP7/EP10 availability ${code} is named and only offered before work`,()=>{
 expect(canOfferOwnBrowser(code,0)).toBe(true);expect(canOfferOwnBrowser(code,1)).toBe(false);expect(browserFailure(code).code).toBe(code);expect(browserFailure(code).action).not.toBe('');
});
for(const code of ['stopped','handoff','uncertain','connection_lost','paused','site_blocked','action_check_refused','floor','protected_list','unknown','browser_extension_not_ready'])it(`EP7 no fallback offer for ${code}`,()=>expect(canOfferOwnBrowser(code,0)).toBe(false));
import { codedBrowserReason, readBrowserFailure } from './browser-choice-eligibility.ts';
it('EP10 named causes survive the activity wire and never widen eligibility',()=>{
 for(const code of ['host_offline','stopped','handoff','uncertain','connection_lost','policy_refusal']){
  const parsed=readBrowserFailure(codedBrowserReason(code,'raw details',0));expect(parsed?.code).toBe(code);expect(parsed?.offer).toBe(code==='host_offline');
  expect(readBrowserFailure(codedBrowserReason(code,'raw details',1))?.offer).toBe(false);
 }
});
import { browserReleaseFailureReason } from './browser-choice-eligibility.ts';
it('three failed release rounds name the failed close without offering another route',()=>{
 for(const attempts of [0,1,2])expect(browserReleaseFailureReason({attempts,reason:'raw'})).toBeUndefined();
 expect(readBrowserFailure(browserReleaseFailureReason({attempts:3,reason:'raw'})!)).toMatchObject({code:'browser_release_failed',action:'Try again',details:'raw',offer:false});
});
