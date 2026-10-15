// SPDX-License-Identifier: AGPL-3.0-or-later
// A shared-prefix automaton avoids scanning each event once per forgotten message.
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));
export const MATCH_SLICE_CHARS = 4096;
type Node = { next: Map<string, number>; fail: number; end: boolean };
const node = (): Node => ({ next: new Map(), fail: 0, end: false });

export class EventLogMatcher {
  private nodes: Node[] = [node()];
  static async build(patterns: Iterable<string>): Promise<EventLogMatcher> {
    const matcher = new EventLogMatcher(), nodes = matcher.nodes;
    let work = 0;
    for (const pattern of patterns) {
      if (!pattern) continue;
      let state = 0;
      for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        let next = nodes[state]!.next.get(char);
        if (next === undefined) { next = nodes.length; nodes[state]!.next.set(char, next); nodes.push(node()); }
        state = next;
        if (++work >= MATCH_SLICE_CHARS) { work = 0; await yieldLoop(); }
      }
      nodes[state]!.end = true;
    }
    const queue = [...nodes[0]!.next.values()];
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head]!;
      for (const [char, child] of nodes[state]!.next) {
        let fallback = nodes[state]!.fail;
        while (fallback && !nodes[fallback]!.next.has(char)) {
          fallback = nodes[fallback]!.fail;
          if (++work >= MATCH_SLICE_CHARS) { work = 0; await yieldLoop(); }
        }
        const fail = nodes[fallback]!.next.get(char) ?? 0;
        nodes[child]!.fail = fail;
        nodes[child]!.end ||= nodes[fail]!.end;
        queue.push(child);
        if (++work >= MATCH_SLICE_CHARS) { work = 0; await yieldLoop(); }
      }
    }
    return matcher;
  }

  private advance(state: number, char: string): number {
    while (state && !this.nodes[state]!.next.has(char)) state = this.nodes[state]!.fail;
    return this.nodes[state]!.next.get(char) ?? 0;
  }

  matches(line: string): boolean {
    if (this.nodes.length === 1) return false;
    let state = 0;
    for (let i = 0; i < line.length; i++) {
      state = this.advance(state, line[i]!);
      if (this.nodes[state]!.end) return true;
    }
    return false;
  }

  /** State carries across slices, including a match spanning two slices. Counts expose work, not elapsed time, to tests. */
  async matchesSliced(line: string, onSlice?: (characters: number) => void): Promise<boolean> {
    if (this.nodes.length === 1) return false;
    let state = 0;
    for (let start = 0; start < line.length; start += MATCH_SLICE_CHARS) {
      const end = Math.min(start + MATCH_SLICE_CHARS, line.length);
      for (let i = start; i < end; i++) {
        state = this.advance(state, line[i]!);
        if (this.nodes[state]!.end) { onSlice?.(i - start + 1); return true; }
      }
      onSlice?.(end - start);
      if (end < line.length) await yieldLoop();
    }
    return false;
  }
}
