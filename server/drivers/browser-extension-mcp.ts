// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { readPrivateBrowserClientJson } from "../browser-extension-clients.ts";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "../browser-engine-policy.ts";
import { BROWSER_EXTENSION_CALL_TIMEOUT_MS } from "../../shared/browser-extension-protocol.ts";
import { EXTENSION_CALL_FAILED_TEXT } from "../browser-extension-refusals.ts";
import { readBrowserRefusal } from "../browser-floor-builtin.ts";
export type BrowserExtensionMcpConfig = { endpoint: string; clientId: string; token: string };
export function parseBrowserExtensionMcpConfig(value: unknown): BrowserExtensionMcpConfig {
  const config=value as BrowserExtensionMcpConfig;
  if (!config || typeof config!=="object" || Array.isArray(config) || Object.keys(config).sort().join(",")!=="clientId,endpoint,token" || typeof config.clientId!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.clientId) || typeof config.token!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(config.token) || typeof config.endpoint!=="string") throw new Error("Invalid browser MCP configuration");
  let url: URL; try {url=new URL(config.endpoint);} catch {throw new Error("Invalid browser MCP endpoint");}
  if (url.protocol!=="http:" || !["127.0.0.1","[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname!=="/api/browser-extension/mcp" || url.search || url.hash) throw new Error("Invalid browser MCP endpoint");
  return {...config,endpoint:url.href};
}
async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw Object.assign(new Error("Unavailable"), { refusal: await readBrowserRefusal(response) });
  if (!response.body) throw new Error("Unavailable");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {for (;;) {const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>16*1024*1024)throw new Error("Oversized response");chunks.push(chunk.value);}return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export async function runBrowserExtensionMcp(options: { config: BrowserExtensionMcpConfig; input?: Readable; output?: Writable; fetch?: typeof fetch }): Promise<void> {
  const config=parseBrowserExtensionMcpConfig(options.config),input=options.input??process.stdin,output=options.output??process.stdout,request=options.fetch??fetch;
  const lines:string[]=[];const splitter=createLineSplitter(line=>lines.push(line),64*1024);
  const drain=async()=>{for(const line of lines.splice(0)){
    let rpc: {id?:unknown;method?:unknown;params?:unknown};
    try {rpc=JSON.parse(line);}catch{await writeMcpLine(output,JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Invalid JSON"}}));continue;}
    if (!rpc || typeof rpc!=="object" || Array.isArray(rpc)) {await writeMcpLine(output,JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid request"}}));continue;}
    if (rpc.id===undefined) continue;
    if (!(typeof rpc.id==="string"&&rpc.id.length<=128)&&!(typeof rpc.id==="number"&&Number.isSafeInteger(rpc.id))) {await writeMcpLine(output,JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid request id"}}));continue;}
    try {
      let result: unknown;
      if(rpc.method==="initialize") result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"murage-browser",version:"1"}};
      else if(rpc.method==="ping") result={};
      else if(rpc.method==="tools/list"||rpc.method==="tools/call") {
        let params: Record<string,unknown>={};
        if(rpc.method==="tools/call") {
          if(!rpc.params||typeof rpc.params!=="object"||Array.isArray(rpc.params)||Object.keys(rpc.params).some(key=>!["name","arguments"].includes(key)))throw new Error("Invalid tool request");
          const supplied=rpc.params as Record<string,unknown>;params=validateHeadlessBrowserCall(supplied.name,supplied.arguments??{});
        } else if(rpc.params!==undefined && (!rpc.params||typeof rpc.params!=="object"||Array.isArray(rpc.params)||Object.keys(rpc.params).length))throw new Error("Invalid tool list request");
        result=await boundedResponse(await request(config.endpoint,{method:"POST",headers:{authorization:`Bearer ${config.token}`,"x-murage-browser-client":config.clientId,"content-type":"application/json"},body:JSON.stringify({method:rpc.method,params}),redirect:"error",signal:AbortSignal.timeout(BROWSER_EXTENSION_CALL_TIMEOUT_MS)}));
        if(rpc.method==="tools/list")result={tools:listHeadlessBrowserTools((result as {tools?:unknown}|null)?.tools)};
      } else {await writeMcpLine(output,JSON.stringify({jsonrpc:"2.0",id:rpc.id,error:{code:-32601,message:"Method not available"}}));continue;}
      await writeMcpLine(output,JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
    }catch(error){
      const refusal=(error as {refusal?:{code:string;text:string}}|undefined)?.refusal;
      const message=refusal?.text??EXTENSION_CALL_FAILED_TEXT;
      await writeMcpLine(output,JSON.stringify(rpc.method==="tools/call"?{jsonrpc:"2.0",id:rpc.id,result:{isError:true,...(refusal?{code:refusal.code}:{}),content:[{type:"text",text:message}]}}:{jsonrpc:"2.0",id:rpc.id,error:{code:-32000,message,...(refusal?{data:{code:refusal.code}}:{})}}));
    }
  }};
  for await(const chunk of input){splitter.push(chunk);await drain();}splitter.flush();await drain();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {const file=process.env.MURAGE_BROWSER_MCP_CONFIG;if(!file)throw new Error();const config=parseBrowserExtensionMcpConfig(readPrivateBrowserClientJson(file));void runBrowserExtensionMcp({config}).catch(()=>{process.stderr.write("Browser MCP disconnected. Check Murage connection settings.\n");process.exitCode=1;});}
  catch {process.stderr.write("Browser MCP configuration unavailable. Pair this client in Murage.\n");process.exitCode=1;}
}
