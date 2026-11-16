// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reporting acceptance driven through the real packaged desktop server API.
// Imported by verify-gh18-linux-package.mjs; all engine output is synthetic.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { raiseLevel } from '../server/testing/raise-level.ts';

export function seedPackagedReporterHome(home) {
  // The fake accepts its empty native login record; no credential or service.
  mkdirSync(join(home, '.fuigo'), { recursive: true });
  writeFileSync(join(home, '.fuigo', 'auth.json'), '{}');
}
export function packagedReporterInstance(data) {
  const reportPath = join(data, 'gh15-report.md');
  const call = { toolCallId: 'package-report', kind: 'edit', title: 'Apply patch', rawInput: { patch: `*** Begin Patch\n*** Add File: ${reportPath}\n+GH15_SYNTHETIC_REPORT\n*** End Patch\n` }, _meta: { 'fuigo/tool': { version: 1, namespace: 'codex', name: 'apply_patch', kind: 'edit', read_only: false } } };
  // Fuigo's production Linux launch does not nest under the host-power cage.
  // Use the same fake ACP protocol with no test-mode or sandbox bypass flag.
  return { driver: 'fuigoAgent', config: { cli: resolve('server/testing/fake-acp-cli.ts'), fullAuto: false }, environment: { PATH: dirname(process.execPath), FAKE_ACP_MODE: 'permission', FAKE_ACP_GH15_REPORT: '1', FAKE_ACP_PERMISSION_TOOLCALL: JSON.stringify(call), FAKE_ACP_DUMP: join(data, 'gh15-acp.json') } };
}
export async function verifyPackagedReporting(api, data, evidence) {
  const receipts = [];
  const until = async (read, predicate, ms = 45000) => {
    const end = Date.now() + ms; let value;
    do { value = await read(); if (predicate(value)) return value; if (value?.status === 'failed') assert.fail(`Packaged report failed: ${JSON.stringify(value)}`); await new Promise(done => setTimeout(done, 100)); } while (Date.now() < end);
    assert.fail(`Packaged report timed out: ${JSON.stringify(value)}`);
  };
  const made = await api('POST', '/api/bots', { name: 'Packaged reporter', modelSelection: { instanceId: 'reporter', model: 'fake-model' } });
  assert.equal(made.status, 201); const bot = made.body.bot;
  assert.equal((await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false })).status, 200);
  assert.equal((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true })).status, 200);
  for (const scheduled of [false, true]) {
    const reportPath = join(data, 'gh15-report.md');
    if (existsSync(reportPath)) unlinkSync(reportPath);
    const created = await api('POST', '/api/routines', { name: 'Packaged synthetic report', prompt: 'Produce the synthetic report.', botId: bot.id, enabled: scheduled, permissionMode: 'full', schedule: scheduled ? { type: 'once', at: Date.now() + 1000 } : { type: 'interval', everyMinutes: 30, anchorAt: Date.now() } });
    assert.equal(created.status, 201);
    const started = scheduled ? undefined : await api('POST', `/api/routines/${created.body.routine.id}/run`);
    if (started) assert.equal(started.status, 201);
    const read = async () => (await api('GET', '/api/routines')).body.runs.find(r => r.routineId === created.body.routine.id);
    let run = await until(read, r => r?.status === 'completed', scheduled ? 100000 : 45000);
    assert.equal(run.triggerSource, scheduled ? 'schedule' : 'manual'); assert.equal(run.manual, !scheduled);
    if (scheduled) run = await until(read, r => r?.delivery?.state === 'sent', 30000);
    assert(existsSync(reportPath), 'An allowed packaged run must write the report file');
    const report = readFileSync(reportPath, 'utf8'); assert.equal(report, 'GH15_SYNTHETIC_REPORT\n');
    const messages = (await api('GET', `/api/threads/${run.threadId}/messages?limit=100`)).body.messages;
    assert(messages.some(m => m.role === 'bot' && m.text?.includes('Report written: GH15_SYNTHETIC_REPORT')));
    assert.deepEqual(messages.filter(m => m.kind === 'options' && m.card?.requestId && m.card.answered === undefined), []);
    const decision = JSON.parse(readFileSync(join(data, 'gh15-acp.json'))).decision;
    assert.equal(decision.outcome.outcome, 'selected'); assert.match(decision.outcome.optionId, /^allow/);
    receipts.push({ scheduled, created, started, run, report, messages, decision });
    writeFileSync(join(evidence, 'gh15-reporting.json'), JSON.stringify(receipts, null, 2));
  }
  return receipts;
}
