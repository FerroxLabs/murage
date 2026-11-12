import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
it('R9 never resolving transport retries same answerId, interrupts by 20s and ignores late completion',async()=>{
 vi.useFakeTimers();try{const f=fixture();let ack:any;f.respond.mockImplementation(()=>new Promise(resolve=>{ack=resolve;}));const h=f.open();d.decide(h,baseCard);const delivered=d.deliverRequest(h);
 await vi.advanceTimersByTimeAsync(20001);await delivered;expect(f.respond).toHaveBeenCalledTimes(2);expect(f.respond.mock.calls[0][2]).toEqual(f.respond.mock.calls[1][2]);expect(f.interrupt).toHaveBeenCalledOnce();ack({state:'accepted'});await Promise.resolve();expect(f.interrupt).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
});
it('R8 R9 M33 X7 two questions retain FIFO; instructions remain a normal send',async()=>{
 const f=fixture();for(const id of ['q1','q2']){const ref=card(d.decide(f.open(id,{}, {requestType:'question',choices:['Red','Blue']}),baseCard));await d.presentApproval(ref,{title:'Question',subtitle:'x'});}
 expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);expect(d.openApprovals()).toHaveLength(2);
 expect((await d.answerQuestionReply('t','Please do another task')).kind).toBe('send');expect(d.openApprovals()).toHaveLength(2);
 expect((await d.answerQuestionReply('t','2')).kind).toBe('answered');expect(d.openApprovals()).toHaveLength(1);expect(f.respond.mock.calls[0][1]).toMatchObject({behavior:'answer',message:'Blue'});
 await d.answerQuestionReply('t','Red');expect(d.openApprovals()).toHaveLength(0);
});
it('R19 Ask→No limits answers open owner BASE before returning; webhook stays BASE',async()=>{
 const f=fixture('ask');const ref=card(d.decide(f.open(),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});f.setLevel('unlimited');await d.onLevelChange('b');expect(f.respond).toHaveBeenCalledOnce();expect(d.readApproval(ref.approvalId)!.state).toBe('answered');
});
it('R19 a retained wipe card is reclassified when owner moves into No limits',async()=>{
 const f=fixture('ask');const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});f.setLevel('unlimited');await d.onLevelChange('b');expect(d.readApproval(ref.approvalId)!.why).toBe('wipe');expect(f.respond).not.toHaveBeenCalled();
});
it.each(['request.resolved','turn.completed'] as const)('native %s retires the captured generation and preserves its replacement',async type=>{
 const f=fixture();const old=card(d.decide(f.open('old',{command:'rm -rf ~'}),baseCard));await d.presentApproval(old,{title:'Old',subtitle:'x'});f.setGeneration('new-generation');f.setTurn('new-turn');const next=card(d.decide(f.open('next',{command:'rm -rf ~'}),baseCard));await d.presentApproval(next,{title:'Next',subtitle:'x'});
 f.publish({type,threadId:'t',providerInstanceId:'p',turnId:'turn',requestId:'old',settlement:'superseded'});await Promise.resolve();expect(d.readApproval(old.approvalId)!.state).toBe(type==='request.resolved'?'superseded':'cancelled');expect(d.readApproval(next.approvalId)!.state).toBe('open');
});

it('R19 webhook BASE cards release on a move into No limits (Sean 11-12)',async()=>{
 const f=fixture('ask',{k:'webhook'});const ref=card(d.decide(f.open(),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});f.setLevel('unlimited');await d.onLevelChange('b');expect(d.readApproval(ref.approvalId)!.state).toBe('answered');expect(d.readApproval(ref.approvalId)!.why).toBe('base');expect(f.respond).toHaveBeenCalledOnce();
});

it('R18 ninth question refuses under a bounded reply and leaves the eight FIFO records intact',async()=>{
 const f=fixture();
 for(let i=0;i<9;i++){
  const ref=card(d.decide(f.open('question-'+i,{}, {requestType:'question',choices:['Red','Blue']}),baseCard));
  await d.presentApproval(ref,{title:'Question',subtitle:'Fixture'});
 }
 expect(d.openApprovals('t')).toHaveLength(8);expect(f.respond).toHaveBeenCalledOnce();
 expect(f.respond.mock.calls[0][1].behavior).toBe('deny');
 expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
