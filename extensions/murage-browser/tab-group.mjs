// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure builder for the title and colour of a Murage tab group (spec 4.1, 9.1).
// No bot id ever reaches a title: only the display name the owner gave the bot.
export const GROUP_COLOR = 'orange';
// Chrome's nine tab group colours (light theme RGB). A group takes the one nearest the bot's own colour (journey 1024, section 20).
export const TAB_GROUP_RGB = { grey: [95, 99, 104], blue: [26, 115, 232], red: [217, 48, 37], yellow: [249, 171, 0], green: [30, 142, 62],
  pink: [208, 24, 132], purple: [161, 66, 244], cyan: [0, 123, 131], orange: [250, 144, 62] };
export const TAB_GROUP_COLORS = Object.keys(TAB_GROUP_RGB);
export function hexRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(typeof hex === 'string' ? hex : '');
  return m ? m.slice(1).map(h => parseInt(h, 16)) : undefined;
}
// The nearest of Chrome's nine to a #rrggbb colour; Murage orange when the bot has no (valid) colour.
export function nearestGroupColor(hex) {
  const rgb = hexRgb(hex);
  if (!rgb) return GROUP_COLOR;
  let best = GROUP_COLOR, distance = Infinity;
  for (const name of TAB_GROUP_COLORS) {
    const d = TAB_GROUP_RGB[name].reduce((sum, c, i) => sum + (c - rgb[i]) ** 2, 0);
    if (d < distance) { best = name; distance = d; }
  }
  return best;
}
// Chrome truncates long group titles; keep the whole title within this many characters.
export const MAX_TITLE = 40;

const ENGLISH = {
  groupTitle: 'Murage',
  groupTitleBot: 'Murage · $1',
  groupSuffixPaused: 'paused',
  groupSuffixStopped: 'stopped',
  groupSuffixYourTurn: 'your turn',
  groupSuffixFull: 'full',
  groupSuffixWorking: 'working',
  groupSuffixDone: 'done',
};

export function message(i18n, key, substitution) {
  let text = '';
  try { text = i18n?.getMessage?.(key, substitution === undefined ? undefined : [substitution]) ?? ''; } catch { text = ''; }
  if (typeof text === 'string' && text.trim()) return text;
  const fallback = ENGLISH[key] ?? key;
  return substitution === undefined ? fallback : fallback.replace('$1', substitution);
}

// state: 'active' | 'paused' | 'stopped'. yourTurn / full: booleans. activity: 'working' | 'done' | undefined.
// A group is titled with the bot's own name whenever it has one (one group per bot); `Murage` only for a nameless binding.
// showBot is kept for older callers and no longer changes the title.
export function groupTitle({ botName, showBot = false, state, yourTurn = false, full = false, activity } = {}, i18n) {
  const suffixes = [];
  if (state === 'stopped') suffixes.push(message(i18n, 'groupSuffixStopped'));
  else if (state === 'paused') suffixes.push(message(i18n, 'groupSuffixPaused'));
  if (yourTurn) suffixes.push(message(i18n, 'groupSuffixYourTurn'));
  if (full) suffixes.push(message(i18n, 'groupSuffixFull'));
  if (activity === 'working') suffixes.push(message(i18n, 'groupSuffixWorking'));
  else if (activity === 'done') suffixes.push(message(i18n, 'groupSuffixDone'));
  const tail = suffixes.map(s => ` · ${s}`).join('');
  const name = String(botName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return `${message(i18n, 'groupTitle')}${tail}`.slice(0, MAX_TITLE);
  const room = Math.max(1, MAX_TITLE - tail.length);
  const fitted = name.length > room ? `${name.slice(0, Math.max(1, room - 1)).trimEnd()}…` : name;
  return `${fitted}${tail}`.slice(0, MAX_TITLE);
}

export const groupColor = botColor => nearestGroupColor(botColor);
