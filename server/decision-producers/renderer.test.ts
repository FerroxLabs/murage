// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot} from 'react-dom/client';
import {PERMISSION_CARD_KEYS,PERMISSION_CARD_KINDS} from '../../shared/permission-card.ts';
const store=vi.hoisted(()=>({dispatch:vi.fn()}));
vi.mock('@/state/store',()=>({useStore:()=>({state:{bots:[]},dispatch:store.dispatch}),visibleMessages:()=>[]}));
// Vitest loads the browser module; its JSX is checked by the app project,
// while this test also belongs to the server's NodeNext project without JSX.
const optionModule='../../src/components/OptionCard.tsx';
const {OptionCard,permissionCardRenderable}=await import(optionModule);
function routeCard(card:any,components:Record<string,React.ElementType>={}){
 const source=readFileSync('src/components/ChatView.tsx','utf8');
 const branch=source.slice(source.indexOf('case "options":'),source.indexOf('case "routine.run":'));
 const names=['BrowserSetupCard','PublishCard','McpEnableCard','QuestionCard','LimitOfferCard','EmailSendCard','EmailTrustOfferCard','ApprovalCard','OptionCard','IntakeTurn','FirstRunCard'];
 const readers:any={permissionCardRenderable,readBrowserSetupCard:(c:any)=>c.browserSetup,readPublishCard:(c:any)=>c,readIntakeCard:()=>false,readSetupCard:()=>false,isQuestionCard:()=>false,isLimitOfferCard:()=>false,shouldHideOnboardingCard:()=>false};
 for(const name of names)readers[name]=()=>React.createElement('button',null,name);
 Object.assign(readers,components);
 const code=ts.transpile(`function route(m:any){const bot={id:'bot',threadId:'thread'},transcript=[];switch(m.kind){${branch}}}` ,{jsx:ts.JsxEmit.React});
 const route=new Function('React',...Object.keys(readers),code+';return route;')(React,...Object.values(readers));
 return route({id:'message',kind:'options',card});
}
function renderRouted(card:any){return renderToStaticMarkup(routeCard(card));}

it('A1 terminal legacy permissions remain visible, while actionable rows require identity',()=>{
 expect(permissionCardRenderable({kind:'options',card:{requestId:'legacy',answered:'Expired (upgrade)',orphaned:true}})).toBe(true);
 expect(permissionCardRenderable({kind:'options',card:{requestId:'legacy',options:['Allow']}})).toBe(false);
 expect(permissionCardRenderable({kind:'options',card:{title:'Onboarding',options:['Start']}})).toBe(true);
 expect(permissionCardRenderable({kind:'options',card:{requestId:'request',approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)}})).toBe(true);
});

it('P31 folder trust without a requestId is still a permission; P32 raw fallthrough is hidden',()=>{
 expect(permissionCardRenderable({kind:'options',card:{folderTrust:{folder:'fixture'},options:['Trust']}})).toBe(false);
 expect(permissionCardRenderable({kind:'options',card:{folderTrust:{folder:'fixture'},approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)}})).toBe(true);
 expect(permissionCardRenderable({kind:'options',card:{approvalScope:'local-computer',options:['Allow']}})).toBe(false);
});

for(const card of [{browserSetup:{}},{kind:'publish',publish:{}},{kind:'mcpEnable',mcpEnable:{}},{emailSend:{}},{emailTrustOffer:{}},{requestId:'r',tool:'Bash'}])it(`B2 actual ChatView permission route requires identity: ${JSON.stringify(card)}`,()=>{
 expect(renderRouted(card)).toBe('');
 expect(renderRouted({...card,approvalId:'approval',requestRef:'r',actionHash:'a'.repeat(64)})).toContain('<button>');
});

