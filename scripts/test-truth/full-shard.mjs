// Complete-source release comparison. Results include every assertion ID;
// a missing JSON report or a killed process is a failure, never a green file.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, existsSync, lstatSync, readlinkSync, openSync, closeSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dedicatedFileBudget } from './file-budget.mjs';
const [side, shardText] = process.argv.slice(2), shard = Number(shardText);
if (!['base', 'head'].includes(side) || !Number.isInteger(shard) || shard < 0 || shard > 7) throw Error('side base|head, shard 0..7');
// Prepare both revisions and all ignored runtime fixtures before the first
// full shard. Base runs once in full, with the same inputs as head.
if(!existsSync('/work/.test-tmp/truth/payload.tar.gz'))throw Error('Prepare pinned runtime fixtures before testing');

const scratch = mkdtempSync(join(tmpdir(), 'test-truth-')), root = join(scratch, 'source'), out = join(scratch, 'results');
mkdirSync(root); mkdirSync(out);
const checked = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, ...options });
  if (r.status !== 0) throw Error(`${cmd}: ${r.status}: ${r.stderr}`); return r.stdout;
};
checked('tar', ['-xzf', `/work/.test-tmp/truth/${side}.tar.gz`, '-C', root]);
// These snapshots are checkouts, not git archive: retain every tracked path,
// including export-ignore paths and Git metadata needed by repository guards.
const sha = checked('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
const files = checked('git', ['ls-files', '-z'], { cwd: root }).split('\0').filter(Boolean);
writeFileSync(join(root, 'server/testing/.git-ls-files.fixture'), files.join('\0') + '\0');
const manifest = JSON.parse(readFileSync(`/work/.test-tmp/truth/${side}-manifest.json`, 'utf8'));
const entries = manifest.files ?? manifest;
const mismatches = [];
if(manifest.revision&&manifest.revision!==sha)mismatches.push('<source revision>');
for (const [file, row] of Object.entries(entries)) {
  try {
    const path=join(root,file), stat=lstatSync(path);
    if(typeof row==='string') {if(createHash('sha256').update(readFileSync(path)).digest('hex')!==row)mismatches.push(file);}
    else if(row.kind==='symlink') {if(!stat.isSymbolicLink()||readlinkSync(path)!==row.target)mismatches.push(file);}
    else if(row.kind==='gitlink') {if(!stat.isDirectory())mismatches.push(file);}
    else if(!stat.isFile()||createHash('sha256').update(readFileSync(path)).digest('hex')!==row.sha256||(stat.mode&0o777)!==(parseInt(row.mode,8)&0o777))mismatches.push(file);
  }
  catch { mismatches.push(file); }
}
writeFileSync(join(out, 'source.json'), JSON.stringify({ side, sha, tracked: files.length, checked: Object.keys(entries).length, mismatches }));
if (mismatches.length) throw Error('incomplete source');
checked('tar', ['-xzf', '/work/.test-tmp/truth/payload.tar.gz', '-C', root]);
const buildPayload=`/work/.test-tmp/truth/${side}-build.tar.gz`;
if(existsSync(buildPayload)) {
  const built=JSON.parse(readFileSync(`/work/.test-tmp/truth/${side}-build.finished`,'utf8'));
  const privatePayload=join(scratch,'runtime.tar.gz');
  copyFileSync(buildPayload,privatePayload);
  if(built.sha!==sha||built.archiveSha256!==createHash('sha256').update(readFileSync(privatePayload)).digest('hex'))throw Error('Runtime fixture does not match its source revision or build receipt');
  checked('tar',['-xzf',privatePayload,'-C',root]);
}
mkdirSync(join(root, 'node_modules'));
for (const name of readdirSync('/work/node_modules')) if (!['.vite', '.vite-temp', '.cache'].includes(name)) symlinkSync(`/work/node_modules/${name}`, join(root, 'node_modules', name));
for(const ref of ['.v101-ref','.v102-ref','.vrel-ref'])if(existsSync(join(root,ref)))symlinkSync(join(root,'node_modules'),join(root,ref,'node_modules'));
mkdirSync(join(scratch, 'home')); mkdirSync(join(scratch, 'data')); writeFileSync(join(scratch, 'gitconfig'), '');
const env = { ...process.env, CI: '1', OPENCLAW_PACKAGE_DIR: '/work/.test-tmp/truth/openclaw/package', HOME: join(scratch, 'home'), MURAGE_E2E_DATA_DIR: join(scratch, 'data'), MURAGE_BACKUP_TEST_AGE_DIR: '/work/.test-tmp/truth/age', PUBLIC_LEAK_GUARD_SHARED_DIR: '/work/.test-tmp/truth/shared', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: join(scratch, 'gitconfig'), MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE: '1' };
const vitest = ['node_modules/vitest/vitest.mjs'];
const all = checked('node', [...vitest, 'list', '--filesOnly'], { cwd: root, env }).split('\n').map(s => s.trim().replace(root + '/', '')).filter(Boolean).sort();
const hash = s => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
const requested = process.env.TEST_TRUTH_FILE_LIST ? new Set(JSON.parse(readFileSync(process.env.TEST_TRUTH_FILE_LIST,'utf8'))) : null;
const own = all.filter(f => hash(f) % 8 === shard && (!requested || requested.has(f)));
writeFileSync(join(out, 'inventory.json'), JSON.stringify({ all, own }));
// Start the declared long model-checker cases first without changing the
// complete partition recorded in inventory.json.
const sequence=[...own.filter(f=>f.includes('keystore-ci.test')),...own.filter(f=>!f.includes('keystore-ci.test'))];
const receipts = [];
// A fixture-only recheck can legitimately assign no files to one index.
// Keep that completed empty shard reviewable with an explicit empty receipt.
writeFileSync(join(out, 'receipts.json'), JSON.stringify(receipts));
const slowFiles = JSON.parse(readFileSync(new URL('./slow-files-1019.json', import.meta.url), 'utf8'));
async function run(batch, label, timeout) {
  const report = join(out, `${label}.json`), fd = openSync(join(out, `${label}.log`), 'w');
  const started = Date.now();
  const progress = join(out, `${label}.jsonl`);
  const child = spawn('node', [...vitest, 'run', ...batch, '--reporter=default', '--reporter=/work/scripts/test-truth/progress-reporter.mjs', '--reporter=json', `--outputFile=${report}`], { cwd: root, env:{...env,TEST_TRUTH_PROGRESS:progress}, stdio: ['ignore', fd, fd], detached: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref(); }, timeout);
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); closeSync(fd);
  let covered = []; try { covered = JSON.parse(readFileSync(report, 'utf8')).testResults.map(r => r.name.replace(root + '/', '')); } catch {}
  const active=new Set();
  if(timedOut)try{for(const line of readFileSync(progress,'utf8').trim().split('\n')){const item=JSON.parse(line),id=item.file+' :: '+item.fullName;if(item.status==='running')active.add(id);else if(item.status!=='collected')active.delete(id);}}catch{}
  const row = { batch, label, ...result, timedOut, timeoutMs:timeout, activeTestIds:[...active], covered, seconds: (Date.now() - started) / 1000 };
  receipts.push(row); writeFileSync(join(out, 'receipts.json'), JSON.stringify(receipts));
  console.log(JSON.stringify({ side, shard, ...row })); return row;
}
try {
  for (let i = 0; i < sequence.length; i += 20) {
    const batch = sequence.slice(i, i + 20);
    // Honor each file's actual Vitest deadlines, including the I/O drain and
    // scale suites. Fixture timestamps and expect.poll budgets do not count.
    const budgets = new Map(batch.map(file => {
      const declared = dedicatedFileBudget(readFileSync(join(root,file),'utf8'),file);
      return [file, slowFiles[file] ? Math.max(declared ?? 0, slowFiles[file].budgetMs) : declared];
    }));
    const long = batch.filter(file => budgets.get(file) !== null);
    const ordinary = batch.filter(file => !long.includes(file));
    if(ordinary.length) {
      const result = await run(ordinary, `batch-${i}`, 900000);
      // Recover all files without authoritative results, even on exit 0.
      for (const [j, file] of ordinary.filter(f => !result.covered.includes(f)).entries()) await run([file], `retry-${i}-${j}`, 600000);
    }
    for(const [j,file] of long.entries())await run([file],`long-${i}-${j}`,budgets.get(file));
  }
  writeFileSync(join(out, 'finished.json'), JSON.stringify({ side, shard, sha, finished: new Date().toISOString() }));
} finally {
  const archive = spawnSync('tar', ['-czf', '-', '-C', out, '.'], { maxBuffer: 512 * 1024 ** 2 });
  if (archive.status !== 0) throw Error('result archive failed');
  process.stdout._handle?.setBlocking(true);
  writeFileSync(1, 'BEGIN_RESULTS\n' + archive.stdout.toString('base64') + '\nEND_RESULTS\n');
  rmSync(scratch, { recursive: true, force: true });
}
