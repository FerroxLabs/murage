// Owner: sc-safety-rd (test-to-historical-source map and RED classification).
// Owner: integration runner (historical archives and isolated execution).
// Historical snapshots must be unpacked outside the worktree. Supply their
// locations with SC_RED_REFS_JSON={"78257357":"/tmp/red/78257357",...}.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { safeWipeSync } from '../../../server/testing/safe-wipe.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const argument = process.argv.indexOf('--out');
if (argument < 0 || !process.argv[argument + 1]) throw Error('An external evidence directory is required');
const out = resolve(process.argv[argument + 1]);
if (!relative(root, out).startsWith('..') || out === '/dev' || out.startsWith('/dev/')) throw Error('Evidence must be outside the worktree');
mkdirSync(out, { recursive: true });
const refs = JSON.parse(process.env.SC_RED_REFS_JSON ?? '{}');
const cases = [
  ['A-F1a','78257357','server/sc-safety-r4-regression.test.ts'],
  ['A-F1b','78257357','server/sc-safety-r4-regression.test.ts'],
  ['A-F2a','78257357','server/sc-safety-r4-regression.test.ts'],
  ['A-F2b','7c9ce6fe','server/sc-safety-r4-regression.test.ts'],
  ['A-F2c','418c2209','server/sc-safety-r4-regression.test.ts'],
  ['A-F6','78257357','server/sc-safety-r4-regression.test.ts'],
  ...['H-SCOPE-1','H-SCOPE-2','H-SCOPE-3','H-SCOPE-4','H-SCOPE-5','H-STORE-1','H-CLAUDE-1'].map(id => [id,'56a6de35','server/testing/source-extract.test.ts']),
  ...['H-FENCE-1','H-FENCE-3','H-FENCE-4'].map(id => [id,'56a6de35','server/memory/learning-send-boundary.test.ts']),
  ['H-PLANT-1','56a6de35','server/testing/ast-plant.test.ts'],
  ['A-F3a','78257357','server/drivers/claude-s2-safety-regression.test.ts'],
  ['A-F3b','56a6de35','server/drivers/claude-s2-safety-regression.test.ts'],
  ['A-F3c','56a6de35','server/drivers/claude-s2-safety-regression.test.ts'],
  ['FL-1','56a6de35','server/sc-safety-r4-regression.test.ts'],
];
const excluded = new Set(['node_modules','.git','evidence','lane-evidence','dist','build','target','coverage','.vite','.vitest','test-results','playwright-report']);
const infra = /dispatch dependency missing|FIXTURE_|MUTANT_NOT_ACTIVATED|is not a function|Cannot find module|does not provide an export|ReferenceError|Test timed out/i;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function describeStatement(text, title, file) {
  const source = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  let statement;
  const walk = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'describe'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title
      && ts.isExpressionStatement(node.parent)) statement = node.parent;
    ts.forEachChild(node,walk);
  };
  walk(source);
  if (!statement) throw Error(`RED_TRANSPLANT_MISSING ${title}`);
  return { text:statement.getText(source), start:statement.getStart(source) };
}
function overlayAcceptance(source, file, id, row) {
  const current = readFileSync(join(root,file),'utf8');
  mkdirSync(dirname(join(source,file)),{recursive:true});
  if (file === 'server/memory/learning-send-boundary.test.ts') {
    // The scanner is the subject. Transplant only the new behavioral cases,
    // leaving every historical scanner predicate, pin and caller untouched.
    const original = readFileSync(join(source,file),'utf8');
    const block = describeStatement(current,'scanner redesign regressions',file).text;
    const insertion = describeStatement(original,'T15a: planted bypasses fail the scan',file).start;
    writeFileSync(join(source,file),original.slice(0,insertion)+block+'\n'+original.slice(insertion));
    row.overlay = 'new scanner regression describe only; historical scanner retained';
  } else cpSync(join(root,file),join(source,file));
  if (id === 'FL-1') {
    // The subject is the ledger fixture's finally statement. The new shared
    // extraction harness is infrastructure, and does not replace that subject.
    const support = 'server/testing/source-extract.ts';
    mkdirSync(dirname(join(source,support)),{recursive:true});
    cpSync(join(root,support),join(source,support));
    row.harnessOverlay = [support];
  }
}
const rows = [];
for (const [id, revision, file] of cases) {
  if (process.env.SC_RED_ONLY && !process.env.SC_RED_ONLY.split(',').includes(id)) continue;
  const row = { id, revision, file, verdict: 'INFRA' };
  const snapshot = refs[revision];
  if (!snapshot || !existsSync(snapshot)) { row.reason = 'historical snapshot missing'; rows.push(row); continue; }
  const scratch = mkdtempSync(join(out, 'red-')), source = join(scratch, 'source');
  try {
    cpSync(snapshot, source, { recursive: true, filter: path => !relative(snapshot,path).split('/').some(part => excluded.has(part)) });
    symlinkSync(join(root,'node_modules'),join(source,'node_modules'));
    // Only the acceptance file is overlaid. A product or harness subject that
    // did not exist must be handled by that test's boundary assertion, never
    // silently copied from HEAD to manufacture a historical result.
    overlayAcceptance(source,file,id,row);
    const report = join(out,`${id}-${revision}.json`);
    const run = spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--testNamePattern',escape(id),'--reporter=json',`--outputFile=${report}`],{cwd:source,env:process.env,encoding:'utf8',timeout:650000,maxBuffer:32*1024*1024});
    writeFileSync(join(out,`${id}-${revision}.log`),(run.stdout??'')+(run.stderr??''));
    row.status = run.status;
    if (run.error?.code === 'ETIMEDOUT') row.verdict = 'TIMEOUT';
    else {
      const data = JSON.parse(readFileSync(report,'utf8'));
      const named = data.testResults.flatMap(result=>result.assertionResults??[]).filter(test=>test.fullName.includes(id));
      const failed = named.filter(test=>test.status==='failed');
      // FIXTURE_* inside an expected matcher is not an infrastructure failure;
      // the thrown failure must itself be an AssertionError from the named ID.
      const kills = failed.filter(test=>(test.failureMessages??[]).some(message=>/^AssertionError\b/.test(String(message).replace(/\u001b\[[0-9;]*m/g,'').trimStart().split('\n')[0])));
      const errors = data.testResults.flatMap(result=>result.message?[result.message]:[]);
      row.verdict = kills.length && !data.numRuntimeErrorTestSuites ? 'ASSERTION_RED'
        : named.length && named.every(test=>test.status==='passed') ? 'NOT_RED'
        : errors.some(message=>infra.test(message)) ? 'INFRA' : 'INFRA';
      row.assertions = kills.map(test=>test.fullName);
    }
  } catch (error) { row.reason = String(error); }
  finally { safeWipeSync(scratch, { within: out }); }
  rows.push(row);
  writeFileSync(join(out,'RED-PROOFS.json'),JSON.stringify({pass:rows.every(row=>row.verdict==='ASSERTION_RED'),rows},null,2));
  process.stdout.write(`${id} ${revision} ${row.verdict}\n`);
}
const finalReport = {complete:rows.length===cases.length,pass:rows.length===cases.length&&rows.every(row=>row.verdict==='ASSERTION_RED'),rows};
writeFileSync(join(out,'RED-PROOFS.json'),JSON.stringify(finalReport,null,2));
process.stdout.write(`SC_SAFETY_RED_REPORT\n${JSON.stringify(finalReport)}\n`);
process.exitCode=rows.length>0&&rows.every(row=>row.verdict==='ASSERTION_RED')?0:1;
