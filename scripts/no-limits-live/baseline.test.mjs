import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BASE_SHA, compareBaseline } from './baseline.mjs';
import { scriptedPrompts, replayScripts } from '../nolim-replay/scripted-prompts.mjs';
it('baseline is hash-bound and non-owner/below-No-limits rows must equal BASE', () => {
 const row = { id: 'parity-ask', engine: 'codex', actor: 'owner', level: 'ask', verdict: 'PASS', cardCount: 1, actionProven: true, ended: true };
 const bytes = JSON.stringify({ tree: BASE_SHA, verdict: 'PASS', rows: [row] });
 const hash = createHash('sha256').update(bytes).digest('hex');
 expect(compareBaseline(bytes, hash, [row]).verdict).toBe('PASS');
 expect(compareBaseline(bytes, hash, [{ ...row, cardCount: 0 }]).verdict).toBe('FAIL');
 expect(compareBaseline(bytes, '0'.repeat(64), [row]).verdict).toBe('FAIL');
});
it('J2 maps requests and refuses unverified synthetic containment before execution', async () => {
 const scripts = scriptedPrompts([{ key: { requestId: 'r' }, engine: 'codex', tool: 'shell', fullToolInput: { command: 'echo fixture' } }], row => row.fullToolInput);
 expect(scripts[0].engine).toBe('codex');
 const containment = { container: true, network: 'allowlist', probe: { attempted: true, blocked: true, host: '192.0.2.1' } };
 await expect(replayScripts(scripts, { containment: {}, run: async () => ({}) })).rejects.toThrow('containment');
 const run = vi.fn(async () => ({ complete: true, actionProven: false, accounting: { verdict: 'PASS' } }));
 await expect(replayScripts(scripts, { containment, run })).rejects.toThrow('containment');
 expect(run).not.toHaveBeenCalled();
});

it('Q6 fake-engine BASE never substitutes for the live BASE gate',()=>{
 const row={engine:'codex',id:'parity-ask',actor:'owner',level:'ask',verdict:'PASS',cardCount:1,actionProven:true,ended:true};
 const bytes=JSON.stringify({tree:BASE_SHA,verdict:'PASS',label:'fake-engine BASE',liveBaseline:false,rows:[row]});
 const result=compareBaseline(bytes,createHash('sha256').update(bytes).digest('hex'),[row]);
 expect(result.verdict).toBe('FAIL');expect(result.errors).toContain('fake-engine BASE cannot satisfy the live BASE gate');
});
