// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A least-recently-used map with an entry cap and a byte cap. SQLite is the
 * source of truth for every cached value, so an evicted entry is simply read
 * again on its next use. The most recently used entry is never evicted, so a
 * single over-size value is still usable, and neither is an entry `pinned`
 * says is in use (a thread with a turn, a stream or a write in flight). A
 * value that grows in place reports it through `adjust`, which re-checks the
 * caps. */
export class LruMap<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  private maxEntries: number;
  private maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly pinned: (key: string) => boolean;

  constructor(maxEntries: number, maxBytes: number, sizeOf: (value: V) => number, pinned: (key: string) => boolean = () => false) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.pinned = pinned;
  }

  /** The value without counting a use. */
  peek(key: string): V | undefined { return this.entries.get(key)?.value; }

  /** A held value changed size by `delta` bytes in place; evicts if that
   * crossed the cap. */
  adjust(key: string, delta: number): void {
    const entry = this.entries.get(key);
    if (!entry || !delta) return;
    entry.bytes = Math.max(0, entry.bytes + delta);
    this.total = Math.max(0, this.total + delta);
    this.evict();
  }

  get size(): number { return this.entries.size; }
  get bytes(): number { return this.total; }
  keys(): string[] { return [...this.entries.keys()]; }
  has(key: string): boolean { return this.entries.has(key); }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert so Map order stays oldest-first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): this {
    const previous = this.entries.get(key);
    if (previous) this.total -= previous.bytes;
    this.entries.delete(key);
    const bytes = this.sizeOf(value);
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    this.evict();
    return this;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.total -= entry.bytes;
    return this.entries.delete(key);
  }

  limits(maxEntries: number, maxBytes: number): void {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.evict();
  }

  /** Drop least recently used entries until both caps hold, skipping the
   * newest entry and pinned ones (which may leave the map over its caps). */
  evict(): void {
    if (this.entries.size <= this.maxEntries && this.total <= this.maxBytes) return;
    const keys = [...this.entries.keys()];
    keys.pop();
    for (const key of keys) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxBytes) return;
      if (!this.pinned(key)) this.delete(key);
    }
  }
}
