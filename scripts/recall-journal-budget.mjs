// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt producer: recall-prod-x3; calibration consumer: recall-journal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkBudgetLog(text, sha) {
  assert.match(sha, /^[a-f0-9]{40}$/, 'exact source SHA required');
  const pins = [...text.matchAll(/^COMMITTED[= ]([a-f0-9]{40})(?: ROUNDS=12)?$/gm)];
  assert.equal(pins.length, 1, 'one source pin required');
  assert.equal(pins[0][1], sha, 'source changed');
  const rounds = text.split(/^BENCH_BEGIN=/m).slice(1);
  assert.equal(rounds.length, 12, 'all twelve fixed samples required');
  assert(pins[0].index < text.search(/^BENCH_BEGIN=/m), 'source pin must precede samples');
  const samples = rounds.map((round, index) => {
    assert.equal(round.split('\n')[0], String(index + 1), 'sample order changed');
    const ends = [...round.matchAll(/^BENCH_END=(\d+) RC=(\d+)$/gm)];
    assert.equal(ends.length, 1, 'one completion per sample required');
    assert.equal(Number(ends[0][1]), index + 1, 'wrong sample completion');
    const lines = round.split('\n').filter(line => line.startsWith('{"rows":'));
    assert.equal(lines.length, 1, 'one measurement per sample required');
    assert(round.indexOf(lines[0]) < ends[0].index, 'measurement follows completion');
    const metric = JSON.parse(lines[0]);
    assert.equal(metric.rows, 30_000, 'fixed row count changed');
    assert(Array.isArray(metric.attempts) && metric.attempts.length > 0, 'attempts missing');
    assert(Array.isArray(metric.cpu), 'CPU samples missing');
    assert.equal(metric.cpu.length, metric.attempts.length, 'every attempt needs CPU accounting');
    for (const attempt of metric.attempts) {
      assert(Number.isSafeInteger(attempt.rows) && attempt.rows >= 0 && attempt.rows <= 2048, 'invalid attempted rows');
      assert(Number.isFinite(attempt.bytes) && attempt.bytes >= 0, 'invalid attempt bytes');
      assert.equal(typeof attempt.committed, 'boolean', 'commit result missing');
    }
    const committed = metric.attempts.reduce((sum, attempt) => sum + (attempt.committed ? attempt.rows : 0), 0);
    assert.equal(committed, 30_000, 'drain incomplete');
    assert.deepEqual(metric.initial, { bg: 0, debt: 0, total: 0, reserved: 0 }, 'seed admission not settled');
    assert(Number.isSafeInteger(metric.admission?.bg) && metric.admission.bg >= 0, 'invalid final admission bytes');
    assert(metric.bytesPerRow >= metric.attempts.reduce((sum, attempt) => sum + attempt.bytes, 0) / metric.rows, 'attempt charge omitted');
    // Positive ledger deltas can also occur between attempts and after the last one.
    assert(metric.bytesPerRow >= metric.admission.bg / metric.rows, 'final admission charge omitted');
    assert(metric.cpu.every(ms => Number.isFinite(ms) && ms >= 0), 'invalid CPU measurement');
    assert.equal(metric.rowCpuMax, Math.max(...metric.cpu), 'CPU maximum disagrees');
    assert(metric.rowCpuMax <= 10, 'CPU exceeds 10 ms');
    assert(Number.isFinite(metric.bytesPerRow) && metric.bytesPerRow >= 0 && metric.bytesPerRow <= 350, 'bytes exceed 350 per row');
    assert.equal(Number(ends[0][2]), 0, 'whole sample failed');
    return { round: index + 1, committed, bytesPerRow: metric.bytesPerRow, rowCpuMax: metric.rowCpuMax };
  });
  const bytes = samples.map(sample => sample.bytesPerRow).sort((a, b) => a - b);
  const median = (bytes[5] + bytes[6]) / 2, p90 = bytes[Math.ceil(bytes.length * .9) - 1];
  assert(median <= 419 && p90 <= 419, 'paired byte budget exceeded');
  return { sha, median, p90, samples };
}

