// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage's real palette, copied from src/styles.css (@theme and [data-skin="light"]). Dev tooling for the
// T30A design variants only; nothing here ships. Re-open src/styles.css if a value looks off.
export const THEMES = {
  dark: {
    app: '#0a0a0a', panel: '#171717', card: '#1f1f1f', inset: '#121212', raised: '#2a2a2a', control: '#2a2a2a',
    hairline: '#4d4d4d', ink: '#f5f5f5', inkSecondary: '#a8a8a8', accent: '#ff6b35', accentBorder: '#ff8255',
    accentText: '#ff8255', focus: '#ff8255', accentInk: '#2a1207', success: '#34d399', successInk: '#06231a',
    danger: '#f87171', dangerInk: '#2a0806', warning: '#fbbf24', warningInk: '#241800',
  },
  light: {
    app: '#f7f7f7', panel: '#f0f0f0', card: '#ffffff', inset: '#eaeaea', raised: '#ffffff', control: '#d4d4d4',
    hairline: '#bfbfbf', ink: '#0d0d0d', inkSecondary: '#555555', accent: '#b8481f', accentBorder: '#cc5529',
    accentText: '#a83c14', focus: '#b8481f', accentInk: '#ffffff', success: '#0f7a52', successInk: '#ffffff',
    danger: '#b3261e', dangerInk: '#ffffff', warning: '#8a6100', warningInk: '#ffffff',
  },
};

// The bot's own identity colour: EMBER_COLORS teal (src/lib/mascot.ts). The product accent is orange, the
// bot is teal, so "Murage" and "which bot" never read as the same thing.
export const BOT = { name: 'Dax', initial: 'D', color: '#01A492', ink: '#04221e' };
// Hairline drawn outside every on-page shape so it reads on a white page and on a black one.
export const KEYLINE = '#0a0a0a';

const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
export function cssVars(theme) {
  const t = THEMES[theme];
  return Object.entries(t).map(([k, v]) => `--${kebab(k)}:${v}`).join(';') + `;--bot:${BOT.color};--bot-ink:${BOT.ink};--k:${KEYLINE}`;
}

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

// Every pair the variants rely on, per theme: text pairs need 4.5, non-text indicators need 3.
export function contrastTable() {
  const rows = [];
  for (const theme of Object.keys(THEMES)) {
    const t = THEMES[theme];
    const add = (what, fg, bg, need) => rows.push({ theme, what, fg, bg, ratio: Math.round(contrast(fg, bg) * 100) / 100, need });
    add('text on panel (pill, badge, side panel header)', t.ink, t.panel, 4.5);
    add('secondary text on card', t.inkSecondary, t.card, 4.5);
    add('accent ink on accent fill (rail, Continue)', t.accentInk, t.accent, 4.5);
    add('success ink on success fill (done rail)', t.successInk, t.success, 4.5);
    add('danger ink on danger fill (Stop)', t.dangerInk, t.danger, 4.5);
    add('warning ink on warning fill (Full marker)', t.warningInk, t.warning, 4.5);
    add('bot initial on bot colour', BOT.ink, BOT.color, 4.5);
    add('app background on ink fill (Your turn rail text)', t.app, t.ink, 4.5);
    add('accent cue against keyline (edge cue on a dark page)', t.accent, KEYLINE, 3);
    add('keyline against white page (outer edge of every cue)', KEYLINE, '#ffffff', 3);
    add('accent border against panel (control boundary)', t.accentBorder, t.panel, 3);
  }
  return rows;
}
