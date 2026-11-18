import { expect, it } from 'vitest';
import { observe, checkContainment } from './observe.mjs';
import { classifyRequest, hashInput } from './oracle-class.mjs';
const request = { type: 'request', engine: 'codex', generation: 'g', requestId: 'r', tool: 'shell', inputHash: hashInput({ command: 'echo fixture' }) };
const spec = { actor: 'owner', level: 'unlimited', expected: 'RUN', requests: [{ engine: 'codex', tool: 'shell', input: { command: 'echo fixture' }, class: 'run' }] };
const observation = () => ({ taps: [request, { type: 'answer', generation: 'g', requestId: 'r', answerId: 'a', state: 'accepted', behavior:'allow' }], registrations: [{ generation: 'g', requestId: 'r' }], records: [], messages: [], queues: [], electron: [], mirrors: [], complete: true });
it('A14a/M66 rejects substitution and extra unclassified requests', () => {
 expect(observe(spec, observation()).verdict).toBe('PASS');
 for (const patch of [{ inputHash: hashInput({ command: 'rm -rf ~' }) }, { tool: 'other' }, { engine: 'gemini' }]) {
  expect(classifyRequest(spec, { ...request, ...patch })).toBe(null);
  const o = observation(); o.taps[0] = { ...request, ...patch }; expect(observe(spec, o).verdict).toBe('FAIL');
 }
});
it('A14b/M67 credentials need no record, but cannot carry a card', () => {
 for (const kind of ['secret', 'mcpSignIn', 'connector']) {
  const o = observation(); o.messages.push({ id: 'credential', kind }); expect(observe(spec, o).verdict).toBe('PASS');
  o.messages[0].card = {}; expect(observe(spec, o).verdict).toBe('FAIL');
 }
});
it('M35 finds queue-only permissions and requires complete all-surface evidence', () => {
 const o = observation(); o.queues.push({ approvalId: 'unrecorded' }); expect(observe(spec, o).verdict).toBe('FAIL');
 for (const surface of ['taps','registrations','records','messages','queues','electron','mirrors']) { const o = observation(); delete o[surface]; expect(observe(spec,o).verdict).toBe('FAIL'); }
});
it('questions are separate; duplicate answers and unmatched records fail', () => {
 const q = { ...spec, requests: [{ ...spec.requests[0], class:'question' }] };
 const o = observation(); o.records.push({ id: 'q', why: 'question', chat_message_id: 'qrow', generation:'g', requestId:'r' }); o.messages.push({ id: 'qrow', kind: 'options', card: { approvalId: 'q', questions: [] } });
 expect(observe(q,o).verdict).toBe('PASS'); expect(observe(q,o).permissions).toBe(0);
 o.taps.push(o.taps[1]); expect(observe(spec,o).verdict).toBe('FAIL');
});
it('S3e/M73 requires a witnessed negative egress probe', () => {
 expect(checkContainment({ container: true, network: 'allowlist', probe: { attempted: true, host: 'blocked.example.invalid', blocked: true } })).toBe(false);
 expect(checkContainment({ container: true, network: 'allowlist' })).toBe(false);
 expect(checkContainment({ container: true, network: 'allowlist', probe: { attempted: true, host: 'blocked.example.invalid', blocked: false } })).toBe(false);
});

it('declared requests cannot disappear, and a question must have its own record', () => {
 const o = observation(); o.taps=[]; o.registrations=[];
 expect(observe(spec,o).verdict).toBe('FAIL');
 const q = { ...spec, requests: [{ ...spec.requests[0], class:'question' }] };
 expect(observe(q,observation()).verdict).toBe('FAIL');
});
