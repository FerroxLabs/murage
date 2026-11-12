import { createHash } from 'node:crypto';
export const BASE_SHA = '292df98d80a1c55db3e6f232166fc05162b632ab';
export function compareBaseline(bytes, committedHash, rows) {
 const errors = [];
 if (!/^[a-f0-9]{64}$/.test(committedHash ?? '') || createHash('sha256').update(bytes).digest('hex') !== committedHash) return { verdict: 'FAIL', errors: ['baseline hash mismatch'] };
 let baseline; try { baseline = JSON.parse(bytes); } catch { return { verdict: 'FAIL', errors: ['invalid baseline JSON'] }; }
 if (baseline.label === 'fake-engine BASE' || baseline.liveBaseline === false || baseline.smoke) errors.push('fake-engine BASE cannot satisfy the live BASE gate');
 if (baseline.tree !== BASE_SHA || baseline.verdict !== 'PASS') errors.push('baseline source is not pinned BASE');
 const comparable = r => r.actor === 'non-owner' || r.level !== 'unlimited';
 const projection = r => JSON.stringify({ cards: r.cardCount, actionProven: r.actionProven, ended: r.ended,
  permissions: r.accounting?.permissions, questions: r.accounting?.questions, credentials: r.accounting?.credentials });
 for (const row of rows.filter(comparable)) {
  const matches = (baseline.rows ?? []).filter(b => b.engine === row.engine && b.id === row.id);
  if (matches.length !== 1 || matches[0].verdict !== 'PASS' || projection(matches[0]) !== projection(row)) errors.push(`BASE mismatch: ${row.engine}/${row.id}`);
 }
 return { verdict: errors.length ? 'FAIL' : 'PASS', errors };
}
