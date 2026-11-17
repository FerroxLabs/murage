import {it,expect,vi,beforeEach} from 'vitest';
vi.hoisted(()=>vi.resetModules());
vi.mock('../decision/index.ts',()=>({readApproval:vi.fn(),openApprovals:vi.fn(()=>[])}));
import {durableChannelApproval} from '../telegram-approvals.ts';
// @ts-expect-error Native ESM has no declaration file.
import {createAttentionActions} from '../../electron/attention-actions.mjs';
import {readApproval} from '../decision/index.ts';
import {currentApprovalNotification as notificationProjection} from '../approval-notification-state.ts';
// Model the authenticated server read, including its record projection. The
// Electron policy itself has no server registry instance and no runtime import.
function currentApprovalNotification(payload:any,bot:any,messages:any[],preferences:any){
 return notificationProjection(payload,bot,messages.map(message=>({...message,approvalRecord:readApproval(message.card?.approvalId)})),preferences);
}
// @ts-expect-error Native ESM has no declaration file.
import {approvalPayload} from '../../electron/approval-notification.mjs';
// @ts-expect-error Native ESM has no declaration file.
import {itemsFromAttention} from '../../electron/attention-items.mjs';
const payload={approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64),botId:'bot',threadId:'thread',requestId:'request',messageId:'message',title:'',body:''};
const bot={id:'bot',name:'Bot',threadId:'thread'};
const message={id:'message',role:'bot',kind:'options',card:{approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64),requestId:'request',title:'Approval needed',subtitle:'private',pushBody:'Read notes'}};
it('R17 forged or missing approval identity cannot notify, and terminal rows stay closed',()=>{
 expect(currentApprovalNotification(payload,bot,[message],undefined)?.body).toBe('Read notes');
 for(const change of [{approvalId:'forged'},{approvalId:undefined},{requestRef:'other'},{actionHash:'b'.repeat(64)}])expect(currentApprovalNotification({...payload,...change} as any,bot,[message],undefined)).toBeNull();
 expect(currentApprovalNotification(payload,bot,[{...message,card:{...message.card,answered:'allow'}}],undefined)).toBeNull();
});
it('native notifications preserve identity and reject a payload that drops the approval id',()=>{
 expect(approvalPayload(payload)).toEqual(payload);
 expect(approvalPayload({...payload,approvalId:undefined})).toBeNull();
});
it('native attention carries the durable identity along with routing ids',()=>{
 const output=itemsFromAttention({home:'home',previews:true,attention:{open:[payload]}});
 expect(output.items[0]).toMatchObject({approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)});
});

const record=()=>({ref:{approvalId:'approval'},state:'open',threadId:'thread',botId:'bot',requestId:'request',chatMessageId:'message',actionHash:'a'.repeat(64)});
beforeEach(()=>vi.mocked(readApproval).mockImplementation(id=>id==='approval'?record() as any:undefined));
it('R17 a copied matching row without its durable record never notifies',()=>{
 vi.mocked(readApproval).mockReturnValue(undefined);
 expect(currentApprovalNotification(payload,bot,[message],undefined)).toBeNull();
 for(const patch of [{state:'answered'},{botId:'other'},{threadId:'other'},{chatMessageId:'other'},{requestId:'other'},{actionHash:'b'.repeat(64)}]){
  vi.mocked(readApproval).mockReturnValue({...record(),...patch} as any);
  expect(currentApprovalNotification(payload,bot,[message],undefined),JSON.stringify(patch)).toBeNull();
 }
});

it('R17 channel mirrors reject row-only, forged and settled presentations',()=>{
 const offer={approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64),id:'message',fingerprint:'fingerprint',summary:'fixture'};
 expect(durableChannelApproval(offer)).toBe(true);
 expect(durableChannelApproval({...offer,approvalId:'other'})).toBe(false);
 vi.mocked(readApproval).mockReturnValue({...record(),state:'answered'} as any);
 expect(durableChannelApproval(offer)).toBe(false);
});
it('native outside actions preserve the registered identity and reject substitutions',async()=>{
 const identity={};let card:any={...payload,open:true,outsideOk:{tray:true},digest:'digest'};
 const post=vi.fn(async(_body:any)=>({ok:true}));const transport={current:()=>identity,readCard:async()=>card,post};
 const actions=createAttentionActions({lock:{locked:()=>false}});
 const entry={...payload,home:'fixture',epoch:'epoch',digest:'digest',surface:'tray',surfaceId:'tray',identity,transport};
 expect(await actions.act(actions.mint(entry),'allow')).toEqual({ok:true});
 expect(post.mock.calls[0][0]).toMatchObject({approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)});
 for(const patch of [{approvalId:'other'},{requestRef:'other'},{actionHash:'other'}]){
  card={...card,...patch};expect(await actions.act(actions.mint(entry),'allow')).toMatchObject({ok:false,reason:'card'});
 }
 expect(post).toHaveBeenCalledTimes(1);
});

it('Electron policy requires the authenticated read projection and never opens a server registry',()=>{
 expect(notificationProjection(payload,bot,[message],undefined)).toBeNull();
 expect(notificationProjection(payload,bot,[{...message,approvalRecord:record() as any}],undefined)?.body).toBe('Read notes');
});
