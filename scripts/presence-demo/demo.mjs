// SPDX-License-Identifier: AGPL-3.0-or-later
// Demo: outline, edge glow, bot pointer moves and clicks, typing marker, waiting state, Full
// permissive pill, capture mode and reduced motion, saved as screenshots.
//   CFT_PATH="/path/to/Google Chrome for Testing" node scripts/presence-demo/demo.mjs <shotsDir>
import path from 'node:path';
import { launch, openTab, startServer, rectOf, sleep } from './harness.mjs';

const out = path.resolve(process.argv[2] || 'shots');
const server = await startServer();
const browser = await launch();
try {
  console.log('Chrome:', browser.version);
  const tab = await openTab(browser, server.origin + '/');
  const shot = (name, params) => tab.shot(path.join(out, name + '.png'), params);
  const call = (expr) => tab.world(`globalThis.__muragePresence.${expr}`);
  const renewal = setInterval(() => tab.world('globalThis.__muragePresence?.renew()').catch(() => {}), 1500);

  await shot('00-baseline-no-overlay');
  await call("state('driving')");
  await sleep(300);
  await shot('01-driving-outline-glow-pill');

  const button = await rectOf(tab, '#go');
  const bx = Math.round(button.x + button.width / 2), by = Math.round(button.y + button.height / 2);
  await call('move(120, 140)');
  const moving = call(`move(${bx}, ${by})`);
  await sleep(90);
  await shot('02-pointer-moving-mid-path');
  await moving;
  await shot('03-pointer-arrived-at-button');
  await call(`click(${bx}, ${by})`);
  await tab.click(bx, by);
  await sleep(110);
  await shot('04-click-ripple');
  console.log('page click counter:', await tab.main("document.getElementById('count').textContent"));

  const field = await rectOf(tab, '#name');
  await call(`type(${JSON.stringify(field)})`);
  await tab.click(field.x + 10, field.y + 10);
  await tab.s('Input.insertText', { text: 'Dax Party of 4' });
  await sleep(150);
  await shot('05-typing-marker-beside-field');

  await call(`avoid(${JSON.stringify({ x: 440, y: 740, width: 400, height: 50 })})`);
  await sleep(100);
  await shot('06-pill-moved-to-top-near-target');
  await call('avoid({ x: 0, y: 0, width: 10, height: 10 })');

  await call("state('driving', { full: true })");
  await sleep(150);
  await shot('07-full-permissive-pill');
  await call("state('driving')");

  // Capture mode: what the bot sees. Must equal the baseline apart from the page state we changed.
  await call("capture(true, [{ x: 40, y: 250, width: 300, height: 40 }])");
  await shot('08-capture-mode-bot-view-with-mask');
  await call('capture(false)');
  await call("state('waiting')");
  await sleep(200);
  await shot('09-waiting-state');

  await call("state('driving')");
  await tab.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call("state('off')");
  await tab.world("(() => 0)()").catch(() => {});
  clearInterval(renewal);
  console.log('Screenshots in', out);
} finally {
  await browser.close();
  await server.close();
}
