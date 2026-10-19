// SPDX-License-Identifier: AGPL-3.0-or-later
// One scope's filed jobs in the claim index (claim-index.ts): rowids in ascending order, without duplicates, kept as sorted blocks of at
// most RID_BLOCK rowids (1.0.3 memory stall, Astra build2 H2). The open walk files a page in retry order, not rowid order, so a page's
// rowids land anywhere in the list: one insert is a binary search over the blocks and a splice inside one block, never a copy of the
// list's tail. A page of P rowids costs O(P x (log n + RID_BLOCK)) plus at most P / (RID_BLOCK / 2) + 1 block splits, whatever the
// list holds.
//
// The blocks sit in one array behind a head index, with free slots in front of the head (Astra build3 H1). A split puts its new block
// on the side with fewer blocks to move, so a split near the front (the reverse-order walk) moves no block, and a split anywhere moves
// at most half the blocks. Consumed heads advance the head index and move nothing; the free run is compacted once it is twice the live
// blocks, so a compaction costs less than the drops that earned it, amortized O(1) per drop.

/** Most rowids one block holds; a fuller one is split in two halves. */
export const RID_BLOCK = 512;
/** Free slots kept in front of the first block when the front runs out of room. */
const FRONT_SLACK = 16;

export class RidList {
  /** The blocks, in order, from `head` on; the slots before `head` are free. */
  private blocks: bigint[][] = [];
  private head = 0;
  /** Rowids held. */
  size = 0;
  /** Elements moved by inserts and splits so far (for tests and the trace: the per-page cost the design bounds). */
  moves = 0;
  /** Block pointers moved by splits, slack refills and compactions so far (for tests: O(1) amortized per split and per drop). */
  blockMoves = 0;

  private get count(): number { return this.blocks.length - this.head; }
  /** The block that holds `rid` or the place for it: the first block whose last rowid is >= rid, else the last block (index from `head`). */
  private blockOf(rid: bigint): number {
    const blocks = this.blocks, head = this.head;
    let lo = 0, hi = this.count - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; const block = blocks[head + mid]!; if (block[block.length - 1]! < rid) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** Put `block` before the one at `index` (from `head`), moving the fewer of the blocks before it (into the front slack) or after it. */
  private placeBefore(index: number, block: bigint[]): void {
    const blocks = this.blocks;
    const count = this.count;
    if (index < count - index) {
      if (this.head === 0) {
        // no room in front: refill the slack, as many free slots as blocks (so a refill costs what the blocks before it cost since the last one)
        const slack = Math.max(FRONT_SLACK, count);
        this.blocks = new Array<bigint[]>(slack).concat(blocks);
        this.head = slack; this.blockMoves += count;
      }
      const head = --this.head, b = this.blocks;
      for (let i = 0; i < index; i++) b[head + i] = b[head + i + 1]!;
      b[head + index] = block;
      this.blockMoves += index;
    } else {
      blocks.splice(this.head + index, 0, block);
      this.blockMoves += count - index;
    }
  }

  /** File `rid`; false when it is already held (a stale copy is kept once). */
  insert(rid: bigint): boolean {
    const blocks = this.blocks;
    if (this.count === 0) { blocks.length = this.head; blocks.push([rid]); this.size++; return true; }
    const last = blocks[blocks.length - 1]!;
    let at: number, block: bigint[], index: number;
    if (rid > last[last.length - 1]!) { index = this.count - 1; block = last; at = block.length; }
    else {
      index = this.blockOf(rid); block = blocks[this.head + index]!;
      let lo = 0, hi = block.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (block[mid]! < rid) lo = mid + 1; else hi = mid; }
      if (block[lo] === rid) return false;
      at = lo;
    }
    if (at === block.length) block.push(rid);
    else { this.moves += block.length - at; block.splice(at, 0, rid); }
    this.size++;
    if (block.length > RID_BLOCK) {
      // the lower half becomes a block of its own before this one; the upper half stays (the block's slot keeps the higher rowids)
      const lower = block.splice(0, RID_BLOCK >> 1);
      this.moves += block.length + lower.length;
      this.placeBefore(index, lower);
    }
    return true;
  }

  /** The rowids in ascending order (the list must not change while this runs). */
  *ascending(): Generator<bigint> { for (let b = this.head; b < this.blocks.length; b++) for (const rid of this.blocks[b]!) yield rid; }
  /** The rowids in descending order (the list must not change while this runs). */
  *descending(): Generator<bigint> {
    for (let b = this.blocks.length - 1; b >= this.head; b--) { const block = this.blocks[b]!; for (let i = block.length - 1; i >= 0; i--) yield block[i]!; }
  }
  /** Drop the `count` lowest rowids (consumed): whole blocks go (their slots are left free), and at most one block is cut. */
  dropFront(count: number): void {
    let n = Math.min(count, this.size);
    const blocks = this.blocks;
    while (n > 0 && this.head < blocks.length && blocks[this.head]!.length <= n) { n -= blocks[this.head]!.length; this.size -= blocks[this.head]!.length; blocks[this.head] = undefined as unknown as bigint[]; this.head++; }
    if (n > 0 && this.head < blocks.length) { blocks[this.head]!.splice(0, n); this.size -= n; }
    if (this.head === blocks.length) { this.blocks = []; this.head = 0; }
    else if (this.head > FRONT_SLACK && this.head > 2 * this.count) { this.blocks = blocks.slice(this.head); this.blockMoves += this.blocks.length; this.head = 0; }
  }
  /** For tests: every rowid, in order. */
  toArray(): bigint[] { return this.blocks.slice(this.head).flat(); }
}
