// Run only inside the offline test container. Restore each source before moving on.
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const sourceRoot = process.cwd();
const dir = resolve(sourceRoot, process.env.HLF7_EVIDENCE_DIR ?? '.test-tmp/afix2-hlf7-r3/mutants');
mkdirSync(dir, { recursive: true });
// Mutants never edit the checkout being typechecked or used by another test run.
const isolatedRoot = mkdtempSync(join(tmpdir(), 'afix-hlf7-mutants-'));
const excluded = new Set(['.git', 'node_modules', '.test-tmp', 'evidence', 'dist', 'build']);
for (const entry of readdirSync(sourceRoot)) {
  if (!excluded.has(entry)) cpSync(join(sourceRoot, entry), join(isolatedRoot, entry), { recursive: true, filter: path => !excluded.has(basename(path)) });
}
symlinkSync(join(sourceRoot, 'node_modules'), join(isolatedRoot, 'node_modules'), 'dir');
process.chdir(isolatedRoot);
const cases = [
  ['M1-invoice-collection', 'server/highlevel/write-recovery.ts', "'payments.invoices.list': 'invoices', ", '', 'recovery allows invoice.create'],
  ['M2-invoice-aliases', 'server/highlevel/operations/returned-identity-schemas.ts', 'if (key === "id" || key === "_id")', 'if (key === "id")', 'returned identity recognizes'],
  ['M3-review-values', 'server/highlevel/actions.ts', '...this.#held.get(actionId)?.approvalContextCopy()?.values, ', '', 'review includes the exact'],
  ['M4-ordinary-read-context', 'server/highlevel/host.ts', 'pages.push(spec.project(value, held.frozen));', 'pages.push(spec.project(value));', 'read release supplies'],
  ['M5-frozen-location', 'server/highlevel/held-request.ts', "(key === 'locationId' || key === 'altId')", "key === 'locationId'", 'freeze binds altId'],
  ['M6-reviewed-read-context', 'server/highlevel/host.ts', 'const projected = spec.project(value, dispatch.held.frozen);', 'const projected = spec.project(value);', 'read location binding covers reviewed=true'],
  ['M7-review-digest', 'server/highlevel/actions.ts', ', ...(intent.approvalContextDigest ? [intent.approvalContextDigest] : [])', '', 'immutable review snapshot'],
  ['M8-created-at-window', 'server/highlevel/write-recovery.ts', 'created <= plan.invoiceLookup.createdAfter || ', '', 'uncertain old', 'payments-bounded.test.ts'],
  ['M9-complete-invoice-list', 'server/highlevel/write-recovery.ts', " || plan.collection === 'invoices'", '', 'recovery binds the complete'],
  ['M10-retained-contact-proof', 'server/highlevel/returned-identities.ts', 'held.approvalContextCopy?.()?.identities ?? {}', '{}', 'returned identity recognizes'],
  ['M12-retained-discount', 'server/highlevel/operations/payments.ts', "{ ...invoice, ...a, items: undefined } : a", 'a : a', 'review total includes a retained'],
  ['M13-retained-dynamic-taxes', 'server/highlevel/operations/payments.ts', '      validateValues(priced, verb);', '', 'update refuses retained automatic'],
  ['M14-snapshot-dispatch-race', 'server/highlevel/operations/payments.ts', 'if (!sameSnapshot)', 'if (false)', 'financial snapshot change'],
  ['M15-precreation-collection-read', 'server/highlevel/write-recovery.ts', 'if (!plan.create || plan.invoiceLookup) return;', 'if (!plan.create) return;', 'bounded creation ignores'],
  ['M16-contact-filter', 'server/highlevel/write-recovery.ts', 'contactId: lookup.contactId, startAt:', 'startAt:', 'lookup has a contact filter', 'payments-bounded.test.ts'],
  ['M17-review-clipping', 'server/highlevel/operations/payments.ts', ', invoice, true)', ', invoice)', 'refuses an incomplete financial'],
  ['M18-review-string-clipping', 'server/highlevel/operations/payments.ts', "if (full && (v.length > 4000 || v.length > Math.floor(remaining / 6))) return incomplete();", '', 'refuses an incomplete financial approval snapshot: string'],
  ['M19-review-budget', 'server/highlevel/operations/payments.ts', 'let remaining = 48_000;', 'let remaining = 480_000;', 'refuses an incomplete financial approval snapshot: budget'],
  ['M20-invoiceItems-identity', 'server/highlevel/returned-identities.ts', "part === 'invoiceItems' ? 'items' : part", 'part', 'applies a documented new invoice'],
  ['M21-empty-is-unknown', 'server/highlevel/write-recovery.ts', 'if (plan.invoiceLookup) return conflict();', "if (plan.invoiceLookup) return conflict('negative_confirmation');", 'uncertain empty', 'payments-bounded.test.ts'],
  ['M22-fixed-page-cap', 'server/highlevel/write-recovery.ts', 'if (plan.invoiceLookup && items.length > 100) return;', '', 'uncertain over-cap', 'payments-bounded.test.ts'],
  ['M23-created-before-bound', 'server/highlevel/write-recovery.ts', ' || created > plan.invoiceLookup.createdBefore', '', 'uncertain future', 'payments-bounded.test.ts'],
  ['M24-journal-context-digest', 'server/highlevel/journal-file.ts', ', "approvalContextDigest"]);', ']);', 'durable invoice restart', 'payments-bounded.test.ts'],
  ['M11-text2pay-prestate', 'server/highlevel/write-recovery.ts', '(?:create|upsert|text2pay)', '(?:create|upsert)', 'invoice.text2pay recovery binds'],
  ['M25-required-invoice-items', 'server/highlevel/operations/payments.ts', '        requireReviewableItems(invoice);', '', 'unreviewable fetched invoice items'],
];
const table = [];
for (const [id, path, from, to, test, testFile] of cases.filter(([id]) => !process.env.HLF7_MUTANT_FILTER || id === process.env.HLF7_MUTANT_FILTER)) {
  const before = readFileSync(path, 'utf8');
  if (!before.includes(from)) throw new Error(`Missing mutation anchor: ${id}`);
  try {
    writeFileSync(path, before.replace(from, to));
    const args = ['exec', 'vitest', 'run', `server/highlevel/operations/${testFile ?? 'payments-seams.test.ts'}`, '-t', test];
    const result = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    writeFileSync(join(dir, `${id}.log`), log);
    const killed = result.status !== 0 && /AssertionError/u.test(log) && !/TypeError:|SyntaxError:|Failed to load/u.test(log);
    table.push({ id, command: `pnpm ${args.join(' ')}`, exit: result.status, result: killed ? 'KILLED' : 'SURVIVED_OR_INVALID' });
    console.log(`${id}: ${table.at(-1).result}`);
  } finally { writeFileSync(path, before); }
}
writeFileSync(join(dir, 'table.json'), JSON.stringify(table, null, 2));
if (table.some(row => row.result !== 'KILLED')) process.exitCode = 1;

process.chdir(sourceRoot);
if (!basename(isolatedRoot).startsWith('afix-hlf7-mutants-')) throw new Error('Unexpected mutation directory');
safeWipeSync(isolatedRoot);
