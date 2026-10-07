// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable, Writable } from "node:stream";
import { describe,it,expect,vi } from "vitest";
import { runBrowserExtensionMcp, parseBrowserExtensionMcpConfig } from "./browser-extension-mcp.ts";
const config={endpoint:"http://127.0.0.1:12345/api/browser-extension/mcp",clientId:"paired_client",token:"a".repeat(43)};
async function run(messages:unknown[],response:unknown={content:[{type:"text",text:"fixture observation"}]}){
 const calls:unknown[][]=[];let stdout="";
 const fetcher=vi.fn(async(...args:unknown[])=>{calls.push(args);return Response.json(response);});
 const output=new Writable({write(chunk,_encoding,callback){stdout+=chunk.toString();callback();}});
 await runBrowserExtensionMcp({config,input:Readable.from(messages.map(message=>JSON.stringify(message)+"\n")),output,fetch:fetcher as unknown as typeof fetch});
 return {calls,stdout,replies:stdout.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))};
}
describe("paired browser MCP stdio",()=>{
 it.each(["https://127.0.0.1:12345/api/browser-extension/mcp","http://localhost:12345/api/browser-extension/mcp","http://example.com:12345/api/browser-extension/mcp","http://127.0.0.1:12345/other","http://user:pass@127.0.0.1:12345/api/browser-extension/mcp","http://127.0.0.1:12345/api/browser-extension/mcp?q=secret","http://127.0.0.1:12345/api/browser-extension/mcp#x"])("rejects endpoint %s",endpoint=>expect(()=>parseBrowserExtensionMcpConfig({...config,endpoint})).toThrow());
 it("rejects extra client-supplied authority in config",()=>expect(()=>parseBrowserExtensionMcpConfig({...config,botId:"someone"})).toThrow());
 it("initializes and pings with JSON-only stdout",async()=>{const result=await run([{id:1,method:"initialize"},{method:"notifications/initialized"},{id:2,method:"ping"}]);expect(result.calls).toHaveLength(0);expect(result.replies).toHaveLength(2);expect(result.replies[0].result.serverInfo.name).toBe("murage-browser");expect(result.stdout).not.toContain(config.token);});
 it("filters server tool lists to existing restricted contract",async()=>{const result=await run([{id:1,method:"tools/list"}],{tools:[{name:"agent_browser_snapshot"},{name:"agent_browser_evaluate"},{name:"approve"}]});expect(result.replies[0].result.tools.map((tool:{name:string})=>tool.name)).toEqual(["agent_browser_snapshot"]);});
 it("forwards only validated tool arguments with paired credentials",async()=>{const result=await run([{id:1,method:"tools/call",params:{name:"agent_browser_snapshot",arguments:{}}}]);expect(result.calls).toHaveLength(1);const init=result.calls[0][1] as RequestInit;expect(init.redirect).toBe("error");expect(init.headers).toMatchObject({authorization:`Bearer ${config.token}`,"x-murage-browser-client":config.clientId});expect(JSON.parse(init.body as string)).toEqual({method:"tools/call",params:{name:"agent_browser_snapshot",arguments:{}}});expect(result.replies[0].result.content[0].text).toBe("fixture observation");});
 it.each([{name:"agent_browser_evaluate",arguments:{script:"1"}},{name:"agent_browser_snapshot",arguments:{extraArgs:["--cdp=x"]}},{name:"agent_browser_snapshot",arguments:{},botId:"other"}])("refuses malformed or privileged call %j",async params=>{const result=await run([{id:1,method:"tools/call",params}]);expect(result.calls).toHaveLength(0);expect(result.replies[0].result.isError).toBe(true);});
 it("does not forward approval or identity methods",async()=>{const result=await run([{id:1,method:"approvals/allow",params:{requestId:"x"}}]);expect(result.calls).toHaveLength(0);expect(result.replies[0].error.code).toBe(-32601);});
 it("malformed input emits a protocol error without leaking input",async()=>{let output="";await runBrowserExtensionMcp({config,input:Readable.from(["not-json-secret\n"]),output:new Writable({write(chunk,_encoding,cb){output+=chunk.toString();cb();}})});expect(JSON.parse(output).error.code).toBe(-32700);expect(output).not.toContain("secret");});
 it("host failure yields generic refusal without backend secrets",async()=>{let output="";await runBrowserExtensionMcp({config,input:Readable.from([JSON.stringify({id:1,method:"tools/call",params:{name:"agent_browser_snapshot",arguments:{}}})+"\n"]),output:new Writable({write(chunk,_encoding,cb){output+=chunk.toString();cb();}}),fetch:async()=>new Response("private failure",{status:403})});expect(JSON.parse(output).result.isError).toBe(true);expect(output).not.toContain("private failure");});
 it("rejects oversized request frame",async()=>{await expect(runBrowserExtensionMcp({config,input:Readable.from(["x".repeat(65537)]),output:new Writable({write(_chunk,_encoding,cb){cb();}})})).rejects.toThrow("frame exceeds");});
});
