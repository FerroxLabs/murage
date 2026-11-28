// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
"use strict";

/** Literal configured values only. Failure links keep the text walk linear;
 * only the longest match ending at each position is needed for the union.
 * All offsets refer to original UTF-16 text, never to generated markers.
 * Self-contained so the desktop browser can install it in its isolated world. */
function configuredValueRanges(text, values) {
  const nodes = [{ next: new Map(), fail: 0, length: 0 }];
  for (const value of values) {
    if (!value) continue;
    let state = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (!nodes[state].next.has(char)) {
        nodes[state].next.set(char, nodes.length);
        nodes.push({ next: new Map(), fail: 0, length: 0 });
      }
      state = nodes[state].next.get(char);
    }
    nodes[state].length = Math.max(nodes[state].length, value.length);
  }
  const queue = [...nodes[0].next.values()];
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i];
    for (const [char, child] of nodes[state].next) {
      let fallback = nodes[state].fail;
      while (fallback && !nodes[fallback].next.has(char)) fallback = nodes[fallback].fail;
      nodes[child].fail = nodes[fallback].next.get(char) ?? 0;
      nodes[child].length = Math.max(nodes[child].length, nodes[nodes[child].fail].length);
      queue.push(child);
    }
  }
  const ranges = [];
  let state = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
    state = nodes[state].next.get(char) ?? 0;
    const length = nodes[state].length;
    if (!length) continue;
    let start = i + 1 - length;
    // Matches arrive by end offset. A later match may begin before several
    // earlier ones; each merged range is popped at most once.
    while (ranges.length && ranges[ranges.length - 1][1] > start) {
      start = Math.min(start, ranges.pop()[0]);
    }
    ranges.push([start, i + 1]);
  }
  return ranges;
}

function redactConfiguredValues(text, values, marker = "[redacted]") {
  const ranges = configuredValueRanges(text, values);
  if (!ranges.length) return text;
  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(cursor, start), marker);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

module.exports = { configuredValueRanges, redactConfiguredValues };
