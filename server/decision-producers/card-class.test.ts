import {DatabaseSync} from 'node:sqlite';
import {it,expect} from 'vitest';
import {PERMISSION_CARD_KINDS,PERMISSION_CARD_KEYS} from '../../shared/permission-card.ts';
import {mcpEnableCard} from '../mcp-bot-cards.ts';
import {emailCardView,trustCardView} from '../email/cards.ts';

/** The same generated predicate inputs as the seam, evaluated by SQLite.
 * Fixtures below come from production card factories, not a second key list. */
function classified(card:object,kind='options'):boolean {
 const db=new DatabaseSync(':memory:');
 try {
  const paths=PERMISSION_CARD_KEYS.map(key=>`'$.card.${key}'`).join(',');
  const nil=JSON.stringify(PERMISSION_CARD_KEYS.map(()=>null));
  const sql=`SELECT ? IN (${PERMISSION_CARD_KINDS.map(()=>'?').join(',')}) AND json_valid(?) AND json_extract(?,${paths}) IS NOT ? AS yes`;
  return Number(db.prepare(sql).get(kind,...PERMISSION_CARD_KINDS,JSON.stringify({card}),JSON.stringify({card}),nil)?.yes)===1;
 }finally{db.close();}
}
const row:any={sendId:'send',state:'awaiting_owner',revision:1,botId:'bot',threadId:'thread',kind:'send',payloadHash:'hash',heldIds:[],summary:{to:['recipient@example.test'],cc:[],subject:'rm -rf ~',attachments:[],replySource:null}};
it('F4 / M39: all standalone S2 factories are CLASS, including request-less MCP',()=>{
 const cards=[
  mcpEnableCard('fixture',{command:'fixture',args:[],env:{},enabled:false},'revision',{id:'bot',name:'Bot'}),
  emailCardView(row,{botName:'Bot',text:'rm -rf ~',approved:()=>false}),
  trustCardView('Bot',{botId:'bot',address:'recipient@example.test',offeredAt:1,phase:'open'}),
 ];
 for(const card of cards)expect(classified(card),JSON.stringify(card)).toBe(true);
});
it('CLASS excludes information and includes the real local-computer scope key',()=>{
 expect(classified({title:'Information',options:[]})).toBe(false);
 expect(classified({approvalScope:'local-computer',options:['Allow','Deny']})).toBe(true);
 expect(classified({requestId:'x'},'secret')).toBe(false);
});
export {classified};
