// MCP server names the owner already declared in Codex's own config.toml.
//
// Murage mounts a bot's custom MCP servers as `-c mcp_servers.<name>.…`
// overrides on the app-server command line. Codex does not treat an override
// as a fresh definition: it MERGES it into any same-named table already in
// `config.toml`. Two things go wrong when the owner happens to have a server
// of their own under that name.
//
// 1. A stdio `command` laid over a remote `url` entry is a contradiction.
//    Codex rejects the whole file as "invalid configuration", so the turn dies
//    on config/read before the model is ever asked — and the failure names the
//    config, not the bot's MCP server, so it reads as a broken Codex install.
//
// 2. The keys Murage does NOT write survive from the owner's table. The one
//    that matters is `default_tools_approval_mode`: Murage mounts custom
//    servers with `preApproved = false` precisely so their tool calls arrive
//    as approval cards (see mountMcpServer in codex.ts). An `auto` left in the
//    owner's own entry silently cancels that, and nothing in Murage can see it
//    happen. `enabled = false` there is the mirror image — the bot's server is
//    mounted and then quietly never started.
//
// Neither case is the owner misconfiguring anything: both files are correct on
// their own, and the collision only exists because Murage reuses the name.
// So Murage gives its own mount a name of its own and leaves both definitions
// intact.
//
// Harness-owned mounts (`computer`, `browser`, `agents`, `murage_connectors`,
// `murage-memory`, `murage_phone`) are NOT handled here: a bot's custom server
// can never take one of those names, because mcp-registry.ts rejects them at
// the config boundary (RESERVED_MCP_NAMES).
import { createHash } from "node:crypto";
import { memoDeps, readText } from "./isolation-cache.ts";
import { join } from "node:path";

import type { McpMountRecord } from "../../shared/mount-identity.ts";

import { codexHome } from "./codex-catalog.ts";

/** A config.toml this module could not make sense of. Carries where the scan
 * gave up, never any of the file's content. */
export class TomlScanError extends Error {}

/** What the owner's Codex config says about MCP server names.
 *
 * `names` is an answer: these servers are declared and no others. An absent
 * config.toml is an honest empty `names` — a file that is not there cannot
 * declare anything.
 *
 * `unreadable` is the absence of an answer: the file is there and Murage could
 * not read or parse it, so it does not know which names are taken. */
export type DeclaredMcpServers =
  | { readonly kind: "names"; readonly names: ReadonlySet<string> }
  | { readonly kind: "unreadable"; readonly why: string };

const BARE = /[A-Za-z0-9_-]/;

/** Every `mcp_servers.<name>` in a Codex config.toml, whichever of TOML's
 * spellings names it. All of these define the same table, and the `-c` override
 * merges into it just the same:
 *
 *     [mcp_servers.fibery]        [mcp_servers."fibery"]   ["mcp_servers".fibery]
 *     [mcp_servers.fibery.env]    [[mcp_servers.fibery]]
 *     mcp_servers.fibery.url = "…"
 *     mcp_servers = { fibery = { url = "…" } }
 *     [mcp_servers]
 *     fibery = { url = "…" }
 *     fibery.url = "…"
 *
 * So this walks key paths rather than matching a header shape: a table header
 * sets the current path, every assignment extends it, and any path whose first
 * two segments are `mcp_servers` and a name records that name. Comments and
 * string bodies are stepped over by the walk itself, so a commented-out header
 * or a quoted key that merely contains the text (`[projects."/mcp_servers.x"]`)
 * cannot reach `record`.
 *
 * Throws {@link TomlScanError} rather than returning a short answer: a file
 * this cannot parse is not a file with no servers in it, and the difference
 * decides whether a bot's server is allowed to keep its name.
 *
 * Values are skipped, not interpreted. Over-collecting a name only moves a
 * server aside needlessly; under-collecting lets the merge happen, so where
 * this is inexact it is inexact towards collecting. */
export function mcpServerNamesInToml(toml: string): Set<string> {
  return scanMcpServers(toml).names;
}

/** One assignment inside an `mcp_servers.<name>` table: its key path below the
 * table and the value's text exactly as the file spells it (trimmed). */
export interface TomlAssignment {
  readonly key: readonly string[];
  readonly raw: string;
}

