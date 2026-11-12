// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import {createElement,act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),state:{bots:[],config:{}}}));
vi.mock('@/state/store',()=>({api:mocks.api,useStore:()=>({state:mocks.state})}));
import {NoLimitsFollowers} from './NoLimitsFollowers';
let root:Root|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;vi.clearAllMocks();});
it('F7 shows following counts and explicit lower choices, and one click restores inheritance',async()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const initial={enabled:true,bots:3,routines:4,lower:[{id:'b',kind:'bot',name:'Editor',level:'full'},{id:'r',kind:'routine',name:'Review',level:'ask'}]};
 mocks.api.mockImplementation(async(_path:string,options?:{method?:string})=>options?.method==='POST'?{enabled:true,bots:4,routines:5,lower:[]}:initial);
 const host=document.createElement('div');root=createRoot(host);await act(async()=>root!.render(createElement(NoLimitsFollowers)));
 expect(host.textContent).toContain('3 bots and 4 routines follow No limits');
 expect(host.textContent).toContain('Editor (bot): Full access');expect(host.textContent).toContain('Review (routine): Ask');
 const button=host.querySelector('button')!;expect(button.textContent).toBe('Use No limits for all');
 await act(async()=>button.click());
 expect(mocks.api).toHaveBeenCalledWith('/api/permissions/no-limits',{method:'POST',body:'{}'});
 expect(host.textContent).toContain('4 bots and 5 routines follow No limits');expect(host.textContent).not.toContain('Explicit lower levels');
});
it('F7 does not offer the No limits action when the owner default is lower',async()=>{
 mocks.api.mockResolvedValue({enabled:false,bots:0,routines:0,lower:[]});
 const host=document.createElement('div');root=createRoot(host);await act(async()=>root!.render(createElement(NoLimitsFollowers)));
 expect(host.querySelector('button')).toBeNull();
});
it('H7 H8 M3 upgrade explains wipe-only No limits and lists legacy lower bots and chats once',async()=>{
 localStorage.clear();
 mocks.api.mockResolvedValue({enabled:true,bots:1,routines:0,lower:[
  {id:'full',kind:'bot',name:'Legacy Full access',level:'full'},
  {id:'auto',kind:'bot',name:'Edited Auto',level:'auto'},
  {id:'chat',kind:'chat',name:'Earlier chat',level:'ask'},
 ]});
 const host=document.createElement('div');root=createRoot(host);
 await act(async()=>root!.render(createElement(NoLimitsFollowers,{upgrade:true} as any)));
 const dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();
 expect(dialog!.textContent).toContain('Legacy Full access');expect(dialog!.textContent).toContain('Edited Auto');expect(dialog!.textContent).toContain('Earlier chat');
 for(const word of ['protected files','keys','outside content','Trigger links from other apps','wipe'])expect(dialog!.textContent).toContain(word);
 for(const sentence of ['Only a likely wipe or catastrophe asks first.','Saved permission rules do not block actions.','Features you switched off entirely stay off until you turn them on.',"Other people's chats stay at Ask unless you explicitly set that bot's level."])expect(dialog!.textContent).toContain(sentence);
 const keep=[...dialog!.querySelectorAll('button')].find(button=>button.textContent==='Keep current levels')!;expect(keep).toBeDefined();
 await act(async()=>keep.click());expect(document.querySelector('[role="dialog"]')).toBeNull();
 await act(async()=>root!.unmount());root=createRoot(host);
 await act(async()=>root!.render(createElement(NoLimitsFollowers,{upgrade:true} as any)));
 expect(document.querySelector('[role="dialog"]')).toBeNull();
});
