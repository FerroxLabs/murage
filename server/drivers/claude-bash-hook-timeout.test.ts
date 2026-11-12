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