/** Every `mcp_servers.<name>` table of a Codex config.toml with ALL of its
 * assignments, however the file spells them (headers, dotted keys, inline
 * tables). Inline tables are walked into, so `env = { A = "1" }` and
 * `[mcp_servers.x.env]` / `A = "1"` give the same assignment. Nothing is
 * left out: the identity of an external server (Rule 54) covers every key.
 * Throws {@link TomlScanError} for a file this cannot parse. */
export function mcpServerTablesInToml(toml: string): Map<string, TomlAssignment[]> {
  return scanMcpServers(toml).tables;
}

function scanMcpServers(toml: string): { names: Set<string>; tables: Map<string, TomlAssignment[]> } {
  const names = new Set<string>();
  const tables = new Map<string, TomlAssignment[]>();
  const src = toml.charCodeAt(0) === 0xfeff ? toml.slice(1) : toml;
  const n = src.length;
  let i = 0;
  let table: string[] = [];

  const fail = (why: string): never => {
    throw new TomlScanError(`${why} at offset ${i}`);
  };

  // `mcp_servers.<name>` and anything below it names <name>.
  const record = (path: readonly string[]): void => {
    if (path.length >= 2 && path[0] === "mcp_servers" && path[1]) {
      names.add(path[1]);
      if (!tables.has(path[1])) tables.set(path[1], []);
    }
  };
  // A scalar or array value assigned under `mcp_servers.<name>`.
  const leaf = (path: readonly string[], raw: string): void => {
    if (path.length >= 2 && path[0] === "mcp_servers" && path[1]) tables.get(path[1])?.push({ key: path.slice(2), raw });
  };
  /** The value after `=`: an inline table is walked into (its own assignments
   * are the leaves), anything else is captured as written. */
  const assigned = (path: readonly string[]): void => {
    spaces();
    if (src[i] === "{") {
      value(path);
      return;
    }
    const start = i;
    value(path);
    leaf(path, src.slice(start, i).trim());
  };

  const spaces = (): void => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  };
  const comment = (): void => {
    if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
  };
  /** Whitespace, newlines and comments — the gaps between statements, and
   * inside arrays, where TOML allows all three. */
  const gap = (): void => {
    for (;;) {
      const before = i;
      spaces();
      comment();
      while (i < n && (src[i] === "\n" || src[i] === "\r")) i++;
      if (i === before) return;
    }
  };

  const basicString = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = src[i]!;
      if (c === "\\") {
        const e = src[i + 1];
        if (e === undefined) fail("unterminated escape");
        if (e === "u" || e === "U") {
          const width = e === "u" ? 4 : 8;
          const hex = src.slice(i + 2, i + 2 + width);
          if (hex.length < width || !/^[0-9A-Fa-f]+$/.test(hex)) fail("bad unicode escape");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + width;
          continue;
        }
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\n") fail("newline in string");
      out += c;
      i++;
    }
  };

  const literalString = (): string => {
    i++; // opening quote
    const end = src.indexOf("'", i);
    const nl = src.indexOf("\n", i);
    if (end < 0 || (nl >= 0 && nl < end)) fail("unterminated literal string");
    const out = src.slice(i, end);
    i = end + 1;
    return out;
  };

  /** A dotted key: `a`, `"a"`, `'a'`, `a.b`, `a."b c"`. Multi-line strings are
   * not keys, so a `"""` here is malformed rather than a key. */
  const keyPath = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      spaces();
      const c = src[i];
      if (c === '"') {
        if (src.startsWith('"""', i)) fail("multi-line string used as a key");
        parts.push(basicString());
      } else if (c === "'") {
        if (src.startsWith("'''", i)) fail("multi-line string used as a key");
        parts.push(literalString());
      } else if (c !== undefined && BARE.test(c)) {
        const start = i;
        while (i < n && BARE.test(src[i]!)) i++;
        parts.push(src.slice(start, i));
      } else {
        fail("expected a key");
      }
      spaces();
      if (src[i] === ".") {
        i++;
        continue;
      }
      return parts;
    }
  };

  const multilineString = (): void => {
    const quote = src.slice(i, i + 3);
    i += 3;
    for (;;) {
      const at = src.indexOf(quote, i);
      if (at < 0) fail("unterminated multi-line string");
      if (quote === '"""') {
        // an odd run of backslashes escapes the quote, so it does not close
        let back = at - 1;
        let slashes = 0;
        while (back >= 0 && src[back] === "\\") {
          slashes++;
          back--;
        }
        if (slashes % 2 === 1) {
          i = at + 1;
          continue;
        }
      }
      i = at + 3;
      // TOML lets up to two more of the same quote belong to the content
      for (let extra = 0; extra < 2 && src[i] === quote[0]; extra++) i++;
      return;
    }
  };

  /** Steps over a value. `path` is the key path it was assigned to, so an
   * inline table can go on recording names below it. */
  const value = (path: readonly string[]): void => {
    spaces();
    const c = src[i];
    if (c === undefined || c === "\n" || c === "\r") fail("missing value");
    if (c === "{") return inlineTable(path);
    if (c === "[") return array();
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) return multilineString();
    if (c === '"') {
      basicString();
      return;
    }
    if (c === "'") {
      literalString();
      return;
    }
    // number, boolean, date — runs to whichever delimiter comes first
    const start = i;
    while (i < n && !"\n\r,]}#".includes(src[i]!)) i++;
    if (i === start) fail("missing value");
  };

  const array = (): void => {
    i++; // [
    for (;;) {
      gap();
      if (i >= n) fail("unterminated array");
      if (src[i] === "]") {
        i++;
        return;
      }
      // nothing inside an array is an mcp_servers table
      value([]);
      gap();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "]") {
        i++;
        return;
      }
      fail("expected , or ] in array");
    }
  };

  function inlineTable(path: readonly string[]): void {
    i++; // {
    for (;;) {
      gap();
      if (i >= n) fail("unterminated inline table");
      if (src[i] === "}") {
        i++;
        return;
      }
      const full = [...path, ...keyPath()];
      record(full);
      spaces();
      if (src[i] !== "=") fail("expected = in inline table");
      i++;
      assigned(full);
      gap();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        return;
      }
      fail("expected , or } in inline table");
    }
  }

  for (;;) {
    gap();
    if (i >= n) break;
    if (src[i] === "[") {
      const arrayOfTables = src.startsWith("[[", i);
      i += arrayOfTables ? 2 : 1;
      const header = keyPath();
      record(header);
      table = header;
      spaces();
      const close = arrayOfTables ? "]]" : "]";
      if (!src.startsWith(close, i)) fail("unterminated table header");
      i += close.length;
    } else {
      const full = [...table, ...keyPath()];
      record(full);
      spaces();
      if (src[i] !== "=") fail("expected = after a key");
      i++;
      assigned(full);
    }
    spaces();
    comment();
    if (i < n && src[i] !== "\n" && src[i] !== "\r") fail("trailing text after a statement");
  }
  return { names, tables };
}