it('B2 a valid permission and an ordinary options card render through ChatView and accept the owner choice',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 // Keep this jsdom surface local: lib.dom changes the server's fetch/timer types.
 type Button={textContent:string|null;disabled:boolean;click():void};
 type Container=Parameters<typeof createRoot>[0]&{querySelectorAll(selector:string):Iterable<Button>;remove():void};
 const {document}=globalThis as unknown as {document:{createElement(tag:'div'):Container;body:{append(child:Container):void}}};
 const container=document.createElement('div'),root=createRoot(container);
 document.body.append(container);
 store.dispatch.mockClear();
 try{
  for(const identity of [{requestId:'request',approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)},{}]){
   const card={title:'Fixture choice',options:['Allow','Deny'],...identity};
   await React.act(async()=>root.render(routeCard(card,{OptionCard})));
   const allow=Array.from(container.querySelectorAll('button')).find(button=>button.textContent?.endsWith('Allow'));
   expect(allow).toBeDefined();
   expect(allow!.disabled).toBe(false);
   await React.act(async()=>allow!.click());
   expect(store.dispatch).toHaveBeenLastCalledWith({type:'answerCard',botId:'bot',messageId:'message',answer:'Allow'});
   // The fake store acknowledgement closes this same rendered card.
   await React.act(async()=>root.render(routeCard({...card,answered:'Allow'},{OptionCard})));
   const answered=Array.from(container.querySelectorAll('button')).filter(button=>button.textContent?.endsWith('Allow'));
   expect(answered).toHaveLength('requestId' in identity?1:0);
   if(answered.length)expect(answered[0].disabled).toBe(true);
  }
  expect(store.dispatch).toHaveBeenCalledTimes(2);
 }finally{
  await React.act(async()=>root.unmount());
  container.remove();
 }
});

it('B2 rejects only nonterminal permission presentations missing S2 identity, never a contract-valid live approval',()=>{
 // r3.1 A1: a live permission has all three registration fields. Legacy
 // permissions survive only as terminal history; queue recovery re-presents
 // a registered card. The client gate must preserve every valid live card.
 const identity={approvalId:'approval',requestRef:'request',actionHash:'a'.repeat(64)};
 for(const kind of PERMISSION_CARD_KINDS){
  for(const key of [...PERMISSION_CARD_KEYS,'emailTrustOffer']){
   const card={title:'Fixture permission',options:['Allow','Deny'],[key]:key==='requestId'?'request':{},...identity};
   expect(permissionCardRenderable({kind,card}),`${kind}/${key}: valid live approval`).toBe(true);
   expect(renderRouted(card),`${key}: valid live approval remains visible`).toContain('<button>');
   for(const field of Object.keys(identity) as (keyof typeof identity)[])for(const absent of [undefined,'']){
    const rejected={...card,[field]:absent};
    expect(permissionCardRenderable({kind,card:rejected}),`${key}: missing ${field}`).toBe(false);
    expect(renderRouted(rejected),`${key}: incomplete permission stays hidden`).toBe('');
    // Assert the rejection's meaning independently of the render helper:
    // this is an invalid actionable presentation, not an owner decision
    // bound to a complete registered approval identity.
    expect((Object.keys(identity) as (keyof typeof identity)[]).every(name=>typeof rejected[name]==='string'&&rejected[name].length>0)).toBe(false);
    for(const terminal of [{answered:'Expired (upgrade)'},{dismissed:true},{orphaned:true}]){
     expect(permissionCardRenderable({kind,card:{...rejected,...terminal}})).toBe(true);
    }
   }
  }
 }
 expect(renderRouted({title:'Setup question',options:['Start']})).toContain('<button>');
});
it('B10 renderer tests stay within assigned S2 paths',()=>{
 expect(()=>readFileSync('src/lib/permission-card.test.ts')).toThrow();
});

vi.mock('@/lib/plain-approval', () => ({ plainApproval: () => undefined, usePlainApprovalReady: () => false }));
vi.mock('@/lib/grant-added', () => ({ useGrantAdded: () => false }));
const approvalModule = '../../src/components/ApprovalCard.tsx';
const { ApprovalCard } = await import(approvalModule);

it('T3 M-A1i Allowed routine cards render Undo only from a fresh terminal stamp', () => {
 const now = 1_800_000_000_000;
 const date = vi.spyOn(Date, 'now').mockReturnValue(now);
 const render = (changes: any = {}) => renderToStaticMarkup(React.createElement(ApprovalCard, { message: {
  id: 'routine-message', kind: 'options', card: {
   title: 'Fixture routine', subtitle: '', options: [], answered: 'Allowed', approvalId: 'fixture-approval',
   routineRequest: { requestId: 'request', threadId: 'thread', operation: { action: 'pause' }, appliedAt: now },
   ...changes,
  },
 } }));
 try {
  expect(render({ answeredAt: now })).toContain('Undo');
  expect(render({ answeredAt: now })).toContain('<button');
  expect(render()).not.toContain('<button');
  expect(render({ answeredAt: now - 7 * 24 * 60 * 60 * 1000 - 1 })).not.toContain('<button');
  expect(render({ answered: 'allow', approvalId: undefined })).toContain('<button');
  expect(render({ answered: 'undone', answeredAt: now })).toContain('Undone');
  expect(render({ answered: 'undone', answeredAt: now })).not.toContain('<button');
 } finally { date.mockRestore(); }
});
