// SPDX-License-Identifier: AGPL-3.0-or-later
import {EventEmitter} from 'node:events';
import {connect} from 'node:net';
import {afterEach,expect,it,vi} from 'vitest';
import {relayClaudeBash} from './claude-bash-hook.ts';
vi.mock('node:net',async original=>{const real=await original<typeof import('node:net')>();return {...real,connect:vi.fn(real.connect)};});
afterEach(()=>{vi.useRealTimers();vi.mocked(connect).mockReset();});
it.each([false,true])('R6 connection timeout uses the local wipe check, wipe=%s',async wipe=>{
 vi.useFakeTimers();
 const socket=Object.assign(new EventEmitter(),{setEncoding:vi.fn(),destroy:vi.fn(),write:vi.fn()});
 vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
 const answer=relayClaudeBash('/fake/socket',{command:wipe?'rm -rf ~':'echo ordinary'},new AbortController().signal);
 await vi.advanceTimersByTimeAsync(10_000);
 expect(await answer).toMatchObject({hookSpecificOutput:{permissionDecision:wipe?'deny':'allow'}});
 expect(socket.destroy).toHaveBeenCalledTimes(1);
});
it('R6 cancellation remains deny for ordinary work even before connect',async()=>{
 const socket=Object.assign(new EventEmitter(),{setEncoding:vi.fn(),destroy:vi.fn(),write:vi.fn()});
 vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
 const abort=new AbortController();abort.abort();
 expect(await relayClaudeBash('/fake/socket',{command:'echo ordinary'},abort.signal)).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
 expect(socket.destroy).toHaveBeenCalledTimes(1);
});

for(const partial of [false,true])it.each([false,true])(`R2 connected response deadline partial=${partial}, wipe=%s`,async wipe=>{
 vi.useFakeTimers();
 const socket=Object.assign(new EventEmitter(),{setEncoding:vi.fn(),destroy:vi.fn(),write:vi.fn()});
 vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
 const abort=new AbortController();
 let result:Record<string,unknown>|undefined;
 const answer=relayClaudeBash('/fake/socket',{command:wipe?'rm -rf ~':'printf ok'},abort.signal).then(value=>{result=value;});
 await vi.advanceTimersByTimeAsync(9_000);
 socket.emit('connect');
 expect(socket.write).toHaveBeenCalledOnce();
 if(partial)socket.emit('data','{"t":"answer"');
 await vi.advanceTimersByTimeAsync(9_999);
 expect(result).toBeUndefined();
 await vi.advanceTimersByTimeAsync(1);
 try{
  // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: ordinary No limits work runs on deadline; both real-wipe controls still deny.
  expect(result).toMatchObject({hookSpecificOutput:{permissionDecision:wipe?'deny':'allow'}});
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
 }finally{abort.abort();await answer;}
});
it.each(['allow','deny'])('R2 connected normal %s reply keeps its decision and clears the deadline',async behavior=>{
 vi.useFakeTimers();
 const socket=Object.assign(new EventEmitter(),{setEncoding:vi.fn(),destroy:vi.fn(),write:vi.fn()});
 vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
 const input={command:'printf ok'},updatedInput={command:'printf narrowed'};
 const answer=relayClaudeBash('/fake/socket',input,new AbortController().signal);
 socket.emit('connect');
 const ask=JSON.parse(socket.write.mock.calls[0]![0]);
 socket.emit('data',JSON.stringify({t:'answer',id:ask.id,behavior,updatedInput})+'\n');
 expect(await answer).toMatchObject({hookSpecificOutput:{permissionDecision:behavior,...(behavior==='allow'?{updatedInput}:{})}});
 expect(vi.getTimerCount()).toBe(0);
 await vi.advanceTimersByTimeAsync(20_000);
 expect(socket.destroy).toHaveBeenCalledTimes(1);
});
