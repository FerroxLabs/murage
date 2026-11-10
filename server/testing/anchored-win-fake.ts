// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An in-memory stand-in for the Windows anchored-open helper (CONTRACTS-B 1.3, WinAnchor in server/claude-code-import.ts).
// It records every call and every open handle, and injects any native error code at the Nth call, a fileId, size or link-count
// change between open and the post-read stat, a short read, a premature zero read, `truncated: true`, and (through the
// caller's clock) a deadline jump. It makes no file system call at all.
// The shapes match WinAnchor / WinEntry in server/claude-code-import.ts; they are repeated here so this file compiles on its own.
export interface WinEntry { handle: unknown; kind: "dir" | "file"; volume: bigint; fileId: bigint; nlink: number; size: number }
export interface WinAnchor {
  anchorBegin(home: string, budgetMs: number): unknown;
  anchorOpen(parent: unknown, name: string, want: "dir" | "file"): WinEntry;
  anchorList(dir: unknown): { names: string[]; truncated: boolean };
  anchorRead(file: unknown, position: number, length: number): Buffer;
  anchorStat(handle: unknown): { kind: "dir" | "file"; volume: bigint; fileId: bigint; nlink: number; size: number; attributes: number };
  anchorClose(handle: unknown): void;
  anchorEnd(session: unknown): boolean;
}

export type FakeNode =
  | { kind: "dir"; id: bigint; kids: Map<string, FakeNode> }
  | { kind: "file"; id: bigint; bytes: Buffer; nlink: number };

interface FakeHandle { node: FakeNode; session: boolean }
export interface FakeCall { op: string; name?: string }

export class AnchoredWinFake {
  readonly root: FakeNode = { kind: "dir", id: 1n, kids: new Map() };
  readonly calls: FakeCall[] = [];
  /** Every name handed to anchorOpen, refused or not. */
  readonly opened: string[] = [];
  readonly live = new Set<FakeHandle>();
  begins = 0;
  /** Every anchorEnd call (the settle loop polls, so this is the poll count). */
  ends = 0;
  /** Scripted answers of anchorEnd; the last value repeats. Default: settled at once. */
  endScript: Array<boolean | "throw"> = [true];
  homeSeen: string | undefined;
  budgetSeen: number | undefined;
  private nextId = 2n;
  private count = new Map<string, number>();
  private failAt: Array<{ op: string; nth: number; code: string }> = [];
  private failNames = new Map<string, string>();
  private drift = new Map<string, Partial<{ fileId: bigint; size: number; nlink: number }>>();
  private cut = new Set<string>();
  private zero = new Set<string>();
  shortRead = 0;
  onOpen?: (name: string) => void;

  constructor(files: Record<string, string | Buffer> = {}) {
    for (const [path, content] of Object.entries(files)) this.put(path, content);
  }

  put(path: string, content: string | Buffer): void {
    const parts = path.split("/");
    let dir = this.root as Extract<FakeNode, { kind: "dir" }>;
    for (const part of parts.slice(0, -1)) {
      let next = dir.kids.get(part);
      if (!next) { next = { kind: "dir", id: this.nextId++, kids: new Map() }; dir.kids.set(part, next); }
      if (next.kind !== "dir") throw new Error("fake: not a directory");
      dir = next;
    }
    dir.kids.set(parts[parts.length - 1]!, { kind: "file", id: this.nextId++, bytes: Buffer.from(content), nlink: 1 });
  }
  /** Make a directory exist even when it holds nothing. */
  mkdir(path: string): void {
    let dir = this.root as Extract<FakeNode, { kind: "dir" }>;
    for (const part of path.split("/")) {
      let next = dir.kids.get(part);
      if (!next) { next = { kind: "dir", id: this.nextId++, kids: new Map() }; dir.kids.set(part, next); }
      dir = next as typeof dir;
    }
  }
  /** The Nth (1-based) call of `op` throws `code`. */
  failOn(op: "anchorBegin" | "anchorOpen" | "anchorList" | "anchorRead" | "anchorStat", nth: number, code: string): this { this.failAt.push({ op, nth, code }); return this; }
  /** Every anchorOpen of `name` throws `code`. */
  failName(name: string, code: string): this { this.failNames.set(name, code); return this; }
  /** After a read of the file called `name`, anchorStat reports these instead. */
  driftAfterRead(name: string, patch: Partial<{ fileId: bigint; size: number; nlink: number }>): this { this.drift.set(name, patch); return this; }
  truncateListOf(name: string): this { this.cut.add(name); return this; }
  prematureZeroRead(name: string): this { this.zero.add(name); return this; }

  openCount(): number { return this.live.size; }
  callsOf(op: string): FakeCall[] { return this.calls.filter((call) => call.op === op); }

  private enter(op: string, name?: string): void {
    this.calls.push({ op, name });
    const n = (this.count.get(op) ?? 0) + 1;
    this.count.set(op, n);
    const hit = this.failAt.find((f) => f.op === op && f.nth === n);
    if (hit) throw this.error(hit.code);
  }
  private error(code: string): Error {
    return Object.assign(new Error("Could not read Claude Code files."), { code });
  }
  private handleOf(value: unknown): FakeHandle {
    const handle = value as FakeHandle;
    if (!handle || !this.live.has(handle)) throw this.error("EBADF");
    return handle;
  }

