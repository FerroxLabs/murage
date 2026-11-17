// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),dispatch:vi.fn()}));
vi.mock('@/state/store',()=>({api:mocks.api,useStore:()=>({state:{config:{browserProfiles:[]},bots:[]},dispatch:mocks.dispatch})}));
vi.mock('../components/BrowserLiveView',()=>({BrowserLiveView:()=>null}));
vi.mock('../components/BrowserSetupList',()=>({BrowserSetupList:()=>null}));
import {BrowserChoice} from '../components/BrowserChoice';
import type {Bot} from '@/state/store';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
const bot={id:'a',name:'Ava',browserMode:'chrome-extension',selectionRevision:3,browserApproval:'step'} as unknown as Bot;
let root:ReturnType<typeof createRoot>|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());document.body.innerHTML='';mocks.api.mockReset();mocks.dispatch.mockReset();});
const click=async(text:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
it('owner switch keeps the picker, reviews the server disclosure, and sends the exact revision and key',async()=>{
 mocks.api.mockImplementation(async(_path:string,options?:{method?:string})=>options?.method==='PATCH'?{bot:{...bot,browserMode:'builtin'}}:{destination:{mode:'builtin'},baseRevision:3,disclosure:{lines:['Ava will stop asking each step.',"From now on, Ava uses profile Ava's own."],disclosureKey:'reviewed'}});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserChoice,{bot})));
 await click("Ava's browser");expect(document.body.textContent).toContain('From now on');expect(mocks.api.mock.calls.some(call=>call[1]?.method==='PATCH')).toBe(false);
 await click('Switch from now on');const call=mocks.api.mock.calls.find(call=>call[1]?.method==='PATCH')!;expect(JSON.parse(call[1].body)).toEqual({browserChoice:{mode:'builtin',baseRevision:3,disclosureKey:'reviewed'}});expect(document.body.textContent).toContain('Your Chrome');
});
it('a held refusal shows Hand back and never sends a release on the owner’s behalf',async()=>{
 mocks.api.mockImplementation(async(_path:string,options?:{method?:string})=>{if(options?.method==='PATCH')throw new Error('Hand back first, then change Ava’s browser.');return{destination:{mode:'builtin'},baseRevision:3,disclosure:{lines:['From now on, Ava uses its own browser.'],disclosureKey:'held'}};});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserChoice,{bot})));await click("Ava's browser");await click('Switch from now on');expect(document.querySelector('[role="alert"]')?.textContent).toContain('Hand back first');expect(mocks.api.mock.calls.some(call=>String(call[1]?.body).includes('"release"'))).toBe(false);
});
import {UnifiedBrowserPanel} from '../components/UnifiedBrowserPanel';
it('EP11/EP13 direct stays selected and checks only once per second while Allow is unanswered',async()=>{
 Object.defineProperty(document,'hidden',{value:false,configurable:true});
 vi.useFakeTimers();try{
 mocks.api.mockImplementation(async(path:string)=>path.includes('/frame?')?null:{generation:1,waitingForChrome:true,held:false,connected:false});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(UnifiedBrowserPanel,{bot:{...bot,browserMode:'chrome-direct',useMyChrome:true,browserTransport:undefined}})));
 const frames=()=>mocks.api.mock.calls.filter(call=>call[0].includes('/frame?')).length;
 expect(frames()).toBe(1);await act(async()=>{await vi.advanceTimersByTimeAsync(999);});expect(frames()).toBe(1);await act(async()=>{await vi.advanceTimersByTimeAsync(2);});expect(frames()).toBe(2);
 expect(mocks.api.mock.calls.some(call=>call[1]?.method==='PATCH')).toBe(false);
 }finally{vi.useRealTimers();}
});
it('Finish setup opens this bot’s Browser tab from the unavailable chat row',async()=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',botName:'Ava',reason:"browser-cause:browser_extension_setup_required:0|Connect Chrome"})));
 await click('Finish setup');expect(localStorage.getItem('murage-computer-panel-view:a')).toBe('browser');expect(mocks.dispatch).toHaveBeenCalledWith({type:'select',id:'a'});expect(mocks.dispatch).toHaveBeenCalledWith({type:'toggleComputer',open:true});
});
it('a failed old-route close offers an explicit recovery retry from chat',async()=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');mocks.api.mockResolvedValue({bot});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',botName:'Ava',reason:'browser-cause:browser_release_failed:0|daemon did not acknowledge'})));
 expect(document.body.textContent).toContain("Ava couldn't close the old browser connection");await click('Try again');expect(mocks.api).toHaveBeenCalledWith('/api/bots/a/browser-choice/retry',{method:'POST',body:'{}'});expect(document.body.textContent).toContain('daemon did not acknowledge');
});
it.each([['builtin_restart','Restart browser','restart'],['builtin_check_failed','Try again','restart'],['builtin_page_locked','Reopen blank page','reopen']] as const)('chat recovery %s executes the fenced owner action',async(code,label,action)=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');
 mocks.api.mockImplementation(async()=>({sessionKey:'key',selectionRevision:3,generation:7,control:2,held:true,owned:true}));
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',botName:'Ava',reason:`browser-cause:${code}:0|fixture cause`})));
 await click(label);
 expect(mocks.api.mock.calls.some(call=>call[0]==='/api/bots/a/browser'&&JSON.parse(call[1]?.body??'{}').action===action&&JSON.parse(call[1].body).expectedRevision===3)).toBe(true);
});
it('chat sandbox recovery executes Enable browser',async()=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');mocks.api.mockResolvedValue({outcome:'enabled'});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',botName:'Ava',reason:'browser-cause:browser_sandbox_enable:0|AppArmor'})));
 await click('Enable browser');expect(mocks.api).toHaveBeenCalledWith('/api/browser/linux-sandbox/enable',{method:'POST',body:'{}'});
});
it.each(['chrome_closed','allow_not_given'])('chat %s opens Chrome through the authenticated server route',async code=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');mocks.api.mockResolvedValue({opened:true});
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',botName:'Ava',reason:`browser-cause:${code}:0|fixture cause`})));
 await click(code==='chrome_closed'?'Open Chrome':'Click Allow in Chrome');
 expect(mocks.api).toHaveBeenCalledWith('/api/bots/a/browser-choice/open-chrome',{method:'POST',body:'{}'});
});
it('debugging recovery copies the fixed Chrome setup link',async()=>{
 const writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',reason:'browser-cause:debugging_off:0|off'})));
 await click('Copy link');expect(writeText).toHaveBeenCalledWith('chrome://inspect/#remote-debugging');
});
it('only missing browser files offer the fixed reinstall link',async()=>{
 const {BrowserUnavailableRow}=await import('../components/BrowserUnavailableRow');
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',reason:'browser-cause:builtin_missing:0|missing'})));
 expect(document.querySelector('a')?.href).toBe('https://github.com/FerroxLabs/murage-releases/releases/latest');
 await act(async()=>root!.render(createElement(BrowserUnavailableRow,{botId:'a',reason:'browser-cause:builtin_check_failed:0|unfinished check'})));
 expect(document.querySelector('a')).toBeNull();
});
