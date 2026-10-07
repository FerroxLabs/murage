// Draft store assets: actual panel source with synthetic presentation data.
// This is image preparation, not native/runtime qualification.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const out = path.dirname(fileURLToPath(import.meta.url));
const source = path.dirname(out);
const home = process.env.HOME;
if (!home?.startsWith('/Volumes/Scratch/work/murageextension/.planning/browser-extension/experiments/store-assets-') ||
    process.env.USERPROFILE !== home || process.env.CFFIXED_USER_HOME !== home ||
    !process.env.TMPDIR?.startsWith(path.dirname(home) + path.sep)) {
  throw Error('Explicit task-owned store asset HOME and temporary paths required before launch');
}
const browser = await chromium.launch({ headless: true });
const receipt = { draft: true, published: false, nativeProof: false, sourceFiles: {}, images: {} };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const assets = new Map();
  for (const name of ['index.html', 'panel.css', 'panel.js']) {
    const bytes = await fs.readFile(path.join(source, 'sidepanel', name));
    assets.set(name, bytes);
    receipt.sourceFiles[name] = createHash('sha256').update(bytes).digest('hex');
  }
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1) || 'index.html';
    if (url.hostname !== 'store-preview.invalid' || !assets.has(name)) return route.abort();
    return route.fulfill({ body: assets.get(name), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await context.addInitScript(() => {
    const binding = { bindingId: 'preview', botName: 'Preview bot', state: 'active', ready: true, tabs: [{ tabId: 1, origin: 'https://example.com' }], approvedOrigins: ['https://example.com'] };
    globalThis.chrome = { runtime: { sendMessage: async ({ action }) => {
      if (action === 'pause') binding.state = 'paused';
      if (action === 'resume') binding.state = 'active';
      if (action === 'stop') { binding.state = 'stopped'; binding.tabs = []; }
      return { result: { connected: true, profileId: 'Store preview', bindings: [binding] } };
    } }, tabs: { query: async () => [] } };
  });
  const page = await context.newPage();
  await page.goto('https://store-preview.invalid/index.html');
  await page.getByText('Browser control is active', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, '01-browser-controls-1280x800.png') });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByText('Browser control is paused', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, '02-paused-1280x800.png') });
  await context.close();
  const promo = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  const icon = await fs.readFile(path.join(source, 'icons/icon128.png'));
  await promo.setContent(`<html><body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0a0a0a;color:#ededed;font:600 32px system-ui"><img width="96" height="96" src="data:image/png;base64,${icon.toString('base64')}" alt=""><div>Murage</div></body></html>`);
  await promo.screenshot({ path: path.join(out, 'promo-440x280.png') });
  await promo.close();
  await fs.copyFile(path.join(source, 'icons/icon128.png'), path.join(out, 'icon128.png'));
  for (const name of ['01-browser-controls-1280x800.png', '02-paused-1280x800.png', 'promo-440x280.png', 'icon128.png']) {
    const bytes = await fs.readFile(path.join(out, name));
    receipt.images[name] = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await browser.close(); }
