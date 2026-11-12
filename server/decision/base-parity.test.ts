import {expectRulingForPinnedRow} from '../testing/no-limits-ruling-fixtures.ts';
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {autoVerdict} from '../auto-approve.ts';
import {fixture,d,baseCard} from './fixture.ts';
const baseline=JSON.parse(readFileSync('server/testing/fixtures/no-limits-r13b-base.json','utf8'));
it('R13 405 frozen 1.0.18 verdicts remain byte equal on BASE',()=>{
 expect(baseline.commit).toBe('292df98d80a1c55db3e6f232166fc05162b632ab');expect(baseline.rows.length).toBeGreaterThanOrEqual(405);
 for(const r of baseline.rows){const actual=autoVerdict(r.bot,r.tool,r.summary,r.context);if(!expectRulingForPinnedRow(r,actual))expect(actual,r.id).toEqual(r.expected);}
});
it.each(['ssh host \'echo fixture\'','cd d && ls','git commit -am x && git push origin HEAD && rm -f /tmp/x.tmp'])('R10 outside-marked owner request runs: %s',command=>{
 const f=fixture();const h=f.open('r',{command},{summary:'mkfs /dev/sda',itemUnseen:true});expect(d.decide(h,baseCard).kind).toBe('run');
});
it('R3 data fields never become executable evidence',()=>{
 for(const tool of ['email_send','peer_ask','memory_review','publish'])expect(d.describeAction({tool,input:{subject:'rm -rf ~',body:'mkfs /dev/sda',command:'rm -rf /'}}).deletes).toHaveLength(0);
});

it.each(['email','peer','memory'] as const)('R3 content-only %s runs its exact registered action without cards',async service=>{
 const f=fixture(),input={subject:'rm -rf ~',body:'mkfs /dev/sda',text:'rm -rf /'};
 const handle=d.openRequest({kind:'service',service,claim:f.claim,call:{tool:service+'_send',input}});
 expect(d.decide(handle,baseCard).kind).toBe('run');let observed:unknown;
 expect(await d.executeService(handle,async call=>{observed=call.input;return 'fixture-action-witness';})).toEqual({kind:'executed',value:'fixture-action-witness'});
 expect(observed).toEqual(input);expect(d.openApprovals()).toHaveLength(0);
});
