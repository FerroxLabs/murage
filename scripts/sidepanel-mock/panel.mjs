// SPDX-License-Identifier: AGPL-3.0-or-later
// Side panel mock in Murage's own look (src/styles.css tokens, Inter, 8px controls, 12px cards, hairlines).
// Builds a full HTML document for one variant, state and theme. T30A design variants only; nothing ships.
import { cssVars, BOT } from './tokens.mjs';
import { COPY } from './copy.mjs';

const MARK = '<svg width="26" height="26" viewBox="0 0 1024 1024" aria-hidden="true"><g transform="translate(71.68 71.68) scale(36.69)" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001"/><path d="M17 21h.01"/><path d="M7 3h.01"/><path d="M7.997 8.891a11.885 7.288-60.756 0111.977 8.107"/><circle cx="12" cy="12" r="1" fill="var(--accent)" stroke="none"/></g></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
@font-face{font-family:Inter;src:url(/font.ttf) format("truetype");font-weight:100 900}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--app);color:var(--ink);font:14px/1.5 Inter,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;gap:10px;height:56px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--hairline)}
header .w{font-size:15px;font-weight:700;letter-spacing:-.01em}
header .f{color:var(--ink-secondary);font-size:13px}
header .conn{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--ink-secondary);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block}
main{padding:16px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border:1px solid var(--hairline);border-radius:12px}
.bot{display:flex;align-items:center;gap:12px;padding:12px}
.av{width:36px;height:36px;border-radius:50%;background:var(--bot);color:var(--bot-ink);display:grid;place-items:center;font-weight:700;font-size:17px;flex:none}
.bot .n{font-weight:650;font-size:15px;line-height:1.2}
.bot .s{color:var(--ink-secondary);font-size:12px}
h2{font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-secondary);margin:0 0 8px}
.btn{font:inherit;font-weight:600;min-height:40px;padding:0 14px;border-radius:8px;border:1px solid var(--hairline);background:var(--control);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;gap:6px}
.btn.stop{background:var(--danger);color:var(--danger-ink);border-color:var(--danger)}
.btn.go{background:var(--accent);color:var(--accent-ink);border-color:var(--accent-border)}
.btn.sm{min-height:32px;padding:0 10px;font-size:13px}
.btns{display:flex;gap:8px;margin-top:14px}.btns .btn{flex:1}
.state{position:relative;padding:16px}
.state .t{font-size:18px;font-weight:650;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.state .p{color:var(--ink-secondary);margin:6px 0 0}
.state .site{display:inline-block;margin-top:10px;font-size:12px;padding:3px 8px;border-radius:6px;background:var(--inset);border:1px solid var(--hairline)}
.state .offer{margin-top:14px;padding-top:12px;border-top:1px solid var(--hairline)}
.state .offer .q{font-weight:600}
.tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:var(--warning);color:var(--warning-ink);font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;background:var(--inset);border:1px solid var(--hairline);border-radius:8px}
.seg span{min-height:44px;display:grid;place-items:center;text-align:center;font-size:12px;font-weight:600;line-height:1.25;padding:4px 6px;border-radius:6px;color:var(--ink-secondary)}
.seg span.on{background:var(--raised);color:var(--ink);border:1px solid var(--hairline)}
.seg span.on.full{border-color:var(--warning)}
.hint{color:var(--ink-secondary);font-size:13px;margin:8px 0 0}
ul{list-style:none;margin:0;padding:0}
.grants li{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--hairline)}
.grants li:last-child{border:0}
.grants .o{flex:1;min-width:0;overflow-wrap:anywhere}.grants .o b{display:block;font-weight:600}.grants .o small{color:var(--ink-secondary);font-size:12px}
.grants .none{padding:12px;color:var(--ink-secondary)}
.act li{display:flex;gap:12px;padding:8px 12px;border-bottom:1px solid var(--hairline);font-size:13px}
.act li:last-child{border:0}.act time{color:var(--ink-secondary);font-variant-numeric:tabular-nums;flex:none}
footer{color:var(--ink-secondary);font-size:12px;border-top:1px solid var(--hairline);padding:14px 16px 18px}
.pulse{width:10px;height:10px;border-radius:50%;background:var(--accent);animation:pl 1.6s steps(2,jump-none) infinite}
@keyframes pl{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
/* variant motifs, same shapes as the on-page cue */
.mA::before,.mA::after,.mA i::before,.mA i::after{content:"";position:absolute;width:18px;height:18px;border:0 solid var(--accent-c)}
.mA i{position:absolute;inset:0;pointer-events:none}
.mA::before{left:-1px;top:-1px;border-width:4px 0 0 4px;border-top-left-radius:12px}
.mA::after{right:-1px;top:-1px;border-width:4px 4px 0 0;border-top-right-radius:12px}
.mA i::before{left:-1px;bottom:-1px;border-width:0 0 4px 4px;border-bottom-left-radius:12px}
.mA i::after{right:-1px;bottom:-1px;border-width:0 4px 4px 0;border-bottom-right-radius:12px}
.mB{padding:0!important;overflow:hidden}
.mB .strip{display:flex;align-items:center;gap:8px;height:34px;padding:0 16px;font-weight:650;font-size:13px;background:var(--accent);color:var(--accent-ink);border-bottom:2px solid var(--k)}
.mB .strip.waiting{background:var(--ink);color:var(--app)}.mB .strip.done{background:var(--success);color:var(--success-ink)}
.mB .strip.idle{background:var(--inset);color:var(--ink-secondary);border-bottom:1px solid var(--hairline)}
.mB .strip.full{background:var(--accent)}
.mB .haz{height:6px;background:repeating-linear-gradient(135deg,var(--warning) 0 9px,#0a0a0a 9px 18px)}
.mB .body{padding:16px}
.mC.dashed{border:2px dashed var(--accent)}
.mC.dashed.full{border-color:var(--warning)}
.mC.wait{border:2px solid var(--accent)}
`;

const kv = (state) => ({ working: 'working', full: 'working', waiting: 'waiting', done: 'done', idle: 'idle' })[state];

function stateCard(variant, state) {
  const title = { idle: COPY.idle, working: COPY.working, full: COPY.working, waiting: COPY.yourTurn, done: COPY.done }[state];
  const body = { idle: COPY.idleBody, working: COPY.step, full: COPY.step, waiting: COPY.yourTurnBody, done: COPY.doneBody }[state];
  const icon = state === 'working' || state === 'full' ? '<span class="pulse"></span>' : state === 'done' ? `<span style="color:var(--success);display:inline-flex">${CHECK}</span>` : '';
  const site = state === 'idle' ? '' : '<span class="site">shop.example.com</span>';
  const buttons = {
    idle: '',
    working: `<div class="btns"><button class="btn">${PAUSE}${COPY.pause}</button><button class="btn stop">${STOP}${COPY.stop}</button></div>`,
    full: `<div class="btns"><button class="btn">${PAUSE}${COPY.pause}</button><button class="btn stop">${STOP}${COPY.stop}</button></div>`,
    waiting: `<div class="btns"><button class="btn go">${COPY.continue}</button><button class="btn">${COPY.stopTask}</button></div>`,
    done: `<div class="offer"><div class="q">${COPY.allowAlways}</div><div class="btns" style="margin-top:10px"><button class="btn">${COPY.allowAlwaysYes}</button><button class="btn">${COPY.notNow}</button></div></div><div class="btns"><button class="btn">${COPY.dismiss}</button></div>`,
  }[state];
  const fullTag = state === 'full' ? `<span class="tag">${COPY.full}</span>` : '';
  const inner = `<div class="t">${icon}${title}${fullTag}</div><p class="p">${body}</p>${site}${buttons}`;
  const k = kv(state);
  if (variant === 'frame') {
    const c = state === 'done' ? 'var(--success)' : state === 'idle' ? 'var(--hairline)' : 'var(--accent)';
    return `<section class="card state mA" style="--accent-c:${c}" aria-live="polite"><i></i>${inner}</section>`;
  }
  if (variant === 'rail') {
    const label = { idle: 'Ready', working: 'Working', full: 'Working', waiting: 'Your turn', done: 'Done' }[state];
    return `<section class="card state mB" aria-live="polite"><div class="strip ${k}${state === 'full' ? ' full' : ''}">${label}</div>${state === 'full' ? '<div class="haz"></div>' : ''}<div class="body">${inner}</div></section>`;
  }
  const cls = state === 'working' ? 'dashed' : state === 'full' ? 'dashed full' : state === 'waiting' ? 'wait' : '';
  return `<section class="card state mC ${cls}" aria-live="polite">${inner}</section>`;
}

function grants(state) {
  if (state === 'idle') return `<div class="card grants"><div class="none">${COPY.noAccess}</div></div>`;
  if (state === 'done') return `<div class="card grants"><div class="none">${COPY.accessEnded}</div></div>`;
  const rows = state === 'waiting' ? [['shop.example.com', COPY.levelRead]] : [['shop.example.com', COPY.levelRead], ['calendar.example.org', COPY.levelFill]];
  return `<div class="card grants"><ul>${rows.map(([o, l]) => `<li><div class="o"><b>${o}</b><small>${l}</small></div><button class="btn sm">${COPY.revoke}</button></li>`).join('')}</ul></div>`;
}

export function panelHtml({ variant, state, theme }) {
  const mode = state === 'full' ? 2 : 1;
  const items = COPY.activityItems[kv(state)];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Murage for Chrome side panel</title><style>:root{color-scheme:${theme};${cssVars(theme)}}${CSS}</style></head><body>
<header>${MARK}<span class="w">${COPY.title}</span><span class="f">${COPY.titleSuffix}</span><span class="conn"><span class="dot"></span>${COPY.connected}</span></header>
<main>
<div class="card bot"><span class="av">${BOT.initial}</span><div><div class="n">${BOT.name}</div><div class="s">${COPY.connectedLine}</div></div></div>
${stateCard(variant, state)}
<div><h2>${COPY.approvalMode}</h2><div class="seg" role="radiogroup" aria-label="${COPY.approvalMode}">${COPY.modes.map((m, i) => `<span role="radio" aria-checked="${i === mode}" class="${i === mode ? 'on' : ''}${i === mode && i === 2 ? ' full' : ''}">${m}</span>`).join('')}</div><p class="hint">${COPY.modeHints[mode]}</p></div>
<div><h2>${COPY.taskAccess}</h2>${grants(state)}</div>
<div><h2>${COPY.activity}</h2><div class="card act"><ul>${items.map(([t, s]) => `<li><time>${t}</time><span>${s}</span></li>`).join('')}</ul></div></div>
</main><footer>${COPY.profile}</footer></body></html>`;
}