/** What the config.toml of the Codex home THIS child will use declares. The
 * env is the child's own, so `CODEX_HOME` is honoured exactly as the spawned
 * CLI will honour it.
 *
 * A config.toml that is not there is an empty answer, not a missing one: that
 * is the ordinary fresh-install case, and a file that does not exist declares
 * nothing. Anything else — unreadable, a directory in its place, not valid
 * UTF-8, TOML this module cannot parse — is `unreadable`, and the caller has
 * to treat every name as possibly taken.
 *
 * Answering "no names" there instead would be a guess in the one direction
 * that hurts. It lets the `-c` override merge into an owner entry Murage never
 * managed to look at, which is exactly how a bot's custom server inherits
 * `default_tools_approval_mode = "auto"` and stops raising approval cards, or
 * inherits `enabled = false` and is never started — both silent. The other
 * direction costs the server a different mount name: a different tool prefix
 * for the model and a fresh piece of per-server state in Codex. No capability
 * moves and no turn is refused, so that is the side to be wrong on. */
export function codexConfigMcpServerNames(env: Record<string, string | undefined>): DeclaredMcpServers {
  const path = join(codexHome(env), "config.toml");
  return memoDeps("codex-config-names", path, () => scanCodexConfig(path));
}

function scanCodexConfig(path: string): DeclaredMcpServers {
  let text: string;
  try {
    text = readText(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT/ENOTDIR: no such file, so nothing is declared in it.
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "names", names: new Set() };
    return { kind: "unreadable", why: code ?? "unreadable" };
  }
  try {
    return { kind: "names", names: mcpServerNamesInToml(text) };
  } catch {
    return { kind: "unreadable", why: "unparsable" };
  }
}

