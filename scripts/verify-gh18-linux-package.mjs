// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Native packaged Linux GH18 fixture. Only temporary data and loopback models.
// node scripts/verify-gh18-linux-package.mjs --executable /absolute/murage --out /absolute/evidence
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, expect } from '@playwright/test';
import { packageReaderProjection, seedPackageReaders } from './gh18-package-acceptance.ts';
import { packagedReporterInstance, seedPackagedReporterHome, verifyPackagedReporting } from './verify-gh15-linux-package.mjs';
import { verifyPackageG9 } from './gh18-package-g9.mjs';
import { resolveBuildCommit } from './build-commit.mjs';
import { seedTermsAccepted } from './terms-fixture.mjs';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
const option = flag => process.argv[process.argv.indexOf(flag) + 1];
assert.equal(process.platform, 'linux');
const executable = option('--executable'), evidence = option('--out');
assert(executable && isAbsolute(executable) && evidence && isAbsolute(evidence));
assert(!existsSync(evidence), 'Use a new evidence destination');
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'murage-gh18-package-'));
const data = join(root, 'data'), home = join(root, 'home'), userData = join(root, 'electron'), temporary = join(root, 'tmp');
for (const dir of [data, home, userData, temporary]) mkdirSync(dir, { mode: 0o700 });
const bots = Array.from({ length: 20 }, (_, index) => {
  const id = `package-bot-${index + 1}`, threadId = `${id}-thread`;
  return { id, threadId, name: `Package bot ${index + 1}`, title: '', description: '', color: 'blue', notifications: false, unread: false, createdAt: Date.now(), modelSelection: { instanceId: 'fixture', model: 'synthetic' }, resumeCursors: { fixture: `native-${index + 1}` }, tasks: [{ threadId, title: 'Isolated package task', createdAt: Date.now(), resumeCursors: { fixture: `native-${index + 1}` } }], composio: false, computer: 'off', browser: false };
});
const selected = bots[12], checks = [], traces = [];
const sourceCommit = resolveBuildCommit();
assert(sourceCommit, 'Run from the committed source checkout used for this package');
let application, page, db, calls = 0, ok = false;
const provider = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'synthetic' }] }));
  else { calls++; response.writeHead(503); response.end('{"error":"No model generation in package fixture"}'); }
});
await new Promise(done => provider.listen(0, '127.0.0.1', done));
const port = provider.address().port;
seedPackagedReporterHome(home);
// A saved notice exposes spending controls without any account or key.
writeFileSync(join(data, 'config.json'), JSON.stringify({ spend: { monthlyLimitUsd: 1000 }, profile: { name: 'Package fixture' }, instances: { reporter: packagedReporterInstance(data), fixture: { driver: 'openai-compat', config: { url: `http://127.0.0.1:${port}/v1`, key: 'synthetic-loopback', model: 'synthetic' } } } }));
writeFileSync(join(data, 'bots.json'), JSON.stringify(bots));
seedTermsAccepted(data);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
writeFileSync(join(data, 'whats-new.json'), JSON.stringify({ seen: [version], lastVersion: version }));
writeFileSync(join(userData, 'companion-settings.json'), JSON.stringify({ enabled: false, remoteAccess: false, keepAwake: false }));
try {
  const env = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE, HOME: home, USERPROFILE: home, TMPDIR: temporary, TEMP: temporary, TMP: temporary, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: temporary, MURAGE_DATA_DIR: data, MURAGE_USER_DATA: userData, MURAGE_DESKTOP_CLOUD: '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LANG: 'en_US.UTF-8' };
  application = await _electron.launch({ executablePath: executable, args: ['--no-sandbox', `--user-data-dir=${userData}`], env, cwd: root, timeout: 90000 });
  application.process().stderr.on('data', chunk => writeFileSync(join(evidence, 'electron.log'), chunk, { flag: 'a' }));
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), logs: app.getPath('logs'), userData: app.getPath('userData'), data: process.env.MURAGE_DATA_DIR, pid: process.pid }));
  assert.equal(identity.packaged, true); assert(identity.appPath.endsWith('/app.asar')); assert.equal(realpathSync(identity.userData), realpathSync(userData)); assert.equal(realpathSync(identity.data), realpathSync(data)); assert.equal(JSON.parse(readFileSync(join(identity.appPath, '..', 'ui', 'build-commit.json'))).commit, sourceCommit, 'Package and acceptance helpers must use the same commit'); checks.push({ identity, serverSha256: createHash('sha256').update(readFileSync(join(identity.appPath, '..', 'server', 'index.js'))).digest('hex'), appAsarSha256: createHash('sha256').update(readFileSync(identity.appPath)).digest('hex'), sourceCommit: JSON.parse(readFileSync(join(identity.appPath, '..', 'ui', 'build-commit.json'))).commit });
  // Packaged startup opens a splash first. Select the actual loopback app
  // window; the splash closes normally when the main window is ready.
  await expect.poll(() => {
    page = application.windows().find(candidate => {
      try { const url = new URL(candidate.url()); return url.protocol === 'http:' && url.hostname === '127.0.0.1'; } catch { return false; }
    });
    return Boolean(page);
  }, { timeout: 90000 }).toBe(true);
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => traces.push({ pageerror: error.message }));
  await page.waitForFunction(() => typeof window.muragebox?.desktopSurfaceSecret === 'string');
  const origin = new URL(page.url()).origin;
  assert.equal((await fetch(`${origin}/api/memory/bots/${selected.id}/fresh-start/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': window.muragebox.desktopSurfaceSecret }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { method, path, body });
  assert.equal((await api('GET', '/api/bots?messages=0')).body.bots.length, 20);
  db = new DatabaseSync(join(data, 'messages.db')); db.exec('PRAGMA busy_timeout=10000');
  await expect.poll(() => db.prepare('SELECT ready FROM memory_lineage_cert WHERE id=1').get()?.ready, { timeout: 60000 }).toBe(1);
  // Let the real first-install repair finish before staging a legacy profile.
  // It correctly drops unproven initial cursors. Seed only while this exact
  // app is stopped, then reopen the same normally repaired installation.
  const installation = db.prepare('SELECT installation_id FROM memory_meta WHERE id=1').get().installation_id;
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(join(data, 'memory-repairs.json'))).keepallUnwedge103?.installationId; } catch { return null; }
  }, { timeout: 30000 }).toBe(installation);
  db.close(); db = undefined;
  await application.close(); application = undefined;
  const repairedBots = JSON.parse(readFileSync(join(data, 'bots.json')));
  for (const bot of repairedBots) {
    const legacy = bots.find(candidate => candidate.id === bot.id);
    bot.resumeCursors = { ...legacy.resumeCursors };
    for (const task of bot.tasks) {
      const saved = legacy.tasks.find(candidate => candidate.threadId === task.threadId);
      if (saved) task.resumeCursors = { ...saved.resumeCursors };
    }
  }
  writeFileSync(join(data, 'bots.json'), JSON.stringify(repairedBots));
  application = await _electron.launch({ executablePath: executable, args: ['--no-sandbox', `--user-data-dir=${userData}`], env, cwd: root, timeout: 90000 });
  application.process().stderr.on('data', chunk => writeFileSync(join(evidence, 'electron.log'), chunk, { flag: 'a' }));
  await expect.poll(() => {
    page = application.windows().find(candidate => { try { const url = new URL(candidate.url()); return url.protocol === 'http:' && url.hostname === '127.0.0.1'; } catch { return false; } });
    return Boolean(page);
  }, { timeout: 90000 }).toBe(true);
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => traces.push({ pageerror: error.message }));
  await page.waitForFunction(() => typeof window.muragebox?.desktopSurfaceSecret === 'string');
  const restartedIdentity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'), data: process.env.MURAGE_DATA_DIR, pid: process.pid }));
  assert.equal(restartedIdentity.packaged, true); assert.equal(restartedIdentity.data, data); assert.equal(restartedIdentity.userData, userData);
  checks.push({ normallyRepairedInstallation: installation, restartedIdentity });
  db = new DatabaseSync(join(data, 'messages.db')); db.exec('PRAGMA busy_timeout=10000');
  await api('POST', `/api/bots/${selected.id}/typing`, {});
  await expect.poll(() => db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased'").get().n, { timeout: 30000 }).toBe(0);
  db.exec('BEGIN IMMEDIATE');
  db.exec('INSERT INTO memory_revoke_audience(revoke_id) VALUES(918001)');
  for (const bot of bots) db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,918001)').run(bot.threadId, 'fixture', bot.tasks[0].resumeCursors.fixture);
  db.prepare('INSERT INTO memory_deny_session VALUES(?,?,?,918002)').run(selected.threadId, 'fixture', selected.tasks[0].resumeCursors.fixture);
  db.prepare("INSERT INTO memory_deny_session VALUES('package-room','fixture','room-native',918001)").run();
  db.exec('COMMIT');
  seedPackageReaders(db, selected.threadId);
  const visibilityBefore = packageReaderProjection(db, selected.threadId);
  const before = db.prepare('SELECT * FROM memory_deny_session ORDER BY thread_id,driver_instance,native_session,revoke_id').all();
  await page.evaluate(() => { localStorage.setItem('murage-email-gate', 'skipped'); localStorage.setItem('murage.settings.mode', 'advanced'); });
  await page.reload();
  const invitation = page.getByRole('complementary', { name: 'Let your bots pick the right model', exact: true });
  if (await invitation.isVisible()) await invitation.getByRole('button', { name: 'Not now', exact: true }).last().click();
  // A fresh profile shows the normal coach mark and folds a long team.
  const coach = page.getByRole('button', { name: 'Got it', exact: true });
  if (await coach.isVisible()) await coach.click();
  const sidebar = page.getByRole('complementary', { name: 'Bots and navigation', exact: true });
  await sidebar.getByRole('button', { name: /Show \d+ more bots/ }).click();
  await sidebar.locator(`button[data-sidebar-select="${selected.id}"]`).press('Enter');
  if (await coach.isVisible()) await coach.click();
  await page.getByRole('main').getByRole('button', { name: `Open ${selected.name}'s profile`, exact: true }).filter({ hasText: selected.name }).click();
  const settings = page.getByRole('dialog', { name: `Bot settings: ${selected.name}`, exact: true });
  await settings.getByRole('searchbox', { name: 'Search settings' }).fill('memory');
  const action = settings.getByRole('button', { name: 'Start fresh for this bot', exact: true });
  for (const width of [390, 1440]) for (const skin of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(skin => { document.documentElement.dataset.skin = skin; }, skin);
    await action.click();
    const dialog = page.getByRole('dialog', { name: `Start fresh for ${selected.name}?`, exact: true });
    await expect(dialog.getByRole('status')).toHaveText('Start fresh in 1 chats and clear 1 old blocks.');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(dialog.locator('[data-primary="true"]')).toHaveCount(1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(evidence, `ready-${width}-${skin}.png`), fullPage: true });
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(action).toBeFocused();
    assert.deepEqual(db.prepare('SELECT * FROM memory_deny_session ORDER BY thread_id,driver_instance,native_session,revoke_id').all(), before);
    checks.push(`keyboard-cancel-no-mutation-${width}-${skin}`);
  }
  const requests = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname.includes('/fresh-start/')) requests.push({ method: response.request().method(), path: new URL(response.url()).pathname, body: await response.json().catch(() => null) });
  });
  // Startup's obsolete recall views must finish collecting before minting the confirmation snapshot.
  await expect.poll(() => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views v WHERE NOT EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation)').get().n)).toBe(0);
  await action.click();
  const dialog = page.getByRole('dialog', { name: `Start fresh for ${selected.name}?`, exact: true });
  await dialog.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(`${selected.name} starts fresh in 1 chats. Cleared 1 old blocks. Deleted and withdrawn information stays hidden.`);
  const after = db.prepare('SELECT * FROM memory_deny_session ORDER BY thread_id,driver_instance,native_session,revoke_id').all();
  assert.deepEqual(after, before.filter(row => !(row.thread_id === selected.threadId && row.revoke_id === 918001)));
  const audit = db.prepare('SELECT * FROM gh18_operations').all(); assert.equal(audit.length, 1); assert.equal(audit[0].cursors_applied, 1);
  const saved = JSON.parse(readFileSync(join(data, 'bots.json')));
  assert.equal(saved.find(bot => bot.id === selected.id).tasks[0].resumeCursors.fixture, undefined);
  for (const bot of bots.filter(bot => bot.id !== selected.id)) assert.equal(saved.find(row => row.id === bot.id).tasks[0].resumeCursors.fixture, bot.tasks[0].resumeCursors.fixture);
  const visibilityAfter = packageReaderProjection(db, selected.threadId);
  assert.deepEqual(visibilityAfter, visibilityBefore, 'Content, owner and nonowner reader visibility must stay unchanged');
  await page.screenshot({ path: join(evidence, 'completed.png'), fullPage: true });
  await page.keyboard.press('Escape');
  const g9 = await verifyPackageG9(page, selected, evidence, path => page.screenshot({ path, fullPage: true }));
  assert.equal(g9.length, 15);
  checks.push('gh18_nonowner_visibility_unchanged', 'gh18_g9_fifteen_tasks_preserved');
  writeFileSync(join(evidence, 'gh18-acceptance.json'), JSON.stringify({ visibilityBefore, visibilityAfter, g9 }, null, 2));
  checks.push('real-packaged-preload-owner-authorization', 'twenty-bots-exact-target-and-count', 'content-room-and-other-bot-marks-preserved', 'durable-audit-and-selected-cursor-clear');
  const reporting = await verifyPackagedReporting(api, data, evidence);
  checks.push('gh15_packaged_manual_output', 'gh15_packaged_scheduled_output_and_delivery');
  assert.equal(calls, 0); assert.deepEqual(traces, []);
  writeFileSync(join(evidence, 'state.json'), JSON.stringify({ selected, before, after, audit, requests, checks, visibilityBefore, visibilityAfter, g9, reporting, providerGenerationCalls: calls }, null, 2));
  ok = true;
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(evidence, 'failure.txt'), String(error.stack ?? error));
  writeFileSync(join(evidence, 'failure-controls.json'), JSON.stringify(await page?.evaluate(() => [...document.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label') ?? button.textContent, select: button.getAttribute('data-sidebar-select') }))).catch(() => []) ?? [], null, 2));
  throw error;
} finally {
  db?.close();
  await application?.close();
  if (existsSync(join(userData, 'logs'))) cpSync(join(userData, 'logs'), join(evidence, 'logs'), { recursive: true });
  await new Promise(done => provider.close(done));
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok, executable: resolve(executable), executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), fixture: { root, data, userData }, checks, traces, limitation: 'Isolated packaged Linux; synthetic legacy cursors and marks; real read predicates over the packaged database and fifteen Settings search destinations; no model generation, Mac, Windows or reporter profile claim.' }, null, 2));
  safeWipeSync(root);
}
