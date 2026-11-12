// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createBrowserExtensionService } from '../browser-extension-service.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../../shared/browser-extension-protocol.ts';
import { privateTestDirectory } from "../testing/private-test-dir.ts";
import { removeTempDir } from "../testing/cleanup.ts";
// SABLE-B test 23: a pass-through wrapper around decide() that logs each outcome while a matrix step runs. The prediction (wouldCard,
// design 4) is the decideFor call with no `alive`; the real decision (admitAction) always passes `alive` (5.5 R1). Nothing else changes.
const decideLog = vi.hoisted(() => ({ on: false, rows: [] as { predict: boolean; outcome: string }[] }));
vi.mock('../browser-extension-decide.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../browser-extension-decide.ts')>();
  return { ...real, decide: async (...args: Parameters<typeof real.decide>) => {
    const out = await real.decide(...args);
    if (decideLog.on) decideLog.rows.push({ predict: !('alive' in args[0]), outcome: out.outcome });
    return out;
  } };
});
const cleanup: string[] = [];
// A service saves its state in the background; stop each one (and wait for its last save) before its folder is removed.
const services: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close().catch(() => {}); for (const directory of cleanup.splice(0)) await removeTempDir(directory); });
async function fixture(extraOptions: Record<string, unknown> = {}) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve('.service-')); cleanup.push(directoryRoot);
  const stateFile = path.join(directory, 'state.json');
  const bindings = new Map<string, { generation: number; state: string; tabs: {tabId:number;navigationEpoch:number;origin:string;url:string}[] }>();
  const calls: BrowserExtensionCommand[] = []; let nextTab = 1; let connected = true;
  let approve: () => Promise<boolean> = async () => true; let consent = true;
  let engineReply: ((name: string) => unknown) | undefined; const cards: { summary: string }[] = [];
  let onCdp: ((method: string, params: any, b: { generation: number; state: string; tabs: {tabId:number;navigationEpoch:number;origin:string;url:string}[] }, bindingId: string) => Promise<void>) | undefined;
  const broker = {
    drop: () => false,
    profiles: (): BrowserExtensionHello[] => connected ? [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '1.0', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause','ordered_requests_v1'] }] : [],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      if (!connected) throw Error('host_offline');
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: 'active', tabs: [{ tabId: nextTab++, navigationEpoch: 1, origin: 'https://fixture.test', url: 'https://fixture.test/' }] }; bindings.set(command.bindingId, b); }
      let result: any = b;
      if (command.operation === 'stop' || command.operation === 'pause') { b.generation++; b.state = command.operation === 'stop' ? 'stopped' : 'paused'; }
      if (command.operation === 'cdp') {
        const { method, params } = command.params as any; let value: any = {};
        if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'L' } } };
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        if (method === 'Page.createIsolatedWorld') value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === 'DOM.getDocument') value = { root: { nodeId: 1 } };
        if (method === 'DOM.describeNode') value = {node:{backendNodeId:12}};
        if (method === 'DOM.resolveNode') value = {object:{objectId:"target"}};
        if (method === 'Runtime.evaluate') value = { result: { value: String(params.expression).includes('__murageGuard()') ? false : 'page', objectId: 'target' } };
        if (method === 'Runtime.callFunctionOn') value = { result: { value: String(params.functionDeclaration).includes('const value=JSON.stringify') ? '{"tag":"BUTTON","form":"https://fixture.test/submit"}' : String(params.functionDeclaration).includes('elementFromPoint') ? true : { x: 1, y: 1, w: 10, h: 10 } } };
        if (method === 'Accessibility.getFullAXTree') value = { nodes: [] };
        const before = { ...b.tabs[0] };
        await onCdp?.(method, params, b, command.bindingId);
        result = { result: value, ...before };
      }
      return { version: 1, type: 'response', id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const options = { collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never, createEngine:(engine:import('../browser-extension-engine.ts').BrowserExtensionEngineOptions)=>({
    resolveTarget:async()=>({backendNodeId:12,document:await engine.transport.selected()}),resolveTab:async()=>engine.transport.selected(),event(){},async close(){},
    async call(name:string,args:Record<string,unknown>){const document=await engine.transport.selected();
      if(name==='agent_browser_click'){for(const type of ['mousePressed','mouseReleased']){const params={type,x:1,y:1,button:'left',clickCount:1};await engine.beforeCommand(document,'Input.dispatchMouseEvent',params);await engine.transport.send('Input.dispatchMouseEvent',params,document);}
        // The pinned engine rechecks authority after every tool call.
        if(!engine.authorize())throw Error('Browser control is no longer authorised.');return{content:[{type:'text',text:'clicked'}]};}
      const method=name==='agent_browser_fill'?'Input.insertText':'Accessibility.getFullAXTree';const params=name==='agent_browser_fill'?{text:args.text}:{};await engine.beforeCommand(document,method,params);await engine.transport.send(method,params,document);return engineReply?engineReply(name) as never:{content:[]};},
  }), broker, workspaceId: 'workspace', stateFile, askSite: async () => consent ? 'allow' as const : 'never' as const, askAction: async (_c: unknown, a: { summary: string }) => { cards.push({ summary: a.summary }); return approve(); }, ...extraOptions };
  const service = await createBrowserExtensionService(options); services.push(service);
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' });
  return { service, binding, calls, bindings, options, cards, setEngineReply: (fn: typeof engineReply) => { engineReply = fn; }, onCdp: (hook: typeof onCdp) => { onCdp = hook; }, offline: () => { connected = false; }, denySite: () => { consent = false; }, setApproval: (fn: typeof approve) => { approve = fn; } };
}

