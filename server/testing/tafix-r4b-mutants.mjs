// SPDX-License-Identifier: AGPL-3.0-or-later
// Test owner: tafix-r4b. Production owners remain responsible for any exposed bug.
// Run inside the test container: node server/testing/tafix-r4b-mutants.mjs <group> <external-output-dir>.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
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
const scratch = mkdtempSync(join(tmpdir(), 'tafix-mutants-'));
try {
 cpSync(root, scratch, { recursive: true, filter: path => !['.git', 'node_modules'].includes(basename(path)) });
 // Dependency resolution must use this container's installed packages, never a download.
 symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
 for (const [id, , file, before, after, test, title, kind] of selected) {
  const path = join(scratch, file), original = readFileSync(path, 'utf8');
  if (original.split(before).length !== 2) throw Error(`${id}: stale or ambiguous mutation`);
  writeFileSync(path, original.replace(before, after));
  const report = join(output, `${id}.json`);
  const result = spawnSync(process.execPath, [join(scratch, 'node_modules/vitest/vitest.mjs'), 'run', test, '-t', title, '--reporter=json', `--outputFile=${report}`], { cwd: scratch, encoding: 'utf8' });
  writeFileSync(join(output, `${id}.log`), `${result.stdout}\n${result.stderr}`);
  writeFileSync(path, original);
  const rows = JSON.parse(readFileSync(report, 'utf8')).testResults.flatMap(row => row.assertionResults);
  const failures = rows.filter(row => row.status === 'failed');
  if(kind==='equivalent'){
   if(result.status!==0||failures.length||!rows.some(row=>row.status==='passed'))throw Error(`${id}: expected a redundant leaf entry`);
   console.log(`${id}: EQUIVALENT (bounded leaf retained)`);continue;
  }
  const intended = id.startsWith('R4B-7-') ? /expected 'run' to be 'card'/
   : id.startsWith('R4B-8-') ? /expected true to be false/
   : id.startsWith('R4B-9-') ? /expected 'sent' to be undefined/
   : id.startsWith('R4B-10-') ? /not to (?:match|contain)/
   : id.startsWith('R4B-11-') ? /expected false to be true/
   : id==='R4B-12-false-clean' ? /expected 0 to be greater than 0/
   : id.startsWith('R4B-12-') ? /expected true to be false/
   : /expected false to be true/;
  if (result.status !== 1 || !failures.some(row => row.fullName.includes(title) && row.failureMessages.some(message => /AssertionError/.test(message) && intended.test(message))) || failures.some(row => row.failureMessages.some(message => /timed out|Unhandled|ERR_MODULE_NOT_FOUND|ReferenceError|SyntaxError/.test(message)))) throw Error(`${id}: no intended assertion kill`);
  console.log(`${id}: KILLED by ${title}`);
 }
} finally { rmSync(scratch, { recursive: true, force: true }); }
