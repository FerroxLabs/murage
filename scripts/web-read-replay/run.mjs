import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { engineSpecs } from './engines.mjs';
import { fakeEngineSetup, fakeSpecs } from './fake-engines.mjs';
import { createHash } from 'node:crypto';
import { launchVerificationServer } from '../control-murage.ts';
import { CardLedger } from './cards.mjs';
import { levelPatch } from '../smoothness/smooth-config.mjs';
import { freePortBlock } from '../../server/testing/ports.ts';
import { waitForExit, removeTempDir } from '../../server/testing/cleanup.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const check = (condition, message) => { if (!condition) throw Error(message); };
const executable = name => process.env.PATH?.split(delimiter).map(p => join(p, name)).find(p => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
});
function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  check(r.status === 0, `fixture git ${args[0]} failed`);
  return r.stdout.trim();
}
export class ProductClient {
  constructor(url, headers, dataDir, timeout = 180000) {
    Object.assign(this, { url, headers, dataDir, timeout });
    this.ledger = new CardLedger(); this.events = []; this.streamErrors = []; this.owned = new Set();
  }
  async api(method, path, body) {
    const res = await fetch(this.url + path, { method, headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const json = await res.json();
    check(res.ok, `${method} ${path} returned ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }
  async connect() {
    this.abort = new AbortController();
    const res = await fetch(this.url + '/api/events', { headers: this.headers, signal: this.abort.signal });
    check(res.ok && res.body, 'event stream unavailable');
    this.stream = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i).trimEnd(); buffer = buffer.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const frame = JSON.parse(line.slice(5).trim());
            this.ledger.event(frame);
            const e = frame.event ?? frame;
            if (e.type) this.events.push({ ...e, threadId: e.threadId ?? frame.threadId, receivedAt: Date.now() });
          }
        }
        if (!this.abort.signal.aborted) this.streamErrors.push('event stream ended unexpectedly');
      } catch (e) { if (!this.abort.signal.aborted) this.streamErrors.push(`event stream failure: ${e.message}`); }
    })();
  }
  async disconnect() { this.abort?.abort(); await this.stream; }
  async messages(threadId) {
    let before; const rows = [], cursors = new Set();
    for (let n = 0; n < 100; n++) {
      const page = await this.api('GET', `/api/threads/${threadId}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      check(Array.isArray(page.messages) && typeof page.hasMore === 'boolean', 'incomplete transcript schema');
      rows.push(...page.messages);
      for (const row of page.messages) this.ledger.observe(threadId, row);
      if (!page.hasMore) return rows;
      before = page.messages[0]?.id;
      check(before && !cursors.has(before), 'transcript pagination did not advance'); cursors.add(before);
    }
    throw Error('transcript exceeded 100 pages');
  }
  async level(id, level) {
    if (level === 'ask' || level === 'auto') return this.api('PATCH', `/api/bots/${id}`, levelPatch(level));
    const path = `/api/bots/${id}/permissions/refresh`, targetLevel = level === 'unlimited' ? 'no-limits' : level;
    const preview = await this.api('POST', path, { scope: 'open', targetLevel });
    const set = await this.api('PATCH', `/api/bots/${id}`, { ...levelPatch(level), acknowledgeLocalAuto: true, settingsScope: 'defaults', previewId: preview.previewId, ifRev: preview.botRev });
    if (preview.eligible?.length) await this.api('POST', path, { scope: 'open', targetLevel, rosterId: preview.rosterId, afterRev: set.permissionRev });
    return { permissionRev: set.permissionRev, eligible: preview.eligible };
  }
  async bot(name, engine, cwd, level) {
    const { bot } = await this.api('POST', '/api/bots', { name, modelSelection: { instanceId: engine.id, model: engine.model } });
    this.owned.add(bot.id);
    await this.api('PATCH', `/api/bots/${bot.id}`, { cwd, autoReview: 'off' });
    await this.level(bot.id, level);
    const current = (await this.api('GET', `/api/bots/${bot.id}`)).bot;
    check(current?.threadId, 'new bot has no thread');
    const actualLevel = !current.autoApprove ? 'ask' : current.fullAccess ? current.noLimits ? 'unlimited' : 'full' : 'auto';
    check(actualLevel === level, `bot level is ${actualLevel}, expected ${level}`);
    return current;
  }
  async stop(bot) {
    await this.api('POST', `/api/bots/${bot.id}/interrupt`, { all: true });
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const current = (await this.api('GET', `/api/bots/${bot.id}`)).bot;
      if (current?.busy === false) return;
      await sleep(200);
    }
    throw Error('owned bot did not settle after interrupt');
  }
  async observe(bot, send, tick = async () => {}) {
    const mark = this.events.length, start = Date.now();
    await send();
    let ended, turnId;
    const answered = new Set();
    try {
      while (Date.now() - start < this.timeout) {
        await tick();
        const open = await this.api('GET', `/api/threads/${bot.threadId}/open-cards`);
        check(Array.isArray(open.openCards), 'open-cards unreadable');
        if (open.pending !== true) for (const row of open.openCards) {
          this.ledger.observe(bot.threadId, row);
          const c = row.card;
          if (!c?.requestId || c.answered || answered.has(c.requestId)) continue;
          // Never execute a must-card action, or approve unexpected cards to manufacture a pass.
          await this.api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: c.requestId, behavior: 'deny' });
          answered.add(c.requestId);
        }
        const events = this.events.slice(mark).filter(e => e.threadId === bot.threadId);
        turnId ??= events.find(e => e.type === 'turn.started')?.turnId;
        ended = events.find(e => ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(e.type) && (!turnId || e.turnId === turnId));
        if (ended) break;
        check(!this.streamErrors.length, 'lost event stream');
        await sleep(200);
      }
      check(ended, 'turn timed out');
      await sleep(300); // Drain product message patches queued behind the turn end.
      const messages = await this.messages(bot.threadId);
      const open = await this.api('GET', `/api/threads/${bot.threadId}/open-cards`);
      check(open.pending === false || open.pending === undefined, 'open-cards still pending');
      check(Array.isArray(open.openCards), 'final open-cards unreadable');
      for (const row of open.openCards) this.ledger.observe(bot.threadId, row);
      const events = this.events.slice(mark).filter(e => e.threadId === bot.threadId);
      return { complete: true, ended: ended.type === 'turn.completed' && ended.ok !== false,
        cards: this.ledger.forThreads([bot.threadId]), messages, events,
        errors: [...this.ledger.problems([bot.threadId]), ...this.streamErrors], threadIds: [bot.threadId],
        turn: { type: ended.type, ok: ended.ok, turnId: ended.turnId } };
    } catch (error) {
      await this.stop(bot);
      throw error;
    }
  }
  turn(bot, text, tick) {
    return this.observe(bot, () => this.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: randomUUID() }), tick);
  }
}