const browserCore=vi.hoisted(()=>{vi.resetModules();return {sources:new Map<any,any>(),presented:[] as any[]};});
vi.mock('../decision/index.ts',()=>({
 readTurnPolicy:()=>({permission:{noLimits:true}}),
 openRequest:(source:any)=>{const handle={};browserCore.sources.set(handle,source);return handle;},
 decide:()=>({kind:'run'}),
 executeService:async(handle:any,operation:any)=>({kind:'executed',value:await operation(browserCore.sources.get(handle).call)}),
 presentApproval:(ref:any)=>{browserCore.presented.push(ref);},
}));
import {BrowserExtensionApprovals} from '../browser-extension-approvals.ts';
it('B1 Sable browser executes a read and shell-like page text without owner cards on an unapproved site',async()=>{
 const authority={identity:{},claim:{},proof:{fixture:true}},rows:any[]=[];
 const approvals=new BrowserExtensionApprovals({authorityFor:()=>authority,store:{appendMessage:(_thread:any,row:any)=>{rows.push(row);return row;}}} as any);
 const ask=(context:any,binding:any,call:any,kind:'site'|'action')=>approvals.ask({bot:{id:'bot',name:'Sable',color:'blue'},threadId:'thread',bindingId:context.bindingId,generation:context.generation,digest:binding.actionDigest,summary:'Sable outside content',binding,kind,call});
 const f=await fixture({authorityFor:()=>authority,askSite:async(context:any,origin:string,binding:any)=>(await ask(context,binding,{tool:'agent_browser_snapshot',input:{origin}},'site'))==='allow'?'allow':'never',askAction:async(context:any,action:any,binding:any)=>(await ask(context,binding,{tool:action.name,input:action.arguments},'action'))==='allow',approvalMode:()=> 'full'});
 await expect(f.service.dispatch(f.binding.bindingId,'agent_browser_snapshot',{},()=>true)).resolves.toBeDefined();
 await expect(f.service.dispatch(f.binding.bindingId,'agent_browser_fill',{selector:'textarea',text:'cat <<EOF > report.txt\noutside page\nEOF'},()=>true)).resolves.toBeDefined();
 expect(f.calls.some(c=>c.params?.method==='Input.insertText')).toBe(true);
 expect(f.cards).toHaveLength(0);expect(rows).toHaveLength(0);expect(browserCore.presented).toHaveLength(0);expect(browserCore.sources.size).toBeGreaterThan(0);
});
