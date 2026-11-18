// Isolated owner-wait fixture: real integration, service, executor and approval cards;
// only the browser broker and native engine are fake. No host browser is contacted.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../../shared/browser-extension-protocol.ts';
function fixture() {
  const bindings = new Map<string, { generation: number; state: string; tabs: {tabId:number;navigationEpoch:number;origin:string;url:string}[] }>();
  let nextTab = 1;
  const broker = {
    drop: () => false, close: async () => {}, configPath: 'fixture-host',
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '1.0', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause','ordered_requests_v1'] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: 'active', tabs: [{ tabId: nextTab++, navigationEpoch: 1, origin: 'null', url: 'about:blank' }] }; bindings.set(command.bindingId, b); }
      let result: any = b;
      if (command.operation === 'stop' || command.operation === 'pause') { b.generation++; b.state = command.operation === 'stop' ? 'stopped' : 'paused'; }
      if (command.operation === 'cdp') {
        const { method, params } = command.params as any; let value: any = {};
        if(method === 'Page.navigate') { b.tabs[0].url=params.url; b.tabs[0].origin=new URL(params.url).origin; b.tabs[0].navigationEpoch++; }
        appendFileSync(join(process.env.MURAGE_DATA_DIR!, 'extension-commands.jsonl'), JSON.stringify({bindingId:command.bindingId,method,params})+'\n');
        if (method === 'Murage.getAllFrames') value = { frames: [{ frameId: 0, parentFrameId: -1, url: b.tabs[0].url }] };
        if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'L' } } };
        if (method === 'Page.createIsolatedWorld') value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeId: 1 } };
        if (method === 'DOM.describeNode') value = {node:{backendNodeId:12}};
        if (method === 'DOM.resolveNode') value = {object:{objectId:"target"}};
        if (method === 'Runtime.evaluate') value = { result: { value: String(params.expression).includes('__murageGuard()') ? false : 'page', objectId: 'target' } };
        if (method === 'Runtime.callFunctionOn') value = { result: { value: String(params.functionDeclaration).includes('const value=JSON.stringify') ? '{"tag":"BUTTON","form":"https://fixture.test/submit"}' : String(params.functionDeclaration).includes('elementFromPoint') ? true : { x: 1, y: 1, w: 10, h: 10 } } };
        if (method === 'Accessibility.getFullAXTree') value = { nodes: [] };
        const before = { ...b.tabs[0] };
        result = { result: value, ...before };
      }
      return { version: 1, type: 'response', id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const options = { collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never, createEngine:(engine:import('../browser-extension-engine.ts').BrowserExtensionEngineOptions)=>({
    resolveTarget:async()=>({backendNodeId:12,document:await engine.transport.selected()}),resolveTab:async()=>engine.transport.selected(),event(){},async close(){},
    async call(name:string,args:Record<string,unknown>){const document=await engine.transport.selected();
      if(name==='agent_browser_open'){ await engine.beforeDestination(String(args.url),document); await engine.transport.send('Page.navigate',{url:args.url},document); return {content:[]}; }
      if(name==='agent_browser_click'){for(const type of ['mousePressed','mouseReleased']){const params={type,x:1,y:1,button:'left',clickCount:1};await engine.beforeCommand(document,'Input.dispatchMouseEvent',params);await engine.transport.send('Input.dispatchMouseEvent',params,document);}
        // The pinned engine rechecks authority after every tool call.
        if(!engine.authorize())throw Error('Browser control is no longer authorised.');return{content:[{type:'text',text:'clicked'}]};}
      const method=name==='agent_browser_fill'?'Input.insertText':'Accessibility.getFullAXTree';const params=name==='agent_browser_fill'?{text:args.text}:{};await engine.beforeCommand(document,method,params);await engine.transport.send(method,params,document);return {content:[]};},
  }), broker };
  return options;
}
export const extensionFixture = fixture();
export async function startBrowserExtensionBroker() { return extensionFixture.broker; }
