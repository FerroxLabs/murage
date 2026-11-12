import { expect, it } from 'vitest';
import { autoVerdict } from '../../server/auto-approve.ts';
import { noLimits, context } from './mandatory-fixture.mjs';
// Replaces the retired No limits reader/taint carve-outs in means-it-1020
// and r13-gate. Unreadable input alone is not a catastrophe.
it.each(['eval "$OPAQUE"','eval "$(ssh-agent -s)"','cat <<EOF\nfixture\nEOF','printf fixture > "$fixture_target"'])('opaque non-wipe runs: %s',command=>{
  expect(autoVerdict(noLimits,'Bash',command,context(command,{inputCut:true,inputTruncated:true,outsideRead:['earlier-turn']})).approve).not.toBeNull();
});
it('a prior non-wipe card is not retained at eligible No limits',async()=>{
  const {finalizeNoLimits}=await import('../../server/auto-approve.ts');
  expect(finalizeNoLimits(noLimits,'Bash','printf fixture',context('printf fixture'),{approve:null,source:'always-ask',rule:'unreadable'}).approve).not.toBeNull();
});
