// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S0 data and runtime qualification only. This module never grants approval.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitsEnvelope } from '../shared/outside-limits.mjs';

export const MANDATORY = Object.freeze([
  { id: 'w10', os: 'Windows 10 22H2', platform: 'win32', arches: ['x64'], session: 'gui' },
  { id: 'w11', os: 'Windows 11 24H2', platform: 'win32', arches: ['x64'], session: 'gui' },
  { id: 'm14', os: 'macOS 14', platform: 'darwin', arches: ['arm64', 'x64'], session: 'aqua' },
  { id: 'm15', os: 'macOS 15', platform: 'darwin', arches: ['arm64', 'x64'], session: 'aqua' },
  { id: 'm26', os: 'macOS 26', platform: 'darwin', arches: ['arm64', 'x64'], session: 'aqua' },
  { id: 'gx', os: 'Ubuntu 24.04 GNOME 46', platform: 'linux', arches: ['x64'], session: 'x11' },
  { id: 'gw', os: 'Ubuntu 24.04 GNOME 46', platform: 'linux', arches: ['x64'], session: 'wayland' },
  { id: 'kw', os: 'Fedora (release pinned at admission) KDE Plasma 6', platform: 'linux', arches: ['x64'], session: 'wayland' },
]);
export const LOCALES = Object.freeze(['en', 'de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh']);
export const BINDING_FILES = Object.freeze([
  'electron/notify-s0.mjs', 'shared/outside-limits.mjs', 'electron/windows-banners.mjs',
  'electron/windows-notification-activation.mjs', 'electron/mac-banners.mjs',
  'electron/linux-notify.mjs', 'electron/native-banner-labels.mjs',
  'electron/background-lifecycle.mjs', 'electron/notification-authorization.mjs',
  'electron/native-banner-approvals.mjs',
]);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sourceBinding(root) {
  return sha256(canonical(Object.fromEntries(BINDING_FILES.map(file => [file, sha256(readFileSync(join(root, file)))]))));
}
const fail = reason => { throw Error(`S0_REFUSED:${reason}`); };
const string = value => typeof value === 'string' && value.trim().length > 0 && !/unknown|pending|placeholder/i.test(value);
const positive = value => Number.isFinite(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => canonical(a) === canonical(b);
export const LAYOUT_KEYS = Object.freeze(['platformId', 'platform', 'osVersion', 'osBuild', 'arch', 'session',
  'desktop', 'daemon', 'font', 'textScale', 'displayScale', 'workArea', 'theme', 'locale', 'layout', 'surface',
  'electron', 'nativeHash']);
export function layoutKey(layout) {
  if (!layout || !same(Object.keys(layout).sort(), [...LAYOUT_KEYS].sort())) fail('layout-fields');
  for (const key of LAYOUT_KEYS.filter(k => !['textScale', 'displayScale', 'workArea'].includes(k))) if (!string(layout[key])) fail(`layout-${key}`);
  if (!positive(layout.textScale) || !positive(layout.displayScale) || !Array.isArray(layout.workArea) || layout.workArea.length !== 2 || !layout.workArea.every(positive)) fail('layout-geometry');
  const os = MANDATORY.find(p => p.id === layout.platformId);
  if (!os || os.platform !== layout.platform || os.session !== layout.session || !os.arches.includes(layout.arch)) fail('platform');
  const banner = { win32: 'banner-win', darwin: 'banner-mac', linux: 'banner-linux' }[layout.platform];
  if (![banner, 'menu'].includes(layout.surface) || !LOCALES.includes(layout.locale) || !['light', 'dark'].includes(layout.theme) || !hash(layout.nativeHash)) fail('layout-values');
  // Exact builds still bind below. These are admission floors, not forward compatibility.
  if (os.id === 'w10' && !/^10\.0\.19045(?:\.|$)/.test(layout.osBuild)) fail('windows-version');
  if (os.id === 'w11' && !/^10\.0\.26100(?:\.|$)/.test(layout.osBuild)) fail('windows-version');
  if (layout.platform === 'darwin' && !layout.osVersion.startsWith(`${os.id.slice(1)}.`)) fail('mac-version');
  if (['gx', 'gw'].includes(os.id) && (layout.osVersion !== '24.04' || !/^GNOME 46(?:\.|$)/.test(layout.desktop))) fail('gnome-version');
  if (os.id === 'kw' && (!/^Fedora \d+/.test(layout.osVersion) || !/^KDE Plasma 6(?:\.|$)/.test(layout.desktop))) fail('kde-version');
  return sha256(canonical(layout));
}
export function envelopeShape(e) {
  if (!e || !same(Object.keys(e).sort(), ['maxLines', 'maxLineChars', 'titleChars', 'nameChars', 'templateLines', 'repertoire'].sort()) || e.repertoire !== 'ascii') fail('envelope');
  for (const key of ['maxLines', 'maxLineChars', 'titleChars', 'nameChars', 'templateLines']) if (!Number.isSafeInteger(e[key]) || e[key] <= 0 || e[key] > 4096) fail(`envelope-${key}`);
  if (e.templateLines < e.maxLines + 2) fail('whole-template');
  return e;
}
// Candidates are proposed from calibration, never installed by the probe.
// Every field is at its maximum simultaneously, using the widest measured glyph.
export function casesFor(envelope, widest = { botName: 'W', title: 'W', willRun: 'W' }) {
  const e = envelopeShape(envelope);
  for (const field of ['botName', 'title', 'willRun']) if (typeof widest[field] !== 'string' || !/^[\x21-\x7e]$/.test(widest[field])) fail('widest');
  const full = { botName: widest.botName.repeat(e.nameChars), title: widest.title.repeat(e.titleChars), willRun: Array(e.maxLines).fill(widest.willRun.repeat(e.maxLineChars)).join('\n') };
  const cases = [];
  for (const field of ['botName', 'title', 'willRun']) for (let code = 32; code <= 126; code++) {
    // Anchors permit measuring spaces; subtract the two anchor advances.
    cases.push({ id: `glyph-${field}-${code}`, kind: 'glyph', field, code, display: { botName: 'S0', title: 'S0', willRun: 'S0', [field]: `|${String.fromCharCode(code).repeat(8)}|` } });
  }
  cases.push({ id: 'full-template', kind: 'fit', display: full });
  for (const [id, detail] of [
    ['wrap-token', widest.willRun.repeat(e.maxLineChars * e.maxLines)],
    ['wrap-words', Array(e.maxLines).fill(`${widest.willRun.repeat(Math.max(1, e.maxLineChars - 2))} X`).join(' ')],
    ['wrap-spaces', ' A  B   C '], ['wrap-breaks', Array(e.maxLines).fill('X').join('\n')],
    ['punctuation', '<>&"\'_%_*_`[]()\\/'],
  ]) cases.push({ id, kind: fitsEnvelope(detail, full.title, full.botName, e) ? 'fit' : 'reject', display: { ...full, willRun: detail } });
  for (const [id, display] of [
    ['plus-title', { ...full, title: full.title + widest.title }],
    ['plus-name', { ...full, botName: full.botName + widest.botName }],
    ['plus-detail', { ...full, willRun: full.willRun + '\nX' }],
    ['non-ascii', { ...full, willRun: '漢字' }], ['invisible', { ...full, willRun: 'A\u200bB' }],
  ]) cases.push({ id, kind: 'reject', display });
  return cases;
}

/** Validate operator evidence structurally. Hashes establish integrity, not truthful observation.
 * Fixtures may be inspected by tests but are NEVER returned as runtime qualifications. */
export function validateBundle(bundle, binding, { inspectFixture = false } = {}) {
  if (bundle?.fixture !== false && !(inspectFixture && bundle?.fixture === true)) fail('fixture');
  if (bundle.schema !== 1 || bundle.kind !== 'murage-s0-native-measurement' || bundle.binding !== binding || !hash(binding)) fail('revision');
  const key = layoutKey(bundle.layout), e = envelopeShape(bundle.envelope);
  if (!string(bundle.operator) || !string(bundle.machine) || !hash(bundle.packageHash) || !hash(bundle.planHash) || !hash(bundle.rigHash) || !Number.isFinite(Date.parse(bundle.startedAt)) || !Number.isFinite(Date.parse(bundle.finishedAt)) || Date.parse(bundle.finishedAt) < Date.parse(bundle.startedAt)) fail('provenance');
  const measurements = bundle.measurements;
  if (!measurements || !['normal', 'maximum'].includes(measurements.textSizeMode) || measurements.minimumWorkArea !== true || !string(measurements.method)) fail('scale');
  const widest = {};
  for (const field of ['botName', 'title', 'willRun']) {
    const m = measurements[field];
    if (!m || !positive(m.usableWidthPx) || !positive(m.lineHeightPx) || !positive(m.usableHeightPx) || !Array.isArray(m.advancesPx) || m.advancesPx.length !== 95 || !m.advancesPx.every(positive)) fail(`metrics-${field}`);
    const max = Math.max(...m.advancesPx);
    // A space can be widest; use the widest non-space glyph for the visible stress case,
    // while the width bound still includes space.
    widest[field] = String.fromCharCode(33 + m.advancesPx.slice(1).indexOf(Math.max(...m.advancesPx.slice(1))));
    const chars = field === 'botName' ? e.nameChars : field === 'title' ? e.titleChars : e.maxLineChars;
    const lines = field === 'willRun' ? e.maxLines : 1;
    if (chars * max > m.usableWidthPx || lines * m.lineHeightPx > m.usableHeightPx) fail(`geometry-${field}`);
  }
  if (!positive(measurements.templateHeightPx) || !positive(measurements.templateUsableHeightPx) || measurements.templateHeightPx > measurements.templateUsableHeightPx) fail('template-geometry');
  const expected = casesFor(e, widest);
  if (!Array.isArray(bundle.observations) || bundle.observations.length !== expected.length) fail('cases');
  for (let i = 0; i < expected.length; i++) {
    const c = expected[i], o = bundle.observations[i];
    if (o?.id !== c.id || o.payloadHash !== sha256(canonical(c.display)) || o.nativePosted !== true || !hash(o.captureHash) || !hash(o.postReceiptHash) || !Number.isFinite(Date.parse(o.observedAt))) fail(`evidence-${c.id}`);
    if (c.kind !== 'reject' && (o.complete !== true || o.transformed !== false)) fail(`clipped-${c.id}`);
    if (c.kind === 'reject' && (o.runtimeRefused !== true || fitsEnvelope(c.display.willRun, c.display.title, c.display.botName, e))) fail(`negative-${c.id}`);
  }
  return { key, envelope: structuredClone(e), eligible: bundle.fixture === false };
}

/** Immutable canonical index. Import is offline and explicit, never an app preference. */
export function bindBundles(bundles, binding) {
  if (!Array.isArray(bundles) || bundles.length === 0) fail('empty');
  const entries = {};
  for (const bundle of bundles) {
    const checked = validateBundle(bundle, binding);
    if (entries[checked.key]) fail('duplicate-layout');
    entries[checked.key] = structuredClone(bundle);
  }
  return { schema: 1, binding, revision: sha256(canonical(entries)), entries };
}

/** Read only a MAIN-owned canonical index path, never a renderer-supplied path. */
export function loadS0Index(file, root) {
  const index = JSON.parse(readFileSync(file, 'utf8'));
  const binding = sourceBinding(root);
  if (index?.schema !== 1 || index.binding !== binding || !index.entries || index.revision !== sha256(canonical(index.entries))) fail('index');
  const rebound = bindBundles(Object.values(index.entries), binding);
  if (!same(rebound, index)) fail('index-keys');
  return rebound;
}

/** MAIN supplies a fresh native layout observation, never renderer/user settings.
 * Re-read source binding/index/layout at each mint AND activation. Any change invalidates
 * outstanding leases; no common-envelope bypass and no remembered last good layout. */
export function createS0Qualification({ readBinding, readIndex, readLayout, invalidate = () => {} }) {
  let current = null, generation = 0;
  function reset(next = null) {
    if (current !== next) { current = next; generation++; try { invalidate(); } catch { /* refusal cannot depend on diagnostics */ } }
  }
  function qualify(surface) {
    try {
      const binding = readBinding(), index = readIndex(), layout = readLayout(surface);
      const key = layoutKey(layout);
      if (layout.surface !== surface || index?.schema !== 1 || index.binding !== binding || index.revision !== sha256(canonical(index.entries))) fail('index');
      const bundle = index.entries[key];
      const checked = validateBundle(bundle, binding);
      if (!checked.eligible || checked.key !== key) fail('unknown-layout');
      const identity = `${binding}:${index.revision}:${key}`;
      reset(identity);
      return { ok: true, revision: index.revision, key, generation, envelope: checked.envelope };
    } catch { reset(); return { ok: false, reason: 'unqualified-layout', generation }; }
  }
  return { qualify, invalidate: () => { current = null; generation++; try { invalidate(); } catch { /* refusal cannot depend on diagnostics */ } },
    valid(lease, surface) { const now = qualify(surface); return now.ok && lease?.ok === true && same(now, lease); } };
}
