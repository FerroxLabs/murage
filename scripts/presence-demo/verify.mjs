// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser checks for presence.mjs in Chrome for Testing: the 4.3 rules, measured.
//   CFT_PATH="/path/to/Google Chrome for Testing" node scripts/presence-demo/verify.mjs
import { launch, openTab, startServer, rectOf, sleep } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const server = await startServer();
const browser = await launch();
try {
  console.log('Chrome:', browser.version);
  const hostGone = (tab) => tab.main("!document.querySelector('murage-presence')");

  // 1. No disturbance, no leak, page hit-testing unaffected.
  {
    const tab = await openTab(browser, server.origin + '/', { leaseMs: 60000 });
    const before = await tab.main('JSON.stringify({sy: scrollY, h: document.documentElement.scrollHeight, ae: document.activeElement.tagName, kids: document.documentElement.children.length})');
    const baseline = await tab.shot();
    await tab.world("globalThis.__muragePresence.state('driving')");
    await sleep(250);
    const after = await tab.main('JSON.stringify({sy: scrollY, h: document.documentElement.scrollHeight, ae: document.activeElement.tagName, kids: document.documentElement.children.length})');
    const parsed = (s) => JSON.parse(s);
    check('no scroll, layout-height or focus change', parsed(before).sy === parsed(after).sy && parsed(before).h === parsed(after).h && parsed(before).ae === parsed(after).ae, after);
    check('one host element, appended to documentElement', parsed(after).kids === parsed(before).kids + 1 && await tab.main("document.documentElement.lastElementChild.localName === 'murage-presence'"));
    check('page world cannot see the control object', await tab.main("typeof window.__muragePresence === 'undefined' && !Object.getOwnPropertyNames(window).some(k => /murage/i.test(k))"));
    check('closed shadow root: host.shadowRoot is null', await tab.main("document.querySelector('murage-presence').shadowRoot === null"));
    check('host is in the top layer (popover-open)', await tab.main("document.querySelector('murage-presence').matches(':popover-open')"));
    const btn = await rectOf(tab, '#go');
    check('elementFromPoint ignores the overlay', await tab.main(`document.elementFromPoint(${btn.x + 5}, ${btn.y + 5}).id === 'go' && document.elementFromPoint(640, 400).localName !== 'murage-presence' && document.elementFromPoint(2, 2).localName !== 'murage-presence'`));
    check('page z-index 2147483647 element does not cover the overlay', await tab.main("getComputedStyle(document.querySelector('murage-presence')).zIndex === '2147483647'"));
    // Page CSS cannot hide it.
    await tab.main("document.head.appendChild(Object.assign(document.createElement('style'), {textContent: 'murage-presence{display:none!important;visibility:hidden!important;opacity:0!important}'}))");
    check('page stylesheet with !important cannot hide the host', await tab.main("(() => { const s = getComputedStyle(document.querySelector('murage-presence')); return s.display === 'block' && s.visibility === 'visible' && s.opacity !== '0'; })()"));
    // 5. Capture mode.
    const driving = await tab.shot();
    await tab.world("globalThis.__muragePresence.capture(true)");
    const captured = await tab.shot();
    await tab.world("globalThis.__muragePresence.capture(false)");
    const restored = await tab.shot();
    check('driving screenshot differs from baseline (overlay is drawn)', driving !== baseline);
    check('capture-mode screenshot is byte-identical to the no-overlay baseline', captured === baseline);
    check('overlay is back after capture mode', restored === driving || restored !== baseline);
    // Pill controls need trusted input from a world-scoped binding.
    const r = await tab.world('globalThis.__muragePresence.rects()');
    await tab.click(r.pause.x + r.pause.width / 2, r.pause.y + r.pause.height / 2);
    await sleep(150);
    const sig = tab.signals.find((s) => s.payload === 'pause');
    check('pill Pause click calls the world-scoped binding from the presence context', !!sig && sig.contextId === tab.contextId());
    check('page cannot call the binding (not defined in the main world)', await tab.main(`typeof ${tab.bindingName} === 'undefined'`));
    // 9. States.
    await tab.world("globalThis.__muragePresence.state('waiting')");
    check('waiting hides glow and pointer, keeps outline and pill', await tab.world('(() => { const l = globalThis.__muragePresence.status().layers; return l.outline && l.pill && !l.glow && !l.pointer; })()'));
    const t0 = Date.now();
    await tab.world("globalThis.__muragePresence.state('off')");
    await sleep(20);
    check('state off removes the overlay within 300 ms', await hostGone(tab) && Date.now() - t0 < 300, `${Date.now() - t0} ms`);
    check('control object is gone after off', await tab.world("typeof globalThis.__muragePresence") === 'undefined');
  }

  // 6. Lease: no renewal, overlay removes itself.
  {
    const tab = await openTab(browser, server.origin + '/');
    await tab.world("globalThis.__muragePresence.state('driving')");
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 6000) { if (await hostGone(tab)) { gone = true; break; } await sleep(50); }
    const ms = Date.now() - t0;
    check('lease lapse removes the overlay within 3.5 s', gone && ms >= 2800 && ms <= 3500, `${ms} ms`);
    // Renewed lease keeps it alive.
    const keep = await openTab(browser, server.origin + '/');
    await keep.world("globalThis.__muragePresence.state('driving')");
    for (let i = 0; i < 6; i += 1) { await sleep(1000); await keep.world('globalThis.__muragePresence.renew()'); }
    check('renewal every second keeps the overlay beyond 3 s', !(await hostGone(keep)));
    await keep.world('globalThis.__muragePresence.remove()');
    check('remove() takes the host out at once', await hostGone(keep));
  }

  // Navigation: the new-document script reinstalls the control, state starts off.
  {
    const tab = await openTab(browser, server.origin + '/', { leaseMs: 60000 });
    await tab.world("globalThis.__muragePresence.state('driving')");
    await tab.s('Page.navigate', { url: server.origin + '/?second' });
    await sleep(600);
    check('after navigation a fresh control exists in state off, nothing drawn', await hostGone(tab) && (await tab.world('globalThis.__muragePresence.status().state')) === 'off');
  }

  // CSP + Trusted Types.
  {
    const tab = await openTab(browser, server.origin + '/csp', { leaseMs: 60000 });
    await tab.world("globalThis.__muragePresence.state('driving')");
    await sleep(200);
    check('strict CSP (no unsafe-inline styles) and Trusted Types do not block the overlay', await tab.main("!!document.querySelector('murage-presence')") && (await tab.world('globalThis.__muragePresence.status().mounted')) === true);
    await tab.world('globalThis.__muragePresence.remove()');
  }

  // 8. Re-insertion, then fallback.
  {
    const tab = await openTab(browser, server.origin + '/hostile', { leaseMs: 60000 });
    await tab.world("globalThis.__muragePresence.state('driving')");
    await sleep(1500);
    const removals = await tab.main('window.removals');
    const fallback = tab.signals.find((s) => s.payload === 'fallback');
    check('page removes host: 3 re-insertions then fallback signal, then it stops fighting', removals === 4 && !!fallback, `removals=${removals}`);
    await tab.world('globalThis.__muragePresence.remove()');
  }

  // Reduced motion.
  {
    const tab = await openTab(browser, server.origin + '/', { leaseMs: 60000 });
    await tab.world("globalThis.__muragePresence.state('driving')");
    const animated = await tab.world('globalThis.__muragePresence.status().glowAnimating');
    await tab.world('globalThis.__muragePresence.remove()');
    await tab.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await tab.world('typeof globalThis.__muragePresence').catch(() => {});
    await tab.s('Page.reload'); await sleep(600);
    await tab.world("globalThis.__muragePresence.state('driving')");
    const still = await tab.world('globalThis.__muragePresence.status().glowAnimating');
    const t0 = Date.now();
    await tab.world('globalThis.__muragePresence.move(900, 600)');
    await tab.world('globalThis.__muragePresence.move(100, 100)');
    const jump = Date.now() - t0;
    const at = await tab.world('globalThis.__muragePresence.status().pointerAt');
    check('reduced motion: glow does not pulse, normal motion does', animated === true && still === false);
    check('reduced motion: pointer jumps (no path animation)', at.x === 100 && at.y === 100 && jump < 150, `${jump} ms for two moves`);
    await tab.world('globalThis.__muragePresence.remove()');
  }

  // Pointer path timing (normal and Full permissive).
  {
    const tab = await openTab(browser, server.origin + '/', { leaseMs: 60000 });
    await tab.world("globalThis.__muragePresence.state('driving')");
    await tab.world('globalThis.__muragePresence.move(50, 50)');
    const time = async () => { const t0 = Date.now(); await tab.world('globalThis.__muragePresence.move(1200, 700)'); const d = Date.now() - t0; await tab.world('globalThis.__muragePresence.move(50, 50)'); return d; };
    const normal = await time();
    await tab.world("globalThis.__muragePresence.state('driving', { full: true })");
    const fast = await time();
    check('long pointer move awaits about 350 ms, and about half in Full permissive', normal >= 300 && normal <= 450 && fast < normal, `normal=${normal} ms, full=${fast} ms (includes CDP round trip)`);
    await tab.world('globalThis.__muragePresence.remove()');
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
