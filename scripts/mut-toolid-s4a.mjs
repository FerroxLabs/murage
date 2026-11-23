#!/usr/bin/env node
// S6 judge-only mutation pass. Hand-translated anchors from r1.2 mutate.py.
// Run on the host: node scripts/mut-toolid-s4a.mjs
// Tests run ONLY through it-remote.sh, sequentially in one networkless container.
// A failed assertion in the unchanged TSV suite kills a mutant; infrastructure
// errors never do. Strict mutants must fail an expected-run corpus row.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = '1fcf6c713268288bdd2a60ae28f8502544037d1d';
const spec = '/root/fuigo-builds/swarm-b/nolimint-redesign/spec/mutate.py';
const specHash = '6bee697b2c86bb0621a0f2a7de7992059ea45c42ccf591ff4338dd7145237f4f';
const corpus = 'server/testing/fixtures/no-limits-r12/judge_expected.tsv';
const corpusHash = 'bca5ba97c9d70a49ea7c8d274969b8ec17d79f87b274383c0870c9e405097134';
const artifacts = join(root, 'evidence/mut-toolid-s4a-logs');
const evidence = join(root, 'evidence/mut-toolid-s4a.tsv');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const code = 'server/no-limits-code.ts';
const py = 'server/no-limits-python.ts';
const js = 'server/no-limits-javascript.ts';
const sh = 'server/no-limits-shell.ts';
// One manually chosen TS anchor per Python mutant. Do not broaden JM1/JM2 to
// JS: their reference anchors affect only PyReader. JM8 disables command
// extraction at the port's helper boundary, preserving all text leaves.
const mutants = [
  ['JM1', 'lenient', py,
    'twinDelete(flag: string, target: string, why: string): void {',
    'twinDelete(flag: string, target: string, why: string): void { target = "$MURAGE_U9";'],
  ['JM2', 'lenient', py,
    'const a = this.resolve(e.left, depth), b = this.resolve(e.right, depth);',
    'throw new Unresolved();'],
  ['JM3', 'strict', code,
    'c = targetFree(text); why = c ? "S1 " + c : "";',
    'c = targetFree(text) || (plainWipe(text) ? "word" : ""); why = c;'],
  ['JM4', 'strict', code,
    'if (!c && plainWipe(text))',
    'if (!c && (plainWipe(text) || text.includes("$MURAGE_U")))'],
  ['JM5', 'strict', code,
    'for (const item of nested) if (item[2] <= MAX_DEPTH) work.push(item);',
    'for (const item of nested) if (item[2] <= MAX_DEPTH) work.push(item); else classes.push("word");'],
  ['JM6', 'lenient', code,
    'if (!c && plainWipe(text))',
    'if (!c && !nested.length && plainWipe(text))'],
  ['JM7', 'lenient', py,
    'else if (f === "os.truncate" && first) {',
    'else if (false) {'],
  ['JM8', 'lenient', code,
    'const cmd = commandArgument(value);',
    'const cmd = undefined;'],
  ['JM9', 'strict', code,
    'else if (lng === "text") [c, why] = readShell(text, depth, [], true);',
    'else if (lng === "text") { [c, why] = readShell(text, depth, [], true); c = c || (plainWipe(text) ? "word" : ""); }'],
  ['JM10', 'strict', code,
    'for (const s of stringLeaves(rest)) work.push(["text", s, 0, "leaf"]);',
    'for (const s of stringLeaves(rest)) work.push(["text", s, 0, "leaf"]);\n    if (!work.length) return { verdict: "card", cls: "word", why: "empty input", twins: [] };'],
  ['JM11', 'lenient', js,
    'this.alias.set(name, kind + (chain.length ? "." + chain[0] : ""));',
    '/* JM11: require alias registration omitted. */'],
  ['JM12', 'lenient', code,
    'for (const lit of r.literals) {',
    'for (const lit of []) {'],
  ['JM13', 'lenient', sh,
    'if (hd.has(args[k])) hop(lang ?? "text", hd.get(args[k])!, "heredoc");',
    '/* JM13: heredoc hop omitted. */'],
];
const protectedPaths = [code, py, js, sh, 'server/code-lexer.ts', 'server/no-limits-code.test.ts', corpus,
  'server/testing/fixtures/no-limits-r12/judge.py'];
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  requireThat(!result.error && !result.signal, `${command}: ${result.error || result.signal}`);
  return result;
}

