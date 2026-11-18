// SPDX-License-Identifier: AGPL-3.0-or-later
// The foreign CLI launches this wrapper with ordinary stdio. It connects to
// its server before starting the owned writer; receipt frames use that private
// connection, never the MCP stdout stream. Only the writer gets the preload.
import "../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import {connect} from "node:net";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {existsSync} from "node:fs";
const generation=randomUUID(),port=Number(process.env.MURAGE_IO_PROXY_PORT),key=process.env.MURAGE_IO_PROXY_KEY;
const socket=connect({port,host:"127.0.0.1"});
const send=(message:unknown)=>socket.write(JSON.stringify(message)+"\n");
let child:ReturnType<typeof spawn>|undefined,buffer="",exited=false;
const deadline=setTimeout(()=>{socket.destroy();process.exitCode=1;},5000);
socket.once("connect",()=>send({type:"launch",key,generation}));
socket.on("error",()=>{process.exitCode=1;child?.kill();});
socket.on("close",()=>{clearTimeout(deadline);if(!exited){process.exitCode=1;child?.kill();}});
socket.on("data",chunk=>{
 buffer+=chunk;if(buffer.length>64*1024){socket.destroy();return;}
 while(buffer.includes("\n")){
  const at=buffer.indexOf("\n"),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
  try{const frame=JSON.parse(line);
   if(frame.type==="ready"&&!child){
    clearTimeout(deadline);
    const root=dirname(fileURLToPath(import.meta.url)),source=join(root,"io-child-bootstrap.ts"),preload=pathToFileURL(existsSync(source)?source:join(root,"io-child-bootstrap.js")).href;
    const env:NodeJS.ProcessEnv={...process.env,MURAGE_IO_GENERATION:generation,MURAGE_IO_CHILD:"1"};delete env.MURAGE_IO_PROXY_PORT;delete env.MURAGE_IO_PROXY_KEY;
    child=spawn(process.execPath,[`--import=${preload}`,...process.argv.slice(2)],withHideInherit({env,stdio:["pipe","pipe","pipe","ipc"]}));
    process.stdin.pipe(child.stdin!);child.stdout!.pipe(process.stdout);child.stderr!.pipe(process.stderr);
    child.on("message",message=>{if((message as {type?:string})?.type==="io")send({type:"sample",message});});
    child.once("error",()=>{send({type:"exit",code:1,signal:null});exited=true;process.exitCode=1;});
    child.once("exit",(code,signal)=>{exited=true;process.exitCode=code??1;send({type:"exit",code,signal});});
   }else if(frame.type==="ack")child?.send(frame.message);
  }catch{socket.destroy();}
 }
});
for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>{child?.kill(signal);});
