import { expect, it } from 'vitest';
import { judgeScenario } from './counts.mjs';
import { availability } from '../nolim-replay/replay-decide.mjs';
import { replayCards } from '../nolim-replay/release-runner.mjs';
import { checkContainment } from './observe.mjs';
import { containmentReport } from './containment.mjs';
const obs = { complete: true, ended: true, actionProven: true, cards: [] };
it('BLOCK4 question presentations are separate from permission counts', () => {
 expect(judgeScenario({ expected: 'RUN' }, { ...obs, cards: [{ question: true, why: 'question' }] }).verdict).toBe('PASS');
 expect(judgeScenario({ expected: 'RUN' }, { ...obs, cards: [{ why: 'base' }] }).verdict).toBe('FAIL');
});
it('BLOCK4 Ask switch counts only later presentations and requires native acknowledgement', () => {
 const spec = { id: 'switch-ask-to-nolimits', expected: 'RUN' };
 const switched = { ...obs, cards: [{ at: 9, why: 'base', answered: 'Allowed (No limits)' }], switch: { at: 10, nativeAck: { at: 11 } } };
 expect(judgeScenario(spec, switched).verdict).toBe('PASS');
 expect(judgeScenario(spec, { ...switched, switch: { at: 10 } }).verdict).toBe('FAIL');
 expect(judgeScenario(spec, { ...switched, cards: [{ at: 12, why: 'base' }] }).verdict).toBe('FAIL');
 expect(judgeScenario(spec, { ...switched, cards: [{ why: 'base' }] }).verdict).toBe('FAIL');
});
it.each([
 { card: { subtitle: 'echo x…[12 bytes more]' } },
 { card: { subtitle: 'x\n[truncated, 100 bytes more]' } },
 { fullToolInput: { command: 'echo [REDACTED]' } },
 { fullToolInput: { text: 'x'.repeat(2048) + '…[22 bytes more]' } },
 { contextRequired: ['host-consent'] },
])('BLOCK6 detects unavailable recorded input/context without boolean flags: %j', patch => {
 expect(availability({ tool: 'shell', fullToolInput: { command: 'echo fixture' }, ...patch }).status).toBe('unavailable');
});
it('BLOCK6 keeps exception reasons and fails unmapped unavailable shapes', async () => {
 const result = await replayCards({ rows: [{ key: { threadId: 't', requestId: 'r' }, tool: 'shell', fullToolInput: null }], labels: [], labelBytes: '[]', committedLabelHash: 'a'.repeat(64), candidateSha: 'b'.repeat(40), baseline: [], production: {} });
 expect(result.results[0].reason).toBe('unavailable:input');
 expect(result.results[0].requiredLiveRow).toBe('unavailable-shell-missing-input');
 expect(result.errors).toContain('unavailable shape lacks passing J3 witness');
});
it('BLOCK7 arguments and a dead reserved address cannot attest enforcement', async () => {
 const report = await containmentReport(['api.example.invalid']);
 expect(report.network).toBe('unverified');
 expect(checkContainment({ container: true, network: 'allowlist', allowlist: ['api.example.invalid'], probe: { attempted: true, host: '192.0.2.1', blocked: true, reason: 'timeout' } })).toBe(false);
});
