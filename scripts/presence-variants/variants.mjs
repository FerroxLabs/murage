// SPDX-License-Identifier: AGPL-3.0-or-later
// Three Murage-styled on-page presence variants for Sean to choose from (T30A). Each builder returns the
// markup for one shadow root: edge cue, bot pointer with name chip, control pill, and the five states.
// Hard-edged shapes only: no glow, no blur, no soft orange edge. Mocks, not the shipped overlay.
import { cssVars, BOT } from '../sidepanel-mock/tokens.mjs';
import { COPY } from '../sidepanel-mock/copy.mjs';

export const VARIANTS = ['frame', 'rail', 'badge'];
export const VARIANT_TITLES = { frame: 'A Frame', rail: 'B Rail', badge: 'C Badge' };
export const STATES = ['idle', 'working', 'waiting', 'done', 'full'];

const I = {
  pause: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  turn: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>',
};
export const ICONS = I;

const BASE_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{position:fixed;inset:0;pointer-events:none;font:13px/1.35 Inter,-apple-system,"Segoe UI",system-ui,sans-serif;color:var(--ink)}
.av{width:18px;height:18px;border-radius:50%;background:var(--bot);color:var(--bot-ink);display:inline-grid;place-items:center;font-size:11px;font-weight:700;flex:none}
.av.lg{width:30px;height:30px;font-size:15px}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 3px;border-radius:12px;background:var(--panel);border:1px solid var(--hairline);outline:1px solid rgba(10,10,10,.55);color:var(--ink);font-weight:600;font-size:12px;white-space:nowrap}
.btn{font:inherit;font-weight:600;height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--hairline);background:var(--control);color:var(--ink);display:inline-flex;align-items:center;gap:6px;pointer-events:auto;cursor:pointer}
.btn.stop{background:var(--danger);color:var(--danger-ink);border-color:var(--danger)}
.btn.go{background:var(--accent);color:var(--accent-ink);border-color:var(--accent-border)}
.btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:var(--warning);color:var(--warning-ink);font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.ptr{position:fixed;left:0;top:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.trail{display:none!important}}
@media (forced-colors:active){
  .chip,.pill,.badge,.btn{border:2px solid CanvasText;background:Canvas;color:CanvasText;outline:none}
  .btn.go,.btn.stop{background:ButtonFace;color:ButtonText}
  .fa{border-color:Highlight!important;box-shadow:none!important}
  .rail{background:Highlight!important;color:HighlightText!important;border-bottom:3px solid CanvasText!important}
  .rail .btn{border-color:HighlightText;color:HighlightText;background:transparent}
  .tag{background:Mark;color:MarkText;border:2px solid CanvasText}
  .dash{stroke:Highlight!important}.dash.k{stroke:CanvasText!important}
}`;

const arrow = (fill) => `<svg width="26" height="28" viewBox="0 0 26 28" aria-hidden="true"><path d="M3 3 L3 21 L8 16.5 L11.5 24.5 L15 23 L11.5 15 L18 15 Z" fill="${fill}" stroke="#0a0a0a" stroke-width="4.5" stroke-linejoin="round"/><path d="M3 3 L3 21 L8 16.5 L11.5 24.5 L15 23 L11.5 15 L18 15 Z" fill="${fill}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
const chip = () => `<span class="chip"><span class="av">${BOT.initial}</span>${BOT.name}</span>`;

// ---------------------------------------------------------------- A Frame
function frame(state, t) {
  const brackets = (color) => ['top:0;left:0', 'top:0;right:0;transform:scaleX(-1)', 'bottom:0;left:0;transform:scaleY(-1)', 'bottom:0;right:0;transform:scale(-1)']
    .map((pos) => `<svg class="br" style="position:fixed;${pos}" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true"><path d="M4 44V4H44" fill="none" stroke="#0a0a0a" stroke-width="9" stroke-linecap="square"/><path d="M4 44V4H44" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="square"/></svg>`).join('');
  const css = `
  .fa{position:fixed;inset:6px;border:2px solid var(--accent);box-shadow:0 0 0 1px var(--k),inset 0 0 0 1px var(--k);animation:fa 2.4s steps(2,jump-none) infinite}
  .fa.full{border-color:var(--warning)}
  @keyframes fa{50%{opacity:.5}}
  .pill{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;min-height:52px;padding:7px 8px 7px 12px;background:var(--panel);border:1px solid var(--hairline);outline:1px solid rgba(10,10,10,.55);border-radius:12px;pointer-events:auto;white-space:nowrap;font-weight:600}
  .pill .sep{width:1px;height:22px;background:var(--hairline)}
  .pill .ok{color:var(--success);display:inline-flex}`;
  const accent = state === 'done' ? t.success : t.accent;
  let cue = '';
  if (state === 'working') cue = `<div class="fa"></div>${brackets(accent)}`;
  if (state === 'full') cue = `<div class="fa full"></div>${brackets(accent)}`;
  if (state === 'waiting') cue = brackets(accent);
  if (state === 'done') cue = brackets(accent);
  let pill = '';
  if (state === 'working' || state === 'full') pill = `<div class="pill" role="region" aria-label="Murage"><span class="av">${BOT.initial}</span><span>${COPY.working}</span>${state === 'full' ? `<span class="tag">${COPY.full}</span>` : ''}<span class="sep"></span><button class="btn">${I.pause}${COPY.pause}</button><button class="btn stop">${I.stop}${COPY.stop}</button></div>`;
  if (state === 'waiting') pill = `<div class="pill" role="status"><span class="av">${BOT.initial}</span><span>${COPY.yourTurnPill}</span><span class="sep"></span><button class="btn go">${COPY.continue}</button><button class="btn">${COPY.stopTask}</button></div>`;
  if (state === 'done') pill = `<div class="pill" role="status"><span class="ok">${I.check}</span><span>${COPY.done}</span><span class="sep"></span><button class="btn">${COPY.dismiss}</button></div>`;
  const pointer = (p) => state === 'working' || state === 'full' || state === 'waiting'
    ? `<div class="ptr" style="transform:translate(${p.x}px,${p.y}px);${state === 'waiting' ? 'opacity:.7' : ''}">${arrow(BOT.color)}<span style="position:absolute;left:20px;top:22px">${chip()}</span></div>` : '';
  return { css, cue, pill, pointer };
}

