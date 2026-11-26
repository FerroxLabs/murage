// SPDX-License-Identifier: AGPL-3.0-or-later
// Test owner: tafix-r4a (taken over from the closed tafix-r4b). Production owners remain responsible for any exposed bug.
// Run inside the test container: node server/testing/tafix-r4b-mutants.mjs <group> <external-output-dir>.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { verifyDecisionMutant } from '../../scripts/test-truth/decision-mutant.test-helper.mjs';
import { tmpdir } from 'node:os';
import { safeWipeSync } from './safe-wipe.mjs';
const [group, outputArg] = process.argv.slice(2), root = process.cwd(), output = resolve(outputArg);
if (!relative(root, output).startsWith('..' + sep)) throw Error('Evidence must be outside the checkout');
mkdirSync(output, { recursive: true });
const cases = [
 // Raised to MAIN: this is a stronger fault reproducer against real code, not a production mutation.
 ['R4B-7-sustained-active-reader-fault','7','server/decision/no-limits-y3c.test.ts',"const spy=vi.spyOn(interpreter,'interpreterEffects').mockImplementationOnce","const spy=vi.spyOn(interpreter,'interpreterEffects').mockImplementation",'server/decision/no-limits-y3c.test.ts','C3 py transient active-reader fault is entered before the visible root wipe cards'],
 ['R4B-10-stored-record-unredacted','10','server/memory/record-write.ts','safeMemoryRecordText(row.kind, row.text)','row.text','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-10-engine-line-unredacted','10','server/engine-reply-check.ts','const safe = redactSecretsForSink(raw);','const safe = raw;','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-10-approval-input-unredacted','10','server/approval-text.ts','const redacted = redactSecretsForCard(input);','const redacted = input;','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-10-text-pass-through','10','server/redact.ts','export function redactSecretsInText(text:string):string {','export function redactSecretsInText(text:string):string {return text;','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-10-card-pass-through','10','server/redact.ts','export function redactSecretsForCard(input: unknown): unknown {','export function redactSecretsForCard(input: unknown): unknown {return input;','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-10-sink-pass-through','10','server/redact.ts','export function redactSecretsForSink(text:string):string {','export function redactSecretsForSink(text:string):string {return text;','server/redact-sink-boundaries.test.ts','redact-callsite.inventory'],
 ['R4B-8-release-bypass', '8', 'server/decision/provider-release.ts', "try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}", 'try{return true;}', 'server/decision/no-limits-recovery.test.ts', 'R4 final writer rechecks a recovery replacement: rm -rf /'],
 ['R4B-8-projection-only-refresh', '8', 'server/decision/implementation.ts', "||canonical(old.exact)!==canonical(exact)||canonical(old.latestExact)!==canonical(visibleExact)", "", 'server/decision/no-limits-review-fixes.test.ts', 'R1 retained replacement with unchanged display: rm -rf /'],
];
cases.push(
 ['R4B-14-graceful-close','14','server/memory/testing/wal-crash-child.ts','process.send!({ pid: process.pid, cut, handlesOpen: opened?.writable.isOpen && opened.guard.isOpen, ...details });','(opened!.wal as IndexWalWriter).closeForQuarantine();process.send!({ pid: process.pid, cut, handlesOpen: opened?.writable.isOpen && opened.guard.isOpen, ...details });','server/memory/index-wal-state.test.ts','R4 process death 8i-pass-commit, shm kept'],
 ['R4B-9-consume-claim-removed','9','server/index.ts','claimOwnerLimitDispatch(turn.threadId, owner?.generation);','', 'server/limit-backup-gate.test.ts','R4 consuming dispatch rechecks principal after the spend await'],
 ['R4B-9-credit-refusal-ignored','9','server/spend-gate.ts',`if (!outcome.ok) throw new SpendGateRefusal(outcome.holds);
        syncKey();
        const credential = credentialFor(key);
        const holds = credential ? holdsFor(credential) : [];
        if (holds.length) throw new SpendGateRefusal(holds);`,'syncKey();','server/limit-backup-gate.test.ts','R4 consuming dispatch rechecks credit after the spend await'],
 ['R4B-12-no-progress', '12', 'server/memory/index.ts', 'try{return await this.scrubDeletedStep();}finally{restore();}', 'try{return false;}finally{restore();}', 'server/memory/scrub-owner-admission.test.ts', 'foreground memory off: production scrub completes bounded owner deletion'],
 ['R4B-12-false-clean', '12', 'server/memory/index.ts', 'try{return await this.scrubDeletedStep();}finally{restore();}', `try{this.db.exec("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_completed','1');DELETE FROM index_meta WHERE key='delete_scrub_owed'");return true;}finally{restore();}`, 'server/memory/scrub-owner-admission.test.ts', 'foreground memory off: production scrub completes bounded owner deletion'],
);
const independentPrimitives = ['rm ', 'rmdir', 'unlink', 'shred', 'srm', 'Remove-Item', 'ri ', 'del ', 'erase', 'rd ', '-delete', 'git clean', 'dd ', 'mkfs', 'wipefs', 'diskpart', 'format ', 'rmtree', 'os.remove', 'fs.rm', 'rmSync', 'rimraf', 'unlinkSync', 'File.Delete', 'Directory.Delete', 'deleteMany', 'deleteOne', 'dropDatabase', 'dropdb', 'dropuser', 'flushall', 'flushdb'];
for (const [n, primitive] of independentPrimitives.entries()) cases.push([`R4B-11-remove-${n + 1}`, '11', 'shared/no-limits-raw-wipe.ts', `'${primitive}'`, '', 'server/no-limits-raw-boundaries-r9.test.ts', `R9 bounded primitive ${primitive}`]);
for (const primitive of ['os.unlink','os.rmdir']) cases.push([`R4B-11-remove-${primitive}`, '11', 'shared/no-limits-raw-wipe.ts', `'${primitive}'`, '', 'server/no-limits-raw-boundaries-r9.test.ts', `R9 bounded primitive ${primitive}`, 'equivalent']);
// os.unlink and os.rmdir are equivalent removal mutants: the independently bounded
// unlink/rmdir leaf matches every occurrence of those entries. Never count them as killed.
const selected = cases.filter(row => row[1] === group);
if (!selected.length) throw Error('Unknown mutant group');
const pins = JSON.parse(readFileSync(new URL('./tafix-r4b-pins.json', import.meta.url), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'tafix-mutants-'));
let failed = false;
try {
 cpSync(root, scratch, { recursive: true, filter: path => !['.git', 'node_modules'].includes(basename(path)) });
 // Dependency resolution must use this container's installed packages, never a download.
 symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
 process.chdir(scratch);
 for (const [id, , file, before, after, test, title, kind] of selected) {
  const path = join(scratch, file), original = readFileSync(path, 'utf8');
  if (original.split(before).length !== 2) throw Error(`${id}: stale or ambiguous mutation`);
  const args = ['node_modules/vitest/vitest.mjs', 'run', test, '-t', title];
  if (kind === 'equivalent') {
   // Equivalent mutants are never counted as kills: the mutated copy must stay green.
   const result = await verifyDecisionMutant({ id, dir: output, args, file: test, assertions: ['unused'], mutate: () => writeFileSync(path, original.replace(before, after)), restore: () => writeFileSync(path, original) });
   const { green, red, restored } = result, clean = run => run.code === 0 && run.passed > 0 && !run.signal && !run.error;
   if (![green, red, restored].every(clean)) throw Error(`${id}: expected a redundant leaf entry`);
   console.log(`${id}: EQUIVALENT (bounded leaf retained)`); continue;
  }
  const assertions = pins[id];
  if (!Array.isArray(assertions) || !assertions.length) throw Error(`${id}: no pinned assertion`);
  const result = await verifyDecisionMutant({ id, dir: output, args, file: assertions[0].file ?? test, testFile: test, assertions, mutate: () => writeFileSync(path, original.replace(before, after)), restore: () => writeFileSync(path, original) });
  if (result.killed) console.log(`${id}: KILLED by ${title}`);
  else { failed = true; console.log(`${id}: NOT CERTIFIED`); }
 }
} finally { process.chdir(root); safeWipeSync(scratch); }
if (failed) process.exitCode = 1;
