// SPDX-License-Identifier: AGPL-3.0-or-later
// Visual presence for Murage for Chrome (spec section 4): the Frame (hairline and corner brackets), the
// bot's avatar pointer with its name, a control pill and, in Full permissive, a hazard stripe, drawn by an overlay that lives in a CDP isolated world named
// `murage-presence-v1`. This module only builds the source text and holds the pure logic; the
// runtime installs it (install with Page.createIsolatedWorld, then Runtime.evaluate with
// the world's contextId, like takeover.mjs).
//
// Every function that ends up inside the page (createPresenceCore, moveDuration, curvePoints,
// pillPlacement, presenceMain) is serialised with toString(), so each must be self-contained: no
// reference to anything declared outside its own body.
export const PRESENCE_WORLD = 'murage-presence-v1';
export const PRESENCE_ORANGE = '#ff6b35';
export const PRESENCE_LEASE_MS = 3000;

// ---- Pure logic (unit tested in node, embedded verbatim in the page) -------------------------

// State, lease and capture mode. `now` returns milliseconds from a monotonic clock.
// States: 'off' (nothing drawn, no lease), 'driving', 'waiting' (the owner's turn), 'done' (green corners only). Any call the runtime makes
// renews the lease; if it is not renewed for leaseMs the overlay must remove itself (tick()).
export function createPresenceCore(now, leaseMs) {
  let state = 'off', capture = false, expiresAt = 0, pointerPlaced = false, maskCount = 0, reinserts = 0, gaveUp = false;
  const live = () => state !== 'off';
  const renew = () => { if (live()) expiresAt = now() + leaseMs; return live(); };
  return {
    setState(next) {
      if (next !== 'off' && next !== 'driving' && next !== 'waiting' && next !== 'done') return false;
      state = next;
      if (next === 'off') { capture = false; expiresAt = 0; maskCount = 0; } else expiresAt = now() + leaseMs;
      return true;
    },
    renew,
    // Capture mode hides every element and keeps only the opaque masks. It renews the lease.
    setCapture(on, masks) { capture = !!on; maskCount = capture ? masks | 0 : 0; renew(); },
    markPointerPlaced() { pointerPlaced = true; },
    // Returns 'expired' exactly once when the lease has lapsed (state is then 'off'), else 'ok'.
    tick() {
      if (live() && now() >= expiresAt) { state = 'off'; capture = false; expiresAt = 0; maskCount = 0; return 'expired'; }
      return 'ok';
    },
    // What should be on screen right now.
    layers() {
      const on = live();
      return {
        outline: on && !capture,
        glow: on && !capture && state === 'driving',
        pointer: on && !capture && (state === 'driving' || state === 'waiting') && pointerPlaced,
        pill: on && !capture && state !== 'done',
        masks: capture && maskCount > 0,
      };
    },
    // The page removed our host. Spec 4.3 rule 8: re-insert up to three times, then stop fighting.
    noteRemoved() {
      if (!live() || gaveUp) return 'ignore';
      if (reinserts >= 3) { gaveUp = true; return 'fallback'; }
      reinserts += 1; return 'reinsert';
    },
    snapshot() { return { state, capture, remainingMs: live() ? Math.max(0, expiresAt - now()) : 0, reinserts, gaveUp, layers: this.layers() }; },
  };
}

// 180 to 350 ms by distance in pixels; halved in Full permissive (spec 4.2 and 4.4).
export function moveDuration(distance, full) {
  const ms = 180 + Math.min(1, Math.max(0, distance) / 1200) * 170;
  return Math.round(full ? ms / 2 : ms);
}

// A short eased path: a shallow quadratic curve sampled at eased progress, so the pointer
// accelerates and settles instead of sliding in a straight line.
export function curvePoints(from, to, steps) {
  const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
  const bend = Math.min(40, dist * 0.12) * (dx >= 0 ? -1 : 1);
  const cx = (from.x + to.x) / 2 + (dist ? (-dy / dist) * bend : 0);
  const cy = (from.y + to.y) / 2 + (dist ? (dx / dist) * bend : 0);
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, u = 1 - e;
    out.push({ x: u * u * from.x + 2 * u * e * cx + e * e * to.x, y: u * u * from.y + 2 * u * e * cy + e * e * to.y });
  }
  return out;
}

