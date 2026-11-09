// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Documentation/source closure only. Runtime evidence stays in the DOM and
// Chromium suites named by the ledger; these checks do not substitute for it.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
/** Source text with block and line comments removed, so a check can only pass on code. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const body = (source: string, head: RegExp) => {
  const start = source.search(head); expect(start, String(head)).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed ${head}`);
};
// The closure record is committed (Astra r3 High 1): a clean checkout reads it.
const ledger = read('docs/verification/pullback-layers-1018.md');
const browser = read('src/e2e/pullback-layers.human.spec.ts');

describe('PULLBACK closure record', () => {
  it('R22-MAP: preserves all seven AR21 and eight actual GR2 findings', () => {
    const rows = ledger.split('\n').filter(line => /^\| (AR21-|GR2-)/.test(line));
    expect(rows).toHaveLength(15);
    for (const [prefix, count] of [['AR21', 7], ['GR2', 8]] as const) {
      for (let i = 1; i <= count; i++) expect(rows.filter(row => row.startsWith(`| ${prefix}-${i} |`))).toHaveLength(1);
    }
    expect(ledger).toContain('| GR2-1 | R22-RESUME / D6 |');
    expect(ledger).toContain('| GR2-2 | R22-H1 |');
    expect(ledger).toContain('| GR2-8 | R22-DETAILS |');
  });
  it('R23-MAP: records ten r22 findings, historical nonapproval and current verdicts separately', () => {
    expect(ledger.split('\n').filter(line => /^\| (AR22-|GR22-)/.test(line))).toHaveLength(10);
    for (const statement of ['Historical Astra r23: BLOCK', 'Historical Grok r23: SKIPPED, not approval', 'Current Astra r24: AGREE', 'Current Grok r24: AGREE', 'older reviews were not reread', 'historically empty section 13']) expect(ledger).toContain(statement);
    for (const exclusion of ['dependency/security product work', 'engine-default selection', 'Help-chief fallback', 'No-limits acceptance/copy']) expect(ledger).toContain(exclusion);
  });
  it('R24-AUDIT: accounts for all 26 BF obligations without declaring browser evidence passed', () => {
    const rows = ledger.split('\n').filter(line => /^\| BF-\d+ \|/.test(line));
    expect(rows).toHaveLength(26);
    for (let i = 1; i <= 26; i++) {
      const matching = rows.filter(row => row.startsWith(`| BF-${i} |`)); expect(matching).toHaveLength(1);
      expect(matching[0].split('|').filter(Boolean)).toHaveLength(4);
      const source = matching[0].match(/`([^`]+)`/)!;
      expect(existsSync(fileURLToPath(new URL(source[1], root))), `BF-${i} source`).toBe(true);
    }
    for (const i of [3, 4, 6, 10, 12, 13, 17, 18, 22, 23]) expect(rows.find(row => row.startsWith(`| BF-${i} |`))).toContain('browser not run');
    expect(ledger).toContain('| AR23-1 | R24-H1 / R24-DIRTY / R24-BRANCH / R24-HANDOFF / R24-AUDIT |');
    expect(ledger).toContain('| AR23-2 | R24-INLINE / E4 / H4 / R24-AUDIT |');
    for (const id of ['H3/B7', 'B1:', 'B2:', 'B3:', 'B4:', 'B5 /', 'B6:', 'B8:', 'B9:', 'B10 /', 'D18 / R23-STOP', 'D18 / R23-ENGINE', 'R22-TURN', 'BF-23 / H1 / D2']) expect(browser).toContain(id);
    expect(browser).not.toMatch(/test\.(skip|fixme)\s*\(/);
  });
  it('PB-HEADERS: lane component files carry the AGPL licence header', () => {
    for (const file of ['MemoryLauncher.tsx', 'LazyFallback.tsx', 'LazyOverlay.tsx', 'LayerSlot.tsx', 'LayerSurface.tsx', 'CalendarLayer.tsx']) {
      expect(read(`src/components/${file}`).startsWith('// Copyright 2026 Ferrox Labs\n// SPDX-License-Identifier: AGPL-3.0-or-later\n'), file).toBe(true);
    }
  });
  it('R23-SOURCE: audits the implemented symbols in code, not in the ledger', () => {
    // BF-20: every check below reads comment-free source. The ledger's baseline line citations are history.
    const engine = code('src/lib/focus-trap.ts');
    expect(body(engine, /export interface TrapDocument\b/)).toMatch(/\breadonly documentElement\?:/);
    expect(body(engine, /export interface TrapKeyEvent\b/)).toMatch(/\bkey\b/);
    expect(engine).toMatch(/^import \{ wrapTabTarget \} from '\.\/focus-wrap';/m);
    expect(engine).toMatch(/=\s*wrapTabTarget\(/);
    // LayerImpl owns captureReturn, and the close and handoff paths call it.
    expect(body(engine, /class LayerImpl\b/)).toMatch(/\n\s*captureReturn\(\): \(\) => void \{/);
    expect(engine.match(/\.captureReturn\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const focus = code('src/lib/return-focus.ts');
    expect(body(focus, /export function returnTarget\(/)).toMatch(/return focusTarget\(target, doc\)/);
    expect(body(focus, /export function returnFocus\(/)).toMatch(/\breturnTarget\(opener\b/);
    for (const name of ['src/components/health/health-exit.test.ts', 'src/lib/escape-layer.test.ts']) {
      const row = read('ci/gate-tests.txt').split('\n').find(row => row.startsWith(name + '\t'))!;
      expect(row.split('\t')).toHaveLength(3);
    }
  });
  it('R22-OWNERS: closure index links retained behavior matrices and distinguishes unrun browser supplements', () => {
    const section = ledger.split('## R22-OWNERS closure index')[1].split('## Validation')[0];
    for (const file of ['calendar-layers', 'native-layers', 'additional-modal-layers', 'modal-inventory', 'loaded-modal-layers', 'window-layers', 'palette-layer', 'team-library-layer', 'lazy-overlay']) {
      expect(section).toContain(file);
      expect(read(`src/components/${file}.dom.test.ts`)).toMatch(/(?:it|test)(?:\.each)?\(/);
    }
    expect(section).toContain('eight native crash matrices added under R22-OWNERS / R23-H3 / BF-6, not run');
    expect(section).toContain('calls/find/workspace callbacks added under R22-OWNERS, not run');
  });
});
