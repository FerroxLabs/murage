import { Socket } from 'node:net';
import { mkdtempSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { CodexDriver } from './codex.ts';
import { ClaudeDriver } from './claude.ts';
import { createAcpDriver } from './acp/core.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';

it.each(['codex','gpt-sol','claude','fuigo','gemini'])('BLOCK1 %s waits for native transport acceptance across a ten-second retry', async engine => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'native-answer-'));
 const acp = engine === 'fuigo' || engine === 'gemini';
 const cli = fileURLToPath(new URL(acp ? './testing/posture-acp.mjs' : engine === 'claude' ? '../testing/fake-claude-cli.ts' : '../testing/fake-codex-app-server.ts', import.meta.url));
 chmodSync(cli,0o755);
 process.env.FAKE_CODEX_MODE = 'parent-approval';
 process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command:'echo fixture' });
 const log=join(scratch,'frames.jsonl'), gate=join(scratch,'go');
 const {writeFileSync}=await import('node:fs'); writeFileSync(gate,'go');
 const input={instanceId:engine,displayName:engine,enabled:true,environment:{},config:{cli,fullAuto:false,permissionMode:'default' as const}};
 const instance = acp ? await createAcpDriver({driverKind:engine,displayName:engine,models:{default:'',options:[]},defaultCli:cli,nativeSource:'test.acp',loginNote:'unused',spawnArgs:()=>[gate,log,'--permission-only'],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true}).create(input)
  : engine === 'claude' ? await ClaudeDriver.create(input) : await CodexDriver.create(input);
 const recorder=recordEvents(instance.adapter);
 let release: (()=>void)|undefined, frames=0;
 const original=Socket.prototype.write;
 const spy=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]) {
  const line=String(args[0]);
  if (line.includes('"decision":"accept"') || line.includes('"t":"answer"') || line.includes('"outcome":"selected"')) {
   frames++; release=()=>{ original.apply(this,args as any); }; return true;
  }
  return original.apply(this,args as any);
 } as any);
 try {
  await instance.adapter.sendTurn({threadId:'ack-'+engine,cwd:fixtureBotFolder(),text:engine==='claude'?'__fixture_permission_tool__':'fixture',askLevel:true,routeAsks:true});
  const opened=await recorder.until(e=>e.type==='request.opened');
  let accepted=false;
  const first=instance.adapter.respondToRequest('ack-'+engine,String(opened.requestId),{behavior:'allow'},{answerId:'a'}).then(result=>{accepted=(result as any).state==='accepted' || typeof result==='string' && result==='allowed-once';return result;},()=>({state:'failed'}));
  await new Promise(r=>setTimeout(r,10_050));
  const retry=instance.adapter.respondToRequest('ack-'+engine,String(opened.requestId),{behavior:'allow'},{answerId:'a'}).catch(()=>({state:'failed'}));
  await new Promise(r=>setTimeout(r,10));
  expect(accepted).toBe(false); expect(frames).toBe(1); expect(release).toBeTypeOf('function');
  release!();
  expect(await first).toEqual({state:'accepted'}); expect(await retry).toEqual({state:'accepted'});
  await recorder.until(e=>e.type==='turn.completed');
  if(acp) expect(readFileSync(log,'utf8').split('\n').filter(s=>s.includes('"outcome":"selected"'))).toHaveLength(1);
 } finally { spy.mockRestore();recorder.stop();await instance.dispose();delete process.env.FAKE_CODEX_MODE;delete process.env.FAKE_CLAUDE_PERM_INPUT;await removeTempDir(scratch); }
},30000);
