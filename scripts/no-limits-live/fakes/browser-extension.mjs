// Harness transport owner: gnl-harness-r9. Browser policy/broker owner: MAIN.
// The selected Never profile uses an inert extension peer on the real native
// host wire. Only an approved loopback navigation can produce a page effect.
import {PassThrough} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {requireGatedHandle} from '../gated-handle.mjs';
const loopback=raw=>{const url=new URL(raw);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Fixture extension requires loopback HTTP');return url;};
export async function attachFixtureExtension(broker,gatedHandle){
 const {runNativeHost,readHostConfig,FrameDecoder,encodeFrame}=requireGatedHandle(gatedHandle);
 const input=new PassThrough(),output=new PassThrough(),bindings=new Map();
 const decoder=new FrameDecoder(message=>{if(message.type!=='command')return;void answer(message);});
 output.on('data',chunk=>decoder.push(chunk));
 const host=runNativeHost({input,output,config:readHostConfig(broker.configPath)});
 const close=broker.close.bind(broker);broker.close=async()=>{await host.stop();await close();};
 async function answer(m){
  try{
   let state=bindings.get(m.bindingId);
   if(!state){state={generation:1,state:'active',tabs:[{tabId:1,navigationEpoch:0,origin:'null',url:'about:blank'}],selectedTabId:1};bindings.set(m.bindingId,state);}
   let result;
   if(['bind','status','set_approved_origins','panel'].includes(m.operation))result=state;
   else if(['pause','stop','resume'].includes(m.operation)){state.generation++;state.state=m.operation==='resume'?'active':m.operation==='stop'?'stopped':'paused';result=state;}
   else if(m.operation==='cdp'&&m.params.method==='Page.navigate'){
    if(state.state!=='active')throw Error('Fixture extension is inactive');
    const url=loopback(m.params.params.url),response=await fetch(url,{redirect:'error'});
    if(!response.ok)throw Error('Fixture extension page unavailable');
    const body=await response.text(),tab=state.tabs[0];Object.assign(tab,{url:url.href,origin:url.origin,navigationEpoch:tab.navigationEpoch+1});
    result={result:{frameId:'main',body},...tab};
   }else throw Error('Unsupported fixture extension operation');
   input.write(encodeFrame({version:1,type:'response',id:m.id,bindingId:m.bindingId,generation:m.generation,result}));
  }catch{input.write(encodeFrame({version:1,type:'response',id:m.id,bindingId:m.bindingId,generation:m.generation,error:{code:'unsupported_operation',message:'Fixture extension action refused'}}));}
 }
 input.write(encodeFrame({version:1,type:'hello',profileId:'default',browser:'chromium',extensionVersion:'1.0',capabilities:['scoped_cdp','durable_stop','explicit_share','manual_pause','engine_cdp_v1','unexpected_input_pause','ordered_requests_v1']}));
 const end=Date.now()+5000;
 while(!broker.profiles().some(p=>p.profileId==='default')){if(Date.now()>end)throw Error('Fixture extension did not connect');await sleep(10);}
}
export function fixtureExtensionEngine(options){
 return {
  async call(name,args){
   if(name!=='agent_browser_open')throw Error('Unsupported fixture extension tool');
   loopback(args.url);
   if(!options.authorize())throw Error('Fixture extension is inactive');
   const document=await options.transport.selected();
   // Match BrowserExtensionEngine's Page.navigate path: navigation uses the
   // destination hook; the observation hook refuses a blank bootstrap tab.
   await options.beforeDestination(args.url,document);
   if(!options.authorize())throw Error('Fixture extension is inactive');
   const result=await options.transport.send('Page.navigate',{url:args.url},document);
   return {content:[{type:'text',text:result.body}],structuredContent:{response:{success:true,data:{url:args.url,result:result.body}}}};
  },
  async resolveTarget(){throw Error('Unsupported fixture extension target');},
  async resolveTab(){return options.transport.selected();},event(){},async close(){},
 };
}
