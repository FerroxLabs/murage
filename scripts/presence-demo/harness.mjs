// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the presence demo, spike and verify scripts. Dev tooling only: it launches a
// fresh Chrome for Testing with a throwaway profile and talks CDP over the global WebSocket. It
// never reads Murage state and never touches any real browser profile.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { safeWipe } from '../../server/testing/safe-wipe.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESENCE_WORLD, presenceSource } from '../../extensions/murage-browser/presence.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromePath() {
  const p = process.env.CFT_PATH;
  if (!p || !existsSync(p)) throw new Error('Set CFT_PATH to the Chrome for Testing executable');
  return p;
}

// Local pages on 127.0.0.1 only: the plain test page, one with a strict CSP and Trusted Types, and
// one whose script deletes the overlay every time it appears.
export async function startServer() {
  const page = await readFile(path.join(here, 'test-page.html'), 'utf8');
  const hostile = page.replace('</body>', `<script>
    window.removals = 0;
    new MutationObserver(() => { for (const n of document.querySelectorAll('murage-presence')) { n.remove(); window.removals += 1; } })
      .observe(document, { childList: true, subtree: true });
  </script></body>`);
  const server = createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (req.url === '/csp') headers['content-security-policy'] = "default-src 'self'; script-src 'unsafe-inline'; style-src 'self'; require-trusted-types-for 'script'";
    res.writeHead(200, headers);
    res.end(req.url === '/hostile' ? hostile : page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((r) => server.close(r)) };
}

export class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result); }
      else for (const l of this.listeners) l(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  on(fn) { this.listeners.push(fn); }
}

// Launches Chrome for Testing. opts.headless false opens a real window (still a fresh profile).
export async function launch({ headless = true, width = 1280, height = 800 } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'murage-presence-cft-'));
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', `--window-size=${width},${height}`, 'about:blank'];
  if (headless) args.unshift('--headless=new');
  const child = spawn(chromePath(), args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100);
  const [port, wsPath] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  const close = async () => {
    try { ws.close(); } catch { /* ignore */ }
    child.kill('SIGKILL');
    await sleep(300);
    if (profile.startsWith(tmpdir()) && path.basename(profile).startsWith('murage-presence-cft-')) await safeWipe(profile);
  };
  return { cdp, version, close, headless };
}

// One tab with the presence world wired the way runtime.mjs wires the takeover world.
export async function openTab(browser, url, { bindingName = 'murageSignal', botName = 'Dax', leaseMs, install = true } = {}) {
  const { cdp } = browser;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  const tab = { sessionId, targetId, s, signals: [], contexts: new Map(), bindingName };
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.executionContextCreated') { const c = m.params.context; if (c.name === PRESENCE_WORLD) tab.contexts.set(c.auxData?.frameId, c.id); }
    if (m.method === 'Runtime.executionContextsCleared') tab.contexts.clear();
    if (m.method === 'Runtime.bindingCalled') tab.signals.push({ name: m.params.name, payload: m.params.payload, contextId: m.params.executionContextId, at: Date.now() });
  });
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  if (install) {
    await s('Runtime.addBinding', { name: bindingName, executionContextName: PRESENCE_WORLD });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: presenceSource({ bindingName, botName, leaseMs }), worldName: PRESENCE_WORLD, runImmediately: true });
  }
  const loaded = new Promise((r) => cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); }));
  await s('Page.navigate', { url });
  await loaded; await sleep(150);
  const frameId = (await s('Page.getFrameTree')).frameTree.frame.id;
  tab.contextId = () => tab.contexts.get(frameId);
  // Evaluate in the presence world (isolated) and in the page's own world (main).
  tab.world = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, contextId: tab.contextId(), returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  tab.main = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  tab.shot = async (file, params = {}) => {
    const { data } = await s('Page.captureScreenshot', { format: 'png', ...params });
    if (file) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.from(data, 'base64')); }
    return data;
  };
  tab.click = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  };
  return tab;
}

export const rectOf = (tab, selector) => tab.main(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
