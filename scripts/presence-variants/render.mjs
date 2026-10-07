// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the T30A design variants to PNGs: overlay shots on T15 fixture pages (1280x800) and side panel
// shots (390 wide), dark and light, plus contact sheets. Dev tooling: launches a fresh Chrome with a throwaway
// profile, serves only 127.0.0.1, reads no Murage state. Uses Cdp from the T14 harness unchanged.
//   CFT_PATH=<chrome binary> [CHROME_NO_SANDBOX=1] node scripts/presence-variants/render.mjs <outDir>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { safeWipe } from '../../server/testing/safe-wipe.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, sleep } from '../presence-demo/harness.mjs';
import { startFixtureSite } from '../browser-extension-fixture-site/server.mjs';
import { overlayMarkup, VARIANTS, VARIANT_TITLES } from './variants.mjs';
import { panelHtml } from '../sidepanel-mock/panel.mjs';
import { contrastTable } from '../sidepanel-mock/tokens.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(here, '..', 'sidepanel-mock', 'fonts', 'Inter-Variable.ttf');
const THEME_LIST = ['dark', 'light'];

// What each page shot shows: fixture page, target selector for the pointer, and the Murage state.
const PAGE_SHOTS = [
  { name: '01-idle', page: 't2-eight-field', state: 'idle' },
  { name: '02-working', page: 't2-eight-field', state: 'working' },
  { name: '03-waiting-your-turn', page: 'h6-signin', state: 'waiting' },
  { name: '04-done', page: 'h6-invoices', state: 'done' },
  { name: '05-full-permissive', page: 't2-eight-field', state: 'full' },
  { name: '06-working-reduced-motion', page: 't2-eight-field', state: 'working', media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
  { name: '07-working-forced-colors', page: 't2-eight-field', state: 'working', media: [{ name: 'forced-colors', value: 'active' }], themes: ['dark'] },
  { name: '08-working-on-dark-page', page: 't2-eight-field', state: 'working', darkPage: true, themes: ['dark'] },
];
const PANEL_STATES = ['idle', 'working', 'waiting', 'done', 'full'];

async function launch() {
  const exe = process.env.CFT_PATH;
  if (!exe || !existsSync(exe)) throw new Error('Set CFT_PATH to a Chrome or Chromium executable');
  const profile = await mkdtemp(path.join(tmpdir(), 'murage-variants-'));
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1300,900', 'about:blank'];
  if (process.env.CHROME_NO_SANDBOX) args.push('--no-sandbox');
  const child = spawn(exe, args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i += 1) await sleep(100);
  const [port, wsPath] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  const close = async () => { try { ws.close(); } catch { /* ignore */ } child.kill('SIGKILL'); await sleep(300); if (profile.startsWith(tmpdir()) && path.basename(profile).startsWith('murage-variants-')) await safeWipe(profile); };
  return { cdp, version, close };
}

async function newTab(cdp, width, height) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const ev = async (expression) => { const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const go = async (url) => { const loaded = new Promise((r) => cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); })); await s('Page.navigate', { url }); await loaded; await sleep(120); };
  const shot = async (file, { fullHeight = false } = {}) => {
    const params = { format: 'png' };
    if (fullHeight) { const h = await ev('Math.ceil(document.documentElement.scrollHeight)'); params.clip = { x: 0, y: 0, width, height: h, scale: 1 }; params.captureBeyondViewport = true; }
    const { data } = await s('Page.captureScreenshot', params);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(data, 'base64'));
  };
  return { s, ev, go, shot, close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}) };
}