// ---------------------------------------------------------------- B Rail
function rail(state, t) {
  const css = `
  .rail{position:fixed;left:0;right:0;top:0;height:46px;display:flex;align-items:center;gap:12px;padding:0 12px;background:var(--accent);color:var(--accent-ink);border-bottom:2px solid var(--k);pointer-events:auto;font-weight:650;white-space:nowrap}
  .rail .av{box-shadow:0 0 0 2px var(--accent-ink)}
  .rail .sub{font-weight:500;opacity:.9}
  .rail .grow{flex:1}
  .rail .btn{height:32px;background:transparent;color:inherit;border:1.5px solid currentColor}
  .rail .btn.stop{background:#0a0a0a;color:#f5f5f5;border-color:#0a0a0a}
  .rail .btn.stop svg{color:#f87171}
  .rail .btn.go{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  .rail.waiting{background:var(--ink);color:var(--app)}
  .rail.waiting .btn.stop{background:transparent;color:var(--app);border-color:var(--app)}
  .rail.waiting .btn.stop svg{color:var(--app)}
  .rail.done{background:var(--success);color:var(--success-ink)}
  .sweep{position:fixed;top:48px;left:0;height:3px;width:28%;background:var(--accent);box-shadow:0 0 0 1px var(--k);animation:sw 1.8s linear infinite}
  @keyframes sw{from{transform:translateX(-100%)}to{transform:translateX(360%)}}
  .haz{position:fixed;top:48px;left:0;right:0;height:7px;background:repeating-linear-gradient(135deg,var(--warning) 0 9px,#0a0a0a 9px 18px)}
  .rdot{position:fixed;left:0;top:0}
  .rdot i{position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid #0a0a0a;box-shadow:0 0 0 2px #fff}
  .rdot b{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid var(--accent);outline:1px solid #0a0a0a;animation:rp 1.6s ease-out infinite}
  @keyframes rp{from{transform:scale(.5);opacity:1}to{transform:scale(1.2);opacity:0}}`;
  let cue = '';
  if (state === 'working') cue = `<div class="rail" role="region" aria-label="Murage"><span class="av">${BOT.initial}</span><span>${COPY.workingOnPage}</span><span class="sub">${COPY.step}</span><span class="grow"></span><button class="btn">${I.pause}${COPY.pause}</button><button class="btn stop">${I.stop}${COPY.stop}</button></div><div class="sweep"></div>`;
  if (state === 'full') cue = `<div class="rail" role="region" aria-label="Murage"><span class="av">${BOT.initial}</span><span>${COPY.workingOnPage}</span><span class="tag">${COPY.full}</span><span class="grow"></span><button class="btn">${I.pause}${COPY.pause}</button><button class="btn stop">${I.stop}${COPY.stop}</button></div><div class="haz"></div>`;
  if (state === 'waiting') cue = `<div class="rail waiting" role="status"><span class="av">${BOT.initial}</span><span>${COPY.yourTurn}</span><span class="sub">Dax is waiting for you on this page</span><span class="grow"></span><button class="btn go">${COPY.continue}</button><button class="btn stop">${COPY.stopTask}</button></div>`;
  if (state === 'done') cue = `<div class="rail done" role="status"><span>${I.check}</span><span>${COPY.done}</span><span class="sub">${COPY.doneBody}</span><span class="grow"></span><button class="btn">${COPY.dismiss}</button></div>`;
  const pointer = (p) => state === 'working' || state === 'full'
    ? `<div class="rdot" style="transform:translate(${p.x}px,${p.y}px)"><b></b><i></i><span style="position:absolute;left:14px;top:12px">${chip()}</span></div>`
    : state === 'waiting' ? `<div class="rdot" style="transform:translate(${p.x}px,${p.y}px);opacity:.7"><i></i><span style="position:absolute;left:14px;top:12px">${chip()}</span></div>` : '';
  return { css, cue, pill: '', pointer };
}