async function launchLive(out, specs) {
  check(process.platform === 'linux', 'Live gate is Linux only; never run on the Mac');
  check(process.getuid?.() !== 0, 'Run live as the already signed-in gate engine user, not root');
  const root = mkdtempSync(join(tmpdir(), 'webread-live-'));
  const data = join(root, 'data'), home = join(root, 'sandbox-home'), work = join(root, 'work');
  for (const p of [data, home, work]) mkdirSync(p);
  const emptyConfig = join(root, 'empty.gitconfig'); writeFileSync(emptyConfig, '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // Only the engine itself gets the existing login HOME. Never read, copy, write or configure credentials.
  // The PRODUCT home is disposable: its literal home wipe target contains no login material.
  const environment = Object.fromEntries(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(environment, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: Object.fromEntries(specs.map(s => [s.id, { driver: s.driver, config: { cli: s.path }, environment }])) }));
  const port = await freePortBlock([0, 1]);
  const secret = randomUUID();
  const terms = /TERMS_VERSION\s*=\s*["']([^"']+)/.exec(readFileSync(join(ROOT, 'shared/terms.ts'), 'utf8'))?.[1];
  check(terms, 'terms version unreadable');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: root, MURAGE_DATA_DIR: data, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1', MURAGE_DEV_DESKTOP_SECRET: secret, MURAGE_TERMS_ACCEPTED: terms,
    MURAGE_ANNOUNCEMENTS_URL: 'off', MURAGE_PUSH_RELAY_URL: 'off', MURAGE_TURN_TRACE: '1',
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  writeEvidence(join(out, 'server.log'), '');
  const fd = openSync(join(out, 'server.log'), 'a');
  const tracePreload = join(root, 'route-trace.mjs');
  writeFileSync(tracePreload, `import { readFileSync } from 'node:fs'; import { join } from 'node:path'; const data = ${JSON.stringify(data)};` + browserFixtureSource(false));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(tracePreload).href, join(ROOT, 'server/index.ts')], { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const fixture = { root, data, home, work, gitEnv, child,
    client: new ProductClient(`http://127.0.0.1:${port}`, { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret }, data),
    async close() { await waitForExit(child, { signal: 'SIGTERM' }); await removeTempDir(root, { strict: true }); } };
  try {
    for (let n = 0; n < 600; n++) {
      check(child.exitCode === null, 'fixture server exited during boot');
      try { const h = await fixture.client.api('GET', '/api/health'); if (h.app === 'murage') { check(h.pid === child.pid, 'health is not the owned child'); return fixture; } } catch {}
      await sleep(200);
    }
    throw Error('fixture server startup timed out');
  } catch (e) { await fixture.close(); throw e; }
}
const source = readFileSync(join(ROOT, 'scripts/web-read-replay/fixtures/sales-13342.txt'), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
export function judgeReplay({ text, ranges, cards, events, ended, defaultRoute, routeReceipts, navigationRequests, captures, continuationRequests, lane = "browser" }) {
  check(source.length === 13342, 'fixture length changed');
  for (const marker of ['## Guarantee', '## Fine print', '## Checkout']) check(source.indexOf(marker) > 12000, `${marker} must be after 12k`);
  check(text === source, 'page incomplete or changed');
  check(ranges.length > 1, 'no continuation evidence');
  let offset = 0;
  for (const range of ranges) {
    check(range.handle === ranges[0].handle && range.offset === offset && range.total_length === source.length, 'invalid range receipt');
    check(range.eof === (range.next_offset === null), 'invalid EOF receipt');
    check(range.next_offset === null || (Number.isSafeInteger(range.next_offset) && range.next_offset > range.offset && range.next_offset <= source.length), 'invalid advancing range');
    offset = range.next_offset ?? range.total_length;
  }
  check(offset === source.length && ranges.at(-1).eof, 'missing EOF');
  check(cards.length === 0, `expected zero approval cards, saw ${cards.length}`);
  check(ended, 'engine read did not complete');
  check(events.filter(e => e.type === 'item.completed' && e.itemType === 'tool' && e.ok !== false).length >= (lane === 'browser' ? 5 : 4), 'missing completed tool events');
  if (lane === 'browser') {
    check(defaultRoute?.browser !== false && defaultRoute && !defaultRoute.useMyChrome && defaultRoute.browserTransport !== 'extension', 'not the default browser route');
    const completedReads = events.filter(e => e.type === 'item.completed' && e.itemType === 'tool' && e.ok !== false && (/agent_browser_read/.test(String(e.title ?? e.name ?? '')) || events.some(start => start.type === 'item.started' && start.itemId === e.itemId && /agent_browser_read/.test(String(start.title)))));
    check(completedReads.length >= ranges.length, 'missing browser tool events');
    check(routeReceipts?.length === ranges.length && routeReceipts.every((r, i) => r.route === 'unified' && r.handle === ranges[i].handle && r.offset === ranges[i].offset && r.next_offset === ranges[i].next_offset && r.total_length === ranges[i].total_length && r.eof === ranges[i].eof), 'missing unified route receipts');
    check(navigationRequests === 1 && captures === 1 && continuationRequests === ranges.length - 1, 'invalid browser capture counts');
  }
}
async function runReplay(f, engine, site, out, fake, lane = "browser") {
  const cwd = join(f.work, engine.id + '-' + lane); mkdirSync(cwd); mkdirSync(join(cwd, 'dir'));
  writeFileSync(join(cwd, 'dir', 'sample.txt'), 'fixture\n');
  const bot = await f.client.bot(`Web read ${engine.id}`, engine, cwd, 'unlimited');
  const url = `${site.url}/sales`;
  const eventPath = join(f.client.dataDir, 'browser-route-events.jsonl');
  const browserEvents = () => existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const mark = browserEvents().length;
  const instruction = lane === 'browser'
    ? `Open ${url} in your browser and read the whole page with the browser read tool, 4000 at a time, continuing with handle and next_offset until eof. The initial read uses {length:4000} with no URL so it captures the open page once.`
    : `Read ${url} using Murage web_read with length 4000; continue with handle and next_offset until eof.`;
  const text = `Owner-authorized isolated release fixture. Work only in ${cwd}. ${instruction} Save the exact concatenated text without wrappers in reconstructed.txt. Save range receipts (handle, offset, next_offset, total_length, eof) as ranges.json. Do not use another page reader. Then make these four shell tool calls in order:
cd ${quote(join(cwd, 'dir'))} && pwd > ${quote(join(cwd, 'cd.done'))}
ls ${quote(join(cwd, 'dir'))} > ${quote(join(cwd, 'ls.done'))}
curl -fsS ${quote(site.url + '/expected')} -o ${quote(join(cwd, 'curl.done'))}
python3 -c ${quote("from pathlib import Path; import hashlib; p=Path(" + JSON.stringify(cwd) + "); a=(p/'reconstructed.txt').read_bytes(); b=(p/'curl.done').read_bytes(); assert a==b; (p/'python.done').write_text(hashlib.sha256(a).hexdigest())")}
Use the tools; prose is not evidence. If refused, stop. Never buy anything or contact an external service.${fake ? '\n__fixture_' + (lane === 'browser' ? 'browser_read' : 'web_read') + '__:' + url : ''}`;
  const obs = await f.client.turn(bot, text);
  const read = name => readFileSync(join(cwd, name), 'utf8');
  const result = { engine: engine.id, lane, verdict: 'FAIL', ...(lane === 'browser' ? { gweb: 'FAIL' } : {}), followOn: 'NOT_ATTEMPTED', defaultRoute: { browser: bot.browser, useMyChrome: bot.useMyChrome, browserTransport: bot.browserTransport, browserProfile: bot.browserProfile }, fetches: site.readHits, cards: obs.cards, errors: obs.errors, events: obs.events, turn: obs.turn };
  try {
    const reconstructed = read('reconstructed.txt');
    result.textHash = hash(reconstructed); result.readComplete = reconstructed === source; result.ranges = JSON.parse(read('ranges.json'));
    check(result.readComplete, 'page incomplete or changed');
    const trace = browserEvents().slice(mark);
    result.routeReceipts = trace.filter(e => e.kind === 'route');
    result.navigationRequests = trace.filter(e => e.kind === 'navigation').length;
    result.captures = trace.filter(e => e.kind === 'capture').length;
    result.continuationRequests = result.routeReceipts.filter(e => e.offset > 0).length;
    result.nativeReads = trace.filter(e => e.kind === 'native-read').length;
    const exists = name => existsSync(join(cwd, name));
    result.commands = { cd: exists('cd.done') && read('cd.done').trim() === join(cwd, 'dir'), ls: exists('ls.done') && read('ls.done').trim() === 'sample.txt', curl: exists('curl.done') && read('curl.done') === source, python: exists('python.done') && read('python.done') === hash(source) };
    check(obs.errors.length === 0, obs.errors.join('; '));
    result.followOn = Object.values(result.commands).every(Boolean) ? "PASS" : "REFUSED_OR_INCOMPLETE";
    judgeReplay({ ...result, text: read('reconstructed.txt'), ranges: result.ranges, cards: obs.cards, events: obs.events, commands: result.commands, ended: result.readComplete && result.ranges.at(-1)?.eof });
    check(site.readHits === 1, `expected one fetch, got ${site.readHits}`);
    result.verdict = 'PASS'; if (lane === 'browser') result.gweb = 'PASS';
  } catch (error) { result.errors.push(error.message);
    if (obs.messages.some(m => /browser read refused|Network read must use|browser_read.*unavailable/.test(JSON.stringify(m)))) result.errors.push('browser read refused');
    if (obs.messages.some(m => /no continuation evidence/.test(JSON.stringify(m)))) result.errors.push('no continuation evidence');
  }
  writeEvidence(join(out, `${engine.id}-${lane}-messages.json`), JSON.stringify(obs.messages, null, 2));
  await f.client.stop(bot);
  await f.client.messages(bot.threadId);
  result.cards = f.client.ledger.forThreads([bot.threadId]);
  if (result.cards.length) { result.verdict = 'FAIL'; if (lane === 'browser') result.gweb = 'FAIL'; }
  if (!fake && lane === 'browser' && !result.readComplete && obs.messages.some(m => m.tool?.name?.startsWith('browser unavailable:'))) { result.verdict = 'UNVERIFIED'; result.gweb = 'UNVERIFIED'; }
  return result;
}
/** Route replay success alone cannot verify the installed native-tool exclusions. */
export function releaseGateVerdict(routeVerdict, installedExclusions) {
  if (installedExclusions?.status !== 'PASS' || /OPEN|UNVERIFIED/i.test(installedExclusions?.disposition ?? '')) return 'UNVERIFIED';
  return routeVerdict;
}
export async function main(args = process.argv.slice(2)) {
  const mode = args[0];
  check(['--fake', '--live'].includes(mode) && args[1] === '--out' && args[2], 'Usage: node --experimental-strip-types scripts/web-read-replay/run.mjs --fake|--live --out NEW_DIRECTORY');
  check(process.platform === 'linux', 'Linux fixture only; never run on the Mac');
  const out = resolve(args[2]); check(!out.startsWith('/dev/') && out !== '/dev' && !existsSync(out), 'Use a new evidence directory outside /dev'); evidenceDir(out);
  const report = { gate: 'G-WEB', mode, verdict: 'UNVERIFIED', node: process.version, fakeHostPower: mode === '--fake' ? 'test-only unwrapped fake executables' : undefined, tree: process.env.WEBREAD_REVISION || git(['rev-parse', 'HEAD'], ROOT, process.env), sourceLength: source.length, sourceHash: hash(source), engines: [], rows: [], errors: [] };
  report.sourceHashes = Object.fromEntries([
    'server/web-documents.ts', 'server/web-document-budget.ts', 'server/browser-extension-engine-read.ts',
    'server/drivers/browser-proxy.ts', 'server/drivers/acp/droid.ts', 'server/drivers/acp/fuigo.ts',
    'server/drivers/claude.ts', 'server/drivers/codex.ts', 'server/index.ts',
    'server/testing/fake-web-read.ts', 'scripts/web-read-replay/run.mjs',
    'server/browser-read-route.ts', 'server/browser-control.ts', 'server/browser-native-relay.ts',
    'server/browser-extension-executor.ts', 'shared/web-read-routing.ts',
    'src/components/EngineLimitRow.tsx', 'src/components/ChatView.tsx', 'src/components/GroupView.tsx',
    'src/components/BotSettingsPane.tsx', 'scripts/web-read-replay/evidence-fs.mjs',
  ].map(file => [file, hash(readFileSync(join(ROOT, file)))]));
  report.installedExclusions = { status: 'UNVERIFIED', disposition: 'P1-3 OPEN', reason: 'Fake browser replay does not prove installed native reader exclusions, including Codex/Sol and Droid/Sol.' };
  report.routeVerdict = 'FAIL';
  let f, owned, site;
  const save = () => writeEvidence(join(out, 'verdict.json'), JSON.stringify(report, null, 2));
  try {
    let specs;
    if (mode === '--fake') {
      owned = await launchVerificationServer(process.env, undefined, { instrumentationSource: fakeEngineSetup(ROOT) + browserFixtureSource() });
      const { secret } = await (await fetch(owned.info.url + '/api/desktop-secret')).json();
      const work = mkdtempSync(join(tmpdir(), 'webread-work-'));
      f = { work, client: new ProductClient(owned.info.url, { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret }, owned.info.dataDir) };
      specs = fakeSpecs.filter(s => !process.env.WEBREAD_ENGINES || process.env.WEBREAD_ENGINES.split(',').includes(s.id));
      report.fixture = owned.info;
    } else {
      const selected = process.env.WEBREAD_ENGINES?.split(',');
      specs = engineSpecs.filter(s => !selected || selected.includes(s.id)).flatMap(s => {
        const path = s.cli && executable(s.cli);
        if (!path) { report.engines.push({ ...s, status: 'UNVERIFIED', reason: 'No local CLI; configure a dedicated isolated lane for API/gateway drivers' }); return []; }
        const version = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000 });
        return [{ ...s, path, version: version.stdout?.trim() || 'unknown' }];
      });
      check(specs.length, 'No installed selected engines'); f = await launchLive(out, specs);
    }
    await f.client.connect();
    const instances = (await f.client.api('GET', '/api/instances')).instances;
    site = { readHits: 0 };
    site.server = createServer((req, res) => {
      if (!['/sales', '/expected'].includes(req.url)) { res.writeHead(404); return res.end(); }
      if (req.url === '/sales') site.readHits++;
      const html = req.url === '/sales';
      res.writeHead(200, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }); res.end(html ? '<html><body><div>' + source.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</div></body></html>' : source);
    });
    await new Promise(r => site.server.listen(0, '127.0.0.1', r)); site.url = `http://127.0.0.1:${site.server.address().port}`;
    for (const engine of specs) {
      const status = { ...engine, status: 'FAIL' }; report.engines.push(status); save();
      try {
        const instance = instances.find(i => i.instanceId === engine.id);
        status.snapshot = instance?.snapshot;
        const binary = engine.path || join(ROOT, "server/testing", engine.cli);
        if (existsSync(binary)) status.binarySha256 = hash(readFileSync(binary));
        check(instance, 'engine not registered');
        const options = (instance.models?.options ?? []).map(o => typeof o === 'string' ? o : o.id ?? o.value);
        engine.model = engine.sol ? process.env.WEBREAD_SOL_MODEL ?? options.find(m => /sol/i.test(m)) : (mode === '--fake' ? engine.model : instance.models?.default) || options[0];
        check(engine.model && (!engine.sol || /sol/i.test(engine.model)), 'Sol model unavailable; set WEBREAD_SOL_MODEL explicitly'); status.model = engine.model;
        site.readHits = 0;
        const result = await runReplay(f, engine, site, out, mode === '--fake'); report.rows.push(result); status.status = result.verdict;
        site.readHits = 0;
        const toolLane = await runReplay(f, engine, site, out, mode === '--fake', 'web_read'); (report.subchecks ??= []).push(toolLane);
      } catch (error) { status.reason = error.message; report.errors.push(`${engine.id}: ${error.message}`); }
      save();
    }
    report.routeVerdict = report.rows.length === specs.length && report.engines.every(e => e.status === 'PASS') && !report.errors.length ? 'PASS' : report.engines.some(e => e.status === 'UNVERIFIED') ? 'UNVERIFIED' : 'FAIL';
  } catch (error) { report.errors.push(error.message); const log = /see (\/[^\n]+\.log)/.exec(error.message)?.[1]; if (log && existsSync(log)) writeEvidence(join(out, 'startup.log'), readFileSync(log)); }
  finally {
    await f?.client.disconnect();
    if (owned) { if (f) await removeTempDir(f.work, { strict: true }); await owned.close(); writeEvidence(join(out, 'server.log'), readFileSync(owned.info.logPath)); }
    else await f?.close();
    if (site) { site.server.closeAllConnections(); await new Promise(r => site.server.close(r)); }
    report.verdict = releaseGateVerdict(report.routeVerdict, report.installedExclusions);
    save();
  }
  console.log(`${mode === '--fake' ? 'Fake' : 'Installed'} routes: ${report.routeVerdict ?? 'FAIL'}`);
  console.log(`G-WEB: ${report.verdict}: ${join(out, 'verdict.json')}`); return report.verdict === 'PASS' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

/** Fixture-only native engine. Real HTTP claims, mounted tools, controller,
 * capture/conversion and saved documents remain in the product process. */
export function browserFixtureSource(fakeNative = true) {
  return `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const browserEvents = join(data, 'browser-route-events.jsonl');
registerHooks({ load(url, context, nextLoad) {
  if (!${fakeNative} && url.endsWith('/browser-native-relay.ts')) {
    let source = readFileSync(new URL(url), 'utf8');
    source = 'import { appendFileSync as appendRouteEvidence } from "node:fs";' + source;
    source = source.replace('active();engineAnswered();', 'active();engineAnswered();' +
      'if (method === "tools/call" && (params?.name === "agent_browser_open" || (params?.name === "agent_browser_eval" && (params.arguments as any)?.script === "document.documentElement.outerHTML"))) appendRouteEvidence(' + JSON.stringify(browserEvents) + ', JSON.stringify({ kind: params.name === "agent_browser_open" ? "navigation" : "capture", session: spec.env.AGENT_BROWSER_SESSION }) + String.fromCharCode(10));');
    return { format: 'module-typescript', shortCircuit: true, source };
  }
  if (${fakeNative} && url.endsWith('/browser-native-relay.ts')) {
    const original = readFileSync(new URL(url), 'utf8');
    const sink = original.split('async request(method, params) {')[1]?.split('await warm();')[0] ?? '';
    return { format: 'module', shortCircuit: true, source: \`
      import { appendFileSync } from 'node:fs';
      const log = value => appendFileSync(\${JSON.stringify(browserEvents)}, JSON.stringify(value) + String.fromCharCode(10));
      export function createNativeBrowser(spec) {
        let url = 'about:blank', html = '', nativeText = '';
        return {
          protected: async () => false, resetStream() {}, input() {},
          connect: async () => 'fixture-stream', close: async () => {}, command: async () => ({}),
          async request(method, params) {
            \${sink}
            if (method === 'tools/list') return { tools: ['agent_browser_open', 'agent_browser_read', 'agent_browser_get_url', 'agent_browser_eval'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) };
            const name = params?.name, args = params?.arguments ?? {};
            let value;
            if (name === 'agent_browser_open') {
              url = args.url;
              if (new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/sales') throw Error('Browser fixture only accepts its local sales page');
              html = await (await fetch(url)).text(); nativeText = html.replace(/<[^>]*>/g, '');
              log({ kind: 'navigation', session: spec.env.AGENT_BROWSER_SESSION, url }); value = {};
            } else if (name === 'agent_browser_get_url') value = { url };
            else if (name === 'agent_browser_eval') { log({ kind: 'capture', session: spec.env.AGENT_BROWSER_SESSION }); value = { result: html }; }
            else if (name === 'agent_browser_read') { log({ kind: 'native-read' }); return { content: [{ type: 'text', text: nativeText.slice(0, 12000) + '[Content truncated' }] }; }
            else throw Error('Unexpected fake browser operation: ' + name);
            return { structuredContent: { response: { success: true, data: value } }, content: [{ type: 'text', text: JSON.stringify(value) }] };
          }
        };
      }
    \` };
  }
  if (${fakeNative} && url.endsWith('/browser-direct-readiness.ts')) return { format: 'module', shortCircuit: true, source: 'export function directConnectionState(proxy, endpoint) { return proxy?.chromeEndpoint === endpoint ? proxy.state : "absent"; } export async function observeDirectReadiness() { return "ready"; }' };
  if (${fakeNative} && url.endsWith('/user-chrome.ts')) {
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace('export function readUserChromeEndpoint(dataDir: string = userChromeDataDir()): string | null {', 'export function readUserChromeEndpoint(dataDir: string = userChromeDataDir()): string | null { return "ws://127.0.0.1:9222/devtools/browser/fixture";');
    source = source.replace('export async function userChromeListening(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<"listening" | "off"> {', 'export async function userChromeListening(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<"listening" | "off"> { return "listening";');
    return { format: 'module-typescript', shortCircuit: true, source };
  }
  if (${fakeNative} && url.endsWith('/user-chrome-proxy.ts')) return { format: 'module', shortCircuit: true, source: 'export class UserChromeProxy { static async start(endpoint) { return { chromeEndpoint: endpoint, state: "allowed", engineUrl: endpoint, guardUrl: endpoint, botScope: () => ({ targets: new Set(), closed: 0 }), async close() { this.state = "closed"; } }; } }' };
  if (${fakeNative} && url.endsWith('/browser-engine.ts')) {
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace('export function resolveAgentBrowserBinary(options: ResolveOptions = {}): string | null {', 'export function resolveAgentBrowserBinary(options: ResolveOptions = {}): string | null { return process.execPath;');
    source = source.replace('export async function verifyAgentBrowserBinary(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {', 'export async function verifyAgentBrowserBinary(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { return;');
    source = source.replace('if (browserHostRequiresSandboxBypass(', 'if (false && browserHostRequiresSandboxBypass(');
    return { format: 'module-typescript', shortCircuit: true, source };
  }
  if (url.endsWith('/browser-read-route.ts')) {
    let source = readFileSync(new URL(url), 'utf8').replaceAll('function routeBrowserRead(', 'function fixtureRouteBrowserRead(');
    source += \`
      export async function routeBrowserRead(...args: any[]) {
        const result = await (fixtureRouteBrowserRead as any)(...args);
        const page = result.structuredContent ?? result;
        const { appendFileSync } = await import('node:fs');
        appendFileSync(\${JSON.stringify(browserEvents)}, JSON.stringify({ kind: 'route', route: args[0], handle: page.handle, offset: page.offset, next_offset: page.next_offset, total_length: page.total_length, eof: page.eof }) + String.fromCharCode(10));
        return result;
      }
    \`;
    return { format: 'module-typescript', shortCircuit: true, source };
  }
  return nextLoad(url, context);
} });
`;
}

/** Fake engines consume the real mounted browser tools/list and tools/call. */
export async function replayBrowserRead(launch, url, observe) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/sales$/.test(url)) throw Error('Replay requires its loopback fixture');
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0, buffer = '';
  const pending = new Map();
  const fail = () => { for (const p of pending.values()) p.reject(Error('Browser replay MCP closed')); pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let reply; try { reply = JSON.parse(line); } catch { continue; }
      const p = pending.get(reply.id); if (!p) continue; pending.delete(reply.id);
      if (reply.error) p.reject(Error(reply.error.message)); else p.resolve(reply.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 60000);
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-read-replay', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await request('tools/list', {})).tools;
    for (const name of ['agent_browser_open', 'agent_browser_read']) if (!tools.some(t => t.name === name)) throw Error(name + ' unavailable');
    const call = async (name, args) => {
      const output = await request('tools/call', { name, arguments: args }); observe({ name, ...args }, output);
      if (output.isError) throw Error('browser read refused'); return output;
    };
    await call('agent_browser_open', { url });
    let input = { length: 4000 }, text = ''; const receipts = [];
    for (let n = 0; n < 20; n++) {
      const output = await call('agent_browser_read', input), page = output.structuredContent;
      if (!page?.handle) throw Error('no continuation evidence');
      const content = page.content.slice(page.content.indexOf('\n') + 1, page.content.lastIndexOf('\n'));
      if (page.offset !== text.length) throw Error('Invalid continuation');
      text += content; receipts.push({ handle: page.handle, offset: page.offset, next_offset: page.next_offset, total_length: page.total_length, eof: page.eof });
      if (page.eof) {
        writeFileSync(join(process.cwd(), 'reconstructed.txt'), text);
        writeFileSync(join(process.cwd(), 'ranges.json'), JSON.stringify(receipts));
        return { length: text.length, sha256: hash(text) };
      }
      input = { handle: page.handle, offset: page.next_offset, length: 4000 };
    }
    throw Error('Continuation did not reach EOF');
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
}
