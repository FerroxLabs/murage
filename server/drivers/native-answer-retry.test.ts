import { invalidateCliVersions } from '../cli-version-cache.ts';
import { resetIsolationCache } from './isolation-cache.ts';
import { Socket } from 'node:net';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { CodexDriver } from './codex.ts';
import { ClaudeDriver } from './claude.ts';
import { AntigravityDriver } from './antigravity.ts';
import { PiDriver } from './pi.ts';
import { createAcpDriver } from './acp/core.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';

for(const dead of [false,true]) it.each(['codex','claude','fuigo','gemini','pi'])(`${dead?'T4b':'T4a'} %s failed native write ${dead?'closes unavailable':'retains ask for retry'}`,async engine=>{
 ensureDirs(); const dir=mkdtempSync(join(tmpdir(),'native-retry-'));
 const acp=engine==='fuigo'||engine==='gemini';
 const cli=fileURLToPath(new URL(acp?'./testing/posture-acp.mjs':engine==='claude'?'../testing/fake-claude-cli.ts':engine==='pi'?'../testing/fake-pi-cli.ts':'../testing/fake-codex-app-server.ts',import.meta.url));chmodSync(cli,0o755);
 process.env.FAKE_CODEX_MODE='parent-approval';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command:'echo fixture'});
 const log=join(dir,'frames.jsonl'),gate=join(dir,'go');writeFileSync(gate,'go');
 const input={instanceId:engine,displayName:engine,enabled:true,environment:{FAKE_PI_MODE:'host-confirm',FAKE_PI_COMMAND_LOG:log},config:{cli,fullAuto:false,permissionMode:'default' as const}};
 const instance=acp?await createAcpDriver({driverKind:engine,displayName:engine,models:{default:'',options:[]},defaultCli:cli,nativeSource:'test.acp',loginNote:'unused',spawnArgs:()=>[gate,log,'--question'],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true}).create(input):engine==='claude'?await ClaudeDriver.create(input):engine==='pi'?await PiDriver.create(input):await CodexDriver.create(input);
 const recorder=recordEvents(instance.adapter);let attempted=0,delivered=0;
 const original=Socket.prototype.write;
 const spy=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){
  const line=String(args[0]);
  if(line.includes('"decision":"accept"')||line.includes('"t":"answer"')||line.includes('"extension_ui_response"')||(acp&&line.includes('"id":900')&&!line.includes('"method"'))){
   attempted++;const callback=args.findLast(a=>typeof a==='function');
   if(attempted===1){queueMicrotask(()=>{if(dead)this.destroy();callback?.(new Error('EAGAIN'));});return true;}
   delivered++;
  }
  return original.apply(this,args as any);
 } as any);
 try{
  await instance.adapter.sendTurn({threadId:'retry',cwd:fixtureBotFolder(),text:engine==='claude'?'__fixture_permission_tool__':'fixture',routeAsks:true});
  const opened=await recorder.until(e=>e.type==='request.opened',8000);const id=String(opened.requestId);
  let receiptDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
   const receipt = instance.adapter.respondToRequest('retry',id,{behavior:'allow'},{answerId:'a'});
   if(dead){
    // Check the behavioral boundary before waiting on the explicit receipt.
    // The old Claude broker never confirms that receipt on socket loss.
    await Promise.race([recorder.until(e=>e.type==='request.resolved'&&e.requestId===id,1000).catch(()=>undefined),new Promise(resolve=>{receiptDeadline=setTimeout(resolve,1200);})]);
    expect(attempted,'the dead-write injection must run at this driver site').toBe(1);
    expect(recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===id),'a dead native transport must resolve unavailable exactly once').toMatchObject([{source:'unavailable'}]);
    clearTimeout(receiptDeadline);
   }
   expect(await Promise.race([receipt,new Promise(resolve=>{receiptDeadline=setTimeout(()=>resolve('missing native receipt'),5000);})])).toEqual({state:'failed'});
  } finally { clearTimeout(receiptDeadline); }
  if(!dead){
   expect(recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===id)).toHaveLength(0);
   expect(await instance.adapter.respondToRequest('retry',id,{behavior:'allow'},{answerId:'a'})).toEqual({state:'accepted'});
   expect(attempted).toBe(2);expect(delivered).toBe(1);
   await recorder.until(e=>e.type==='turn.completed');
   if(acp||engine==='pi')expect(readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>acp?x.id===900:x.type==='extension_ui_response')).toHaveLength(1);
  }else{
   await expect(recorder.until(e=>e.type==='request.resolved'&&e.requestId===id)).resolves.toMatchObject({source:'unavailable'});
   expect(await instance.adapter.respondToRequest('retry',id,{behavior:'allow'},{answerId:'a'})).toEqual({state:'failed'});expect(attempted).toBe(1);expect(delivered).toBe(0);
  }
  const resolved=recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===id);
  expect(resolved).toHaveLength(1);expect((resolved[0] as any)?.source).toBe(dead?'unavailable':'user');
 }finally{spy.mockRestore();recorder.stop();await instance.dispose();delete process.env.FAKE_CODEX_MODE;delete process.env.FAKE_CLAUDE_PERM_INPUT;await removeTempDir(dir);}
},60000);