// ---------------------------------------------------------------- C Badge
function badge(state, t) {
  const css = `
  .dashsvg{position:fixed;inset:0;width:100%;height:100%}
  .dash{x:5px;y:5px;width:calc(100% - 10px);height:calc(100% - 10px);fill:none;stroke:var(--accent);stroke-width:3px;stroke-dasharray:12 10;animation:march 1s linear infinite}
  .dash.k{stroke:#0a0a0a;stroke-width:6px}
  .dash.full{stroke:var(--warning)}
  @keyframes march{to{stroke-dashoffset:-22}}
  .badge{position:fixed;right:20px;bottom:20px;width:316px;background:var(--panel);border:1px solid var(--hairline);outline:1px solid rgba(10,10,10,.55);border-radius:12px;pointer-events:auto;overflow:hidden}
  .badge .row{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px}
  .badge .txt{flex:1;min-width:0}
  .badge .h{font-weight:650;font-size:14px}
  .badge .s{color:var(--ink-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge .ibtn{width:40px;height:40px;padding:0;justify-content:center}
  .badge .acts{display:flex;gap:8px;padding:0 12px 12px}
  .badge .acts .btn{flex:1;justify-content:center}
  .badge .band{padding:5px 12px;background:var(--warning);color:var(--warning-ink);font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
  .badge.wait{border:2px solid var(--accent)}
  .badge .ok{color:var(--success);display:inline-flex}
  .cp{position:fixed;left:0;top:0}
  .cp .tr{position:absolute;border-radius:50%;background:var(--bot);outline:1px solid #0a0a0a}
  .cp .main{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;background:var(--bot);color:var(--bot-ink);display:grid;place-items:center;font-weight:700;font-size:15px;box-shadow:0 0 0 2px #fff,0 0 0 3px #0a0a0a}
  .cp .nm{position:absolute;left:22px;top:6px}`;
  let cue = '';
  if (state === 'working' || state === 'full') cue = `<svg class="dashsvg" aria-hidden="true"><rect class="dash k"/><rect class="dash${state === 'full' ? ' full' : ''}"/></svg>`;
  let pill = '';
  const head = (who, sub, right) => `<div class="row"><span class="av lg">${BOT.initial}</span><div class="txt"><div class="h">${who}</div><div class="s">${sub}</div></div>${right}</div>`;
  if (state === 'working' || state === 'full') pill = `<div class="badge" role="region" aria-label="Murage">${state === 'full' ? `<div class="band">${COPY.full}</div>` : ''}${head(COPY.working, COPY.step, `<button class="btn ibtn" aria-label="${COPY.pause}" title="${COPY.pause}">${I.pause}</button><button class="btn stop ibtn" aria-label="${COPY.stop}" title="${COPY.stop}">${I.stop}</button>`)}</div>`;
  if (state === 'waiting') pill = `<div class="badge wait" role="status">${head(COPY.yourTurn, 'Dax is waiting for you on this page', `<span style="color:var(--accent-text);display:inline-flex">${I.turn}</span>`)}<div class="acts"><button class="btn go">${COPY.continue}</button><button class="btn">${COPY.stopTask}</button></div></div>`;
  if (state === 'done') pill = `<div class="badge" role="status">${head(COPY.done, COPY.doneBody, `<span class="ok">${I.check}</span>`)}<div class="acts"><button class="btn">${COPY.dismiss}</button></div></div>`;
  const pointer = (p) => {
    if (state === 'working' || state === 'full') {
      const dx = -150, dy = 70; // direction it came from
      const tr = [[.62, 20, .38], [.38, 15, .24], [.18, 10, .14]].map(([k, d, o]) => `<span class="trail tr" style="left:${dx * k - d / 2}px;top:${dy * k - d / 2}px;width:${d}px;height:${d}px;opacity:${o}"></span>`).join('');
      return `<div class="cp" style="transform:translate(${p.x}px,${p.y}px)">${tr}<span class="main">${BOT.initial}</span><span class="nm">${chip().replace(/<span class="av">.*?<\/span>/, '')}</span></div>`;
    }
    if (state === 'waiting') return `<div class="cp" style="transform:translate(${p.x}px,${p.y}px);opacity:.7"><span class="main">${BOT.initial}</span><span class="nm">${chip().replace(/<span class="av">.*?<\/span>/, '')}</span></div>`;
    return '';
  };
  return { css, cue, pill, pointer };
}

const BUILDERS = { frame, rail, badge };

// Markup for one shadow root. target = where the bot pointer sits, in viewport px.
export function overlayMarkup({ variant, state, theme, target = { x: 640, y: 400 } }) {
  if (!BUILDERS[variant]) throw new Error('unknown variant ' + variant);
  const parts = BUILDERS[variant](state, theme === 'light' ? { accent: '#b8481f', success: '#0f7a52' } : { accent: '#ff6b35', success: '#34d399' });
  return `<style>${BASE_CSS}${parts.css}</style><div class="root" style="${cssVars(theme)}">${parts.cue}${parts.pointer(target)}${parts.pill}</div>`;
}