  readonly anchor: WinAnchor = {
    anchorBegin: (home, budgetMs) => {
      this.homeSeen = home;
      this.budgetSeen = budgetMs;
      this.enter("anchorBegin");
      // a failed begin closes what it opened itself, so only a begin that returned a session is owed an anchorEnd
      this.begins++;
      const handle: FakeHandle = { node: this.root, session: true };
      this.live.add(handle);
      return handle;
    },
    anchorOpen: (parent, name, want) => {
      this.opened.push(name);
      this.enter("anchorOpen", name);
      this.onOpen?.(name);
      const p = this.handleOf(parent);
      const code = this.failNames.get(name);
      if (code) throw this.error(code);
      if (p.node.kind !== "dir") throw this.error("ENOTDIR");
      const node = p.node.kids.get(name);
      if (!node) throw this.error("ENOENT");
      if (want === "dir" && node.kind !== "dir") throw this.error("ENOTDIR");
      if (want === "file" && node.kind !== "file") throw this.error("EISDIR");
      if (node.kind === "file" && node.nlink !== 1) throw this.error("EMLINK");
      const handle: FakeHandle = { node, session: false };
      this.live.add(handle);
      const entry: WinEntry = { handle, kind: node.kind, volume: 7n, fileId: node.id, nlink: node.kind === "file" ? node.nlink : 1, size: node.kind === "file" ? node.bytes.length : 0 };
      return entry;
    },
    anchorList: (dir) => {
      this.enter("anchorList");
      const h = this.handleOf(dir);
      if (h.node.kind !== "dir") throw this.error("ENOTDIR");
      const names = [...h.node.kids.keys()];
      const truncated = [...this.cut].some((marker) => names.includes(marker) || marker === "*");
      return { names: truncated ? names.slice(0, Math.max(0, names.length - 1)) : names, truncated };
    },
    anchorRead: (file, position, length) => {
      this.enter("anchorRead");
      const h = this.handleOf(file);
      if (h.node.kind !== "file") throw this.error("EISDIR");
      if (length > 1024 * 1024) throw this.error("EINVAL");
      const name = [...this.driftKeys()].find((key) => this.nodeNamed(key) === h.node);
      if (name !== undefined) this.readOf.add(name);
      if ([...this.zero].some((key) => this.nodeNamed(key) === h.node)) return Buffer.alloc(0);
      const take = this.shortRead > 0 ? Math.min(length, this.shortRead) : length;
      return Buffer.from(h.node.bytes.subarray(position, position + take));
    },
    anchorStat: (handle) => {
      this.enter("anchorStat");
      const h = this.handleOf(handle);
      const base = h.node.kind === "file"
        ? { kind: "file" as const, volume: 7n, fileId: h.node.id, nlink: h.node.nlink, size: h.node.bytes.length, attributes: 0x20 }
        : { kind: "dir" as const, volume: 7n, fileId: h.node.id, nlink: 1, size: 0, attributes: 0x10 };
      for (const key of this.readOf) if (this.nodeNamed(key) === h.node) return { ...base, ...this.drift.get(key) };
      return base;
    },
    anchorClose: (handle) => {
      this.calls.push({ op: "anchorClose" });
      const h = handle as FakeHandle;
      if (!h || h.session) return;
      this.live.delete(h);
    },
    anchorEnd: (session) => {
      this.calls.push({ op: "anchorEnd" });
      const next = this.endScript[Math.min(this.ends, this.endScript.length - 1)];
      this.ends++;
      void session;
      this.live.clear();
      if (next === "throw") throw this.error("EIO");
      return next === true;
    },
  };

  private readOf = new Set<string>();
  private driftKeys(): string[] { return [...this.drift.keys(), ...this.zero]; }
  /** The first file called `name` anywhere in the tree (test trees keep names unique). */
  private nodeNamed(name: string): FakeNode | undefined {
    const walk = (dir: FakeNode): FakeNode | undefined => {
      if (dir.kind !== "dir") return undefined;
      for (const [key, node] of dir.kids) { if (key === name) return node; const inner = walk(node); if (inner) return inner; }
      return undefined;
    };
    return walk(this.root);
  }
}

/** The usual tree: Alpha and Beta skills (SKILL.md and notes.md each) and a Claude Code config with one server. */
export function standardTree(): AnchoredWinFake {
  const fake = new AnchoredWinFake();
  for (const name of ["Alpha", "Beta"]) {
    fake.put(`.claude/skills/${name}/SKILL.md`, `---\nname: ${name.toLowerCase()}\ndescription: Does ${name}\n---\nBody for ${name}.\n`);
    fake.put(`.claude/skills/${name}/notes-${name}.md`, `notes for ${name}`);
  }
  fake.put(".claude.json", JSON.stringify({ mcpServers: { plain: { command: "uvx", args: ["reviewed-tool"] } } }));
  return fake;
}