export async function renderAll({ outDir }) {
  const fixture = await startFixtureSite();
  let fontServer;
  const panelCache = new Map();
  const shotsDir = path.resolve(outDir);
  fontServer = createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (req.url === '/font.ttf') { res.writeHead(200, { ...cors, 'content-type': 'font/ttf' }); res.end(await readFile(FONT)); return; }
    const m = /^\/panel\/(\w+)\/(\w+)\/(\w+)$/.exec(req.url || '');
    if (m) { res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end(panelHtml({ variant: m[1], state: m[2], theme: m[3] })); return; }
    const sh = /^\/shot\/([\w.-]+)$/.exec(req.url || '');
    if (sh && existsSync(path.join(shotsDir, sh[1]))) { res.writeHead(200, { ...cors, 'content-type': 'image/png' }); res.end(await readFile(path.join(shotsDir, sh[1]))); return; }
    if (req.url === '/sheet') { res.writeHead(200, { ...cors, 'content-type': 'text/html' }); res.end(panelCache.get('sheet') || ''); return; }
    res.writeHead(404, cors); res.end('not found');
  });
  await new Promise((r) => fontServer.listen(0, '127.0.0.1', r));
  const fontOrigin = `http://127.0.0.1:${fontServer.address().port}`;
  const browser = await launch();
  const written = [];
  try {
    for (const theme of THEME_LIST) {
      for (const variant of VARIANTS) {
        for (const shotDef of PAGE_SHOTS) {
          if (shotDef.themes && !shotDef.themes.includes(theme)) continue;
          const tab = await newTab(browser.cdp, 1280, 800);
          await tab.s('Emulation.setEmulatedMedia', { features: shotDef.media || [] });
          await tab.go(fixture.url(shotDef.page));
          await tab.ev(`(() => { const st = document.createElement('style'); st.textContent = '@font-face{font-family:Inter;src:url(${fontOrigin}/font.ttf) format("truetype");font-weight:100 900}${shotDef.darkPage ? 'html{background:#121212}body{filter:invert(.9) hue-rotate(180deg);background:#fff}' : ''}'; document.head.append(st); return document.fonts.load('600 13px Inter'); })()`);
          const target = await tab.ev(`(() => { const e = document.querySelector('input:not([type=hidden]),button'); const r = e ? e.getBoundingClientRect() : { x: 500, y: 300, width: 100, height: 30 }; return { x: Math.round(r.x + Math.min(r.width / 2, 160)), y: Math.round(r.y + r.height / 2) }; })()`);
          const markup = overlayMarkup({ variant, state: shotDef.state, theme, target });
          await tab.ev(`(async () => { const h = document.createElement('murage-variant'); h.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'; document.documentElement.append(h); h.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(markup)}; await document.fonts.ready; return 1; })()`);
          await sleep(80);
          const file = path.join(shotsDir, `${variant}-${theme}-${shotDef.name}.png`);
          await tab.shot(file); written.push(file);
          await tab.close();
        }
        for (const state of PANEL_STATES) {
          const tab = await newTab(browser.cdp, 390, 900);
          await tab.go(`${fontOrigin}/panel/${variant}/${state}/${theme}`);
          await tab.ev('document.fonts.ready.then(() => 1)');
          const file = path.join(shotsDir, `${variant}-${theme}-panel-${state}.png`);
          await tab.shot(file, { fullHeight: true }); written.push(file);
          await tab.close();
        }
      }
    }
    // Contact sheets: one per variant and theme.
    for (const theme of THEME_LIST) {
      for (const variant of VARIANTS) {
        const pageShots = PAGE_SHOTS.filter((p) => !p.themes || p.themes.includes(theme));
        const cell = (f, label) => `<figure><img src="/shot/${f}"><figcaption>${label}</figcaption></figure>`;
        const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;padding:24px;background:#1a1a1a;color:#eee;font:14px Inter,system-ui,sans-serif;width:1700px}h1{font-size:22px;margin:0 0 16px}.g{display:grid;grid-template-columns:repeat(3,520px);gap:16px;align-items:start}.p{display:grid;grid-template-columns:repeat(5,300px);gap:12px;margin-top:24px;align-items:start}figure{margin:0}img{width:100%;display:block;border:1px solid #444}figcaption{margin:4px 0 12px;color:#bbb;font-size:12px}</style><h1>${VARIANT_TITLES[variant]} (${theme} Murage theme)</h1><div class="g">${pageShots.map((p) => cell(`${variant}-${theme}-${p.name}.png`, p.name)).join('')}</div><div class="p">${PANEL_STATES.map((s) => cell(`${variant}-${theme}-panel-${s}.png`, 'side panel ' + s)).join('')}</div>`;
        panelCache.set('sheet', html);
        const tab = await newTab(browser.cdp, 1700, 900);
        await tab.go(`${fontOrigin}/sheet`);
        await sleep(200);
        const file = path.join(shotsDir, `sheet-${variant}-${theme}.png`);
        await tab.shot(file, { fullHeight: true }); written.push(file);
        await tab.close();
      }
    }
    await writeFile(path.join(shotsDir, 'contrast.json'), JSON.stringify(contrastTable(), null, 2));
    return { written, chrome: browser.version };
  } finally {
    await browser.close();
    await fixture.close();
    await new Promise((r) => fontServer.close(r));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || 'shots');
  const r = await renderAll({ outDir: out });
  console.log(`Chrome ${r.chrome}: wrote ${r.written.length} files to ${out}`);
}
