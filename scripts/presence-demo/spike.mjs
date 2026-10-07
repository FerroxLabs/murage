// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike: CDP Overlay domain versus the isolated-world DOM overlay, measured in Chrome for Testing.
// Question: does an Overlay highlight appear in Page.captureScreenshot, and what does it cost?
//   CFT_PATH="/path/to/Google Chrome for Testing" node scripts/presence-demo/spike.mjs <shotsDir> [--headful]
import path from 'node:path';
import { launch, openTab, startServer, rectOf, sleep } from './harness.mjs';

const out = path.resolve(process.argv[2] || 'shots');
const headful = process.argv.includes('--headful');
const server = await startServer();
const browser = await launch({ headless: !headful });
const label = headful ? 'headful' : 'headless';
const rows = [];
const note = (k, v) => { rows.push([k, v]); console.log(`${label}: ${k}: ${v}`); };
try {
  console.log('Chrome:', browser.version, label);
  const tab = await openTab(browser, server.origin + '/', { leaseMs: 60000 });
  const s = tab.s;
  const same = (a, b) => a === b;
  const shotFile = (n) => path.join(out, `spike-${label}-${n}.png`);

  // Overlay scrollbars fade in and out on their own and shift the layout, which would confound
  // pixel comparisons, so the spike page has no scrollbar.
  await tab.main("document.documentElement.style.overflow = 'hidden'");
  await sleep(500);
  const base = await tab.shot(shotFile('00-baseline'));
  note('control: second screenshot after 2 s idle, no overlay', await (async () => { await sleep(2000); return (await tab.shot()) === base ? 'identical to baseline' : 'differs from baseline'; })());

  await s('DOM.enable'); await s('Overlay.enable');
  const bounds = { x: 0, y: 0, width: 1280, height: 800 };
  const colors = { color: { r: 255, g: 107, b: 53, a: 0.18 }, outlineColor: { r: 255, g: 107, b: 53, a: 1 } };

  // A. highlightRect.
  let t0 = performance.now();
  await s('Overlay.highlightRect', { ...bounds, ...colors });
  note('highlightRect call', `${(performance.now() - t0).toFixed(1)} ms`);
  await sleep(300);
  for (const fromSurface of [true, false]) {
    const d = await tab.shot(shotFile(`A-highlightRect-fromSurface-${fromSurface}`), { fromSurface });
    note(`highlightRect in captureScreenshot (fromSurface=${fromSurface})`, same(d, base) ? 'NOT in screenshot (identical to baseline)' : 'IN screenshot (differs from baseline)');
  }
  const noClip = await tab.shot(null, { captureBeyondViewport: true });
  note('highlightRect with captureBeyondViewport', noClip === base ? 'not in screenshot' : 'differs (page is taller, so not comparable)');
  note('page can see it in the DOM', await tab.main("`documentElement children: ${document.documentElement.children.length}, body children: ${document.body.children.length}, murage-presence: ${!!document.querySelector('murage-presence')}`"));
  await s('Overlay.hideHighlight');

  // B. highlightFrame, the whole-frame highlight.
  const frameId = (await s('Page.getFrameTree')).frameTree.frame.id;
  t0 = performance.now();
  await s('Overlay.highlightFrame', { frameId, contentColor: { r: 255, g: 107, b: 53, a: 0.12 }, contentOutlineColor: { r: 255, g: 107, b: 53, a: 1 } });
  note('highlightFrame call', `${(performance.now() - t0).toFixed(1)} ms`);
  await sleep(300);
  const frameShot = await tab.shot(shotFile('B-highlightFrame'));
  note('highlightFrame in captureScreenshot', same(frameShot, base) ? 'NOT in screenshot' : 'IN screenshot');
  await s('Overlay.hideHighlight');

  // C. highlightRect over the button as a pointer stand-in, and persistence over scroll and navigation.
  const btn = await rectOf(tab, '#go');
  await s('Overlay.highlightRect', { x: Math.round(btn.x), y: Math.round(btn.y), width: Math.round(btn.width), height: Math.round(btn.height), ...colors });
  await sleep(200);
  const small = await tab.shot(shotFile('C-highlightRect-on-button'));
  note('small rect in screenshot', same(small, base) ? 'NOT in screenshot' : 'IN screenshot');
  // Hide before the screenshot, as capture mode does for the DOM overlay.
  t0 = performance.now();
  await s('Overlay.hideHighlight');
  const hidden = await tab.shot(shotFile('C2-highlight-hidden-then-screenshot'));
  note('hideHighlight then screenshot', `${(performance.now() - t0).toFixed(0)} ms, ${same(hidden, base) ? 'identical to baseline' : 'differs from baseline'}`);
  await sleep(150);
  const hiddenLater = await tab.shot(shotFile('C3-highlight-hidden-150ms-later'));
  note('hideHighlight, wait 150 ms, screenshot', same(hiddenLater, base) ? 'identical to baseline' : 'differs from baseline');

  // C4. Is more than one highlight possible at once (needed to fake a 3 px border)?
  await s('Overlay.highlightRect', { x: 20, y: 500, width: 100, height: 100, ...colors });
  await s('Overlay.highlightRect', { x: 700, y: 500, width: 100, height: 100, ...colors });
  await sleep(200);
  const two = await tab.shot(shotFile('C4-two-highlightRect-calls'));
  const { PNG } = await import('./png-probe.mjs');
  const probe = PNG(two);
  const tinted = (x, y) => { const b = PNG(base); return probe(x, y).join() !== b(x, y).join(); };
  note('second highlightRect call replaces the first', `first rect tinted: ${tinted(70, 550)}, second rect tinted: ${tinted(750, 550)}`);
  await s('Overlay.hideHighlight');

  // D. Cost of toggling, to compare with the DOM overlay.
  t0 = performance.now();
  for (let i = 0; i < 20; i += 1) { await s('Overlay.highlightRect', { ...bounds, ...colors }); await s('Overlay.hideHighlight'); }
  note('20 highlight+hide cycles', `${(performance.now() - t0).toFixed(0)} ms total`);
  await s('Overlay.disable');

  // E. The DOM overlay, same page, same viewport, for comparison.
  await tab.world("globalThis.__muragePresence.state('driving')");
  await sleep(300);
  const dom = await tab.shot(shotFile('E-dom-overlay-driving'));
  note('DOM overlay in captureScreenshot', same(dom, base) ? 'NOT in screenshot' : 'IN screenshot (hidden only by capture mode)');
  t0 = performance.now();
  await tab.world('globalThis.__muragePresence.capture(true)');
  const cap = await tab.shot(shotFile('F-dom-overlay-capture-mode'));
  note('capture(true) then screenshot', `${(performance.now() - t0).toFixed(0)} ms, ${same(cap, base) ? 'identical to baseline' : 'differs from baseline'}`);
  await tab.world('globalThis.__muragePresence.capture(false)');
  t0 = performance.now();
  for (let i = 0; i < 20; i += 1) { await tab.world('globalThis.__muragePresence.capture(true)'); await tab.world('globalThis.__muragePresence.capture(false)'); }
  note('20 capture on+off cycles', `${(performance.now() - t0).toFixed(0)} ms total`);
  await tab.world('globalThis.__muragePresence.remove()');
} finally {
  await browser.close();
  await server.close();
}