if (!process.argv.includes('--container')) {
  requireThat(sha(readFileSync(spec)) === specHash, 'Reference mutant manifest changed; review the hand port.');
  requireThat(sha(readFileSync(join(root, corpus))) === corpusHash, 'Corpus bytes changed.');
  for (const file of protectedPaths) {
    const original = run('git', ['show', `${base}:${file}`]);
    requireThat(original.status === 0 && original.stdout === readFileSync(join(root, file), 'utf8'), `${file} differs from ${base}`);
  }
  // Read the literal manifest, never import mutate.py (which executes tests).
  const parsed = run('python3', ['-I', '-c',
    'import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); m=next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=="M" for x in n.targets)); print(json.dumps([x for x in m if x[1]=="judge.py"]))', spec]);
  requireThat(parsed.status === 0, parsed.stderr);
  const reference = JSON.parse(parsed.stdout);
  requireThat(JSON.stringify(reference.map(x => [x[0], x[2]])) === JSON.stringify(mutants.map(x => x.slice(0, 2))), 'Judge mutant coverage differs.');
  requireThat(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 85, 'Host load must be below 85.');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'reference-mutants.json'), JSON.stringify(reference, null, 2) + '\n');
  const result = run('/root/fuigo-builds/tools/it-remote.sh', ['node scripts/mut-toolid-s4a.mjs --container'], {
    stdio: 'inherit', env: { ...process.env, IT_JOB: 'mut-toolid-s4a', IT_W: root,
      IT_ORIG: '/root/fuigo-builds/tools/it-local-generic.sh' },
  });
  process.exitCode = result.status;
} else {
  requireThat(existsSync('/.dockerenv'), 'The test phase requires a container.');
  requireThat(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 85, 'Runner load must be below 85.');
  mkdirSync(artifacts, { recursive: true });
  const reference = JSON.parse(readFileSync(join(artifacts, 'reference-mutants.json'), 'utf8'));
  requireThat(JSON.stringify(reference.map(x => [x[0], x[2]])) === JSON.stringify(mutants.map(x => x.slice(0, 2))), 'Incomplete reference manifest.');
  requireThat(sha(readFileSync(join(root, corpus))) === corpusHash, 'Corpus bytes changed.');
  const before = new Map(protectedPaths.map(file => [file, sha(readFileSync(join(root, file)))]));
  const rows = readFileSync(join(root, corpus), 'utf8').trimEnd().split('\n').slice(1).map(line => {
    const [id, identity, mode, payload, expected] = line.split('\t');
    return { id, identity, mode, payload: JSON.parse(payload), expected };
  });
  requireThat(rows.length === 104, 'Expected 104 corpus rows.');
  const scratch = mkdtempSync(join(tmpdir(), 'mut-toolid-s4a-'));
  const record = ['id\tkind\tstatus\tcorpus_tests\tmismatches\tfailed_rows\tmust_accept_failed\texit_code\tbase_commit\tcorpus_sha256\tmutate_py_sha256\tts_file\tts_old_json\tts_new_json\treport_sha256\tlog_sha256\tutc'];
  let fixture;
  try {
    // Follow docs/verification/README.md: launch the repository's isolated,
    // fake-engine fixture. No live app/data and no provider calls are used.
    const { launchVerificationServer, runControlMurage } = await import(pathToFileURL(join(root, 'scripts/control-murage.ts')));
    fixture = await launchVerificationServer(process.env);
    const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]);
    requireThat(doctor?.ok === true, 'Isolated fixture doctor failed.');
    writeFileSync(join(artifacts, 'fixture.json'), JSON.stringify({ ...fixture.info, doctor }, null, 2) + '\n');
    cpSync(fixture.info.logPath, join(artifacts, 'fixture-server.log'));
    await fixture.close();
    fixture = undefined;
    const template = join(scratch, 'template');
    mkdirSync(join(template, 'server/testing/fixtures/no-limits-r12'), { recursive: true });
    for (const file of protectedPaths) cpSync(join(root, file), join(template, file));
    cpSync(join(root, 'shared'), join(template, 'shared'), { recursive: true });
    writeFileSync(join(template, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(template, 'vitest.config.mjs'), `export default { test: { environment: 'node', include: ['server/no-limits-code.test.ts'], setupFiles: [${JSON.stringify(join(root, 'server/testing/setup.ts'))}], fileParallelism: false, maxWorkers: 1 } };\n`);
    let killed = 0;
    for (const mutation of [null, ...mutants]) {
      requireThat(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 85, 'Load rose above 85; stop before next test.');
      const [id, kind, file, oldText, newText] = mutation || ['BASELINE', 'baseline', '', '', ''];
      const work = join(scratch, id);
      cpSync(template, work, { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      if (mutation) {
        const source = readFileSync(join(work, file), 'utf8');
        requireThat(source.split(oldText).length === 2, `${id}: TS anchor is not unique`);
        writeFileSync(join(work, file), source.replace(oldText, newText));
        writeFileSync(join(artifacts, `${id}.anchor.json`), JSON.stringify({ reference: reference.find(x => x[0] === id), file, oldText, newText }, null, 2) + '\n');
      }
      const reportPath = join(artifacts, `${id}.json`);
      if (existsSync(reportPath)) rmSync(reportPath);
      // Unchanged test file: 104 parity assertions plus the corpus hash and
      // adapter/boundary tests. Only parity mismatches count as kills.
      const result = run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
        '--config', join(work, 'vitest.config.mjs'), '--root', work,
        '--reporter=json', `--outputFile=${reportPath}`], { cwd: work });
      const log = result.stdout + result.stderr;
      writeFileSync(join(artifacts, `${id}.log`), log);
      requireThat(existsSync(reportPath), `${id}: no Vitest report (infrastructure failure): ${log}`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const assertions = report.testResults.flatMap(s => s.assertionResults);
      const parity = assertions.filter(a => a.ancestorTitles.includes('r1.2 judge.py port parity'));
      requireThat(parity.length === rows.length && parity.every(a => ['passed', 'failed'].includes(a.status)), `${id}: incomplete corpus run: ${report.testResults.map(s => s.message).join('; ')}`);
      requireThat(!report.numRuntimeErrorTestSuites && !report.numPendingTests, `${id}: runtime error or skipped tests`);
      const failures = parity.filter(a => a.status === 'failed');
      requireThat(failures.every(a => a.failureMessages.every(m => m.includes('AssertionError: expected'))), `${id}: non-assertion test failure`);
      // Vitest 4 quotes string substitutions in it.each titles.
      const rowId = a => /^['"]?([A-Za-z0-9_-]+)['"]? /.exec(a.title)?.[1];
      requireThat(new Set(parity.map(rowId)).size === rows.length && parity.every(a => rows.some(r => r.id === rowId(a))), `${id}: corpus row identity mismatch`);
      const ids = failures.map(rowId);
      requireThat(ids.every(id => rows.some(r => r.id === id)), `${id}: unknown failed row`);
      const accept = ids.filter(id => rows.find(r => r.id === id).expected === 'run');
      const ok = mutation ? failures.length > 0 && (kind !== 'strict' || accept.length > 0) : result.status === 0 && report.success;
      requireThat(result.status === (report.numFailedTests ? 1 : 0), `${id}: unexpected Vitest exit ${result.status}`);
      const status = mutation ? (ok ? 'KILLED' : 'SURVIVED') : (ok ? 'PASS' : 'FAIL');
      record.push([id, kind, status, parity.length, failures.length, ids.join(','), accept.join(','), result.status,
        base, corpusHash, specHash, file, JSON.stringify(oldText), JSON.stringify(newText),
        sha(readFileSync(reportPath)), sha(log), new Date().toISOString()].join('\t'));
      writeFileSync(evidence, record.join('\n') + '\n');
      console.log(`${id} ${status}: ${failures.length} corpus mismatches; must-accept=${accept.join(',') || 'none'}`);
      safeWipeSync(work);
      if (!ok) {
        console.error(`STOP: ${id} ${status}. Do not edit expectations; review its anchor and propose a missing input.`);
        process.exitCode = 1;
        break;
      }
      if (mutation) killed++;
    }
    console.log(`killed/total=${killed}/${mutants.length}`);
  } finally {
    if (fixture) await fixture.close();
    requireThat(realpathSync(scratch).startsWith(join(tmpdir(), 'mut-toolid-s4a-')), 'Refuse cleanup outside owned scratch.');
    safeWipeSync(scratch);
    for (const [file, hash] of before) requireThat(sha(readFileSync(join(root, file))) === hash, `${file} was changed outside scratch`);
  }
}