function selfTest() {
  const sha = '1'.repeat(40);
  const metric = { rows: 30_000, initial: { bg: 0, debt: 0, total: 0, reserved: 0 }, admission: { bg: 7_200_000 }, bytesPerRow: 240, rowCpuMax: 5, cpu: Array(15).fill(5), attempts: Array.from({ length: 15 }, (_, n) => ({ rows: n === 14 ? 1328 : 2048, bytes: 400_000, committed: true })) };
  const log = value => `COMMITTED=${sha}\n` + Array.from({ length: 12 }, (_, n) => `BENCH_BEGIN=${n + 1}\n${JSON.stringify(value)}\nBENCH_END=${n + 1} RC=0\n`).join('');
  assert.equal(checkBudgetLog(log(metric), sha).samples.length, 12);
  const pin = `COMMITTED=${sha}\n`, measurement = JSON.stringify(metric);
  const latePin = log(metric).replace(pin, '').replace('BENCH_BEGIN=1\n', `BENCH_BEGIN=1\n${pin}`);
  assert.throws(() => checkBudgetLog(latePin, sha), /source pin must precede samples/);
  const lateMetric = log(metric).replace(`${measurement}\nBENCH_END=1 RC=0`, `BENCH_END=1 RC=0\n${measurement}`);
  assert.throws(() => checkBudgetLog(lateMetric, sha), /measurement follows completion/);
  for (const [label, change] of [
    ['incomplete', m => { m.attempts[0].committed = false; }],
    ['attempt accounting', m => { m.cpu.pop(); }],
    ['CPU overrun', m => { m.cpu[0] = m.rowCpuMax = 17; }],
    ['CPU maximum', m => { m.cpu[0] = 17; }],
    ['byte overrun', m => { m.bytesPerRow = 351; }],
    ['committed charge', m => { m.attempts[0].bytes = 8_000_000; }],
    ['refused charge', m => { m.attempts.push({ rows: 2048, bytes: 2_000_000, committed: false }); m.cpu.push(5); }],
    ['final charge', m => { m.admission.bg = 8_000_000; }],
    ['negative final charge', m => { m.admission.bg = -1; }],
  ]) {
    const broken = structuredClone(metric); change(broken);
    assert.throws(() => checkBudgetLog(log(broken), sha), undefined, label);
  }
  for (const field of ['bg', 'debt', 'total', 'reserved']) {
    const broken = structuredClone(metric); broken.initial[field] = 1;
    assert.throws(() => checkBudgetLog(log(broken), sha), /seed admission not settled/);
  }
  const refused = structuredClone(metric);
  refused.attempts.push({ rows: 2048, bytes: 200_000, committed: false }); refused.cpu.push(5);
  assert.equal(checkBudgetLog(log(refused), sha).samples.length, 12);
  const reset = structuredClone(refused); reset.admission.bg = 0;
  assert.equal(checkBudgetLog(log(reset), sha).samples.length, 12);
  assert.throws(() => checkBudgetLog(log(metric), '2'.repeat(40)), /source changed/);
  assert.throws(() => checkBudgetLog(log(metric).replace('BENCH_BEGIN=12', 'BENCH_BEGIN=11'), sha), /order changed/);
  assert.throws(() => checkBudgetLog(log(metric).replace('BENCH_END=12 RC=0', 'BENCH_END=12 RC=1'), sha), /sample failed/);
  assert.throws(() => checkBudgetLog(log(metric).slice(0, log(metric).lastIndexOf('BENCH_BEGIN=')), sha), /twelve/);
  console.log('Budget checker self-check passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    assert.equal(process.argv.length, 4, 'usage: node scripts/recall-journal-budget.mjs <log> <exact-sha>');
    console.log(JSON.stringify(checkBudgetLog(readFileSync(process.argv[2], 'utf8'), process.argv[3])));
  }
}
