// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from './page-error-guard';
import { PullbackFixture, BOT, THREAD } from './pullback-layers.fixture';
import type { Action } from '../state/store';
import type { PullbackProbe } from './pullback-layers.observer';

let fixture: PullbackFixture;
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('actual App page-skill-recorder') || /BF-2[456]:/.test(testInfo.title)) await page.addInitScript(() => {
    const capabilities = {
      host: { platform: 'darwin', label: 'Fixture macOS', session: 'unknown', packaged: false }, windowChrome: 'mac-inset',
      screenPreview: { available: false, interaction: 'none', reasonCode: 'desktop-app-required' },
      dictation: { available: false, engine: 'none', onDevice: false, reasonCode: 'desktop-app-required' },
      localComputer: { available: false, support: 'unsupported', enabled: false, status: 'unavailable', reasonCode: 'desktop-app-required' },
    };
    // Renderer capability input only; no IPC or real recorder is invoked.
    window.muragebox = { platform: 'darwin', getCapabilities: async () => capabilities } as unknown as NonNullable<Window['muragebox']>;
  });
  fixture = new PullbackFixture(); await fixture.start();
  // Refuse every non-fixture request, including analytics and remote catalogs.
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await page.goto(fixture.origin + '/__pullback');
  await expect.poll(() => page.evaluate(() => window.pullback?.state.hydrated)).toBe(true);
  // Hydrated roster alone does not prove that the config reply was admitted.
  await expect.poll(() => page.evaluate(() => window.pullback.state.config?.features?.skillRecorder)).toBe(true);
  await expect(page.getByRole('button', { name: 'App settings', exact: true })).toBeAttached();
  await expect.poll(() => page.evaluate(() => window.pullback.state.streamEpoch)).toBe('E1');
});
test.afterEach(async ({ page }) => { await page.close(); await fixture.close(); });
const layers = (page: Page) => page.evaluate(() => window.pullback.layers());
const names = async (page: Page) => (await layers(page)).map(layer => layer.name);
const dispatch = (page: Page, action: Action) => page.evaluate(action => window.pullback.dispatch(action), action);
const auxiliary = (page: Page, name: Parameters<PullbackProbe['auxiliary']>[0]) => page.evaluate(name => window.pullback.auxiliary(name), name);
async function settings(page: Page) {
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
}
async function palette(page: Page) {
  await page.evaluate(() => window.pullback.palette());
  await expect(page.locator('[aria-label="Command palette"] input')).toBeFocused();
}
async function stable(page: Page) {
  await settings(page); await palette(page);
  await page.evaluate(() => window.pullback.mark());
  return layers(page);
}
async function unchanged(page: Page, before: Awaited<ReturnType<typeof layers>>) {
  await expect.poll(() => layers(page)).toEqual(before);
  expect(await page.evaluate(() => window.pullback.sameFocus())).toBe(true);
}
async function paint(page: Page, top: string) {
  const entry = (await layers(page))[0];
  expect(entry.name).toBe(top); expect(entry.paintRank).toBe(entry.rank);
  await expect.poll(() => page.evaluate(name => window.pullback.hit(name), top)).toBe(true);
}
async function hold(page: Page, file: string, reject = false) {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const pattern = `**/components/${file}*`;
  await page.route(pattern, async route => { await wait; if (reject) await route.abort('failed'); else await route.continue(); });
  let completion: Promise<void> | undefined;
  return () => completion ??= (async () => {
    release(); await page.unroute(pattern);
    // Await module evaluation as well as route release. Late-completion assertions
    // must not pass merely because the browser has not received the chunk yet.
    if (!reject) await page.evaluate(async file => { await import('/src/components/' + file); }, file);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  })();
}

test('B1: actual Settings search clears, closes, and returns to its opener', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'App settings', exact: true });
  for (const temperature of ['cold', 'warm']) {
    await opener.click();
    const search = page.getByRole('textbox', { name: 'Search settings', exact: true });
    await search.fill(temperature); await page.keyboard.press('Escape');
    await expect(search).toHaveValue(''); expect(await names(page)).toEqual(['settings']);
    await page.keyboard.press('Escape'); await expect(search).toHaveCount(0);
    await expect(opener).toBeFocused(); expect(await layers(page)).toEqual([]);
  }
});

test('B2: held Settings resolves below empty and reopened palette without stealing focus', async ({ page }) => {
  const releaseSettings = await hold(page, 'SettingsModal.tsx');
  const releasePalette = await hold(page, 'CommandPalette.tsx');
  try {
    await page.keyboard.press('Control+,'); await expect.poll(() => names(page)).toEqual(['settings']);
    await page.evaluate(() => window.pullback.palette());
    await expect.poll(() => names(page)).toEqual(['palette', 'settings']);
    await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['settings']);
    await page.evaluate(() => window.pullback.palette());
    await expect.poll(() => names(page)).toEqual(['palette', 'settings']);
    const id = (await layers(page))[0].id;
    await releaseSettings();
    await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
    expect((await layers(page))[0].id).toBe(id);
    await releasePalette(); await expect(page.locator('[aria-label="Command palette"] input')).toBeFocused();
    await paint(page, 'palette');
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['settings']);
    expect((await layers(page))[0].focused).toBe(true);
  } finally { await releaseSettings(); await releasePalette(); }
});

test('B3: section editor over Settings yields to palette and dirty requestClose preserves edits', async ({ page }) => {
  await settings(page); const parent = (await layers(page))[0];
  await auxiliary(page, 'editor');
  const textarea = page.locator('[aria-modal="true"] textarea'); await textarea.fill('Keep my team instructions');
  const editor = (await layers(page))[0]; expect(editor.name).toBe('section-context');
  await paint(page, 'section-context'); await palette(page); await paint(page, 'palette');
  expect(new Set((await layers(page)).map(entry => entry.rank)).size).toBe(3);
  await page.keyboard.press('Escape'); await expect(textarea).toBeFocused();
  let prompts = 0; page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  await page.keyboard.press('Escape'); expect(prompts).toBe(1);
  await expect(textarea).toHaveValue('Keep my team instructions');
  expect((await layers(page)).map(entry => entry.id)).toEqual([editor.id, parent.id]);
});

