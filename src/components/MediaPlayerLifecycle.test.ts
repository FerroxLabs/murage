import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { LocalMediaResolution } from '@/lib/media-resolve';

// Run the actual component bodies and event handlers. Each instance owns its
// hook slots; effects and cleanups run at render/disposal boundaries.
const runtime = vi.hoisted(() => ({ current: null as any, refresh: vi.fn(), save: vi.fn() }));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual,
    useState: (initial: any) => {
      const c = runtime.current, i = c.index++;
      if (!(i in c.slots)) c.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [c.slots[i], (value: any) => { c.slots[i] = typeof value === 'function' ? value(c.slots[i]) : value; }];
    },
    useRef: (initial: any) => { const c = runtime.current, i = c.index++; return c.slots[i] ??= { current: initial }; },
    useCallback: (callback: any) => callback,
    useEffect: (effect: any, deps: any[]) => {
      const c = runtime.current, i = c.index++, previous = c.slots[i];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) {
        previous?.cleanup?.(); c.effects.push(() => { c.slots[i] = { deps, cleanup: effect() }; });
      }
    },
  };
});
vi.mock('@/lib/media-resolve', async original => ({ ...await original<typeof import('@/lib/media-resolve')>(), refreshLocalMedia: runtime.refresh }));
vi.mock('@/lib/save-file', () => ({ saveUrl: runtime.save, reportSaveFailure: vi.fn() }));
import { LocalMedia, MediaPlayerCard } from './MediaPlayer';
const instances: any[] = [];
function instance(component: any) {
  const c = { slots: [] as any[], effects: [] as any[], index: 0,
    render(props: any) { runtime.current = c; c.index = 0; const tree = component(props); c.effects.splice(0).forEach(effect => effect()); return tree; },
  }; instances.push(c); return c;
}
function find(tree: any, name: string): any {
  if (!tree || typeof tree !== 'object') return;
  if (tree.type === name || tree.type?.name === name) return tree;
  for (const child of [tree.props?.children].flat()) { const result = find(child, name); if (result) return result; }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const asset = { id: 'ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'tone.mp3', kind: 'audio', mime: 'audio/mpeg', revision: 'r1.abcdefgh', availability: 'ready', capabilities: { download: true } };
const ready = { state: 'ready', asset, url: '/api/media/bytes/x?cap=old', expiresAt: 1, generation: 1, canonicalKey: 'test', relativePath: 'tone.mp3' } as LocalMediaResolution;
const fallback = createElement('span', { 'data-testid': 'fallback' }, 'tone.mp3');
const bad = [
  ...['ready', 'unplayable'].flatMap(state => ['image', 'file'].map(kind => ({ state, asset: { ...asset, kind }, url: '/api/media/bytes/x?cap=bad', reason: 'unsupported' }))),
  { state: 'ready', asset: { kind: 'audio' }, url: 'x' }, { state: 'exhausted' },
];
afterEach(() => { instances.splice(0).forEach(c => c.slots.forEach((slot: any) => slot?.cleanup?.())); vi.clearAllMocks(); });
it.each(bad)('F11 render gate keeps $state $asset.kind fallback only', async value => {
  const parent = instance(LocalMedia), props = { scope: { botId: 'b', threadId: 't' }, path: '/work/tone.mp3', fallback, resolve: async () => value };
  parent.render(props); await flush();
  expect(parent.render(props).props.children).toBe(fallback);
});
it.each(['playback', 'download'])('F11 %s refresh refuses every non-player answer before source or handoff', async action => {
  for (const value of bad) {
    runtime.refresh.mockResolvedValue(value);
    const parent = instance(LocalMedia), props = { scope: { botId: 'b', threadId: 't' }, path: '/work/tone.mp3', fallback, resolve: async () => ready };
    parent.render(props); await flush();
    const card = parent.render(props); expect(card.type).toBe(MediaPlayerCard);
    const results: any[] = [], refresh = async () => { const next = await card.props.refresh(); results.push(next); return next; };
    const child = instance(MediaPlayerCard), tree = child.render({ ...card.props, refresh, probe: () => 'probably' });
    const audio = find(tree, 'audio'), element = { error: { code: 2 }, currentTime: 12, paused: true, ended: false, getAttribute: () => ready.state === 'ready' ? ready.url : '', setAttribute() {}, removeAttribute() {}, pause() {}, load() {} };
    audio.props.ref(element);
    if (action === 'playback') audio.props.onError({ currentTarget: element });
    else find(tree, 'DownloadAction').props.onClick({ preventDefault() {} });
    await flush();
    expect(results).toEqual([null]);
    expect(parent.render(props).props.children).toBe(fallback);
    expect(runtime.save).not.toHaveBeenCalled();
  }
});