/** Mount name for each of a bot's custom servers, keyed by the bot's own name.
 * A server keeps its name unless the owner's Codex config already declares one
 * by that name — or Murage could not read that config at all, in which case
 * every name is treated as declared.
 *
 * Every value is distinct, and that is the whole reason this takes the servers
 * together rather than one at a time. An alias has to dodge three things, not
 * just the owner's file: the owner's declared names, the bot's OTHER custom
 * names, and the aliases already handed out in this same pass. Move `foo` aside
 * while the bot also has a server literally called `foo_murage` and both mount
 * under `mcp_servers.foo_murage` — the second `-c` override merges into the
 * first, which is the same silent capability merge this module exists to stop,
 * only now caused by Murage instead of the owner.
 *
 * Deterministic: the same inputs give the same mount names on every turn, so
 * Codex's per-server state stays with the right server. Insertion order of
 * `names` is part of that determinism, and it comes from the bot's stored
 * config, which is stable. */
export function mountedMcpServerNames(
  names: Iterable<string>,
  declared: DeclaredMcpServers,
): Map<string, string> {
  const wanted = [...names];
  // Seeded with the bot's own names so an alias never lands on a sibling that
  // is about to mount, or has already mounted, under that exact name. When the
  // owner's config is unreadable there is nothing else to seed it with: an
  // alias then dodges only what is known, and relies on `_murage` being
  // Murage's own suffix rather than one an owner would have typed.
  const taken = new Set<string>(wanted);
  if (declared.kind === "names") for (const name of declared.names) taken.add(name);
  const mounts = new Map<string, string>();
  for (const name of wanted) {
    if (declared.kind === "names" && !declared.names.has(name)) {
      mounts.set(name, name);
      continue;
    }
    let candidate = `${name}_murage`;
    for (let i = 2; taken.has(candidate); i++) candidate = `${name}_murage${i}`;
    taken.add(candidate);
    mounts.set(name, candidate);
  }
  return mounts;
}

/** The `external` F4 records (Rule 54) of the config.toml this spawn reads.
 *
 * `records` is an answer: these are the `mcp_servers.<name>` tables in the
 * file under the Codex home in effect that Murage did not write, and no
 * others. An absent file declares nothing. `unreadable` is the absence of an
 * answer: the turn then states no mount list at all, so every MCP ask on it
 * resolves unproven. */
export type ExternalMcpRecords =
  | { readonly kind: "records"; readonly records: McpMountRecord[] }
  | { readonly kind: "unreadable"; readonly why: string };

/** One record per `mcp_servers.<name>` table of `<CODEX_HOME in effect>/config.toml`
 * whose name is not in `written` (the mounts Murage's own `-c` overrides
 * name). The mountId digest is sha256 (first 16 hex) over the canonical
 * serialization of the WHOLE table (every key and value, sorted, nothing left
 * out), the file path and the Codex home, so a change to `env`,
 * `bearer_token_env_var`, `http_headers`, `cwd` or any key added later is a
 * new identity, and the same name under two homes is two identities.
 * A name holding `__` gets no record: it cannot be told apart from its tools
 * (Rule 11), and the owner's server is switched off for the bot anyway. */
export function externalMcpRecords(
  env: Record<string, string | undefined>,
  written: ReadonlySet<string>,
): ExternalMcpRecords {
  const home = codexHome(env);
  const path = join(home, "config.toml");
  const scanned = memoDeps("codex-config-tables", path, (): { ok: true; tables: Map<string, TomlAssignment[]> } | { ok: false; why: string } => {
    let text: string;
    try {
      text = readText(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, tables: new Map() };
      return { ok: false, why: code ?? "unreadable" };
    }
    try {
      return { ok: true, tables: mcpServerTablesInToml(text) };
    } catch {
      return { ok: false, why: "unparsable" };
    }
  });
  if (!scanned.ok) return { kind: "unreadable", why: scanned.why };
  const records: McpMountRecord[] = [];
  for (const [name, assignments] of scanned.tables) {
    if (written.has(name) || name.includes("__")) continue;
    const table = assignments
      .map((a) => JSON.stringify([a.key, a.raw]))
      .sort();
    const digest = createHash("sha256")
      .update(JSON.stringify({ table, file: path, home }))
      .digest("hex")
      .slice(0, 16);
    records.push({ engineName: name, mountId: `external:codex:${digest}:${name}`, provenance: "external" });
  }
  return { kind: "records", records };
}
