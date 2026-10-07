// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure builder for the title and colour of a Murage tab group (spec 4.1, 9.1).
// No bot id ever reaches a title: only the display name the owner gave the bot.
export const GROUP_COLOR = 'orange';
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
// showBot: true when two or more bindings have groups in the same window.
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
  if (!showBot || !name) return `${message(i18n, 'groupTitle')}${tail}`.slice(0, MAX_TITLE);
  const prefixLength = message(i18n, 'groupTitleBot', '').length;
  const room = Math.max(1, MAX_TITLE - prefixLength - tail.length);
  const fitted = name.length > room ? `${name.slice(0, Math.max(1, room - 1)).trimEnd()}…` : name;
  return `${message(i18n, 'groupTitleBot', fitted)}${tail}`.slice(0, MAX_TITLE);
}

export const groupColor = () => GROUP_COLOR;