test('B4: real Memory native cancel and nested native showModal order preserve Settings', async ({ page }) => {
  await settings(page); const parent = (await layers(page))[0];
  await auxiliary(page, 'memory');
  await page.locator('[data-pullback-auxiliary]').getByRole('button', { name: 'Open memory for Pullback bot' }).evaluate(node => (node as HTMLButtonElement).click());
  const memory = page.locator('dialog[open]'); await expect(memory).toHaveCount(1);
  await memory.evaluate(node => node.addEventListener('cancel', () => node.setAttribute('data-cancelled', 'yes')));
  const memoryId = (await layers(page))[0].id;
  await auxiliary(page, 'shortcuts'); await expect(page.locator('dialog[open]')).toHaveCount(2);
  expect((await layers(page))[0].kind).toBe('native');
  await page.keyboard.press('Escape'); await expect(page.locator('dialog[open]')).toHaveCount(1);
  expect((await layers(page))[0].id).toBe(memoryId);
  await page.keyboard.press('Escape'); await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('dialog[data-cancelled="yes"]')).toHaveCount(1);
  expect((await layers(page)).map(entry => entry.id)).toEqual([parent.id]);
  expect((await layers(page))[0].focused).toBe(true);
});

test('B5 / R22-RESUME: Help beside Settings keeps focus and Escape returns to Help tab', async ({ page }) => {
  await settings(page); const before = (await layers(page))[0].id;
  const tab = page.locator('[data-help-launcher]'); await tab.click();
  await expect(page.locator('[data-help-panel]:not([data-help-frame])')).toBeVisible();
  await expect(page.locator('[data-help-frame]')).toHaveCount(0);
  const control = page.locator('[data-help-panel] button').first(); await control.focus();
  await expect(control).toBeFocused();
  await palette(page); await page.keyboard.press('Escape'); await expect(control).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-help-panel]')).toHaveCount(0);
  await expect(tab).toBeFocused(); expect((await layers(page))[0].id).toBe(before);
});

test('B6: Routines loading cover paints below Settings and dismisses to Today', async ({ page }) => {
  const release = await hold(page, 'RoutineCalendarPage.tsx');
  try {
    await dispatch(page, { type: 'showToday' });
    await expect.poll(() => page.evaluate(() => window.pullback.state.activeView)).toBe('today');
    await dispatch(page, { type: 'showRoutines' }); await expect.poll(() => names(page)).toEqual(['page-routines']);
    await settings(page); await paint(page, 'settings');
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['page-routines']);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
    expect(await page.evaluate(() => window.pullback.state.activeView)).toBe('today');
    await release(); expect(await layers(page)).toEqual([]);
  } finally { await release(); }
});

for (const reverse of [false, true]) test(`H3/B7: equal-kind Team library and Settings agree on paint and Escape, reverse=${reverse}`, async ({ page }) => {
  if (reverse) await settings(page);
  await dispatch(page, { type: 'showTeamLibrary' }); await expect.poll(() => names(page)).toContain('team-library');
  if (!reverse) await settings(page);
  const top = reverse ? 'team-library' : 'settings';
  await expect.poll(async () => (await layers(page))[0].name).toBe(top);
  await paint(page, top); const before = await layers(page);
  expect(before[0].rank).toBeGreaterThan(before[1].rank!);
  expect(before[0].paintRank).toBeGreaterThan(before[1].paintRank!);
  expect(before.map(entry => entry.paintRank)).toEqual(before.map(entry => entry.rank));
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([before[1].name]);
  // Sidebar explicitly hands Team library back to New or share, even beside Settings.
  if (reverse) await expect(page.getByRole('button', { name: 'New or share', exact: true })).toBeFocused();
  else expect((await layers(page))[0].focused).toBe(true);
});

