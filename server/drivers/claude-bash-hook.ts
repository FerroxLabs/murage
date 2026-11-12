// SPDX-License-Identifier: AGPL-3.0-or-later
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { noLimitsWipe } from '../no-limits-wipe.ts';

export const CLAUDE_BASH_WIPE_CALLBACK = 'murage-bash-wipe';
export const CLAUDE_BASH_WIPE_HOOK = {
  PreToolUse: [{ matcher: 'Bash', hookCallbackIds: [CLAUDE_BASH_WIPE_CALLBACK], timeout: 20 * 24 * 60 * 60 }],
};

/** SDK host callbacks survive disableAllHooks (which excludes settings/plugin
 * hooks). Reuse the permission broker so this path has the same decision,
 * approval delivery and turn retirement as the ordinary permission tool. */
export function relayClaudeBash(socketPath: string, input: Record<string, unknown>, signal: AbortSignal, context: Parameters<typeof noLimitsWipe>[1] = {}): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const socket = connect(socketPath), id = randomUUID();
    let buffer = '', done = false;
    const finish = (decision: string, updatedInput?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
        ...(updatedInput ? { updatedInput } : {}), permissionDecisionReason: 'Murage wipe check' } });
    };
    const abort = () => finish('deny');
    const recover = () => {
      if(done)return;
      if(signal.aborted)return abort();
      const command=input.command??input.cmd??input.script;
      let wipe=false;
      try{wipe=typeof command==='string'&&noLimitsWipe(command,{...context,cwd:typeof input.cwd==='string'?input.cwd:context.cwd})!==null;}catch{/* A reader failure alone is not a wipe. */}
      finish(wipe?'deny':'allow');
    };
    const connectTimer = setTimeout(recover, 10_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      if (!done) socket.write(JSON.stringify({ t: 'ask', id, tool: 'Bash', input }) + '\n');
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
