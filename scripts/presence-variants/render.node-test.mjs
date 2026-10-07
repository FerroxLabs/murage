// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test: the T30A renderers write non-empty PNGs, and the mock copy passes the copy rules.
// The render test needs a browser (CFT_PATH); without one it is skipped, so plain runs stay offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '../sidepanel-mock/copy.mjs';
import { contrastTable } from '../sidepanel-mock/tokens.mjs';
import { VARIANTS, STATES, overlayMarkup } from './variants.mjs';
import { panelHtml } from '../sidepanel-mock/panel.mjs';
import { renderAll } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const strings = (o) => Object.values(o).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flat(Infinity).filter((x) => typeof x === 'string') : v && typeof v === 'object' ? strings(v) : []));
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

test('mock copy follows the copy rules', () => {
  const all = [...strings(COPY)];
  for (const v of VARIANTS) for (const s of STATES) { all.push(textOf(overlayMarkup({ variant: v, state: s, theme: 'dark' }))); all.push(textOf(panelHtml({ variant: v, state: s, theme: 'dark' }))); }
  for (const s of all) {
    assert.ok(!/[—–]/.test(s), `dash in: ${s}`);
    assert.ok(!/\b(safe|safely|safety|unsafe)\b/i.test(s), `safety word in: ${s}`);
    assert.ok(!/composio/i.test(s), `vendor word in: ${s}`);
    assert.ok(!/\b(price|pricing|cost|\$\d)/i.test(s), `price talk in: ${s}`);
  }
});

test('every contrast pair the variants rely on clears its floor', () => {
  for (const r of contrastTable()) assert.ok(r.ratio >= r.need, `${r.theme} ${r.what}: ${r.ratio} < ${r.need}`);
});

test('renderers write the variant screenshots', { skip: !process.env.CFT_PATH && 'set CFT_PATH to run' , timeout: 600000 }, async () => {
  const outDir = process.env.T30A_OUT || path.resolve(here, '../../lanes/chrome-t30a/shots');
  const { written } = await renderAll({ outDir });
  assert.ok(written.length >= 60, `expected 60+ files, got ${written.length}`);
  for (const f of written) { assert.ok(existsSync(f), f); assert.ok((await stat(f)).size > 1000, `${f} empty`); }
});