for (const rejected of [false, true]) test(`B8: phone drawer Team library portal geometry and controls, rejected=${rejected}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const release = await hold(page, 'TeamLibraryPanel.tsx', rejected);
  try {
    await page.getByRole('button', { name: 'Open bot list', exact: true }).click();
    await page.getByRole('button', { name: 'New or share', exact: true }).click();
    await page.getByText('Browse templates…', { exact: true }).click();
    await expect.poll(() => names(page)).toEqual(['team-library']);
    await settings(page); await page.keyboard.press('Escape');
    await expect.poll(() => names(page)).toEqual(['team-library']);
    const geometry = await page.locator('#murage-layer-host > [data-layer-surface]').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, viewport: visualViewport!.height, inert: !!node.closest('[inert]'), host: node.parentElement?.id };
    });
    expect(geometry).toMatchObject({ x: 0, y: 0, width: 390, inert: false, host: 'murage-layer-host' });
    expect(geometry.height).toBeCloseTo(geometry.viewport, 0);
    await paint(page, 'team-library');
    if (rejected) {
      // Change the held response to a failed dynamic import, without a live endpoint.
      await release();
      await expect(page.getByRole('button', { name: /Tap to retry/ })).toBeFocused();
    } else {
      await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true }).click(); await expect.poll(() => names(page)).toEqual([]);
      await release(); expect(await layers(page)).toEqual([]);
    }
  } finally { await release(); }
});

for (const kind of ['bots', 'channels'] as const) test(`B9: actual archived ${kind} and nested ConfirmDelete outrank Settings`, async ({ page }) => {
  await auxiliary(page, kind); const archive = (await layers(page))[0];
  await settings(page); await expect.poll(async () => (await layers(page))[0].id).toBe(archive.id);
  await paint(page, archive.name);
  await page.getByRole('button', { name: kind === 'bots' ? 'Delete Pullback bot' : 'Delete', exact: true }).click();
  await expect.poll(async () => (await layers(page)).length).toBe(3);
  expect((await layers(page))[0].name).toBe('confirm-delete');
  await page.keyboard.press('Escape'); await expect.poll(async () => (await layers(page))[0].id).toBe(archive.id);
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['settings']);
});

async function startSend(page: Page) {
  const sendId = await page.evaluate(() => window.pullback.beginSend());
  await expect.poll(() => fixture.status).toBe('running');
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'])).toContain('Running fixture turn');
  await expect.poll(() => page.evaluate(() => window.pullback.state.pendingQueued['pullback-thread']?.length)).toBe(1);
  return sendId;
}
for (const unmount of [false, true]) test(`D18 / R23-STOP / BF-4: real interrupt POST, stopped lookup and settlement, owner-unmount=${unmount}`, async ({ page }) => {
  const sendId = await startSend(page); const before = await stable(page);
  await dispatch(page, { type: 'interrupt', botId: BOT, threadId: THREAD });
  await expect.poll(() => fixture.interrupts).toEqual([{ method: 'POST', body: { threadId: THREAD } }]);
  expect(fixture.status).toBe('stopped');
  expect(await page.evaluate(() => window.pullback.lookup())).toBe('ack');
  expect(fixture.lookups).toContain(`/api/sends/${THREAD}/${sendId}`);
  fixture.settle();
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'] ?? '')).toBe('');
  await expect.poll(() => page.evaluate(() => window.pullback.state.pendingQueued['pullback-thread'] ?? [])).toEqual([]);
  await unchanged(page, before);
  if (unmount) {
    await dispatch(page, { type: 'toggleAppSettings', open: false });
    await expect.poll(() => names(page)).toEqual(['palette']);
    expect((await layers(page))[0].id).toBe(before[0].id);
    expect(await page.evaluate(() => window.pullback.sameFocus())).toBe(true);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
  }
});

for (const unmount of [false, true]) test(`D18 / R23-ENGINE / BF-4: stream restart adopts E2 and rejects E1, owner-unmount=${unmount}`, async ({ page }) => {
  const before = await stable(page), connections = fixture.connections;
  fixture.restartEngine();
  await expect.poll(() => fixture.connections).toBeGreaterThan(connections);
  await expect.poll(() => page.evaluate(() => window.pullback.state.streamEpoch)).toBe('E2');
  await unchanged(page, before);
  fixture.announce('E1', 'Stale epoch', 1000); fixture.delta('old-epoch-barrier');
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'])).toContain('old-epoch-barrier');
  expect(await page.evaluate(() => window.pullback.state.bots[0].name)).toBe('Pullback bot');
  fixture.announce('E2', 'Admitted epoch', 11);
  await expect.poll(() => page.evaluate(() => window.pullback.state.bots[0].name)).toBe('Admitted epoch');
  fixture.announce('E1', 'Stale after admitted', 1001);
  // A subsequent admissible frame is the processing barrier, not a timed sleep.
  fixture.announce('E2', 'Epoch barrier', 12);
  await expect.poll(() => page.evaluate(() => window.pullback.state.bots[0].name)).toBe('Epoch barrier');
  await unchanged(page, before);
  if (unmount) {
    await dispatch(page, { type: 'toggleAppSettings', open: false }); await expect.poll(() => names(page)).toEqual(['palette']);
    expect((await layers(page))[0].id).toBe(before[0].id);
    expect(await page.evaluate(() => window.pullback.sameFocus())).toBe(true);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
  }
});

test('D18 / R22-TURN / BF-4: concurrent streamed, finished and restarted turn preserves owners', async ({ page }) => {
  await startSend(page); const before = await stable(page);
  fixture.delta(' concurrent');
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'])).toContain('concurrent');
  await unchanged(page, before); fixture.settle('Finished first turn');
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'] ?? '')).toBe('');
  await unchanged(page, before);
  fixture.frame({ kind: 'runtime', event: { type: 'turn.started', threadId: THREAD } }); fixture.delta('Restarted turn');
  await expect.poll(() => page.evaluate(() => window.pullback.streaming.streaming['pullback-thread'])).toBe('Restarted turn');
  await unchanged(page, before);
});

test('B10 / R22-RESTART / BF-4: document reload and application restart discard old owners and capture a fresh opener', async ({ page }) => {
  await settings(page); await palette(page);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.pullback?.state.hydrated)).toBe(true);
  await expect.poll(() => names(page)).toEqual([]);
  const opener = page.getByRole('button', { name: 'App settings', exact: true });
  await opener.click(); await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  await opener.click(); await palette(page);
  await page.evaluate(() => window.pullbackUnmount()); await expect.poll(() => names(page)).toEqual([]);
  await expect(page.locator('[data-layer-surface]')).toHaveCount(0);
  await page.evaluate(() => window.pullbackMount());
  await expect.poll(() => page.evaluate(() => window.pullback.state.hydrated)).toBe(true);
  await expect.poll(() => names(page)).toEqual([]);
  await opener.click(); await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
});

test('BF-23 / H1 / D2: full App app-to-bot-to-app Settings remount retains the original opener', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'App settings', exact: true });
  for (const temperature of ['cold', 'warm']) {
    await opener.click(); await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
    await opener.evaluate(node => { node.setAttribute('data-focus-count', '0'); if (!node.hasAttribute('data-focus-watch')) { node.setAttribute('data-focus-watch', ''); node.addEventListener('focus', () => node.setAttribute('data-focus-count', String(Number(node.getAttribute('data-focus-count')) + 1))); } });
    await dispatch(page, { type: 'toggleSettings', open: true, botId: BOT });
    await expect.poll(() => names(page)).toEqual(['bot-settings']);
    await expect.poll(async () => (await layers(page))[0].focused).toBe(true);
    await expect(opener, temperature).toHaveAttribute('data-focus-count', '0');
    await dispatch(page, { type: 'toggleAppSettings', open: true });
    await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
    await expect(opener).toHaveAttribute('data-focus-count', '0');
    await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute('data-focus-count', '1'); expect(await layers(page)).toEqual([]);
  }
});

test('B10 retry: chunk retry calls the reload seam once, real reload reconstructs without ghosts', async ({ page }) => {
  const release = await hold(page, 'SettingsModal.tsx', true);
  try {
    await page.keyboard.press('Control+,'); await expect.poll(() => names(page)).toEqual(['settings']);
    await release();
    const retry = page.getByRole('button', { name: /Tap to retry/ }); await expect(retry).toBeFocused();
    await retry.click(); expect(await page.evaluate(() => window.pullbackReloads)).toBe(1);
    await page.reload(); await expect.poll(() => page.evaluate(() => window.pullback?.state.hydrated)).toBe(true);
    expect(await layers(page)).toEqual([]); await expect(page.locator('[data-layer-surface]')).toHaveCount(0);
    const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.click();
    await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  } finally { await release(); }
});

test('R22-DETAILS / BF-22: Chromium Tab agrees with the shared resolver for closed and nested details', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'details-fixture';
    root.style.cssText = 'position:fixed;inset:0;background:white;z-index:100';
    root.innerHTML = '<button id="before">Before</button><details><summary id="summary">First <button id="inside-summary">Summary child</button></summary><button id="folded">Folded</button><summary id="later">Later</summary><details open><summary>Nested</summary><button id="nested">Nested child</button></details></details><button disabled id="disabled">Disabled</button><div hidden><button id="hidden">Hidden</button></div><button id="after">After</button>';
    document.body.append(root); document.getElementById('before')!.focus();
  });
  expect(await page.evaluate(() => window.pullback.reachable('details-fixture'))).toEqual(['before', 'summary', 'inside-summary', 'after']);
  for (const id of ['summary', 'inside-summary', 'after']) { await page.keyboard.press('Tab'); await expect(page.locator('#' + id)).toBeFocused(); }
  await page.locator('#summary').click(); await page.locator('#inside-summary').focus();
  await page.keyboard.press('Tab'); await expect(page.locator('#folded')).toBeFocused();
  await page.locator('#later').evaluate(node => node.remove());
  await page.locator('#nested').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#after')).toBeFocused();
  expect(await page.locator('#disabled').evaluate(node => node.getClientRects().length)).toBeGreaterThan(0);
  expect(await page.locator('#hidden').evaluate(node => node.getClientRects().length)).toBe(0);
});

test('R5-M5: Chromium visibility:hidden keeps its boxes, the resolver drops it and the trap wraps past it', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'visibility-fixture';
    root.style.cssText = 'position:fixed;inset:0;background:white;z-index:100';
    root.innerHTML = '<button id="first">First</button><button id="second">Second</button><div style="visibility:hidden"><button id="ghost">Ghost</button></div><button id="own" style="visibility:collapse">Own</button>';
    document.body.append(root);
    const after = document.createElement('button'); after.id = 'outside-after'; after.textContent = 'Outside'; document.body.append(after);
  });
  for (const id of ['ghost', 'own']) expect(await page.locator('#' + id).evaluate(node => node.getClientRects().length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.pullback.reachable('visibility-fixture'))).toEqual(['first', 'second']);
  await page.evaluate(() => window.pullback.trap('visibility-fixture'));
  try {
    await page.locator('#second').focus();
    await page.keyboard.press('Tab'); await expect(page.locator('#first')).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(page.locator('#second')).toBeFocused();
  } finally {
    await page.evaluate(() => { window.pullback.untrap(); document.getElementById('visibility-fixture')?.remove(); document.getElementById('outside-after')?.remove(); });
  }
});

const nullCallers = [
  { caller: 'Sidebar export', file: 'TeamExportDialog.tsx', name: 'team-export', loaded: 'team-export-native' },
  { caller: 'Sidebar shortcuts', file: 'KeyboardShortcutsDialog.tsx', name: 'keyboard-shortcuts-load', loaded: 'keyboard-shortcuts' },
  { caller: 'Sidebar template', file: 'NewFromTemplateDialog.tsx', name: 'new-from-template', loaded: 'new-from-template-dialog' },
  { caller: 'Sidebar hire', file: 'hire/HireBotDialog.tsx', name: 'hire-bot-sidebar', loaded: 'hire-bot' },
  { caller: 'Hire template', file: 'NewFromTemplateDialog.tsx', name: 'hire-bot-templates', loaded: 'new-from-template-dialog' },
] as const;
async function openNullCaller(page: Page, caller: typeof nullCallers[number]['caller']) {
  if (caller === 'Hire template') {
    await page.getByRole('button', { name: 'App settings', exact: true }).focus();
    await auxiliary(page, 'hire');
    await page.getByRole('button', { name: 'Browse templates', exact: true }).click(); return;
  }
  if (caller === 'Sidebar shortcuts') {
    await page.locator('[data-you-health] button').first().click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true }).click(); return;
  }
  await page.getByRole('button', { name: 'New or share', exact: true }).click();
  await page.getByRole('button', { name: caller === 'Sidebar export' ? 'Export bots…' : 'New Bot', exact: true }).click();
  if (caller === 'Sidebar hire') await page.getByRole('button', { name: /Hire in one sentence/ }).click();
}
for (const row of nullCallers) for (const outcome of ['dismiss', 'reject', 'load'] as const) {
  test(`R23-NULL / BF-3 / R22-RETURN: ${row.caller} ${outcome}`, async ({ page }) => {
    const release = await hold(page, row.file, outcome === 'reject');
    try {
      await openNullCaller(page, row.caller);
      await expect.poll(() => names(page)).toContain(row.name);
      const entry = (await layers(page))[0]; expect(entry.name).toBe(row.name);
      const opener = row.caller === 'Hire template' ? page.getByRole('button', { name: 'App settings', exact: true })
        : row.caller === 'Sidebar shortcuts' ? page.locator('[data-sidebar-you-trigger]') : page.getByRole('button', { name: 'New or share', exact: true });
      await opener.evaluate(node => { node.setAttribute('data-returns', '0'); node.addEventListener('focus', () => node.setAttribute('data-returns', String(Number(node.getAttribute('data-returns')) + 1))); });
      await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await expect(page.locator('#murage-layer-host > [data-layer-surface]')).toHaveCount(1);
      if (outcome === 'dismiss') {
        await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain(row.name);
        const remaining = await layers(page); await release();
        await expect.poll(() => layers(page)).toEqual(remaining);
      } else if (outcome === 'reject') {
        await release(); await expect(page.getByRole('button', { name: /Tap to retry/ })).toBeFocused();
        expect((await layers(page))[0].id).toBe(entry.id);
        await page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true }).click(); await expect.poll(() => names(page)).not.toContain(row.name);
      } else {
        await release();
        await expect.poll(async () => (await layers(page))[0]?.id).not.toBe(entry.id);
        await expect.poll(async () => (await layers(page))[0]?.name).toBe(row.loaded);
        expect((await layers(page))[0].focused).toBe(true);
        await expect(opener).toHaveAttribute('data-returns', '0');
        await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain(row.loaded);
      }
      await expect(opener).toBeFocused(); await expect(opener).toHaveAttribute('data-returns', '1');
    } finally { await release(); }
  });
}

for (const query of ['', 'keep query']) test(`R23-H1 / R22-H2: actual search under empty palette preserves query=${JSON.stringify(query)}`, async ({ page }) => {
  await settings(page);
  const search = page.getByRole('textbox', { name: 'Search settings', exact: true }); await search.fill(query); await search.focus();
  const parent = (await layers(page))[0]; const release = await hold(page, 'CommandPalette.tsx');
  try {
    await page.evaluate(() => window.pullback.palette()); await expect.poll(() => names(page)).toEqual(['palette', 'settings']);
    await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['settings']);
    await expect(search).toHaveValue(query); expect((await layers(page))[0].id).toBe(parent.id);
    await page.keyboard.press('Escape');
    if (query) { await expect(search).toHaveValue(''); await page.keyboard.press('Escape'); }
    await expect.poll(() => names(page)).toEqual([]);
    await release(); await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
  } finally { await release(); }
});

test('B10 late completion: application restart invalidates old loading owner and callbacks', async ({ page }) => {
  const release = await hold(page, 'SettingsModal.tsx');
  try {
    await page.keyboard.press('Control+,'); await expect.poll(() => names(page)).toEqual(['settings']);
    const old = (await layers(page))[0].id;
    await page.evaluate(() => window.pullbackUnmount()); await expect.poll(() => names(page)).toEqual([]);
    await release(); await expect(page.locator('[data-layer-surface]')).toHaveCount(0);
    await page.evaluate(() => window.pullbackMount());
    await expect.poll(() => page.evaluate(() => window.pullback.state.hydrated)).toBe(true);
    await expect.poll(() => names(page)).toEqual([]);
    const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.click();
    await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toBeVisible();
    expect((await layers(page))[0].id).not.toBe(old);
    await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  } finally { await release(); }
});

for (const control of ['model', 'revoke'] as const) for (const foreign of ['none', 'aria', 'native'] as const) {
  test(`R23-H1 / D19 / BF-12: actual contained ${control} under empty palette with ${foreign} guard`, async ({ page }) => {
    await settings(page);
    await page.evaluate(control => window.dispatchEvent(new CustomEvent('pullback:control', { detail: control })), control);
    const trigger = page.locator('[data-pullback-controls] [aria-haspopup="dialog"]');
    const target = control === 'model' ? page.getByRole('textbox', { name: 'Search models', exact: true }) : page.locator('[data-pullback-controls] [role="alertdialog"] button').first();
    if (control === 'model') { await trigger.click(); await target.fill('keep'); }
    await target.focus();
    for (const mode of ['composing', 'prevented']) {
      await target.evaluate((node, mode) => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: mode === 'composing' });
        if (mode === 'prevented') event.preventDefault(); node.dispatchEvent(event);
      }, mode);
      await expect(target).toBeVisible();
    }
    const release = await hold(page, 'CommandPalette.tsx');
    try {
      await page.evaluate(() => window.pullback.palette()); await expect.poll(() => names(page)).toEqual(['palette', 'settings']);
      if (foreign !== 'none') {
        await page.evaluate(foreign => {
          const node = document.createElement(foreign === 'native' ? 'dialog' : 'div'); node.id = 'foreign-fixture';
          node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true');
          node.style.cssText = 'position:fixed;inset:20%;background:white;z-index:100';
          node.innerHTML = '<button>Foreign control</button>'; document.body.append(node);
          if (foreign === 'native') (node as HTMLDialogElement).showModal();
          node.querySelector('button')!.focus();
          node.addEventListener('keydown', event => {
            if ((event as KeyboardEvent).key === 'Escape') queueMicrotask(() => document.documentElement.setAttribute('data-foreign-prevented', String(event.defaultPrevented)));
          });
        }, foreign);
        await page.keyboard.press('Escape');
        await expect(page.locator('html')).toHaveAttribute('data-foreign-prevented', 'false');
        expect(await names(page)).toEqual(['palette', 'settings']); await expect(target).toBeAttached();
        if (foreign === 'native') await expect(page.locator('#foreign-fixture')).not.toHaveAttribute('open', '');
        await page.locator('#foreign-fixture').evaluate(node => node.remove()); await target.focus();
      }
      await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['settings']);
      await expect(target).toBeVisible();
      if (control === 'model') {
        await expect(target).toHaveValue('keep'); await page.keyboard.press('Escape'); await expect(target).toHaveValue('');
        await page.keyboard.press('Escape'); await expect(target).toHaveCount(0); await expect(trigger).toBeFocused();
      } else { await page.keyboard.press('Escape'); await expect(target).toHaveCount(0); }
      await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
    } finally { await release(); }
  });
}

for (const name of ['export', 'shortcuts', 'close-project', 'end-project', 'bundle', 'whats-new', 'engine-link', 'engine-signin'] as const) {
  for (const warm of [false, true]) for (const strict of [false, true]) {
    test(`R22-OWNERS / R23-H3 / BF-6 / R22-RETURN: native ${name} warm=${warm} StrictMode=${strict} crash retry and final return`, async ({ page }) => {
      const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.focus();
      await opener.evaluate(node => { node.setAttribute('data-returns', '0'); node.addEventListener('focus', () => node.setAttribute('data-returns', String(Number(node.getAttribute('data-returns')) + 1))); });
      await page.evaluate(({ name, warm, strict }) => window.pullback.nativeCase(name, warm, strict), { name, warm, strict });
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await expect.poll(async () => (await layers(page))[0]?.kind).toBe('native');
      expect((await layers(page))).toHaveLength(1); await expect(opener).toHaveAttribute('data-returns', '0');
      let previous = (await layers(page))[0].id;
      for (let crash = 0; crash < 2; crash++) {
        await page.locator('dialog[open] button').first().focus();
        await page.evaluate(() => window.pullbackNativeCrash(true));
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        const retry = page.getByRole('button', { name: /Try again/ }); await expect(retry).toBeFocused();
        const error = (await layers(page))[0]; expect(error.name).toBe('native-fixture-load'); expect(error.id).not.toBe(previous);
        expect(await layers(page)).toHaveLength(1); await expect(opener).toHaveAttribute('data-returns', '0');
        await page.evaluate(() => window.pullbackNativeCrash(false)); await retry.click();
        await expect(page.locator('dialog[open]')).toHaveCount(1); await expect.poll(async () => (await layers(page))[0]?.kind).toBe('native');
        previous = (await layers(page))[0].id; expect(previous).not.toBe(error.id); await expect(opener).toHaveAttribute('data-returns', '0');
      }
      await page.keyboard.press('Escape'); await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect.poll(() => names(page)).toEqual([]); await expect(opener).toBeFocused(); await expect(opener).toHaveAttribute('data-returns', '1');
      // External owner removal is a different transition from native cancel.
      await page.evaluate(({ name, strict }) => window.pullback.nativeCase(name, true, strict), { name, strict });
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await auxiliary(page, 'none'); await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect.poll(() => names(page)).toEqual([]); await expect(opener).toBeFocused(); await expect(opener).toHaveAttribute('data-returns', '2');
    });
  }
}

// Where the last Escape leaves focus. PULLBACK-LAYERS-1018.md rule 5 returns focus to the opener, and says nothing about a page whose
// dismissal lands on the chat view. All chats and Routines close onto the open chat (closeAllChats, closeCalendar), and that view's
// composer takes focus when it mounts (Composer.tsx, "focus the draft when a thread opens", 2cd0f35a1), after the layer's release. Team
// map and Skill recorder close onto Today, which has no autofocus, so the opener keeps it.
type FocusAfter = 'opener' | 'composer';
const appOwners: Array<{ name: string; file: string; action: Action; kind: 'page' | 'window'; focusAfter: FocusAfter }> = [
  { name: 'page-all-chats', file: 'AllChatsPage.tsx', action: { type: 'showAllChats' }, kind: 'page', focusAfter: 'composer' },
  { name: 'page-team-map', file: 'TeamMapPage.tsx', action: { type: 'showTeamMap' }, kind: 'page', focusAfter: 'opener' },
  { name: 'page-routines', file: 'RoutinesPage.tsx', action: { type: 'showRoutines' }, kind: 'page', focusAfter: 'composer' },
  { name: 'page-skill-recorder', file: 'SkillRecorderPage.tsx', action: { type: 'showSkillRecorder' }, kind: 'page', focusAfter: 'opener' },
  { name: 'computer', file: 'ComputerPanel.tsx', action: { type: 'toggleComputer', open: true }, kind: 'window', focusAfter: 'opener' },
  { name: 'inspector', file: 'InspectorPanel.tsx', action: { type: 'toggleInspector', open: true }, kind: 'window', focusAfter: 'opener' },
];
for (const row of appOwners) test(`R22-OWNERS: actual App ${row.name} cover activation, focus, upper owner and dismissal`, async ({ page }) => {
  await dispatch(page, { type: 'select', id: BOT });
  const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.focus();
  const release = await hold(page, row.file);
  try {
    await dispatch(page, row.action); await expect.poll(() => names(page)).toEqual([row.name]);
    const before = (await layers(page))[0]; expect(before.kind).toBe(row.kind);
    await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await palette(page); await paint(page, 'palette');
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([row.name]);
    expect((await layers(page))[0].id).toBe(before.id); await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
    if (row.focusAfter === 'composer') await expect(page.locator('textarea[aria-label^="Message "]')).toBeFocused(); else await expect(opener).toBeFocused();
    await release(); await expect(page.locator('[data-layer-surface]')).toHaveCount(0);
  } finally { await release(); }
});

test('R24 phone geometry: actual template sheet tracks visual viewport and receives pointer hits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open bot list', exact: true }).click();
  await openNullCaller(page, 'Sidebar template');
  await expect.poll(() => names(page)).toEqual(['new-from-template-dialog']);
  const sheet = page.locator('[aria-labelledby="new-from-template-title"]');
  for (const height of [844, 500]) {
    await page.setViewportSize({ width: 390, height });
    await expect.poll(() => sheet.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return Math.abs(rect.height - visualViewport!.height);
    })).toBeLessThan(1);
    expect(await sheet.evaluate(node => node.getBoundingClientRect().width)).toBe(390);
    await paint(page, 'new-from-template-dialog');
    expect(await sheet.evaluate(node => !!node.closest('[inert]'))).toBe(false);
  }
  await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New or share', exact: true })).toBeFocused();
});

test('R22-OWNERS: actual Plugins cold/warm activation, upper palette, and opener return', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'App settings', exact: true });
  for (const temperature of ['cold', 'warm']) {
    await opener.focus(); await dispatch(page, { type: 'togglePlugins', open: true });
    await expect(page.getByRole('button', { name: 'Close connected apps', exact: true })).toBeVisible();
    expect(await names(page), temperature).toEqual(['plugins']); expect((await layers(page))[0].focused).toBe(true);
    const id = (await layers(page))[0].id; await palette(page);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual(['plugins']);
    expect((await layers(page))[0].id).toBe(id); expect((await layers(page))[0].focused).toBe(true);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]); await expect(opener).toBeFocused();
  }
});

for (const group of [false, true]) test(`R22-OWNERS: actual ${group ? 'group' : 'bot'} call cover dismiss ends only that call`, async ({ page }) => {
  const id = group ? 'pullback-group' : BOT, name = group ? 'group-call' : 'call';
  await expect.poll(() => page.evaluate(id => window.pullback.state.bots.some(bot => bot.id === id) || window.pullback.state.groups.some(group => group.id === id), id)).toBe(true);
  await dispatch(page, { type: 'select', id });
  await expect.poll(() => page.evaluate(() => window.pullback.state.selectedId)).toBe(id);
  const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.focus();
  const release = await hold(page, group ? 'GroupCallView.tsx' : 'CallView.tsx');
  try {
    expect(await page.evaluate(id => window.pullback.call(id), id)).toBe(id);
    await expect.poll(() => names(page)).toEqual([name]);
    await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await palette(page); await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([name]);
    expect(await page.evaluate(() => window.pullback.call())).toBe(id);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
    expect(await page.evaluate(() => window.pullback.call())).toBeNull(); await expect(opener).toBeFocused();
    await release(); expect(await layers(page)).toEqual([]); expect(await page.evaluate(() => window.pullback.call())).toBeNull();
  } finally { await release(); }
});

for (const group of [false, true]) test(`R22-OWNERS: actual ${group ? 'group' : 'chat'} find cover retains its owner and returns`, async ({ page }) => {
  const id = group ? 'pullback-group' : BOT;
  await expect.poll(() => page.evaluate(id => window.pullback.state.bots.some(bot => bot.id === id) || window.pullback.state.groups.some(group => group.id === id), id)).toBe(true);
  await dispatch(page, { type: 'select', id });
  await expect.poll(() => page.evaluate(() => window.pullback.state.selectedId)).toBe(id);
  const opener = page.getByRole('button', { name: 'Find in conversation', exact: true }); await expect(opener).toBeVisible();
  const release = await hold(page, 'ChatFindBar.tsx');
  try {
    await opener.click(); const name = group ? 'group-find' : 'chat-find';
    await expect.poll(() => names(page)).toEqual([name]);
    await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    const before = (await layers(page))[0].id; await palette(page); await page.keyboard.press('Escape');
    await expect.poll(() => names(page)).toEqual([name]); expect((await layers(page))[0].id).toBe(before);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]); await expect(opener).toBeFocused();
    await release(); expect(await layers(page)).toEqual([]);
  } finally { await release(); }
});

for (const kind of ['browser', 'vm'] as const) test(`R22-OWNERS: actual App ${kind} workspace cover follows its dismissal callback`, async ({ page }) => {
  await dispatch(page, { type: 'select', id: BOT });
  const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.focus();
  const release = await hold(page, kind === 'browser' ? 'BrowserWorkspace.tsx' : 'LocalVmWorkspace.tsx');
  const releaseComputer = await hold(page, 'ComputerPanel.tsx');
  try {
    await page.evaluate(kind => window.pullbackWorkspace(kind), kind);
    const name = kind === 'browser' ? 'page-browser-workspace' : 'page-local-vm-workspace';
    await expect.poll(() => names(page)).toEqual([name]);
    await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await palette(page); await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([name]);
    await page.keyboard.press('Escape');
    if (kind === 'browser') {
      await expect.poll(() => names(page)).toEqual(['computer']);
      expect(await page.evaluate(() => window.pullback.state.computerOpen)).toBe(true);
      await expect(page.locator('[data-lazy-overlay]').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
    } else await expect(page.locator('textarea[aria-label^="Message "]')).toBeFocused(); // the VM workspace closes onto the open chat: its composer takes focus (see appOwners)
    await expect.poll(() => names(page)).toEqual([]);
    await release(); await releaseComputer(); expect(await layers(page)).toEqual([]);
  } finally { await release(); await releaseComputer(); }
});

for (const name of ['phone-sheet', 'approval-sheet'] as const) test(`R22-OWNERS: actual ${name} first focus, palette handback and close policy`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByRole('button', { name: 'Open bot list', exact: true }); await opener.focus();
  await opener.evaluate(node => { node.setAttribute('data-returns', '0'); node.addEventListener('focus', () => node.setAttribute('data-returns', String(Number(node.getAttribute('data-returns')) + 1))); });
  await auxiliary(page, name); await expect.poll(() => names(page)).toEqual([name]);
  const before = (await layers(page))[0]; expect(before.focused).toBe(true);
  await paint(page, name); await palette(page); await page.keyboard.press('Escape');
  await expect.poll(() => names(page)).toEqual([name]); expect((await layers(page))[0].id).toBe(before.id); expect((await layers(page))[0].focused).toBe(true);
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
  if (name === 'phone-sheet') { await expect(opener).toBeFocused(); await expect(opener).toHaveAttribute('data-returns', '1'); }
  else { await expect(opener).not.toBeFocused(); await expect(opener).toHaveAttribute('data-returns', '0'); }
});

// Astra r3 Medium 7: the round 2b pins for Hire and the approval sheet promised a first-focus target and Tab
// staying inside at both ends; these drive the actual components with real Chromium Tab and Shift+Tab.
async function wrapsAtBothEnds(page: Page, dialog: ReturnType<Page['locator']>) {
  const count = await dialog.evaluate(node => {
    const tabbable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex^="-"])')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible' && !element.closest('[inert]'));
    tabbable.forEach((element, index) => element.setAttribute('data-r5-tab', String(index)));
    return tabbable.length;
  });
  expect(count).toBeGreaterThan(1);
  const first = dialog.locator('[data-r5-tab="0"]'), last = dialog.locator(`[data-r5-tab="${count - 1}"]`);
  await last.focus(); await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
}
test('R5-M7: actual Hire starts in the job box, Enter writes a new line, Tab wraps at both ends, Escape returns to the opener', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'App settings', exact: true }); await opener.focus();
  await auxiliary(page, 'hire'); await expect.poll(() => names(page)).toEqual(['hire-bot']);
  const job = page.locator('#hire-bot-job'); await expect(job).toBeFocused();
  await page.keyboard.type('Fixture line'); await page.keyboard.press('Enter'); await page.keyboard.type('second');
  await expect(job).toHaveValue('Fixture line\nsecond');
  await expect.poll(() => names(page)).toEqual(['hire-bot']);
  const dialog = page.locator('[data-hire-bot]');
  await wrapsAtBothEnds(page, dialog);
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
  await expect(opener).toBeFocused();
});
test('R5-M7: actual approval sheet Tab and Shift+Tab stay inside at both ends', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open bot list', exact: true }).focus();
  await auxiliary(page, 'approval-sheet'); await expect.poll(() => names(page)).toEqual(['approval-sheet']);
  await wrapsAtBothEnds(page, page.locator('[role="dialog"][aria-modal="true"]').last());
  expect((await layers(page))[0].focused).toBe(true);
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).toEqual([]);
});

for (const reverse of [false, true]) test(`R24-H1 / R24-AUDIT BF-24: Watch a file below Settings reverse=${reverse}`, async ({ page }) => {
  await dispatch(page, { type: 'showRoutines' });
  const watch = page.getByRole('button', { name: 'Watch a file', exact: true });
  await expect(watch).toBeEnabled(); await watch.focus();
  if (reverse) { await settings(page); await watch.focus(); }
  // Programmatic click exercises a lower owner's callback without focusing it.
  await watch.evaluate(node => (node as HTMLButtonElement).click());
  const picker = page.getByRole('dialog', { name: 'Watch a file', exact: true });
  await expect(picker).toBeVisible();
  if (!reverse) {
    await picker.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('c');
    expect((await names(page)).filter(name => name.startsWith('routine-') || name === 'new-routine-sheet')).toEqual(['routine-watch']);
    await settings(page);
  }
  await paint(page, 'settings');
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain('settings');
  await picker.getByRole('button', { name: 'Cancel', exact: true }).focus();
  const release = await hold(page, 'CommandPalette.tsx');
  try {
    await page.evaluate(() => window.pullback.palette());
    await expect.poll(() => names(page)).toContain('palette');
    await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain('palette');
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
    await expect(watch).toBeFocused();
  } finally { await release(); }
});

for (const higher of ['none', 'settings', 'palette']) test(`R24-HANDOFF BF-25: Quick More options under ${higher}`, async ({ page }) => {
  await dispatch(page, { type: 'showRoutines' });
  const opener = page.getByRole('button', { name: 'Watch a file', exact: true });
  await expect(opener).toBeEnabled(); await opener.focus();
  const cell = page.getByRole('gridcell').first();
  await cell.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 });
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 })));
  const quick = page.getByRole('dialog', { name: 'Quick create', exact: true });
  await expect(quick).toBeVisible();
  const release = higher === 'palette' ? await hold(page, 'CommandPalette.tsx') : null;
  try {
    if (higher === 'settings') await settings(page);
    if (higher === 'palette') {
      await page.evaluate(() => window.pullback.palette());
      await expect.poll(() => names(page)).toContain('palette');
      await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    }
    await page.evaluate(() => {
      document.documentElement.dataset.pbFocusEvents = '0';
      document.addEventListener('focusin', () => { document.documentElement.dataset.pbFocusEvents = String(Number(document.documentElement.dataset.pbFocusEvents) + 1); });
    });
    await quick.getByRole('button', { name: 'More options', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
    const editor = page.getByRole('dialog', { name: 'New routine', exact: true });
    await expect(editor).toBeVisible(); await expect(quick).toHaveCount(0);
    await expect(opener).not.toBeFocused();
    if (higher !== 'none') {
      expect(await page.evaluate(() => document.documentElement.dataset.pbFocusEvents)).toBe('0');
      await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain(higher);
    }
    await expect(editor.locator('input').first()).toBeFocused();
    await editor.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0); await expect(opener).toBeFocused();
  } finally { await release?.(); }
});

test('R24-H1 BF-26: webhook editor Settings paint, editable Escape and opener return', async ({ page }) => {
  await dispatch(page, { type: 'showRoutines' });
  await page.getByRole('button', { name: 'Webhooks', exact: true }).click();
  const opener = page.getByRole('button', { name: 'New webhook', exact: true });
  await opener.click();
  const editor = page.getByRole('dialog', { name: 'New local webhook', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.locator('button').first()).toBeFocused();
  await settings(page); await paint(page, 'settings');
  await page.keyboard.press('Escape'); await expect.poll(() => names(page)).not.toContain('settings');
  await editor.getByText('Advanced options', { exact: true }).click();
  await editor.locator('input').first().focus(); await page.keyboard.press('Escape'); await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0); await expect(opener).toBeFocused();
});
