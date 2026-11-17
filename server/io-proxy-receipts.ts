// SPDX-License-Identifier: AGPL-3.0-or-later
// Server side owner: this module (private local transport and receipts).
// Launcher side owner: io-proxy-launcher.ts (owned child lifecycle and stdio).
import {createServer,type Server,type Socket} from "node:net";
import {randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import type {ChildProcess} from "node:child_process";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {existsSync} from "node:fs";
import {classifyChildIo} from "./io-child-meter.ts";
import {observeChildIo,invalidateChildIo} from "./sentinel/io-child-receipts.ts";
const stats={launches:0,finals:0,exits:0};
export const proxyIoSnapshot=()=>({...stats});
let server:Server|undefined,ready:Promise<{port:number;key:string}>|undefined;
const sockets=new Set<Socket>();
function endpoint(){return ready??=new Promise<{port:number;key:string}>((ok,no)=>{
 const key=randomUUID();
 server=createServer(socket=>{
  sockets.add(socket);socket.unref();let buffer="",authenticated=false,ended=false;
  const child=Object.assign(new EventEmitter(),{send:(message:unknown)=>socket.write(JSON.stringify({type:"ack",message})+"\n")});
  socket.on("data",chunk=>{
   buffer+=chunk;if(buffer.length>64*1024){invalidateChildIo();socket.destroy();return;}
   while(buffer.includes("\n")){
    const at=buffer.indexOf("\n"),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
    try{const message=JSON.parse(line);
     if(!authenticated){if(message.type!=="launch"||message.key!==key||typeof message.generation!=="string"){socket.destroy();return;}
      authenticated=true;stats.launches++;observeChildIo(child as unknown as ChildProcess,message.generation,{external:true,onIo:r=>{if(r.final)stats.finals++;}});socket.write('{"type":"ready"}\n');
     }else if(message.type==="sample")child.emit("message",message.message);
     else if(message.type==="exit"){stats.exits++;ended=true;child.emit("exit",message.code,message.signal);socket.end();}
     else throw Error("invalid receipt frame");
    }catch{invalidateChildIo();socket.destroy();return;}
   }
  });
  socket.on("error",()=>{if(authenticated)invalidateChildIo();});
  socket.on("close",()=>{sockets.delete(socket);if(authenticated&&!ended)child.emit("exit",null,"SIGKILL");});
 });
 server.once("error",no);server.listen(0,"127.0.0.1",()=>{server!.unref();ok({port:(server!.address() as {port:number}).port,key});});
 });}
/** Called on the final config, after stable warm-key/credential rendering. */
export async function meterProxyServers(servers:Record<string,unknown>):Promise<Record<string,unknown>>{
 const out:Record<string,unknown>={};
 for(const [name,value] of Object.entries(servers)){
  const stanza=value as {command?:string;args?:string[];env?:Record<string,string>};
  const cls=stanza?.command?classifyChildIo(stanza.command,stanza.args??[]):"ENGINE_EXCLUDED";
  if(cls==="UNMAPPED_NODE")invalidateChildIo();
  if(cls!=="OWNED_NODE"){out[name]=value;continue;}
  // Cloud mounts are rendered by a restricted launcher in another namespace.
  // Until that launcher carries this transport its owned writes remain unknown.
  if(process.env.MURAGE_CLOUD_ROLE==="home"){invalidateChildIo();out[name]=value;continue;}
  const {port,key}=await endpoint(),root=dirname(fileURLToPath(import.meta.url));
  const source=resolve(root,"io-proxy-launcher.ts"),entry=existsSync(source)?source:resolve(root,"io-proxy-launcher.js");
  out[name]={...stanza,command:process.execPath,args:[entry,...stanza.args??[]],env:{...stanza.env,...(process.env.MURAGE_RESOURCES_PATH?{MURAGE_RESOURCES_PATH:process.env.MURAGE_RESOURCES_PATH}:{}),...(process.env.OMB_RESOURCES_PATH?{OMB_RESOURCES_PATH:process.env.OMB_RESOURCES_PATH}:{}),MURAGE_IO_PROXY_PORT:String(port),MURAGE_IO_PROXY_KEY:key}};
 }
 return out;
}
export async function closeProxyIoForTest(){if(process.env.NODE_ENV!=="test")throw Error("IO_METER_TEST_ONLY");for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server?server.close(()=>r()):r());server=undefined;ready=undefined;}
