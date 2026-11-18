import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const seat = process.argv[2] ?? '0a';
const recovery = 'server/highlevel/recovery-contract.ts';
const inventory = 'server/highlevel/operations/invocation-plan-inventory.json';
const checker = 'scripts/highlevel-f0-snapshot.ts';
const mutateJson = (source, change) => { const data = JSON.parse(source); change(data); return JSON.stringify(data); };
const cases = {
  'afix-4': [
    ['M-BASELINE-PLAN-OMIT-CUSTOM-FIELD-READER', inventory, source => mutateJson(source, rows => {
      const row = rows.find(row => row.operation === 'contacts.update');
      row.readers = row.readers.filter(read => read.operation !== 'location.customFields.list');
    })],
    ['M-BASELINE-OWNERSHIP-OMIT-CLIENT-RPC', 'server/highlevel/s0-ownership.json', source => mutateJson(source, rows => {
      rows['C2-client'].regions = []; rows['C2-journal'].regions = [];
    })],
    ['M-BASELINE-EVIDENCE-SEARCH-AS-DIRECT', recovery, source => source.replaceAll('reader: z.literal("contacts.get")', 'reader: z.literal("contacts.search")').replaceAll('reader: "contacts.get"', 'reader: "contacts.search"')],
  ],
  'afix-3': [
    ['M-FIELD-CREATE-UNREACHABLE-PREPARATION', inventory, source => mutateJson(source, rows => {
      rows.find(row => row.operation === 'location.customFields.create').readers.find(read => read.phase === 'prepare').when = 'nonempty-custom-fields';
    })],
  ],
  'afix-2': [
    ['M-BULK-RECOVERY-NONEXISTENT-CONTACT-ID', inventory, source => mutateJson(source, rows => {
      const direct = rows.find(row => row.operation === 'contacts.tags.bulk').readers.find(read => read.slot === 'recovery.contacts.get');
      direct.selectors = [{ kind: 'connection', field: 'locationId' }, { kind: 'argument', field: 'contactId' }];
    })],
  ],
  'afix-1': [
    ['M-SEND-OMIT-PREPARATION-SEARCH', inventory, source => mutateJson(source, rows => {
      for (const row of rows.filter(row => row.operation.startsWith('conversations.send.'))) {
        row.readers = row.readers.filter(read => read.slot !== 'prepare.conversations.search');
      }
    })],
  ],
  '0a': [
    ['M-BULK-STALE-INDEX-APPLIED', recovery, source => source.replaceAll('reader: z.literal("contacts.get")', 'reader: z.literal("contacts.search")').replaceAll('reader: "contacts.get"', 'reader: "contacts.search"')],
    ['M-CONTACT-DIRECT-DIGEST-SKIP', recovery, source => source.replaceAll('fullEffectDigest: z.literal(true)', 'fullEffectDigest: z.literal(false)').replaceAll('fullEffectDigest: true', 'fullEffectDigest: false')],
    ['M-RECOVERY-PREWRITE-AS-DIRECT', recovery, source => source.replaceAll('initiatedAfterDispatch: z.literal(true)', 'initiatedAfterDispatch: z.literal(false)').replaceAll('initiatedAfterDispatch: true', 'initiatedAfterDispatch: false')],
    ['M-BULK-PARTIAL-DIRECT-APPLIED', recovery, source => source.replaceAll('allTargets: z.literal(true)', 'allTargets: z.literal(false)').replaceAll('allTargets: true', 'allTargets: false')],
    ['M-SCOPE-CUSTOMFIELD-ID-SKIP', inventory, source => mutateJson(source, rows => { const row = rows.find(row => row.operation === 'contacts.update'); row.readers = row.readers.filter(read => read.operation !== 'location.customFields.list'); })],
    ['M-OWNERSHIP-OMIT-CLIENT-RPC', 'server/highlevel/s0-ownership.json', source => mutateJson(source, rows => { rows['C2-client'].regions = []; rows['C2-journal'].regions = []; })],
  ],
  '0b': [
    ['M-BULK-GET-EACH', 'server/highlevel/operations/schemas/contacts.ts', source => source.replace('offset += 100', 'offset += 1').replace('offset + 100', 'offset + 1')],
    ['M-BULK-DROP-LAST-CHUNK', 'server/highlevel/operations/schemas/contacts.ts', source => source.replace('offset < sorted.length', 'offset < Math.min(sorted.length, 400)')],
    ['M-BULK-PROJECT-FIRST-50', 'server/highlevel/operations/schemas/contacts.ts', source => source.replace('offset + 100', 'offset + 50')],
    ['M-F10-EXCEPTION-WIDEN', recovery, source => source.replace('Object.freeze(["courses.import"] as const)', 'Object.freeze(["courses.import", "contacts.update"] as const)')],
    ['M-F10-ID-SEARCH', inventory, source => source.replaceAll('approved-domain-path', 'redirectId')],
    ['M-RECOVERY-REQUESTER-BUDGET-RESET', recovery, source => source.replace('5 - preparationReads', '5')],
  ],
  '0c': [
    ['M-CHECKER-IGNORE-FIELD-TYPE', checker, source => source.replace('member.type!.getText(file) === parameter.type!.getText(file)', 'true')],
    ['M-LOCATOR-PLAINTEXT', recovery, source => source.replace('ciphertext: boundedCiphertext', 'ciphertext: boundedCiphertext, selectorPlaintext: z.string().optional()')],
    ['M-LOCATOR-SKIP-EXPIRY', recovery, source => source.replace('now < value.expiresAt', 'true')],
    ['M-LOCATOR-SKIP-REVOKE-CLEANUP', recovery, source => source.replace('"grant-revoke", ', '')],
    ['M-LOCATOR-SKIP-CONVERSATION-CLEANUP', recovery, source => source.replace('"conversation-delete", ', '')],
    ['M-LOCATOR-SKIP-STARTUP-CLEANUP', recovery, source => source.replace('startupIndependentOfReplay: true', 'startupIndependentOfReplay: false')],
    ['M-RECOVERY-STALE-PRESTATE', recovery, source => source.replace('source: z.literal("authenticated-dispatch-response")', 'source: z.enum(["authenticated-dispatch-response", "search-unique-after"])')],
  ],
};
const tests = { '0a': 'server/highlevel/s0-planning-contract.test.ts', '0b': 'server/highlevel/s0-batch-contract.test.ts', '0c': 'server/highlevel/s0-privacy-contract.test.ts' };
tests['afix-1'] = tests['0a'];
tests['afix-2'] = tests['0b'];
tests['afix-3'] = tests['0a'];
tests['afix-4'] = 'server/highlevel/s0-baseline-contract.test.ts';
if (!cases[seat]?.length) throw new Error(`No mutant cases for ${seat}`);
const directory = `evidence/hl-s0-contracts/${seat}-mutants`;
mkdirSync(directory, { recursive: true });
const results = [];
for (const [name, file, change] of cases[seat]) {
  const original = readFileSync(file, 'utf8');
  try {
    const changed = change(original);
    if (changed === original) throw new Error(`Mutant did not change source: ${name}`);
    writeFileSync(file, changed);
    const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', tests[seat]], { encoding: 'utf8', timeout: 120000 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    writeFileSync(`${directory}/${name}.log`, output);
    const killed = run.status !== null && run.status !== 0 && /AssertionError|expected .* to /u.test(output);
    results.push({ name, file, status: run.status, assertionKilled: killed });
    if (!killed) throw new Error(`Mutant survived or failed before assertions: ${name}`);
    process.stdout.write(`${name}: assertion-killed\n`);
  } finally { writeFileSync(file, original); }
}
writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2) + '\n');
