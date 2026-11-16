// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {requireReleaseComparisons} from './release-comparison.mjs';
const pins={baseSha:'base-frozen',headSha:'head-frozen'};
const complete=()=>({base_sha:pins.baseSha,head_sha:pins.headSha,complete:true,no_new_red:true,
 new_red:[],new_skips:[],missing_ids:[],new_suite_error_files:[],removed_files:[],
 base:{shards:[{complete:true}],errors:[]},head:{shards:[{complete:true}],errors:[]}});
it('qualifies complete comparisons on the same frozen pair',()=>{
 expect(requireReleaseComparisons(complete(),complete(),pins)).toEqual({...pins,newFailures:0});
});
it.each(['complete','no_new_red'])('rejects the unfinished release state: %s',key=>{
 const pending=complete();pending[key]=false;
 expect(()=>requireReleaseComparisons(pending,complete(),pins)).toThrow();
});
it.each(['base_sha','head_sha'])('rejects a stale source receipt: %s',key=>{
 const stale=complete();stale[key]='another-source';
 expect(()=>requireReleaseComparisons(complete(),stale,pins)).toThrow();
});
it.each(['new_red','new_skips','missing_ids','new_suite_error_files','removed_files'])('checks IDs even if a summary says pass: %s',key=>{
 const invalid=complete();invalid[key]=['unresolved-test-id'];
 expect(()=>requireReleaseComparisons(invalid,complete(),pins)).toThrow();
});
it('rejects a summary with unfinished shards',()=>{
 const invalid=complete();invalid.head.shards[0].complete=false;
 expect(()=>requireReleaseComparisons(invalid,complete(),pins)).toThrow();
});

it('rejects the salvage handoff with types complete but Vitest unfinished',()=>{
 const unfinished=complete();
 unfinished.head.shards=[{complete:false,typecheckExit:0,assertionResults:[]}];
 expect(()=>requireReleaseComparisons(unfinished,complete(),pins)).toThrow(/unfinished/);
});
