// Run the unmodified product boot on a COPY, with fake engines and no network.
// The product's background runner owns every revoke write. This observer only SELECTs.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const data = '/smooth-data/murage', out = '/out';
const limit = Number(process.env.DRAIN_TIMEOUT_SECONDS ?? 1800) * 1000;
if (!Number.isFinite(limit) || limit <= 0) throw Error('DRAIN_TIMEOUT_SECONDS must be positive');
const interrupted = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => interrupted.abort(Error(`drain interrupted: ${signal}`)));
if (realpathSync(data) !== data || existsSync(`${data}/config.json`)) throw Error('requires an isolated copy without config.json');
mkdirSync('/tmp/drain-home', { recursive: true });
mkdirSync('/tmp/drain-tmp', { recursive: true });
const config = `${data}/config.json`;
writeFileSync(config, JSON.stringify({ instances: { verification: {
  driver: 'claudeAgent', displayName: 'Drain fixture', config: { cli: '/work/server/testing/fake-claude-cli.ts' },
} } }));
// Routines must already have been removed by the copy preparation, as in every gate leg.
if (existsSync(`${data}/routines.json`)) throw Error('remove routines.json from the COPY before boot');
const fd = openSync(`${out}/drain-server.log`, 'a');
const child = spawn(process.execPath, ['--experimental-strip-types', '/work/server/index.ts'], {
  cwd: '/work', stdio: ['ignore', fd, fd, 'ipc'], env: {
    PATH: '', HOME: '/tmp/drain-home', USERPROFILE: '/tmp/drain-home', TMPDIR: '/tmp/drain-tmp',
    XDG_CONFIG_HOME: '/tmp/drain-home/.config', XDG_CACHE_HOME: '/tmp/drain-home/.cache',
    XDG_DATA_HOME: '/tmp/drain-home/.local/share', LANG: 'C.UTF-8',
    MURAGE_DATA_DIR: data, MURAGE_PORT: '19191', MURAGE_WEBHOOK_PORT: '19192',
    MURAGE_ANNOUNCEMENTS_URL: 'off', MURAGE_PUSH_RELAY_URL: 'off',
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1', MURAGE_DEV_DESKTOP_SECRET: 'smooth-drain-fixture',
    MURAGE_KEYCHAIN_UNAVAILABLE: '1', FAKE_CLAUDE_MODE: 'happy',
  },
});
closeSync(fd);
let exited = false, childError;
const exit = new Promise(resolve => {
  child.on('error', error => { childError = error; exited = true; resolve({ code: null, error: error.message }); });
  child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
});
const started = Date.now();
let drained = false, healthy = false, zeroSince = null;
function counts() {
  const db = new DatabaseSync(`${data}/messages.db`, { readOnly: true });
  try {
    return { activeJobs: Number(db.prepare("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active'").get().n),
      pendingJobs: Number(db.prepare("SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')").get().n),
      pendingFlips: Number(db.prepare('SELECT count(*) n FROM memory_receipt_flips').get().n),
      phases: db.prepare("SELECT state,phase,count(*) n FROM memory_revoke_jobs GROUP BY state,phase").all() };
  } finally { db.close(); }
}
try {
  for (;;) {
    interrupted.signal.throwIfAborted();
    if (exited) throw childError ?? Error('product exited before drain completed');
    if (Date.now() - started > limit) throw Error('product drain timed out; fixture is NOT READY');
    try {
      const response = await fetch('http://127.0.0.1:19191/api/health', { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(3000)]) });
      healthy = response.ok;
    } catch { healthy = false; }
    const report = { utc: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), healthy, ...counts() };
    console.log(JSON.stringify(report));
    writeFileSync(`${out}/drain-progress.json`, JSON.stringify(report, null, 2) + '\n');
    if (healthy && report.activeJobs === 0 && report.pendingJobs === 0 && report.pendingFlips === 0) {
      zeroSince ??= Date.now();
      if (Date.now() - zeroSince >= 30000) { drained = true; break; }
    } else zeroSince = null;
    await sleep(15000, undefined, { signal: interrupted.signal });
  }
} finally {
  if (!exited) child.kill('SIGTERM');
  const stopped = await Promise.race([exit, sleep(12000).then(() => null)]);
  if (!stopped) { child.kill('SIGKILL'); await exit; drained = false; }
  unlinkSync(config);
  if (drained) {
    const final = { ...counts(), stopped, product: process.env.PRODUCT_SHA, fakeEngines: process.env.FAKE_SHA };
    if (final.activeJobs !== 0 || final.pendingJobs !== 0 || final.pendingFlips !== 0 || stopped.code !== 0) throw Error('drain/shutdown verification failed');
    writeFileSync(`${out}/drain-complete.json`, JSON.stringify(final, null, 2) + '\n');
    console.log(JSON.stringify(final));
  }
}
