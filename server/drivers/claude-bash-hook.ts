// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { connect } from 'node:net';
import { captureWipeInput } from '../decision/wipe-input.ts';
import { randomUUID } from 'node:crypto';
import { wipeContextFor } from '../wipe/context.ts';
import { noLimitsWipe } from '../no-limits-wipe.ts';


type WipeContext=NonNullable<Parameters<typeof noLimitsWipe>[1]>;

export const CLAUDE_BASH_WIPE_CALLBACK = 'murage-bash-wipe';
export const CLAUDE_BASH_WIPE_HOOK = {
  PreToolUse: [{ matcher: 'Bash', hookCallbackIds: [CLAUDE_BASH_WIPE_CALLBACK], timeout: 20 * 24 * 60 * 60 }],
};

/** SDK host callbacks survive disableAllHooks (which excludes settings/plugin
 * hooks). Reuse the permission broker so this path has the same decision,
 * approval delivery and turn retirement as the ordinary permission tool. */
export function relayClaudeBash(socketPath: string, input: Record<string, unknown>, signal: AbortSignal, context: WipeContext|(()=>WipeContext) = {}, recoveryApplies:()=>boolean=()=>true, onWipe?:(input:Record<string,unknown>,signal:AbortSignal,recoveryScript?:boolean)=>Promise<{behavior:'allow'|'deny';updatedInput?:Record<string,unknown>}>, registerOutOfBand?:(id:string)=>()=>void): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const socket = connect(socketPath), id = randomUUID();
    let buffer = '', done = false, recovering = false;
    const releaseOutOfBand = registerOutOfBand?.(id);
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (decision: string, updatedInput?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      releaseOutOfBand?.();
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
        ...(updatedInput ? { updatedInput } : {}), permissionDecisionReason: 'Murage wipe check' } });
    };
    const abort = () => finish('deny');
    const recover = () => {
      if(done||recovering)return;
      if(signal.aborted)return abort();
      let applies=true;try{applies=recoveryApplies();}catch{/* Keep the prior proven posture on a reader fault. */}
      if(!applies)return abort();
      const raw=captureWipeInput(input);
      if(raw===null)return finish('deny');
      let current:WipeContext={};try{current={...wipeContextFor(),...(typeof context==='function'?context():context)};}catch{return finish('deny');}
      const command=raw.command??raw.cmd??raw.script;
      const cwd=typeof raw.cwd==='string'?raw.cwd:current.cwd;
      if(typeof command!=='string')return finish('allow');
      const recoveryScript=false;
      let wipe=false;
      try{wipe=noLimitsWipe(command,{...current,cwd})!==null;}catch{return finish('deny');}
      if(!wipe||!onWipe)return finish(wipe?'deny':'allow');
      recovering=true;clearTimeout(connectTimer);socket.destroy();
      // A local broker ask uses the same registration, wipe card and final
      // writer guard as a socket ask, without relying on the failed transport.
      void Promise.resolve().then(()=>onWipe(input,signal,recoveryScript)).then(answer=>finish(answer.behavior,answer.updatedInput),()=>finish('deny'));

    };
    const connectTimer = setTimeout(recover, 10_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      if (!done) {
        responseTimer = setTimeout(recover, 10_000);
        NotModelRequest("Local Claude hook broker receives a proposed Bash tool for approval.", socket.write(JSON.stringify({ t: 'ask', id, tool: 'Bash', input }) + '\n'));
      }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return recover();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, end));
        if (answer.t !== 'answer' || answer.id !== id) return recover();
        if(answer.behavior!=='allow'&&answer.behavior!=='deny')return recover();
        finish(answer.behavior === 'allow' ? 'allow' : 'deny', answer.behavior === 'allow' ? answer.updatedInput : undefined);
      } catch { recover(); }
    });
    socket.once('error', recover);
    socket.once('close', recover);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
