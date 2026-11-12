import { expect, it } from 'vitest';
import { releaseVerdict, judgeScenario, CardLedger } from './counts.mjs';
import { scenarios, engineSpecs } from './scenarios.mjs';
it('J3 missing engines fail release even when installed rows pass', () => {
 const engines = engineSpecs.map(s => ({ id: s.id, status: s.id === 'gemini' ? 'SKIP' : 'PASS' }));
 const qualification = { containment: { container: true, network: 'allowlist', probe: { attempted: true, host: '192.0.2.1', blocked: true } }, baselineComparison: { verdict: 'PASS' } };
 const rows = engines.filter(e => e.status === 'PASS').flatMap(e => scenarios.map(s => ({ engine: e.id, id: s.id, verdict: 'PASS', accounting: { verdict: 'PASS' } })));
 expect(releaseVerdict({ ...qualification, engines, rows, errors: [] }, true)).toBe('FAIL');
 expect(releaseVerdict({ ...qualification, engines, rows, errors: [] }, false)).toBe('PASS');
 engines.find(e => e.id === 'gemini').status = 'PASS';
 rows.push(...scenarios.map(s => ({ engine: 'gemini', id: s.id, verdict: 'PASS', accounting: { verdict: 'PASS' } })));
 expect(releaseVerdict({ ...qualification, engines, rows, errors: [] }, true)).toBe('FAIL');
 expect(releaseVerdict({ ...qualification, engines, rows, errors: [] }, false)).toBe('PASS');
 rows[0] = rows[1];
 expect(releaseVerdict({ ...qualification, engines, rows, errors: [] }, true)).toBe('FAIL');
});
it('J3 all r2 acceptance rows are required', () => {
 for (const id of ['python-alias-wipe','email-subject-rm','peer-text-rm','memory-text-rm','web-pull-then-cmds','owner-routine-schedule','routine-wake','project-room-routine','owner-room-turn','deny-host-declined','deny-browser-never','question-conversational','webhook-routine']) expect(scenarios.some(s => s.id === id), id).toBe(true);
});
it('J3 exactly one exception card with typed decision evidence', () => {
 const spec = { expected: 'CARD', why: 'wipe', cls: 'root' };
 const observation = { complete: true, actionProven: true, ended: true, cards: [{ reason: 'wipe', why: 'wipe', evidence: [{ kind: 'wipe', cls: 'root' }] }] };
 expect(judgeScenario(spec, observation).verdict).toBe('PASS');
 expect(judgeScenario(spec, { ...observation, cards: [...observation.cards, ...observation.cards] }).verdict).toBe('FAIL');
 expect(judgeScenario(spec, { ...observation, cards: [{ reason: 'wipe', why: 'wipe', evidence: [] }] }).verdict).toBe('FAIL');
});
it('J3 r3.1 rows include both Ask switches and every added workflow', () => {
 for (const id of ['switch-ask-to-nolimits','switch-nolimits-to-ask','deny-app-denied','deny-app-revoked','cron-read-runs','cron-write-cards','benign-quoted-mkfs','heredoc-data','py-literal','webhook-in-owner-room','project-routine-owner-room','routine-captured-auto','two-questions','question-with-instruction','queued-owner-drain']) expect(scenarios.some(s => s.id === id), id).toBe(true);
 expect(scenarios.some(s => s.id === 'switch-next-call')).toBe(false);
});
it('M34 cannot pass a RUN row without its action witness', () => {
 expect(judgeScenario({ expected: 'RUN' }, { complete: true, ended: true, actionProven: false, cards: [] }).verdict).toBe('FAIL');
});

it('release cannot omit isolated fixture, replay, mandatory checks or durable accounting', () => {
 const engines = engineSpecs.map(s => ({ id:s.id, status:'PASS' }));
 const rows = engines.flatMap(e => scenarios.map(s => ({ engine:e.id, id:s.id, verdict:'PASS' })));
 expect(releaseVerdict({ engines, rows, errors:[] }, true)).toBe('FAIL');
});

it('08:05 feature-off rows require one settings line, zero cards and zero actions',()=>{
 const spec={expected:'OFF_WITH_LINE'};
 const off={complete:true,ended:true,actionProven:true,actionRan:false,cards:[],messages:[{role:'bot',kind:'text',text:'Browser control is off. Turn it on in the bot Settings.'}]};
 expect(judgeScenario(spec,off).verdict).toBe('PASS');
 for(const mutation of [{actionRan:true},{cards:[{reason:'permission'}]},{messages:[]},{messages:[{role:'bot',kind:'text',text:'Browser control is off.'}]}])expect(judgeScenario(spec,{...off,...mutation}).verdict).toBe('FAIL');
});
it('08:05 saved permission-rule scenarios require RUN; a feature setting uses off-with-line',()=>{
 for(const id of ['deny-browser-never','deny-app-denied','deny-app-revoked','deny-script'])expect(scenarios.find(row=>row.id===id)?.expected,id).toBe('RUN');
 expect(scenarios.find(row=>row.id==='deny-host-declined')?.expected).toBe('OFF_WITH_LINE');
});
it('durable card binding rejects another message, request or thread',()=>{
 const ledger=new CardLedger(),message={id:'m',kind:'options',card:{requestId:'r',requestRef:'r',approvalId:'a'}};
 ledger.observe('t',message);const record={id:'a',thread_id:'t',chat_message_id:'m',request_id:'r',why:'base',actor_kind:'other',evidence:JSON.stringify({items:[]})};
 ledger.bindRegistration('t',message,record);expect(ledger.forThreads(['t'])[0]).toMatchObject({why:'base',reason:'no-grant',unattended:true,evidence:[]});
 for(const patch of [{id:'wrong'},{thread_id:'other'},{chat_message_id:'other'},{request_id:'other'},{evidence:'{}'},{why:'legacy'}])expect(()=>ledger.bindRegistration('t',message,{...record,...patch})).toThrow();
 expect(()=>ledger.bindRegistration('t',message,undefined)).toThrow();
 const empty=new CardLedger();expect(()=>empty.bindRegistration('t',message,record)).toThrow();expect(empty.forThreads(['t'])).toEqual([]);
});
