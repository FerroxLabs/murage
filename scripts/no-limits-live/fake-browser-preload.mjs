// Fake browser transport only. The real controller, claims, tool catalogue,
// permission registration and HTTP routes remain loaded.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
process.env.NODE_ENV='test';
globalThis[Symbol.for('murage.browserHost.testHost')]={assertSandbox(){}};
process.env.MURAGE_AGENT_BROWSER_PATH=process.execPath;
registerHooks({load(url,context,next){
 const result=next(url,context);
 if(url.endsWith('/server/browser-extension-integration.ts')){
  const loaded=typeof result.source==='string'?result.source:Buffer.from(result.source).toString();
  const helper=new URL('./browser-fixture.mjs',import.meta.url).href;
  const constructor='this.options = options;',open='const service = await createBrowserExtensionService(';
  if(!loaded.includes(constructor)||!loaded.includes(open))throw Error('Fixture extension transport seam unavailable');
  const source=`import {attachFixtureExtension,fixtureExtensionEngine} from ${JSON.stringify(helper)};\n`+loaded.replace(constructor,'this.options = {...options,createEngine:fixtureExtensionEngine};').replace(open,'await attachFixtureExtension(broker);\n'+open);
  return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(source)};
 }
 if(url.endsWith('/server/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:`
 export function createNativeBrowser(){let address='about:blank',page='Fixture browser ready';
  const visit=async url=>{if(url==='about:blank'){address=url;return;}const target=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('Fixture browser accepts loopback only');const response=await fetch(target);if(!response.ok)throw Error('Fixture page unavailable');address=target.href;page=await response.text();};
  const names=['agent_browser_open','agent_browser_read','agent_browser_snapshot','agent_browser_get_url','agent_browser_close','agent_browser_eval'];
  return {protected:async()=>false,resetStream(){},input(){},
   async request(method,params={}){if(method==='tools/list')return {tools:names.map(name=>({name,inputSchema:{type:'object',properties:{}}}))};if(method!=='tools/call')throw Error('Unknown fixture browser request');if(params.arguments?.url)await visit(params.arguments.url);return {content:[{type:'text',text:params.name==='agent_browser_get_url'?address:page}],structuredContent:{response:{success:true,data:{url:address,result:page}}}};},
   async command(args){if(args[0]==='open')await visit(args[1]);return args[0]==='get'&&args[1]==='url'?address:page;},
   connect:async()=> 'fixture-stream',close:async()=>{},
  };
 }
 `};
 if(url.endsWith('/server/browser-engine.ts')){
  const source=readFileSync(new URL(url),'utf8'),start=source.indexOf('export async function verifyAgentBrowserBinary('),end=source.indexOf('export async function ensureChrome(',start);
  if(start<0||end<0)throw Error('Fake browser verification seam unavailable');
  return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(source.slice(0,start)+'export async function verifyAgentBrowserBinary() {}\n'+source.slice(end))};
 }
 return result;
}});