// Spec 4.3 rule 4: the pill sits bottom centre; if a target rectangle meets it, it goes to the top.
export function pillPlacement(pill, target) {
  if (!target) return 'bottom';
  const hit = target.x < pill.x + pill.width && target.x + target.width > pill.x && target.y < pill.y + pill.height && target.y + target.height > pill.y;
  return hit ? 'top' : 'bottom';
}

// ---- Page code (runs in the isolated world) --------------------------------------------------

// Self-contained on purpose. `config` is plain data; `logic` is the pure logic above.
export function presenceMain(config, logic) {
  if (globalThis.__muragePresence) return;
  const labels = config.labels;
  const now = () => performance.now();
  const core = logic.createPresenceCore(now, config.leaseMs);
  const signal = config.bindingName ? globalThis[config.bindingName] : undefined;
  const reduced = () => { try { return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const send = (payload) => { try { if (typeof signal === 'function') signal(payload); } catch { /* the page may be going away */ } };
  let host, root, parts, timer, observer, full = false, removed = false, pointer = { x: 0, y: 0 }, pillSide = 'bottom';
  const animations = new Map();
  let motion = 0;

  function animate(node, frames, options, onEnd) {
    const animation = node.animate(frames, options);
    let ended = false, fallback;
    const finish = (ok) => {
      if (ended) return;
      ended = true;
      clearTimeout(fallback);
      animations.delete(animation);
      try { animation.cancel(); } catch { /* The document may be gone. */ }
      onEnd?.(ok);
    };
    animations.set(animation, () => finish(false));
    animation.addEventListener('finish', () => finish(true));
    animation.addEventListener('cancel', () => finish(false));
    if (options.iterations !== Infinity) fallback = setTimeout(() => finish(true), options.duration + 50);
    return animation;
  }

  function stopMotion() {
    motion++;
    for (const stop of [...animations.values()]) stop();
    if (parts) parts.typing.style.display = 'none';
  }

  const el = (tag, css, text) => {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const ns = 'http://www.w3.org/2000/svg';
  const important = (node, props) => { for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v, 'important'); };

  function build() {
    host = document.createElement('murage-presence');
    host.setAttribute('data-murage-presence', '');
    host.setAttribute('popover', 'manual');
    // `all: initial` first so later longhands win; inline !important beats any page stylesheet.
    host.style.setProperty('all', 'initial', 'important');
    important(host, { position: 'fixed', inset: '0', display: 'block', 'pointer-events': 'none', 'z-index': '2147483647', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'hidden', opacity: '1', transition: 'opacity 200ms linear' });
    root = host.attachShadow({ mode: 'closed' });
    const T = config.theme, K = T.keyline;
    const sheet = new CSSStyleSheet();
    // Murage look (T30A pick): A Frame, C avatar pointer, A pill, B hazard stripe for Full permissive.
    // Hard-edged shapes, a keyline outside every shape so it reads on a white page and a black one.
    sheet.replaceSync(
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:Inter,-apple-system,"Segoe UI",system-ui,sans-serif}' +
      '.layer{position:absolute;inset:0;pointer-events:none}' +
      '.frame{position:absolute;inset:6px;border:2px solid ' + T.accent + ';box-shadow:0 0 0 1px ' + K + ',inset 0 0 0 1px ' + K + '}' +
      '.frame.full{border-color:' + T.warning + '}' +
      '.br{position:absolute;display:block}' +
      '.haz{position:absolute;left:6px;right:6px;top:6px;height:7px;background:repeating-linear-gradient(135deg,' + T.warning + ' 0 9px,' + K + ' 9px 18px)}' +
      '.ptr{position:absolute;left:0;top:0;pointer-events:none;will-change:transform}' +
      '.main{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;background:' + T.bot + ';color:' + T.botInk + ';display:flex;align-items:center;justify-content:center;font:700 15px/1 Inter,system-ui,sans-serif;box-shadow:0 0 0 2px #fff,0 0 0 3px ' + K + '}' +
      '.tag{position:absolute;left:22px;top:6px;display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:12px;background:' + T.panel + ';border:1px solid ' + T.hairline + ';outline:1px solid rgba(10,10,10,.55);color:' + T.ink + ';font:600 12px/1 Inter,system-ui,sans-serif;white-space:nowrap}' +
      '.trail{position:absolute;border-radius:50%;background:' + T.bot + ';outline:1px solid ' + K + ';opacity:0}' +
      '.typing{position:absolute;left:22px;top:36px;width:2px;height:14px;background:' + T.accent + ';outline:1px solid ' + K + '}' +
      '.ripple{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid ' + T.accent + ';outline:1px solid ' + K + ';pointer-events:none}' +
      '.mask{position:absolute;background:#2b2b2b;pointer-events:auto}' +
      '.pill{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;min-height:52px;padding:7px 8px 7px 12px;border-radius:12px;background:' + T.panel + ';border:1px solid ' + T.hairline + ';outline:1px solid rgba(10,10,10,.55);color:' + T.ink + ';font:600 13px/1.35 Inter,system-ui,sans-serif;pointer-events:auto;white-space:nowrap}' +
      '.pill.bottom{bottom:20px}.pill.top{top:20px}' +
      '.av{width:18px;height:18px;border-radius:50%;background:' + T.bot + ';color:' + T.botInk + ';display:inline-flex;align-items:center;justify-content:center;font:700 11px/1 Inter,system-ui,sans-serif;flex:none}' +
      '.chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:' + T.warning + ';color:' + T.warningInk + ';font:700 11px/1 Inter,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase}' +
      '.sep{width:1px;height:22px;background:' + T.hairline + '}' +
      '.btn{all:unset;box-sizing:border-box;cursor:pointer;height:36px;padding:0 12px;border-radius:8px;border:1px solid ' + T.hairline + ';background:' + T.control + ';color:' + T.ink + ';font:600 13px/1 Inter,system-ui,sans-serif;display:inline-flex;align-items:center;gap:6px}' +
      '.btn.stop{background:' + T.danger + ';color:' + T.dangerInk + ';border-color:' + T.danger + '}' +
      '.btn.go{background:' + T.accent + ';color:' + T.accentInk + ';border-color:' + T.accentBorder + '}' +
      '.btn:focus-visible{outline:2px solid ' + T.focus + ';outline-offset:2px}' +
      '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.trail{display:none!important}}' +
      '@media (forced-colors:active){.pill,.tag,.btn{border:2px solid CanvasText;background:Canvas;color:CanvasText;outline:none}.frame{border-color:Highlight;box-shadow:none}}'
    );
    root.adoptedStyleSheets = [sheet];
    const layer = (cls) => { const n = el('div'); n.className = 'layer ' + cls; return n; };
    const outline = layer('outline'), glow = layer('glow'), masks = layer('masks');
    // Thick corner brackets (outline layer) with a keyline underneath; the colour changes on done.
    const corners = [];
    for (const [pos, flip] of [['top:0;left:0', ''], ['top:0;right:0', 'transform:scaleX(-1)'], ['bottom:0;left:0', 'transform:scaleY(-1)'], ['bottom:0;right:0', 'transform:scale(-1)']]) {
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'br'); svg.setAttribute('width', '48'); svg.setAttribute('height', '48'); svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = pos + ';' + flip;
      const under = document.createElementNS(ns, 'path'), over = document.createElementNS(ns, 'path');
      for (const [p, w, c] of [[under, '9', K], [over, '5', T.accent]]) { p.setAttribute('d', 'M4 44V4H44'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', c); p.setAttribute('stroke-width', w); p.setAttribute('stroke-linecap', 'square'); }
      svg.append(under, over); outline.appendChild(svg); corners.push(over);
    }
    const haz = el('div'); haz.className = 'haz'; haz.style.display = 'none'; outline.appendChild(haz);
    const frame = el('div'); frame.className = 'frame'; glow.appendChild(frame);
    const ptr = el('div'); ptr.className = 'ptr';
    // The pointer, two trail effects and frame glow use at most four animations.
    const trail = [0, 1].map(() => { const d = el('span'); d.className = 'trail'; ptr.appendChild(d); return d; });
    const main = el('span', '', labels.initial); main.className = 'main';
    const tag = el('div', '', labels.name); tag.className = 'tag';
    const typing = el('div'); typing.className = 'typing'; typing.style.display = 'none';
    ptr.append(main, tag, typing);
    const pill = el('div'); pill.className = 'pill bottom'; pill.setAttribute('role', 'status');
    const dot = el('span', '', labels.initial); dot.className = 'av';
    const text = el('span');
    const chip = el('span', '', labels.full); chip.className = 'chip'; chip.style.display = 'none';
    const sepA = el('span'); sepA.className = 'sep';
    const mk = (label, payload, cls) => {
      const b = el('button', '', label); b.type = 'button'; b.tabIndex = -1; b.className = 'btn' + (cls ? ' ' + cls : '');
      b.addEventListener('click', (e) => { if (e.isTrusted) send(payload); });
      return b;
    };
    const pause = mk(labels.pause, 'pause'), stop = mk(labels.stop, 'stop', 'stop');
    const resume = mk(labels.continue, 'continue', 'go'), stopTask = mk(labels.stopTask, 'stop');
    pill.append(dot, text, chip, sepA, pause, stop, resume, stopTask);
    root.append(outline, glow, masks, ptr, pill);
    parts = { outline, glow, masks, ptr, typing, pill, text, sepA, pause, stop, resume, stopTask, dot, chip, haz, frame, corners, trail, main, tag };
  }

  function paintPill() {
    const st = core.snapshot().state, waiting = st === 'waiting';
    parts.text.textContent = waiting ? labels.waiting : labels.working;
    parts.chip.style.display = full ? '' : 'none';
    parts.sepA.style.display = '';
    for (const n of [parts.pause, parts.stop]) n.style.display = waiting ? 'none' : '';
    for (const n of [parts.resume, parts.stopTask]) n.style.display = waiting ? '' : 'none';
  }

  function mounted() { return !!host && host.isConnected; }

  function mount() {
    if (removed || !document.documentElement) return false;
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch { /* popover unsupported: z-index fallback applies */ }
    return true;
  }

  function unmount() { if (host && host.isConnected) { try { host.remove(); } catch { /* ignore */ } } }

  function render() {
    const l = core.layers();
    if (!(l.outline || l.glow || l.pointer || l.pill || l.masks)) { stopTimer(); unmount(); return; }
    startTimer();
    if (!mount()) return;
    // Round 10 (R9-06): the page can edit the host's inline style; what makes the overlay visible is set again on every render.
    important(host, { display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', inset: '0', transform: 'none', translate: 'none', rotate: 'none', scale: 'none', filter: 'none', 'clip-path': 'none', mask: 'none', 'mix-blend-mode': 'normal', 'pointer-events': 'none' });
    parts.outline.style.display = l.outline ? '' : 'none';
    parts.glow.style.display = l.glow ? '' : 'none';
    parts.frame.className = full ? 'frame full' : 'frame';
    parts.haz.style.display = full && l.outline && core.snapshot().state !== 'done' ? '' : 'none';
    for (const c of parts.corners) c.setAttribute('stroke', core.snapshot().state === 'done' ? config.theme.success : config.theme.accent);
    parts.ptr.style.display = l.pointer ? '' : 'none';
    parts.ptr.style.opacity = core.snapshot().state === 'waiting' ? '0.7' : '1';
    parts.pill.style.display = l.pill ? '' : 'none';
    parts.masks.style.display = l.masks ? '' : 'none';
    if (l.pill) paintPill();
    if (l.glow) {
      if (!parts.glowAnim && !reduced()) {
        parts.glowAnim = parts.glow.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 2400, iterations: Infinity, easing: 'steps(2, jump-none)' });
      } else if (parts.glowAnim && reduced()) { parts.glowAnim.cancel(); parts.glowAnim = undefined; }
    } else if (parts.glowAnim) { parts.glowAnim.cancel(); parts.glowAnim = undefined; }
  }

  function startTimer() {
    if (timer || removed) return;
    timer = setInterval(() => {
      if (core.tick() === 'expired') { fadeAndRemove(); return; }
      if (host && !host.isConnected) reinsert();
      else if (host) { try { if (!host.matches(':popover-open')) host.showPopover(); } catch { /* ignore */ } }
    }, config.tickMs);
    observer = new MutationObserver(() => { if (host && !host.isConnected && core.snapshot().state !== 'off') reinsert(); });
    observer.observe(document, { childList: true });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (observer) { observer.disconnect(); observer = undefined; }
  }

  function reinsert() {
    const verdict = core.noteRemoved();
    if (verdict === 'reinsert') mount();
    else if (verdict === 'fallback') { send('fallback'); stopTimer(); }
  }

  function fadeAndRemove() {
    stopTimer();
    if (host && host.isConnected) {
      host.style.setProperty('opacity', '0', 'important');
      setTimeout(remove, 220);
    } else remove();
  }

  function remove() {
    if (removed) return true;
    removed = true;
    stopTimer();
    stopMotion();
    if (parts?.glowAnim) { parts.glowAnim.cancel(); parts.glowAnim = undefined; }
    unmount();
    delete globalThis.__muragePresence;
    return true;
  }

  function place(x, y) {
    pointer = { x, y };
    parts.ptr.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function move(x, y) {
    if (removed || core.snapshot().state !== 'driving' || !mount()) return Promise.resolve(false);
    core.renew();
    stopMotion();
    const firstTime = !core.layers().pointer;
    if (firstTime) { core.markPointerPlaced(); render(); place(Math.max(0, x - 80), Math.max(0, y + 60)); }
    const from = { x: pointer.x, y: pointer.y }, to = { x, y };
    if (reduced() || (from.x === x && from.y === y)) { place(x, y); return Promise.resolve(true); }
    const ms = logic.moveDuration(Math.hypot(x - from.x, y - from.y), full);
    const pts = logic.curvePoints(from, to, 10);
    const moving = new Promise(resolve => {
      animate(parts.ptr, pts.map((p, i) => ({ offset: i / 10, transform: 'translate(' + p.x + 'px,' + p.y + 'px)' })), { duration: ms, easing: 'linear', fill: 'forwards' }, resolve);
    });
    place(x, y);
    // A short fading trail behind the avatar, in the direction it came from (none under reduced motion).
    const dist = Math.hypot(x - from.x, y - from.y) || 1, ux = (from.x - x) / dist, uy = (from.y - y) / dist;
    [[.62, 20, .38], [.18, 10, .14]].forEach(([k, d, o], i) => {
      const t = parts.trail[i], len = Math.min(dist, 150) * k;
      t.style.left = (ux * len - d / 2) + 'px'; t.style.top = (uy * len - d / 2) + 'px'; t.style.width = d + 'px'; t.style.height = d + 'px';
      animate(t, [{ opacity: o }, { opacity: 0 }], { duration: ms + 250, easing: 'ease-out', fill: 'forwards' });
    });
    return moving;
  }

  function click(x, y) {
    if (removed || core.snapshot().state !== 'driving' || !mount()) return false;
    core.renew();
    stopMotion();
    if (!core.layers().pointer) { core.markPointerPlaced(); render(); }
    if (pointer.x !== x || pointer.y !== y) place(x, y);
    if (reduced()) return true;
    const ring = el('div'); ring.className = 'ripple'; ring.style.left = x + 'px'; ring.style.top = y + 'px';
    root.appendChild(ring);
    animate(ring, [{ transform: 'scale(.3)', opacity: 0.9 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 450, easing: 'ease-out' }, () => ring.remove());
    animate(parts.ptr, [{ transform: 'translate(' + x + 'px,' + y + 'px) scale(1)' }, { transform: 'translate(' + x + 'px,' + y + 'px) scale(.82)' }, { transform: 'translate(' + x + 'px,' + y + 'px) scale(1)' }], { duration: 220, easing: 'ease-out' });
    return true;
  }

  function type(rect) {
    if (removed || core.snapshot().state !== 'driving' || !mount()) return Promise.resolve(false);
    core.renew();
    const x = Math.min(rect.x + rect.width - 6, Math.max(0, globalThis.innerWidth - 120)), y = rect.y + rect.height / 2;
    const moving = move(Math.max(0, x), y), current = motion;
    return moving.then((ok) => {
      if (ok && !removed && parts && current === motion && core.snapshot().state === 'driving') {
        parts.typing.style.display = '';
        if (!reduced()) animate(parts.typing, [{ opacity: 1 }, { opacity: 0 }, { opacity: 1 }], { duration: 900, iterations: Infinity, easing: 'steps(2, jump-none)' });
      }
      return ok;
    });
  }

  function avoid(rect) {
    if (removed || !mounted()) return 'bottom';
    core.renew();
    const b = parts.pill.getBoundingClientRect();
    const side = logic.pillPlacement({ x: b.x, y: b.y, width: b.width, height: b.height }, rect);
    if (side !== pillSide) { pillSide = side; parts.pill.className = 'pill ' + side; }
    return side;
  }

  function capture(on, masks, inventoryComplete = false) {
    if (removed) return Promise.resolve(false);
    const list = Array.isArray(masks) ? masks : [];
    core.setCapture(on, list.length);
    render();
    if (parts) parts.masks.replaceChildren();
    if (on && parts) {
      for (const r of list) {
        const m = el('div'); m.className = 'mask';
        m.style.left = r.x + 'px'; m.style.top = r.y + 'px'; m.style.width = r.width + 'px'; m.style.height = r.height + 'px';
        parts.masks.appendChild(m);
      }
    }
    // Round 10 (R9-06): the masks are verified on screen (host connected and shown, every mask has an area and is the top element at its centre).
    // Anything else is not a mask, and the runtime must not take the screenshot.
    const covered = () => {
      if (!on) return true;
      // Only a completed native scan can authorize capture without rectangles.
      if (!list.length) return inventoryComplete === true;
      try {
        if (!host || !host.isConnected || !parts) return false;
        const hs = getComputedStyle(host);
        if (hs.display === 'none' || hs.visibility !== 'visible' || Number(hs.opacity) < 0.99) return false;
        if (typeof host.checkVisibility === 'function' && !host.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const kids = Array.from(parts.masks.children);
        if (kids.length !== list.length) return false;
        for (const m of kids) {
          const b = m.getBoundingClientRect();
          if (!(b.width > 0 && b.height > 0)) return false;
          // Round 10 (R10-09): the mask sits where the sensitive rectangle was asked for, not wherever the page moved the host.
          const want = list[kids.indexOf(m)];
          if (!want || Math.abs(b.x - want.x) > 1 || Math.abs(b.y - want.y) > 1 || Math.abs(b.width - want.width) > 1 || Math.abs(b.height - want.height) > 1) return false;
          // Only the part inside the viewport can be in a screenshot; test the middle of that part.
          const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(globalThis.innerWidth, b.x + b.width), y1 = Math.min(globalThis.innerHeight, b.y + b.height);
          if (x1 <= x0 || y1 <= y0) continue;
          if (document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2) !== host) return false;
        }
        return true;
      } catch { return false; }
    };
    // Resolve after the hidden state has been presented, so the runtime can screenshot right away.
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(covered()); } };
      try { requestAnimationFrame(() => requestAnimationFrame(finish)); } catch { /* ignore */ }
      setTimeout(finish, 60);
    });
  }

  const control = {
    state(next, options) {
      if (removed) return false;
      full = !!(options && options.full);
      if (!core.setState(next)) return false;
      if (next !== 'driving') stopMotion();
      if (next === 'off') { stopTimer(); render(); remove(); return true; }
      render();
      return true;
    },
    renew() { return removed ? false : core.renew(); },
    // Round 10 (R9-05): the genuine overlay host, handed only to this isolated world's callers. The server asks for it to tell the real overlay from a look-alike the page built.
    hostElement() { return !removed && host && host.isConnected ? host : null; },
    move, click, type, avoid, capture,
    remove,
    status() { return removed ? { removed: true } : { ...core.snapshot(), mounted: mounted(), glowAnimating: !!(parts && parts.glowAnim), pointerAt: { ...pointer } }; },
    // Viewport rectangles of the pill controls, so tests can click them with trusted input.
    rects() {
      if (removed || !parts) return {};
      const r = (n) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
      return { pill: r(parts.pill), pause: r(parts.pause), stop: r(parts.stop) };
    },
  };
  Object.defineProperty(globalThis, '__muragePresence', { value: control, configurable: true });
}

