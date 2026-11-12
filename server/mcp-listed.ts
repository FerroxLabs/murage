// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The direct readiness signal from Murage's own MCP servers. The engine starts
// each server Murage hands it (agents, memory, connected apps), and the server
// is Murage's own process: once it has written its answer to the engine's
// `tools/list`, the engine holds that server's tools. The driver hands each such
// mount a marker path; the server writes it right after that answer is flushed,
// and the driver releases the turn's MCP wait when every marker of the turn is
// there. No engine notification is needed, and nothing is inferred from silence.
//
// Standalone and dependency-free on purpose: the proxies are bundled and
// spawned as their own node processes.
import { writeFileSync } from "node:fs";

/** The marker path a Murage MCP server writes once it has answered `tools/list`. */
export const MCP_LISTED_FILE_ENV = "MURAGE_MCP_LISTED_FILE";

/** Write the marker (when the mount was given one) once everything already on
 * stdout, the `tools/list` answer included, has been handed to the engine. */
export function markMcpListedAfterFlush(env: Record<string, string | undefined> = process.env): void {
  const path = env[MCP_LISTED_FILE_ENV];
  if (!path) return;
  process.stdout.write("", () => {
    try { writeFileSync(path, String(Date.now()), { mode: 0o600 }); } catch { /* the driver falls back to its bound */ }
  });
}

/** Catalog state lives in one atomic document. Dirty state never races a
 * separate stale complete marker. The old list remains only a planning hint. */
