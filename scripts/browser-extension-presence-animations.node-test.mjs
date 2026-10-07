// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { presenceSource } from '../extensions/murage-browser/presence.mjs';

function fixture({ reduced = false } = {}) {
  const effects = new Set(), timers = new Map(), nodes = [];
  let sequence = 0, peak = 0;
  class Element {
    constructor() { this.style = { setProperty() {} }; this.children = []; this.isConnected = false; nodes.push(this); }
    setAttribute() {} addEventListener() {} matches() { return true; }
    append(...children) { for (const child of children) this.appendChild(child); }
    appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = true; return child; }
    attachShadow() { this.shadow = new Element(); return this.shadow; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    animate(_frames, options) {
      const listeners = {};
      const animation = {
        node: this, options,
        addEventListener: (name, callback) => { (listeners[name] ??= []).push(callback); },
        finish: () => {
          if (!effects.has(animation) || options.iterations === Infinity) return;
          if (options.fill !== 'forwards') effects.delete(animation);
          for (const callback of listeners.finish ?? []) callback();
        },
        cancel: () => {
          if (!effects.delete(animation)) return;
          for (const callback of listeners.cancel ?? []) callback();
        },
      };
      effects.add(animation); peak = Math.max(peak, effects.size); return animation;
    }
  }
  const context = {
    document: { documentElement: new Element(), createElement: () => new Element(), createElementNS: () => new Element() },
    performance: { now: () => 0 }, innerWidth: 1280, matchMedia: () => ({ matches: reduced }),
    CSSStyleSheet: class { replaceSync() {} }, MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
  };
  runInNewContext(presenceSource(), context);
  const control = context.__muragePresence;
  control.state('driving');
  const finish = () => { for (const animation of [...effects]) animation.finish(); };
  const expireTimeouts = () => { for (const [id, timer] of [...timers]) { if (timers.delete(id)) timer.fn(); } };
  return { control, effects, timers, nodes, finish, expireTimeouts, peak: () => peak };
}

test('100 moves and types retain at most four live effects, including the frame glow', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const moving = f.control.move(i + 10, i + 20); f.finish(); assert.equal(await moving, true);
    const typing = f.control.type({ x: i, y: i, width: 90, height: 20 }); f.finish(); assert.equal(await typing, true);
    assert.ok(f.effects.size <= 4, `iteration ${i}: ${f.effects.size} effects`);
  }
  assert.ok(f.peak() <= 4, `peak effects: ${f.peak()}`);
  assert.equal(f.timers.size, 0, 'completed movement releases fallback timers');
  f.control.remove(); assert.equal(f.effects.size, 0, 'removal includes the frame glow');
});

test('overlapping moves and types settle superseded work and stay bounded', async () => {
  const f = fixture(), pending = [];
  for (let i = 0; i < 100; i++) {
    pending.push(f.control.move(i, i + 1));
    pending.push(f.control.type({ x: i, y: i, width: 90, height: 20 }));
  }
  f.finish(); await Promise.all(pending);
  assert.ok(f.peak() <= 4); assert.ok(f.effects.size <= 2);
  f.control.remove(); assert.equal(f.effects.size, 0);
});

test('completed trails release their filled effects and missing finish events use bounded fallbacks', async () => {
  const f = fixture();
  const first = f.control.move(80, 90); f.finish(); await first;
  assert.equal(f.effects.size, 1);
  const second = f.control.move(120, 130); f.expireTimeouts(); await second;
  assert.equal(f.effects.size, 1); assert.equal(f.timers.size, 0);
});

test('owner waiting cancels an in-flight type without starting a typing loop', async () => {
  const f = fixture();
  const pending = f.control.type({ x: 0, y: 0, width: 90, height: 20 });
  f.control.state('waiting'); f.expireTimeouts(); await pending;
  assert.equal(f.effects.size, 0);
});

test('repeated clicks and removal release ripples and pointer effects', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.control.click(i, i);
  assert.ok(f.peak() <= 4);
  f.control.remove(); assert.equal(f.effects.size, 0); assert.equal(f.timers.size, 0);
  assert.ok(f.nodes.filter(node => node.className === 'ripple').every(node => !node.isConnected));
});

test('reduced motion creates no animation effects during moves and types', async () => {
  const f = fixture({ reduced: true });
  for (let i = 0; i < 100; i++) {
    await f.control.move(i, i); await f.control.type({ x: i, y: i, width: 90, height: 20 });
  }
  assert.equal(f.effects.size, 0); f.control.remove();
});
