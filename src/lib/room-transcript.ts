/** A room's transcript in conversation order, read from its parent links
 * rather than from the order rows reached the client.
 *
 * The server keeps every thread as a chain of `parentId` links, and export
 * reads that chain (Store.activePath). Rows usually arrive in chain order,
 * but not always: text a Fuigo hosted tool row interrupted is saved at
 * response completion and inserted in front of that row (Store
 * insertMessageBefore), so it reaches the client, live and on reload, after
 * the row it precedes. Rendering arrival order would show row then text in
 * the room while export shows text then row.
 *
 * Rooms never fork (an edit branches only a bot's own thread), so the chain
 * from the oldest held row down to the newest is the whole room. Walking
 * parent links depth first from each root, children in arrival order, gives
 * exactly that chain and still shows every held row: nothing is hidden if a
 * link is missing or unexpected, which a leaf walk could not promise.
 *
 * - `parentId` undefined: a legacy row; its parent is the row before it,
 *   as the server reads such rows (Store loadedMessages).
 * - `parentId` null, or a parent not held (an older page not loaded yet):
 *   a root, placed in arrival order, with one exception below.
 *
 * A page boundary can cut an inserted row off from the row it precedes:
 * text L saved before tool row T1 of a 101-row response is stored after
 * T101, so the newest page holds [T3 … T101, L], and neither L's parent nor
 * T1 is in it. Arrival order would show L last; export shows it first. The
 * server marks such a row (`insertedBefore`), and a marked row whose parent
 * is not held starts the held part of the chain: its parent is older than
 * the page, so in a room (one chain) every other held row follows it. Those
 * roots come first, in arrival order, then every other root.
 *
 * The common case (every row follows its parent) returns the input array
 * itself after one linear pass, so memoized consumers see no change. */
export function roomTranscript<T extends { id: string; parentId?: string | null; insertedBefore?: string }>(messages: T[]): T[] {
  const count = messages.length;
  if (count < 2) return messages;
  const indexOf = new Map<string, number>();
  for (let index = 0; index < count; index++) indexOf.set(messages[index]!.id, index);
  // Parent index of each row, or -1 for a root.
  const parents = new Array<number>(count);
  // Inserted rows whose parent is older than the held rows: chain starts.
  const leading: number[] = [];
  let ordered = true;
  for (let index = 0; index < count; index++) {
    const { parentId, insertedBefore } = messages[index]!;
    const parent = parentId === undefined ? index - 1 : parentId === null ? -1 : indexOf.get(parentId) ?? -1;
    parents[index] = parent === index ? -1 : parent;
    if (parents[index] !== -1 && parents[index] !== index - 1) ordered = false;
    if (parent === -1 && typeof parentId === "string" && insertedBefore) leading.push(index);
  }
  // Unless those already arrived first, arrival order is not chain order.
  if (leading.some((index, position) => index !== position)) ordered = false;
  if (ordered) return messages;

  const children = new Array<number[] | undefined>(count);
  const roots: number[] = [...leading];
  const isLeading = new Uint8Array(count);
  for (const index of leading) isLeading[index] = 1;
  for (let index = 0; index < count; index++) {
    const parent = parents[index]!;
    if (parent === -1) {
      if (!isLeading[index]) roots.push(index);
    } else (children[parent] ??= []).push(index);
  }
  const out: T[] = [];
  const seen = new Uint8Array(count);
  const stack: number[] = [];
  const walk = (start: number) => {
    stack.push(start);
    while (stack.length) {
      const index = stack.pop()!;
      if (seen[index]) continue;
      seen[index] = 1;
      out.push(messages[index]!);
      const next = children[index];
      if (next) for (let child = next.length - 1; child >= 0; child--) stack.push(next[child]!);
    }
  };
  for (const root of roots) walk(root);
  // A parent cycle has no root; its rows still show, in arrival order.
  for (let index = 0; index < count; index++) if (!seen[index]) walk(index);
  return out;
}
