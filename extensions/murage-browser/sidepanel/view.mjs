// SPDX-License-Identifier: AGPL-3.0-or-later
// Side panel view (T33, PNL stage 1): pure DOM building, text set as text only. Every visible string is a chrome.i18n key; only
// page-derived or bot-derived text (origins, activity lines, names, the handoff line) is set as plain text and
// marked data-user="true".
const KEYS = ['spHeaderBrand', 'spHeaderSuffix', 'spConnected', 'spNotConnected', 'spBotLine', 'spStateYourTurn', 'spStatePaused', 'spStateStopped', 'overlayWorking',
  'spModeStep', 'spModeTask', 'spModeFull', 'spModeTitle', 'spHintStep', 'spHintTask', 'spHintFull', 'spTurnOff', 'spTaskAccess', 'spAllowedForTask',
  'spRevoke', 'spRevokeAria', 'spActivityTitle', 'spActivityEmpty', 'spSitesTitle', 'spSiteAlways', 'spSiteNever', 'spSiteAsks', 'spSharedTitle', 'spNoTabs',
  'spNoSites', 'spNewTab', 'spUnshareAria', 'btnShare', 'btnUnshare', 'btnPause', 'btnStop', 'btnResume', 'btnEndTask', 'btnContinue', 'spDebugNote',
  'spUpdateWaiting', 'spOldExtension', 'spOldApp', 'spShortcutHint', 'spSetupTitle', 'spSetupBody', 'spCheckConnection', 'spProfile', 'spBodyWorking',
  'spBodyPaused', 'spBodyStopped', 'spBodyReconnect', 'spShareHint', 'spErrHostOffline', 'spErrSiteDenied', 'spErrHumanHandover', 'spErrBindingInactive',
  'spErrTabOwned', 'spErrUnknownBinding', 'spErrBindingStopped', 'spErrGeneric', 'spSwitchTitle', 'spBodyYourTurn',
  'spPending', 'spPhaseStarting', 'spPhaseConnecting', 'spPhaseReading', 'spPhaseWaiting', 'btnNewTask', 'spRecoveryReshare', 'spErrHandoffUseContinue', 'spErrNotHandoff',
  'spErrIncognitoDenied', 'spErrPersistenceFailed', 'spErrUpdateRequired', 'spErrStorageUnavailable'];
