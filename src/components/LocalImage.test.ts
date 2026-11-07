import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ view: {} as any }));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: any) => initial?.state === 'waiting' ? [fixture.view, vi.fn()] : actual.useState(initial) };
});
vi.mock('./ImageMedia', () => ({ ImageLightbox: ({ downloadDisabled }: { downloadDisabled: boolean }) => createElement('button', { disabled: downloadDisabled }, 'Lightbox Save') }));
import { LocalImage } from './LocalImage';
it.each(['thumbnail', 'lightbox'])('F10 disables every Save control on %s during renewal loading', surface => {
  fixture.view = { state: 'ready-loading', saving: true, node: 1, surface, ready: { state: 'ready', relativePath: 'p.png', url: '/api/media/bytes/x?cap=y', asset: { id: 'a', name: 'p.png', revision: 'r1.abcdefgh', capabilities: { download: true } } } };
  const html = renderToStaticMarkup(createElement(LocalImage, { candidate: 'p.png', scope: { botId: 'b', threadId: 't' }, alt: 'Picture' }));
  expect((html.match(/disabled=""/g) ?? []).length).toBe(surface === 'lightbox' ? 2 : 1);
});
