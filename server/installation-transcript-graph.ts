/** Bounded, iterative validation. Explicit parents may reference later rows:
 * inserting a message into an existing branch legitimately does that. Missing
 * parent fields retain the runtime's legacy chain-in-row-order semantics. */
export class InstallationTranscriptGraph {
  private parents = new Map<string, string | null>();
  private previous: string | null = null;
  private identityBytes = 0;
  private fail: (code: string) => never;
  constructor(fail: (code: string) => never) { this.fail = fail; }

  add(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) this.fail("INVALID_RESTORE_MESSAGE");
    const message = value as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,160}$/.test(id);
    if (!validId(message.id) || this.parents.has(message.id) || !Number.isFinite(message.at) || !["bot", "user"].includes(String(message.role)) || typeof message.kind !== "string") this.fail("INVALID_RESTORE_MESSAGE");
    const parent = message.parentId === undefined ? this.previous : message.parentId;
    if (parent !== null && !validId(parent)) this.fail("INVALID_MESSAGE_PARENT");
    this.identityBytes += Buffer.byteLength(message.id) + (parent === null ? 0 : Buffer.byteLength(parent as string));
    if (this.parents.size >= 1_000_000 || this.identityBytes > 128 * 1024 ** 2) this.fail("RESTORE_TRANSCRIPT_LIMIT");
    this.parents.set(message.id, parent as string | null);
    this.previous = message.id;
  }

  validate(activeLeaf: unknown = null) {
    if (activeLeaf !== null && (typeof activeLeaf !== "string" || !this.parents.has(activeLeaf))) this.fail("INVALID_ACTIVE_BRANCH");
    const colors = new Map<string, number>();
    for (const start of this.parents.keys()) {
      if (colors.get(start) === 2) continue;
      const path: string[] = [];
      let current: string | null = start;
      while (current !== null) {
        if (!this.parents.has(current)) this.fail("INVALID_MESSAGE_PARENT");
        if (colors.get(current) === 2) break;
        if (colors.get(current) === 1) this.fail("CYCLIC_MESSAGE_BRANCH");
        colors.set(current, 1); path.push(current);
        current = this.parents.get(current)!;
      }
      for (const visited of path) colors.set(visited, 2);
    }
  }
}