export const panelKeys = () => [...KEYS];
import { patchChildren } from './patch.mjs';
import { URGENT } from './controller.mjs';
// Handoff reads from the paused state (the server reports pausedReason 'handoff'). The older shape, an active binding with
// a handoff line, still renders the same way.
export const isHandoff = b => (b.state === 'paused' && b.pausedReason === 'handoff') || (b.state === 'active' && typeof b.handoff === 'string');
// Bot identity colours: Murage's EMBER_COLORS (src/lib/mascot.ts) minus the product orange, red and coral, which read as
// the accent or as danger. The protocol carries no bot colour yet (NOTES.md, request for T44), so a binding's optional
// `botColor` wins when it is a plain #rrggbb, else the colour comes from a stable hash of the bot name.
const BOT_COLORS = ['#009957', '#377FE6', '#8057C8', '#0EA5C6', '#D84F8B', '#D8A729', '#01A492'];
const lum = h => { const n = parseInt(h.slice(1), 16); const l = c => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(n >> 16) + 0.7152 * l((n >> 8) & 255) + 0.0722 * l(n & 255); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function botColor(name, given) {
  let bg = typeof given === 'string' && /^#[0-9a-fA-F]{6}$/.test(given) ? given : undefined;
  if (!bg) { let h = 0; for (const ch of String(name ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0; bg = BOT_COLORS[h % BOT_COLORS.length]; }
  const ink = ratio(bg, '#0a0a0a') >= ratio(bg, '#ffffff') ? '#0a0a0a' : '#ffffff';
  return { bg, ink };
}
const MARK_PATHS = ['M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001', 'M17 21h.01', 'M7 3h.01', 'M7.997 8.891a11.885 7.288-60.756 0111.977 8.107'];
const MODE_RANK = { step: 0, task: 1, full: 2 };
const MODE = { step: ['spModeStep', 'spHintStep'], task: ['spModeTask', 'spHintTask'], full: ['spModeFull', 'spHintFull'] };
// What the bot is doing, only as the runtime reports it. Anything else is not shown: the panel never guesses a phase and never shows a percentage.
const PHASE = { starting: 'spPhaseStarting', connecting: 'spPhaseConnecting', reading: 'spPhaseReading', waiting: 'spPhaseWaiting' };
const SITE = { always: 'spSiteAlways', never: 'spSiteNever', asks: 'spSiteAsks' };

export function renderPanel(doc, root, view, io) {
  const t = (key, subs) => { if (!KEYS.includes(key)) throw Error(`unknown panel key ${key}`); return io.t(key, subs); };
  const can = action => !view.supports || view.supports.includes(action);
  const el = (tag, role, text, attrs = {}) => {
    const n = doc.createElement(tag); if (role) n.setAttribute('data-role', role);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text; return n;
  };
  const user = (tag, role, text, attrs) => el(tag, role, text, { ...attrs, 'data-user': 'true' });
  // While an owner action is pending every action button is off, so one press cannot become two.
  const busy = Boolean(view.pending);
  const button = (role, label, onclick, cls = '', aria) => { const b = el('button', role, label, aria ? { 'aria-label': aria } : {}); b.className = cls; b.setAttribute('type', 'button'); b.onclick = onclick; if (busy && !URGENT.includes(role)) b.disabled = true; return b; };
  const send = (action, extra = {}) => () => io.act(action, extra);
  const out = [];

  const header = el('header');
  const NS = 'http://www.w3.org/2000/svg';
  const mark = doc.createElementNS(NS, 'svg'); mark.setAttribute('data-role', 'mark'); mark.setAttribute('viewBox', '0 0 1024 1024'); mark.setAttribute('width', '26'); mark.setAttribute('height', '26'); mark.setAttribute('aria-hidden', 'true');
  const g = doc.createElementNS(NS, 'g'); for (const [k, v] of Object.entries({ transform: 'translate(71.68 71.68) scale(36.69)', fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) g.setAttribute(k, v);
  for (const d of MARK_PATHS) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); g.append(p); }
  const dot = doc.createElementNS(NS, 'circle'); for (const [k, v] of Object.entries({ cx: '12', cy: '12', r: '1', fill: 'var(--accent)', stroke: 'none' })) dot.setAttribute(k, v); g.append(dot); mark.append(g);
  const titleEl = el('span', 'title'); titleEl.append(el('span', 'brand', t('spHeaderBrand')), el('span', 'brand-suffix', t('spHeaderSuffix')));
  const conn = el('span', 'connection', undefined, { role: 'status' });
  if (view.connected) conn.append(el('span', 'connection-dot', undefined, { 'aria-hidden': 'true' }));
  conn.append(view.connected ? t('spConnected') : t('spNotConnected'));
  header.append(mark, titleEl, conn);
  out.push(header);
  if (view.feedback) { const f = el('p', 'feedback', t(view.feedback), { role: 'alert' }); out.push(f); }
  if (view.recovery) { const r = el('p', 'recovery-note', t(view.recovery), { role: 'status' }); r.className = 'hint'; out.push(r); }

  const b = view.connected ? view.bindings.find(x => x.bindingId === view.selected) ?? view.bindings[0] : undefined;
  if (!view.connected || !b) {
    const s = el('section', 'setup'); s.className = 'card';
    s.append(el('h2', 'setup-title', t('spSetupTitle')), el('p', undefined, t('spSetupBody')), button('reconnect', t('spCheckConnection'), send('reconnect')));
    out.push(s);
  } else {
    const main = el('main');
    const bot = el('div', 'bot'); bot.className = 'card bot';
    const bc = botColor(b.botName, b.botColor); const av = user('span', 'avatar', [...b.botName][0] ?? '', { 'aria-hidden': 'true', style: `--bot:${bc.bg};--bot-ink:${bc.ink};` }); av.className = 'av';
    const names = el('div'); names.append(user('div', 'botname', b.botName));
    if (b.conversation !== undefined) names.append(el('div', 'botline', t('spBotLine', [b.botName, b.conversation])));
    bot.append(av, names); main.append(bot);
    // Bot switcher: only when more than one bot is running. The panel follows the bot that owns the current tab; this lets the
    // owner look at another one.
    const running = view.bindings.filter(x => x.state !== 'stopped');
    if (running.length > 1 && io.select) {
      const sw = el('div', 'switcher', undefined, { role: 'radiogroup', 'aria-label': t('spSwitchTitle') }); sw.className = 'seg';
      for (const x of running) {
        const on = x.bindingId === b.bindingId; const o = user('button', 'switch-option', x.botName, { role: 'radio', 'aria-checked': String(on), type: 'button', 'data-key': x.bindingId });
        o.className = on ? 'on' : ''; o.onclick = () => io.select(x.bindingId); sw.append(o);
      }
      main.append(sw);
    }

    // State card
    const handoff = isHandoff(b);
    const full = b.mode === 'full';
    const card = el('section', 'state', undefined, { 'aria-live': 'polite' }); card.className = `card state ${handoff ? 'wait' : b.state}`;
    if (b.state !== 'stopped') for (const pos of ['tl', 'tr', 'bl', 'br']) card.append(el('span', 'bracket', undefined, { 'data-pos': pos, 'aria-hidden': 'true' }));
    if (full) card.append(el('div', 'hazard', undefined, { 'aria-hidden': 'true' }));
    const title = el('div', 'state-title-row'); title.className = 't';
    const tt = el('span', 'state-title', handoff ? t('spStateYourTurn') : b.state === 'paused' ? t('spStatePaused') : b.state === 'stopped' ? t('spStateStopped') : t('overlayWorking', [b.botName]));
    title.append(tt); if (full) { const chip = el('span', 'full-chip', t('spModeFull')); chip.className = 'tag'; title.append(chip); }
    const body = handoff ? (typeof b.handoff === 'string' && b.handoff ? user('p', 'state-body', b.handoff) : el('p', 'state-body', t('spBodyYourTurn'))) : el('p', 'state-body', b.state === 'paused' ? t('spBodyPaused') : b.state === 'stopped' ? t('spBodyStopped') : b.ready ? t('spBodyWorking') : t('spBodyReconnect'));
    body.className = 'p';
    const btns = el('div'); btns.className = 'btns';
    if (handoff) { if (b.canContinue && can('continue')) btns.append(button('continue', t('btnContinue'), send('continue'), 'go')); btns.append(can('endtask') ? button('endtask', t('btnEndTask'), send('endtask')) : button('stop', t('btnStop'), send('stop'), 'stop')); }
    else if (b.state === 'active') btns.append(button('pause', t('btnPause'), send('pause')), button('stop', t('btnStop'), send('stop'), 'stop'));
    else if (b.state === 'paused') btns.append(button('resume', t('btnResume'), send('resume')), button('stop', t('btnStop'), send('stop'), 'stop'));
    else { if (can('newtask')) btns.append(button('newtask', t('btnNewTask'), send('newtask'), 'go')); if (can('endtask')) btns.append(button('endtask', t('btnEndTask'), send('endtask'))); }
    // The phase line: only when the runtime reports one (or the bot is running but not connected yet), and only while it is working.
    const phaseKey = !handoff && b.state === 'active' ? PHASE[b.phase] ?? (b.ready === false ? PHASE.connecting : undefined) : undefined;
    const phase = phaseKey ? el('p', 'phase', t(phaseKey)) : undefined; if (phase) phase.className = 'hint';
    const pend = busy ? el('p', 'pending', t('spPending')) : undefined; if (pend) pend.className = 'hint';
    card.append(title, ...(phase ? [phase] : []), body, ...(pend ? [pend] : []), btns); main.append(card);

    // Approval mode: a 3-way segmented control. Read-only until the runtime lists setMode; never fakes the action.
    if (MODE[b.mode]) {
      const sec = el('div'); sec.append(el('h2', 'mode-title', t('spModeTitle')));
      const seg = el('div', 'mode', undefined, { role: 'radiogroup', 'aria-label': t('spModeTitle') }); seg.className = 'seg';
      const live = can('setMode');
      for (const m of ['step', 'task', 'full']) {
        const on = m === b.mode; const o = el('button', 'mode-option', undefined, { role: 'radio', 'aria-checked': String(on), type: 'button' });
        o.className = `${on ? 'on' : ''}${on && m === 'full' ? ' full' : ''}`;
        const label = el('span', on ? 'mode-selected' : undefined, t(MODE[m][0])); o.append(label);
        // Full permissive is turned on in the desktop app only, with the bot's name typed (spec 5, F8): never from here.
        // The panel can only tighten the mode (spec 5, coordinator ruling): an option looser than the current one stays off.
        const looser = MODE_RANK[m] > MODE_RANK[b.mode];
        if (live && !busy && m !== 'full' && !looser) o.onclick = send('setMode', { mode: m }); else { o.disabled = true; o.setAttribute('aria-disabled', 'true'); }
        seg.append(o);
      }
      sec.append(seg, el('p', 'mode-hint', t(MODE[b.mode][1], [b.botName]))); sec.lastChild.className = 'hint';
      if (full && can('turnoff')) { const row = el('div'); row.className = 'btns'; row.append(button('turnoff', t('spTurnOff'), send('turnoff'), 'sm')); sec.append(row); }
      main.append(sec);
    }

    // Current task grants
    const task = el('div'); const h = el('h2', 'task-title', t('spTaskAccess')); task.append(h);
    if (b.grants?.length) {
      task.append(el('p', 'allowed', t('spAllowedForTask'))); task.lastChild.className = 'hint';
      const ul = el('ul'); ul.className = 'card list';
      for (const g of b.grants) {
        const li = el('li', 'grant', undefined, { 'data-key': g.origin }); const o = el('span'); o.className = 'o'; o.append(user('span', 'grant-origin', g.origin)); if (g.label) o.append(user('span', 'grant-label', g.label));
        li.append(o); if (can('revoke')) li.append(button('revoke', t('spRevoke'), send('revoke', { origin: g.origin }), 'sm', t('spRevokeAria', [g.origin]))); ul.append(li);
      }
      task.append(ul);
    }
    main.append(task);

    // Sharing
    const share = el('div'); share.append(el('h2', 'shared-title', t('spSharedTitle')));
    if (b.tabs.length) {
      const ul = el('ul'); ul.className = 'card list';
      for (const tab of b.tabs) {
        const li = el('li', 'tab', undefined, { 'data-key': String(tab.tabId) }); const label = tab.origin === 'null' ? el('span', 'tab-origin', t('spNewTab')) : user('span', 'tab-origin', tab.origin);
        const shown = tab.origin === 'null' ? t('spNewTab') : tab.origin;
        li.append(label, button('unshare', t('btnUnshare'), send('unshare', { tabId: tab.tabId }), 'sm', t('spUnshareAria', [shown]))); ul.append(li);
      }
      share.append(ul);
    } else share.append(el('p', 'no-tabs', t('spNoTabs')));
    const sh = button('share', t('btnShare'), () => io.share?.(), ''); sh.disabled = busy || b.state !== 'active' || !view.connected;
    share.append(sh, el('p', 'share-hint', t('spShareHint'))); share.lastChild.className = 'hint'; main.append(share);

    // Activity
    const act = el('div'); act.append(el('h2', 'activity-title', t('spActivityTitle', [b.botName])));
    if (b.activity?.length) {
      const ul = el('ul'); ul.className = 'card list act';
      for (const [i, a] of b.activity.entries()) { const li = el('li', 'activity-item', undefined, { 'data-key': String(i) }); li.append(user('time', undefined, a.time ?? ''), user('span', undefined, a.text)); ul.append(li); }
      act.append(ul);
    } else act.append(el('p', 'activity-empty', t('spActivityEmpty')));
    main.append(act);

    // Sites
    if (b.sites?.length) {
      const sites = el('div'); sites.append(el('h2', 'sites-title', t('spSitesTitle', [b.botName]))); const ul = el('ul'); ul.className = 'card list';
      for (const s of b.sites) {
        const li = el('li', 'site', undefined, { 'data-key': s.origin }); const o = el('span'); o.className = 'o'; o.append(user('span', 'site-origin', s.origin), el('span', 'site-cat', t(SITE[s.category] ?? 'spSiteAsks')));
        li.append(o); if (s.category === 'always' && can('revoke-site')) li.append(button('site-revoke', t('spRevoke'), send('revoke-site', { origin: s.origin }), 'sm', t('spRevokeAria', [s.origin]))); ul.append(li);
      }
      sites.append(ul); main.append(sites);
    }

    // Notes
    main.append(el('p', 'debug-note', t('spDebugNote', [b.botName])));
    if (b.updateWaiting) main.append(el('p', 'update-note', t('spUpdateWaiting', [b.botName])));
    if (b.versionNote) main.append(el('p', 'version-note', t(b.versionNote === 'oldApp' ? 'spOldApp' : 'spOldExtension')));
    if (view.shortcut) main.append(el('p', 'shortcut', t('spShortcutHint', [view.shortcut])));
    for (const n of main.children) { const r = n.getAttribute('data-role'); if (r?.endsWith('-note') || r === 'shortcut') n.className = 'hint'; }
    out.push(main);
  }
  if (view.contractAhead) out.push(el('p', 'contract-note', t('spOldExtension'), { class: 'hint' }));
  const foot = el('footer', 'profile', t('spProfile', [view.profileId ?? '']));
  out.push(foot);
  patchChildren(root, out);
}
