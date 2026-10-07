// SPDX-License-Identifier: AGPL-3.0-or-later
// Keyed DOM patching (UX-007). The view builds a fresh detached tree on every refresh; this module reconciles it into the
// live tree so an unchanged refresh touches nothing: the focused element, its caret and the live region stay the same node.
// Children match on tag + data-role + data-key (text nodes match by order). Only what differs is written.
const isSvg = n => String(n.tagName).toLowerCase() === 'svg';
const keyOf = n => n.nodeType === 3 ? '#text' : `${n.tagName}|${n.getAttribute('data-role') ?? ''}|${n.getAttribute('data-key') ?? ''}`;

function patchElement(live, next) {
  if (isSvg(live)) return; // the brand mark never changes
  const want = new Set(next.getAttributeNames());
  for (const name of live.getAttributeNames()) if (!want.has(name)) live.removeAttribute(name);
  for (const name of want) { const v = next.getAttribute(name); if (live.getAttribute(name) !== v) live.setAttribute(name, v); }
  if (live.className !== next.className) live.className = next.className;
  if (live.disabled !== next.disabled) live.disabled = next.disabled;
  if (live.hidden !== next.hidden) live.hidden = next.hidden;
  live.onclick = next.onclick;
  patchChildren(live, [...next.childNodes]);
}

export function patchChildren(parent, nextNodes) {
  const queues = new Map();
  for (const n of [...parent.childNodes]) { const k = keyOf(n); if (!queues.has(k)) queues.set(k, []); queues.get(k).push(n); }
  const final = [], kept = new Set();
  for (const next of nextNodes) {
    const live = queues.get(keyOf(next))?.shift();
    if (!live) { final.push(next); continue; }
    if (next.nodeType === 3) { if (live.data !== next.data) live.data = next.data; } else patchElement(live, next);
    kept.add(live); final.push(live);
  }
  for (const n of [...parent.childNodes]) if (!kept.has(n)) parent.removeChild(n);
  // Moving a node detaches it, which would drop focus held inside it; put focus back on the same element afterwards.
  const doc = parent.ownerDocument, active = doc?.activeElement;
  final.forEach((node, i) => { const at = parent.childNodes[i]; if (at !== node) parent.insertBefore(node, at ?? null); });
  if (active && active !== doc.body && doc.activeElement !== active && active.isConnected !== false) active.focus?.();
}