// The single-use hook cannot retry after its socket has closed.
it.each(['codex','antigravity'])('T4c %s closed hook reports unavailable exactly once',async engine=>{
 ensureDirs();const dir=mkdtempSync(join(tmpdir(),'hook-retry-'));
 const cli=fileURLToPath(new URL(engine==='codex'?'../testing/fake-codex-app-server.ts':'../testing/fake-agy-cli.ts',import.meta.url));chmodSync(cli,0o755);
 process.env.FAKE_CODEX_VERSION='codex-cli 0.163.0';invalidateCliVersions();resetIsolationCache();process.env.FAKE_CODEX_MODE='approval';process.env.FAKE_AGY_RUN_HOOKS='1';process.env.FAKE_AGY_TOOL_CALLS=JSON.stringify([{name:'run_command',args:{CommandLine:'echo fixture',Cwd:dir}}]);
 const instance=await(engine==='codex'?CodexDriver:AntigravityDriver).create({instanceId:engine,displayName:engine,enabled:true,environment:{HOME:dir,FAKE_CODEX_VERSION:'codex-cli 0.163.0'},config:{cli,fullAuto:true}});
 const recorder=recordEvents(instance.adapter);const original=Socket.prototype.end;let frames=0;
 const spy=vi.spyOn(Socket.prototype,'end').mockImplementation(function(this:Socket,...args:any[]){
  if(String(args[0]).includes('"decision":"allow"')){frames++;this.destroy();const cb=args.findLast(x=>typeof x==='function');queueMicrotask(()=>cb?.(new Error('closed fixture hook')));return this;}
  return original.apply(this,args as any);
 } as any);
 try{await instance.adapter.sendTurn({threadId:'hook',cwd:fixtureBotFolder(),text:'fixture',routeAsks:true});const opened=await recorder.until(e=>e.type==='request.opened',8000);
  expect(await instance.adapter.respondToRequest('hook',String(opened.requestId),{behavior:'allow'},{answerId:'a'})).toEqual({state:'failed'});
  const resolved=recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===opened.requestId);expect(resolved).toHaveLength(1);expect((resolved[0] as any).source).toBe('unavailable');expect(frames).toBe(1);
 }finally{spy.mockRestore();recorder.stop();await instance.dispose();delete process.env.FAKE_CODEX_MODE;delete process.env.FAKE_AGY_RUN_HOOKS;delete process.env.FAKE_AGY_TOOL_CALLS;delete process.env.FAKE_CODEX_VERSION;invalidateCliVersions();resetIsolationCache();await removeTempDir(dir);}
},20000);
it('T4d codex concurrent legacy finishes coalesce identical frames and reject different frames',async()=>{
 ensureDirs();const cli=fileURLToPath(new URL('../testing/fake-codex-app-server.ts',import.meta.url));chmodSync(cli,0o755);process.env.FAKE_CODEX_MODE='parent-approval';
 const instance=await CodexDriver.create({instanceId:'concurrent',displayName:'Concurrent',enabled:true,environment:{},config:{cli,fullAuto:false}}),recorder=recordEvents(instance.adapter);
 const original=Socket.prototype.write;let frames=0,release:()=>void=()=>{};
 const spy=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){if(String(args[0]).includes('"decision":"accept"')){frames++;release=()=>{original.apply(this,args as any);};return true;}return original.apply(this,args as any);} as any);
 try{await instance.adapter.sendTurn({threadId:'concurrent',cwd:fixtureBotFolder(),text:'fixture',routeAsks:true});const opened=await recorder.until(e=>e.type==='request.opened',8000);const id=String(opened.requestId);
  const first=instance.adapter.respondToRequest('concurrent',id,{behavior:'allow'});await new Promise(r=>setTimeout(r,10));
  const same=instance.adapter.respondToRequest('concurrent',id,{behavior:'allow'});const other=instance.adapter.respondToRequest('concurrent',id,{behavior:'deny'});
  expect(await other).toBe('unavailable');expect(frames).toBe(1);release();expect(await first).toBe('allowed-once');expect(await same).toBe('allowed-once');expect(frames).toBe(1);
 }finally{spy.mockRestore();recorder.stop();await instance.dispose();delete process.env.FAKE_CODEX_MODE;}
},20000);
it.each(['codex','pi'])('T4e %s question timeout retires an ask after failed writable transport',async engine=>{
 ensureDirs();const cli=fileURLToPath(new URL(engine==='codex'?'../testing/fake-codex-app-server.ts':'../testing/fake-pi-cli.ts',import.meta.url));chmodSync(cli,0o755);process.env.FAKE_CODEX_MODE='user-input';
 const instance=await(engine==='codex'?CodexDriver:PiDriver).create({instanceId:'timeout',displayName:'Timeout',enabled:true,environment:{FAKE_PI_MODE:'question'},config:{cli,fullAuto:false}}),recorder=recordEvents(instance.adapter);
 const original=Socket.prototype.write,timeout=globalThis.setTimeout;let expire:(()=>void)|undefined,attempts=0;
 const timers=vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,ms:any,...args:any[])=>{if(ms===30*60_000)expire=()=>fn(...args);return timeout(fn,ms,...args);}) as any);
 const spy=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){const line=String(args[0]);if(line.includes('"answers"')&&!line.includes('"method"')||line.includes('"extension_ui_response"')){attempts++;queueMicrotask(()=>args.findLast(a=>typeof a==='function')?.(new Error('EAGAIN')));return true;}return original.apply(this,args as any);} as any);
 try{await instance.adapter.sendTurn({threadId:'timeout',cwd:fixtureBotFolder(),text:'fixture',routeAsks:true,unattendedAskNote:true});const opened=await recorder.until(e=>e.type==='request.opened',8000);const id=String(opened.requestId);
  expect(await instance.adapter.respondToRequest('timeout',id,{behavior:'deny'},{answerId:'a'})).toEqual({state:'failed'});
  expect(recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===id)).toHaveLength(0);expect(expire).toBeTypeOf('function');expire!();
  await recorder.until(e=>e.type==='request.resolved'&&e.requestId===id);const resolved=recorder.events.filter(e=>e.type==='request.resolved'&&e.requestId===id);expect(resolved).toHaveLength(1);expect((resolved[0] as any).source).toBe('unavailable');expect(attempts).toBe(2);
  expect(await instance.adapter.respondToRequest('timeout',id,{behavior:'deny'},{answerId:'a'})).toEqual({state:'failed'});
 }finally{timers.mockRestore();spy.mockRestore();recorder.stop();await instance.dispose();delete process.env.FAKE_CODEX_MODE;}
},20000);
