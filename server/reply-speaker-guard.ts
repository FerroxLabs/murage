// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export function stripFabricatedSpeakers(text: string, speakers: { self: string; owner: string; teammates: readonly string[] }): { text: string; removedSpeaker?: string } {
  const owners = new Set(["User", "Owner", "Human", speakers.owner].map(name => name.toLowerCase()));
  const teammates = new Set(speakers.teammates.filter(name => name !== speakers.self).map(name => name.toLowerCase()));
  let fence: string | undefined;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trimStart();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; }
    else if (marker) fence = marker;
    else if (raw === line && !line.startsWith(">")) {
      const match = /^([^:*\n]{1,100}):\s*(.*)$/.exec(line);
      if (match && match[1].toLowerCase() !== speakers.self.toLowerCase()
        && (owners.has(match[1].toLowerCase()) && /(?:\?|\b(?:please|supply|tell me|send me|confirm|provide)\b)/i.test(text.slice(0, offset)) && /^(?:["“]|yes\b|no\b|i\b|we\b|the real\b|here\b|please\b)/i.test(match[2]) || teammates.has(match[1].toLowerCase()) && /^["“‘']/.test(match[2]))) {
        return { text: text.slice(0, offset).trimEnd(), removedSpeaker: match[1] };
      }
    }
    offset += raw.length + 1;
  }
  return { text };
}
export function criteriaRecordCorrection(text: string, criteria: readonly { text: string; met: boolean }[], goalState?: string): string {
  const prose: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    // Quoted examples are not claims. A single quote opens only after a non-letter
    // and closes only before one, so apostrophes (team's, owners') stay prose.
    if (!fence && !/^(?:\s|>|["“])/.test(line)) prose.push(line.replace(/`[^`]*`|"[^"]*"|“[^”]*”/g, "")
      .replace(/(^|[^\p{L}\p{N}])(?:'(?:[^'\n]|'(?=[\p{L}\p{N}]))*'|‘(?:[^’\n]|’(?=[\p{L}\p{N}]))*’)(?![\p{L}\p{N}])/gu, "$1"));
  }
  const claims = prose.join("\n").split(/[.!?;\n]+/).filter(clause =>
    !/\b(?:when|if|once|unless|until|not|aren't|isn't)\b/i.test(clause));
  const claim = claims.some(clause => /\ball\s+(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:of\s+the\s+)?(?:done\s+)?criteria\s+(?:are\s+)?(?:now\s+)?met\b|\bevery\s+criterion\s+is\s+(?:now\s+)?met\b|\b(?:the\s+)?goal\s+is\s+(?:done|complete|completed)\b/i.test(clause));
  if (!claim) return "";
  const open = criteria.filter(item => !item.met);
  if (criteria.length && !open.length) {
    if (goalState && goalState !== "done" && /\bgoal\s+is\s+(?:done|complete|completed)\b/i.test(text)) {
      return `On record: ${criteria.length} of ${criteria.length} done criteria met. The goal still needs your sign-off.`;
    }
    return "";
  }
  return `On record: ${criteria.length - open.length} of ${criteria.length} done criteria met. Still open: ${open.map(item => item.text).join("; ") || "done criteria have not been set"}.`;
}

/** Stream ordinary prose immediately; retain only a possible next-speaker line. */
export function createReplySpeakerStream(speakers: Parameters<typeof stripFabricatedSpeakers>[1]) {
  let text = "", emitted = 0, cut = false;
  const labels = ["User", "Owner", "Human", speakers.owner, ...speakers.teammates.filter(name => name !== speakers.self)].map(name => name.toLowerCase() + ":");
  return (delta: string): string => {
    if (cut) return "";
    text += delta;
    const lineStart = text.lastIndexOf("\n") + 1;
    const line = text.slice(lineStart).toLowerCase();
    const possible = Boolean(line) && labels.some(label => label.startsWith(line) || line.startsWith(label));
    const end = possible ? lineStart : text.length;
    const checked = stripFabricatedSpeakers(text.slice(0, end), speakers);
    if (checked.removedSpeaker) cut = true;
    const visible = checked.text.slice(emitted);
    emitted = checked.text.length;
    return visible;
  };
}

/** A room's reply guard across a turn. The stream belongs to the item being
 * written and resets when it completes, so a cut ends only that item's tail,
 * never a later item such as the final answer after a tool call. The removal
 * row and the criteria correction are once per turn. State is keyed by
 * thread and turn, so concurrent turns stream apart and a retired turn's
 * late completion clears only its own state. A driver that omits turnId
 * shares one key per thread: its completion sweeps the thread, and a new
 * such turn starts clean. A turn whose completion never arrives (a driver
 * that ends without turn.completed) is also swept when its room or direct
 * turn ends (`ended`), and at most `maxTurns` turns are held: the least
 * recently used turn that only streams is forgotten first, and a turn with a
 * cut or a correction only when no such turn is left, so a turn still
 * running never earns a second removal row or a second correction. */
export function createReplySpeakerTurns({ maxTurns = 256 }: { maxTurns?: number } = {}) {
  const streams = new Map<string, ReturnType<typeof createReplySpeakerStream>>();
  // A cut turn, and the removal row once it is written.
  const cuts = new Map<string, string | undefined>();
  const corrections = new Set<string>();
  // every turn with state, least recently used first
  const held = new Set<string>();
  const key = (threadId: string, turnId?: string) => `${threadId}\n${turnId ?? ""}`;
  const forget = (k: string) => { streams.delete(k); cuts.delete(k); corrections.delete(k); held.delete(k); };
  const touch = (k: string) => {
    held.delete(k);
    held.add(k);
    for (const oldest of held) { if (held.size <= maxTurns) break; if (oldest !== k && !cuts.has(oldest) && !corrections.has(oldest)) forget(oldest); }
    for (const oldest of held) { if (held.size <= maxTurns) break; forget(oldest); }
  };
  const completed = (threadId: string, turnId: string | undefined): void => {
    if (turnId !== undefined) { forget(key(threadId, turnId)); return; }
    for (const k of new Set([...streams.keys(), ...cuts.keys(), ...corrections, ...held])) if (k.startsWith(`${threadId}\n`)) forget(k);
  };
  return {
    delta(threadId: string, turnId: string | undefined, delta: string, speakers: Parameters<typeof stripFabricatedSpeakers>[1]): string {
      const k = key(threadId, turnId);
      touch(k);
      let stream = streams.get(k);
      if (!stream) { stream = createReplySpeakerStream(speakers); streams.set(k, stream); }
      return stream(delta);
    },
    item(threadId: string, turnId: string | undefined, text: string, speakers: Parameters<typeof stripFabricatedSpeakers>[1]): { text: string; removedSpeaker?: string; removedText?: string; firstCut?: boolean; rowId?: string } {
      const k = key(threadId, turnId);
      streams.delete(k);
      const result = stripFabricatedSpeakers(text, speakers);
      if (result.removedSpeaker || cuts.has(k) || corrections.has(k)) touch(k);
      if (!result.removedSpeaker) return { text };
      const firstCut = !cuts.has(k), rowId = cuts.get(k);
      if (firstCut) cuts.set(k, undefined);
      return { text: result.text, removedSpeaker: result.removedSpeaker, removedText: text.slice(result.text.length).trim(), firstCut, ...(rowId ? { rowId } : {}) };
    },
    /** The engine retried: the item being streamed is void, so its tail
     * starts clean. Cuts and corrections already earned stay. */
    reset(threadId: string, turnId: string | undefined): void { streams.delete(key(threadId, turnId)); },
    /** The turn's removal row, for its later cuts to merge into. */
    removalRow(threadId: string, turnId: string | undefined, rowId: string): void {
      const k = key(threadId, turnId);
      if (cuts.has(k)) cuts.set(k, rowId);
    },
    /** True the first time a turn earns a criteria correction. */
    claimCorrection(threadId: string, turnId: string | undefined): boolean {
      const k = key(threadId, turnId);
      touch(k);
      if (corrections.has(k)) return false;
      corrections.add(k);
      return true;
    },
    /** A turn without an id cannot inherit the last such turn's state. */
    started(threadId: string, turnId: string | undefined): void { if (turnId === undefined) forget(key(threadId)); },
    completed,
    /** A room or direct turn ended on Murage's side (its driver may send no
     * turn.completed): its state goes after the current task, so an event
     * of the turn already queued in this tick still finds it. A turn without
     * an id is left to its own completion or the next such turn's start. */
    ended(threadId: string, turnId: string | undefined): void {
      if (turnId === undefined) return;
      queueMicrotask(() => completed(threadId, turnId));
    },
    /** Turns holding state now (bounded by maxTurns). */
    size(): number { return held.size; },
  };
}

/** Whether a room reply answers only to the owner. The request it answers
 * decides; without one, the audience recorded when the turn was dispatched.
 * With neither, it does not. */
export function replyAudienceIsOwner(
  owner: { notOwnerAudience?: boolean; ownerAudience?: boolean } | undefined,
  request: { notOwnerAudience?: boolean } | null,
  requestStillOwner: () => boolean,
): boolean {
  if (owner?.notOwnerAudience) return false;
  if (request) return !request.notOwnerAudience && requestStillOwner();
  return owner?.ownerAudience === true;
}