// Murage's dark palette (src/styles.css), the same values the store art uses. The bot's own colour is teal.
export const PRESENCE_THEME = { panel: '#171717', control: '#2a2a2a', hairline: '#4d4d4d', ink: '#f5f5f5', accent: '#ff6b35', accentBorder: '#ff8255', accentInk: '#2a1207', focus: '#ff8255', success: '#34d399', danger: '#f87171', dangerInk: '#2a0806', warning: '#fbbf24', warningInk: '#241800', bot: '#01A492', botInk: '#04221e', keyline: '#0a0a0a' };
const DEFAULT_LABELS = { name: 'Murage', working: 'Murage is working', waiting: 'Your turn: Murage is waiting for you', pause: 'Pause', stop: 'Stop', full: 'Full permissive', continue: 'Continue', stopTask: 'Stop task' };

// Source for Page.addScriptToEvaluateOnNewDocument (worldName PRESENCE_WORLD) and for
// Runtime.evaluate with the world's contextId. Idempotent. Installs the control object only; the
// overlay is mounted when the runtime first pushes a state (control.state('driving')).
//   options.bindingName: Runtime.addBinding name scoped to the presence world (payloads 'pause',
//     'stop', 'fallback'); optional.
//   options.botName: shown on the pointer label and in the pill.
//   options.labels: localised strings (name, working, waiting, pause, stop, full, continue, stopTask).
//   options.leaseMs / options.tickMs: for tests; defaults 3000 and 250.
export function presenceSource(options = {}) {
  const botName = options.botName || DEFAULT_LABELS.name;
  const labels = { ...DEFAULT_LABELS, name: botName, working: botName + ' is working', waiting: 'Your turn: ' + botName + ' is waiting for you', ...(options.labels || {}) };
  labels.initial = (Array.from(String(botName).trim())[0] || 'M').toUpperCase();
  const config = { orange: PRESENCE_ORANGE, theme: PRESENCE_THEME, labels, bindingName: options.bindingName || '', leaseMs: options.leaseMs ?? PRESENCE_LEASE_MS, tickMs: options.tickMs ?? 250 };
  const logic = `{createPresenceCore:${createPresenceCore},moveDuration:${moveDuration},curvePoints:${curvePoints},pillPlacement:${pillPlacement}}`;
  return `(${presenceMain})(${JSON.stringify(config)},${logic})`;
}

// Expressions for the runtime to evaluate in the presence world.
export const PRESENCE_REMOVE_EXPRESSION = 'globalThis.__muragePresence?.remove()';
