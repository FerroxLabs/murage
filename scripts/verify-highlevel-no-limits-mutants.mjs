// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in an isolated test container. Each mutant restores its source in finally.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = 'evidence/gnl-hl/mutants';
mkdirSync(root, { recursive: true });
const actions = 'server/highlevel/actions.ts';
const api = 'server/highlevel/no-limits-authority-api.test.ts';
const expiry = 'row.basis === "owner_exact_review" && row.expiresAt <= this.#now()';
const mutants = [
 { name: 'F1-direct-message-ticket', file: 'server/index.ts', from: /const highlevelAdmission = highlevelProof \|\| \(directOwnerAudience\s*&& readTurnPolicy\(\{ threadId, generation: dispatchClaimId \}\)\?\.permission.noLimits === true\);/, to: 'const highlevelAdmission = highlevelProof;', test: 'server/highlevel/owner-turn-api.test.ts', filter: 'GNL-HL F1' },
 { name: 'F2-policy-upgrade-not-rebound', file: actions, from: '    const rebound = { ...row, ...current, basis };', to: '    return; const rebound = { ...row, ...current, basis };', test: api, filter: 'pending Ask action' },
 { name: 'F2-policy-review-exclusivity', file: actions, from: 'if (detail.basis === "owner_exact_review" && this.#openByTurn.has(turnKey(context)))', to: 'if (this.#open.size > 0)', test: api, filter: 'overlapping No limits' },
 { name: 'F2-approval-upgrade-race', file: actions, from: 'if (!row || !["awaiting_approval", "approved"].includes(row.phase) || row.dispatchAttempts !== 0) return;', to: 'if (!row || row.phase !== "awaiting_approval") return;', test: api, filter: 'manual approval racing' },
 { name: 'F2-contact-enrollment-is-wipe', file: 'server/highlevel/host.ts', from: "operation !== 'automations.campaign.removeAll' && ", to: '', test: api, filter: 'not a CRM wipe' },
 ...['beginDispatch', '#approve', 'recordAttempt'].map(method => ({ name: 'F2-review-TTL-' + method.replace('#',''), file: actions, method, from: expiry, to: 'row.expiresAt <= this.#now()', test: api, filter: 'survives the human review TTL' })),
];
const results = [];
for (const mutant of mutants) {
 const original = readFileSync(mutant.file, 'utf8');
 let start = 0;
 if (mutant.method) {
  const anchor = mutant.method === '#approve' ? '  #approve(' : '  ' + mutant.method + '(';
  start = original.indexOf(anchor);
  if (start < 0) throw Error('Missing method ' + anchor);
 }
 const before = original.slice(0, start), tail = original.slice(start);
 const changed = before + tail.replace(mutant.from, mutant.to);
 if (changed === original) throw Error('Mutant anchor moved: ' + mutant.name);
 try {
  writeFileSync(mutant.file, changed);
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', mutant.test, '-t', mutant.filter], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(`${root}/${mutant.name}.log`, (result.stdout ?? '') + (result.stderr ?? ''));
  const killed = result.status === 1 && /AssertionError|expected .* to|AssertionError.*expected/s.test((result.stdout ?? '') + (result.stderr ?? ''));
  results.push({ name: mutant.name, status: result.status, signal: result.signal, killed });
  writeFileSync(`${root}/results.json`, JSON.stringify(results, null, 2));
  console.log(mutant.name, killed ? 'KILLED' : 'NOT KILLED', result.status);
  if (!killed) process.exitCode = 1;
 } finally { writeFileSync(mutant.file, original); }
}