import { readFileSync, renameSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { turnSecret } from "./turn-credential.ts";
import type { Writable } from "node:stream";
type Frame = Record<string, any>;
export interface McpCatalog {
  v: 2; processGeneration: string; catalogGeneration: number; revision: number;
  at: number; ready: boolean; complete: boolean; tools?: string[]; resources: boolean | "unknown";
}
const frameOf = (value: unknown): Frame | undefined => {
  try { const v = typeof value === "string" ? JSON.parse(value) : value; return v && typeof v === "object" && !Array.isArray(v) ? v as Frame : undefined; } catch { return; }
};
const rpcId = (id: unknown): string | undefined => typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : undefined;
export function readMcpCatalog(path: string, generation = basename(path).split(".")[0]): McpCatalog | undefined {
  try {
    const first = readFileSync(path, "utf8"), value = frameOf(first);
    if (value?.v !== 2 || value.processGeneration !== generation || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.catalogGeneration)) return;
    if (readFileSync(path, "utf8") !== first) return;
    const exact = value.complete === true && Array.isArray(value.tools) && value.tools.every((name: unknown) => typeof name === "string");
    return { v: 2, processGeneration: generation!, catalogGeneration: value.catalogGeneration, revision: value.revision, at: value.at, ready: value.ready === true || exact, complete: exact, ...(Array.isArray(value.tools) ? { tools: value.tools } : {}), resources: typeof value.resources === "boolean" ? value.resources : "unknown" };
  } catch { return; }
}
export function mcpMarkerReady(path: string): boolean {
  try { const text = readFileSync(path, "utf8"); return /^\d+$/.test(text.trim()) || readMcpCatalog(path)?.ready === true; } catch { return false; }
}
interface Chain { generation: number; tainted: boolean; names: Set<string>; cursors: Set<string>; pages: number; pending: number }
/** One observed request: the pending entry a response is matched against. It is bound to the handle that observed it, never looked up by id alone. */
interface Entry { method: string; chain?: Chain; published: Promise<boolean>; id: string; retired?: boolean }
export interface Transaction { published: Promise<boolean>; commit(): Promise<boolean>; abort(): void }
const NOOP_TRANSACTION = (): Transaction => ({ published: Promise.resolve(true), commit: async () => true, abort() {} });
const noop = () => {};
const logCatalog = (text: string) => { try { process.stderr.write(`[mcp-catalog] ${text}\n`); } catch { /* stderr is gone */ } };
export function createMcpCatalogObserver(env: Record<string, string | undefined> = process.env) {
  const path = env[MCP_LISTED_FILE_ENV];
  if (env.MURAGE_MCP_LISTED_URL && !/^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/internal\/mcp-catalog\/[a-f0-9-]{36}$/.test(env.MURAGE_MCP_LISTED_URL)) throw new Error("Invalid catalog publication endpoint");
  const processGeneration = path ? basename(path).split(".")[0]! : "unobserved";
  // O1: nothing shared can reject. Every operation resolves true or false and writes one stderr line when it fails.
  let tail: Promise<unknown> = Promise.resolve();
  let revision = 0, generation = 0, resources: boolean | "unknown" = "unknown", ready = false;
  let snapshot: string[] | undefined;
  const active = new Set<Chain>();
  const pending = new Map<string, Entry>();
  const cursors = new Map<string, Set<Chain>>();
  const enqueue = (run: () => Promise<boolean>): Promise<boolean> => {
    const op = tail.then(run);
    tail = op.then(noop, noop);
    return op;
  };
  /** One attempt: its own revision (O2, assigned when the document is posted) and its own 5 s bound. */
  const attempt = async (content: Omit<McpCatalog, "v" | "processGeneration" | "revision" | "at">): Promise<boolean> => {
    const doc: McpCatalog = { v: 2, processGeneration, ...content, revision: ++revision, at: Date.now() };
    const endpoint = env.MURAGE_MCP_LISTED_URL;
    try {
      if (endpoint) {
        const token = ["MURAGE_COMMS_TOKEN", "MURAGE_MEMORY_TOKEN", "MURAGE_CONNECTORS_TOKEN", "MURAGE_CONTROL_TOKEN", "MURAGE_MCP_TOKEN"].map(name => turnSecret(name, env)).find(Boolean);
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token ?? ""}` }, body: JSON.stringify(doc), signal: AbortSignal.timeout(5_000) });
        await response.body?.cancel().catch(noop);
        if (!response.ok) { logCatalog(`publication refused (status ${response.status}) at revision ${doc.revision}`); return false; }
      } else writeCatalogDocument(path!, doc);
      return true;
    } catch (error) {
      logCatalog(`publication failed at revision ${doc.revision}: ${error instanceof Error ? error.name : "error"}`);
      return false;
    }
  };
  /** O3: a complete:true document is posted up to twice inside the one operation, so no later document can pass it. */
  const publish = (complete: boolean, catalogGeneration = generation): Promise<boolean> => {
    if (!path) return Promise.resolve(true);
    const content = { catalogGeneration, ready, complete, ...(snapshot ? { tools: snapshot } : {}), resources };
    return enqueue(async () => {
      for (let tries = complete ? 2 : 1; tries > 0; tries--) if (await attempt(content)) return true;
      return false;
    });
  };
  const dirty = () => publish(false);
  const endChain = (chain: Chain) => { chain.pending--; if (chain.pending === 0) active.delete(chain); };
  /** A request that will never be answered (cancelled, or its id reused): its chain ends tainted and no longer holds `active` open. */
  const retire = (entry: Entry) => {
    if (entry.retired) return;
    entry.retired = true;
    if (pending.get(entry.id) === entry) pending.delete(entry.id);
    if (entry.chain) { entry.chain.tainted = true; endChain(entry.chain); }
  };
  return {
    /** Resolves once every operation enqueued so far has settled. It never rejects. */
    flush: (): Promise<void> => tail.then(noop),
    /** The entry (when the frame is a request the catalog tracks) and the op of its dirty publication. */
    observeRequest(value: unknown): { entry?: Entry; published: Promise<boolean> } {
      const frame = frameOf(value), id = rpcId(frame?.id);
      if (!frame || !id || typeof frame.method !== "string") return { published: Promise.resolve(true) };
      if (frame.method === "initialize") {
        const stale = pending.get(id); if (stale) retire(stale);
        const entry: Entry = { method: "initialize", id, published: Promise.resolve(true) };
        pending.set(id, entry); return { entry, published: entry.published };
      }
      if (frame.method !== "tools/list") return { published: Promise.resolve(true) };
      let chain: Chain | undefined;
      const cursor = frame.params?.cursor;
      if (cursor === undefined) {
        chain = { generation: ++generation, tainted: active.size > 0, names: new Set(), cursors: new Set(), pages: 0, pending: 0 };
        for (const old of active) old.tainted = true;
        active.add(chain);
      } else {
        const owners = typeof cursor === "string" ? cursors.get(cursor) : undefined;
        if (owners?.size === 1) {
          chain = [...owners][0]!; cursors.delete(cursor);
          if (chain.cursors.has(cursor)) chain.tainted = true;
          chain.cursors.add(cursor);
        } else { for (const old of active) old.tainted = true; }
      }
      const stale = pending.get(id);
      if (stale) { for (const old of active) old.tainted = true; retire(stale); }
      if (chain) chain.pending++;
      const entry: Entry = { method: "tools/list", chain, id, published: Promise.resolve(true) };
      pending.set(id, entry); entry.published = dirty();
      return { entry, published: entry.published };
    },
    /** The engine cancelled the request: no response, no publication. Its chain ends tainted. */
    cancelRequest(entry: Entry | undefined) { if (entry) retire(entry); },
    /** Called before forwarding. The transaction belongs to exactly that response.
     * `bound` is the entry the response answers (null: this frame answers nothing the catalog tracks;
     * undefined: look the request up by id, for direct observer use). */
    beforeResponse(value: unknown, bound?: Entry | null): Transaction {
      const frame = frameOf(value);
      if (!frame) return NOOP_TRANSACTION();
      if (frame.method === "notifications/tools/list_changed") {
        for (const chain of active) chain.tainted = true;
        return { published: dirty(), commit: async () => true, abort() {} };
      }
      if (frame.method) return NOOP_TRANSACTION();
      if (bound === null) return NOOP_TRANSACTION();
      const id = rpcId(frame.id), request = bound ?? (id ? pending.get(id) : undefined);
      if (!request || pending.get(request.id) !== request) return NOOP_TRANSACTION();
      pending.delete(request.id);
      if (request.method === "initialize") {
        let settled = false;
        return { published: Promise.resolve(true), commit: async () => {
          if (settled) return true; settled = true;
          if (frame.result?.capabilities && !frame.error) resources = Object.hasOwn(frame.result.capabilities, "resources");
          return true;
        }, abort() { settled = true; } };
      }
      const chain = request.chain;
      if (!chain) return { published: Promise.all([request.published, dirty()]).then(([a, b]) => a && b), commit: async () => true, abort() {} };
      const tools = frame.result?.tools;
      const valid = !frame.error && Array.isArray(tools) && tools.every((t: unknown) => typeof frameOf(t)?.name === "string");
      if (!valid || ++chain.pages > 1000) chain.tainted = true;
      if (valid) for (const tool of tools) chain.names.add(tool.name);
      const cursor = frame.result?.nextCursor;
      if (cursor !== undefined && (typeof cursor !== "string" || chain.cursors.has(cursor))) chain.tainted = true;
      const own = chain.tainted ? dirty() : Promise.resolve(true);
      let flushed = false;
      return {
        published: Promise.all([request.published, own]).then(([a, b]) => a && b),
        commit: () => {
          if (flushed) return Promise.resolve(true);
          flushed = true; chain.pending--;
          if (valid && cursor === undefined) ready = true;
          if (typeof cursor === "string") {
            const owners = cursors.get(cursor) ?? new Set<Chain>(); owners.add(chain); cursors.set(cursor, owners);
            if (owners.size > 1) for (const owner of owners) owner.tainted = true;
            return publish(false, chain.generation);
          }
          if (chain.pending === 0) active.delete(chain);
          if (valid && !chain.tainted && active.size === 0) { snapshot = [...chain.names]; return publish(true, chain.generation); }
          return publish(false, chain.generation);
        },
        abort: () => {
          if (flushed) return;
          flushed = true; chain.tainted = true; endChain(chain);
        },
      };
    },
  };
}

/** The handle of one observed request. Delivery belongs to the handle, not to an id:
 * it writes at most one frame, and an engine that reuses an id gets a new handle. */
export interface McpRequest {
  published: Promise<boolean>;
  /** `stillWanted` is asked inside the writer's turn, synchronously before the frame is written: when it returns false
   * the frame is revoked (nothing is written, the transaction aborts) and the promise resolves. */
  respond(frame: unknown, replace?: (id: unknown) => unknown, options?: RespondOptions): Promise<void>;
  cancel(): void;
}
export interface RespondOptions { stillWanted?: () => boolean }
/** A failed output write is fatal to the caller, and is reported where it happens: the caller's own error fallback
 * (which answers through the same, already claimed handle and so writes nothing) can never swallow it. */
export function guardHandle(req: McpRequest, onOutputFailure: (error: unknown) => void): McpRequest {
  return { published: req.published, cancel: () => req.cancel(), respond: (frame, replace, options) => req.respond(frame, replace, options).catch(onOutputFailure) };
}
const lineOf = (frame: unknown): string => typeof frame === "string" ? frame.replace(/[\r\n]+$/, "") + "\n" : JSON.stringify(frame) + "\n";
/** The answer a request gets when the record of its catalog could not be published. */
export const publicationFailureFrame = (id: unknown) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "Murage could not record this server's tools. Try again in a moment." } });
const DEFAULT_PUBLICATION_FAILURE = publicationFailureFrame;

/** Direct proxy output uses the same observer as the generic bridge. */
export function createMcpCatalogWriter(env: Record<string, string | undefined> = process.env, output: Writable = process.stdout) {
  const observer = createMcpCatalogObserver(env);
  // Frames leave in the order send/respond was called. This tail covers only the write phase and never rejects.
  let outTail: Promise<void> = Promise.resolve();
  const emit = async (frame: unknown, bound: Entry | null | undefined, replace?: (id: unknown) => unknown, response = false, stillWanted?: () => boolean): Promise<void> => {
    let commit: Promise<boolean> = Promise.resolve(true);
    const turn = outTail.then(async () => {
      const t = observer.beforeResponse(frame, bound);
      const ok = await t.published;
      // Revocable until this point: everything from here to output.write is synchronous.
      if (stillWanted && !stillWanted()) { t.abort(); logCatalog("a response revoked before it was written was dropped"); return; }
      let out = frame;
      if (!ok && response) {
        t.abort();
        const id = frameIdOf(frame);
        // The replacer is caller code: it can never make send reject (only a broken output does).
        try { out = replace?.(id) ?? DEFAULT_PUBLICATION_FAILURE(id); } catch { out = DEFAULT_PUBLICATION_FAILURE(id); }
        logCatalog("a response whose catalog record failed was replaced by its error");
      }
      let line: string;
      try { line = lineOf(out); } catch {
        // A frame that cannot be serialised is not an output failure. A response is answered with its error, anything else is dropped.
        t.abort();
        if (!response) { logCatalog("a frame that cannot be serialised was dropped"); return; }
        line = lineOf(DEFAULT_PUBLICATION_FAILURE(frameIdOf(frame)));
        logCatalog("a response that cannot be serialised was replaced by its error");
        await new Promise<void>((resolve, reject) => output.write(line, error => error ? reject(error) : resolve()));
        return;
      }
      await new Promise<void>((resolve, reject) => {
        try {
          output.write(line, error => {
            if (error) { t.abort(); reject(error); return; }
            // Commit is enqueued here, inside the write callback and before the next writer turn starts; its completion is awaited outside outTail.
            if (ok || !response) commit = t.commit().catch(() => false);
            resolve();
          });
        } catch (error) { t.abort(); reject(error); }
      });
    });
    outTail = turn.then(noop, noop);
    await turn;
    if (!(await commit)) logCatalog("a completion publication failed after delivery; the next document is still written");
  };
  const frameIdOf = (frame: unknown) => (typeof frame === "string" ? frameOfSafe(frame) : (frame as Frame | undefined))?.id;
  return {
    /** Observe a request and take its handle. A frame with no method (an engine answer) gets an inert handle. */
    observeRequest(frame: unknown): McpRequest {
      const { entry, published } = observer.observeRequest(frame);
      const shape = plainFrame(frame);
      // A frame that is not a request (an engine answer, a notification) gets an inert handle: no request state, nothing it can write.
      if (!shape || typeof shape.method !== "string" || !rpcId(shape.id)) return { published, respond: () => { logCatalog("a response through an inert handle was dropped"); return Promise.resolve(); }, cancel: noop };
      let claimed = false;
      const claim = (what: string) => { if (claimed) { logCatalog(`${what} dropped: this request already has its answer`); return false; } claimed = true; return true; };
      const req: McpRequest = {
        published,
        respond: (answer, replace, options) => claim("a second response") ? emit(answer, entry ?? null, replace, true, options?.stillWanted) : Promise.resolve(),
        cancel: () => { if (claim("a cancel")) observer.cancelRequest(entry); },
      };
      return req;
    },
    /** Frames that answer no observed request: notifications, outgoing server requests, replies to server requests. */
    send: (frame: unknown): Promise<void> => emit(frame, null),
    flush: () => observer.flush(),
  };
}
const frameOfSafe = (value: string): Frame | undefined => frameOf(value);

function writeCatalogDocument(path: string, doc: McpCatalog): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(doc), { mode: 0o600 }); renameSync(temp, path);
}
const cloudCatalogTargets = new Map<string, { path: string; threadId: string; revision: number }>();
/** Read-only lifetime diagnostic, including registrations not yet attached to a child. */
export function cloudMcpCatalogRegistrationCount(): number { return cloudCatalogTargets.size; }
/** Cloud proxies cannot see the server's private /tmp. Register an opaque,
 * turn-bound destination; requests never supply a filesystem path. */
export function registerCloudMcpCatalog(path: string, threadId: string, origin: string): string {
  const key = randomUUID(); cloudCatalogTargets.set(key, { path, threadId, revision: 0 });
  return new URL(`/api/internal/mcp-catalog/${key}`, origin).href;
}
export function retireCloudMcpCatalog(path: string): void {
  for (const [key, target] of cloudCatalogTargets) if (target.path === path) cloudCatalogTargets.delete(key);
}
export function publishCloudMcpCatalog(key: string, threadId: string, value: unknown): boolean {
  const target = cloudCatalogTargets.get(key), doc = frameOf(value);
  if (!target || target.threadId !== threadId || !doc || doc.v !== 2 || doc.processGeneration !== basename(target.path).split(".")[0]
    || !Number.isSafeInteger(doc.revision) || doc.revision <= target.revision || !Number.isSafeInteger(doc.catalogGeneration)
    || typeof doc.complete !== "boolean" || typeof doc.ready !== "boolean" || typeof doc.at !== "number"
    || ![true, false, "unknown"].includes(doc.resources)
    || (doc.tools !== undefined && (!Array.isArray(doc.tools) || doc.tools.length > 100000 || doc.tools.some((name: unknown) => typeof name !== "string" || name.length > 1024)))
    || (doc.complete && !Array.isArray(doc.tools))) return false;
  const clean: McpCatalog = { v: 2, processGeneration: doc.processGeneration, revision: doc.revision, catalogGeneration: doc.catalogGeneration, at: doc.at, ready: doc.ready, complete: doc.complete, resources: doc.resources, ...(doc.tools ? { tools: doc.tools } : {}) };
  writeCatalogDocument(target.path, clean); target.revision = doc.revision; return true;
}

/** The frame as an object, without serialising it (a string is parsed; a value that is not a plain object is nothing). */
function plainFrame(frame: unknown): Frame | undefined {
  if (typeof frame === "string") return frameOfSafe(frame);
  return frame && typeof frame === "object" && !Array.isArray(frame) ? frame as Frame : undefined;
}
