// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 55 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): the fields
// each tool's call must carry, one table per driver, read by one shared
// reader after resolution and before any guard. The generic table applies
// only to a tool no driver table names. A field read here is the same field
// the driver's own readers use, so the card, the own-workspace check and the
// verdict see one value. Path sources are read as a UNION: every present
// source must be well formed, and one malformed value under any present
// source makes the whole call unread.

import { PATH_KEYS } from "../../shared/arg-vocabulary.ts";
import type { EngineKind, GrantCall, ResolvedCall } from "../../shared/app-action-grant.ts";
import { ownAppTool } from "../../shared/app-action-words.ts";
import { serviceToolName } from "../../shared/connected-app-names.ts";

export type ContractRead =
  | { ok: true; paths?: readonly string[] }
  | { ok: false; field: string };

type Input = Record<string, unknown>;
type Row = (input: Input) => ContractRead;

const isObject = (value: unknown): value is Input => !!value && typeof value === "object" && !Array.isArray(value);
const OK: ContractRead = { ok: true };
const bad = (field: string): ContractRead => ({ ok: false, field });

/** One field: `need` is required, `may` is checked only when present. */
function fields(spec: { need?: Record<string, Kind>; may?: Record<string, Kind> }): Row {
  return (input) => {
    for (const [key, kind] of Object.entries(spec.need ?? {})) if (!is(kind, input[key])) return bad(key);
    for (const [key, kind] of Object.entries(spec.may ?? {})) if (input[key] !== undefined && !is(kind, input[key])) return bad(key);
    return OK;
  };
}

type Kind = "string" | "integer" | "boolean" | "object" | "argv-or-string";

function is(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return isObject(value);
    case "argv-or-string": return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"));
  }
}

/** Every path under PATH_KEYS and (ACP) `locations[].path`, as a union. An
 * empty string, an object, or an array holding anything but strings under a
 * known key is unread, never "names no file". */
function pathUnion(input: Input, locations: unknown, keys: readonly string[] = PATH_KEYS): ContractRead {
  const paths: string[] = [];
  if (locations !== undefined) {
    if (!Array.isArray(locations)) return bad("locations");
    for (const location of locations) {
      if (!isObject(location) || typeof location.path !== "string" || !location.path) return bad("locations[].path");
      paths.push(location.path);
    }
  }
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value === "string" && value) paths.push(value);
    else if (Array.isArray(value) && value.length && value.every((item) => typeof item === "string" && item)) paths.push(...(value as string[]));
    else return bad(key);
  }
  return { ok: true, paths };
}

// ---------------------------------------------------------------------------
// The driver tables.

const CLAUDE: Record<string, Row> = {
  Bash: fields({ need: { command: "string" }, may: { timeout: "integer", description: "string" } }),
  Read: fields({ need: { file_path: "string" }, may: { offset: "integer", limit: "integer" } }),
  Edit: fields({ need: { file_path: "string", old_string: "string", new_string: "string" }, may: { replace_all: "boolean" } }),
  Write: fields({ need: { file_path: "string", content: "string" } }),
  MultiEdit: (input) => {
    if (typeof input.file_path !== "string") return bad("file_path");
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) return bad("edits");
    for (const edit of edits) {
      if (!isObject(edit) || typeof edit.old_string !== "string" || typeof edit.new_string !== "string") return bad("edits[]");
      if (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean") return bad("edits[].replace_all");
    }
    return OK;
  },
  NotebookEdit: fields({ need: { notebook_path: "string", new_source: "string" }, may: { cell_id: "string", cell_type: "string", edit_mode: "string" } }),
  Glob: fields({ need: { pattern: "string" }, may: { path: "string" } }),
  Grep: fields({
    need: { pattern: "string" },
    may: { path: "string", glob: "string", type: "string", output_mode: "string", "-A": "integer", "-B": "integer", "-C": "integer", head_limit: "integer", offset: "integer", "-i": "boolean", "-n": "boolean", multiline: "boolean" },
  }),
};

const CODEX: Record<string, Row> = {
  shell: fields({ need: { command: "argv-or-string" } }),
  edit: (input) => {
    const changes = input.changes;
    if (!Array.isArray(changes) || changes.length === 0) return bad("changes");
    const paths: string[] = [];
    for (const change of changes) {
      if (!isObject(change) || typeof change.path !== "string" || !change.path) return bad("changes[].path");
      paths.push(change.path);
    }
    return { ok: true, paths };
  },
  view_image: fields({ need: { path: "string" } }),
  read_file: fields({ need: { path: "string" } }),
  list_dir: fields({ may: { path: "string" } }),
  grep_files: fields({ need: { pattern: "string" }, may: { path: "string" } }),
  update_plan: () => OK,
};

const ACP: Record<string, (input: Input, call: GrantCall) => ContractRead> = {
  execute: (input) => (is("argv-or-string", input.command) ? OK : bad("rawInput.command")),
  edit: (input) => atLeast(pathUnion(withoutLocations(input), input.locations), 1),
  read: (input) => atLeast(pathUnion(withoutLocations(input), input.locations), 1),
  move: (input) => atLeast(pathUnion(withoutLocations(input), input.locations), 2),
  delete: (input) => atLeast(pathUnion(withoutLocations(input), input.locations), 1),
  search: () => OK,
  fetch: () => OK,
};

/** The ACP kinds whose contract also binds a stamped native tool filed under them. */
const STAMPED_KIND_ROWS = new Set(["execute", "edit", "delete"]);

const PI: Record<string, Row> = {
  bash: fields({ need: { command: "string" }, may: { timeout: "integer" } }),
  powershell: fields({ need: { command: "string" }, may: { timeout: "integer" } }),
  read: fields({ need: { path: "string" }, may: { offset: "integer", limit: "integer" } }),
  // the installed engine's edit takes `edits[]` of {oldText, newText}; the
  // single-pair spelling of earlier versions is read the same way
  edit: (input) => {
    if (typeof input.path !== "string") return bad("path");
    if (input.edits !== undefined) {
      if (!Array.isArray(input.edits) || input.edits.length === 0) return bad("edits");
      for (const edit of input.edits) if (!isObject(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") return bad("edits[]");
      return OK;
    }
    return typeof input.oldText === "string" && typeof input.newText === "string" ? OK : bad("oldText");
  },
  write: fields({ need: { path: "string", content: "string" } }),
  grep: fields({ need: { pattern: "string" }, may: { path: "string", glob: "string", ignoreCase: "boolean", literal: "boolean", context: "integer", limit: "integer" } }),
  find: fields({ need: { pattern: "string" }, may: { path: "string", limit: "integer" } }),
  ls: fields({ may: { path: "string", limit: "integer" } }),
};

function withoutLocations(input: Input): Input {
  const { locations: _locations, ...rest } = input;
  void _locations;
  return rest;
}

function atLeast(read: ContractRead, count: number): ContractRead {
  if (!read.ok) return read;
  return (read.paths?.length ?? 0) >= count ? read : bad(count > 1 ? "two paths" : "path");
}

/** The generic table: a tool no driver table names. */
function generic(name: string, input: Input): ContractRead {
  const app = ownAppTool(name);
  if (app === serviceToolName("APPS_MULTI_EXECUTE_TOOL")) {
    const tools = input.tools;
    if (!Array.isArray(tools) || tools.length === 0) return bad("tools");
    for (const row of tools) if (!isObject(row) || typeof row.tool_slug !== "string" || !isObject(row.arguments)) return bad("tools[]");
    return OK;
  }
  if (app !== undefined) return OK; // a connector lookup
  const bare = name.toLowerCase().replace(/^mcp__.+?__/, "");
  const parts = new Set(bare.split(/[^a-z0-9]+/).filter(Boolean));
  const deletes = (parts.has("delete") || parts.has("remove") || parts.has("trash")) && ["file", "files", "dir", "directory", "path"].some((word) => parts.has(word));
  if (deletes) return atLeast(pathUnion(input, undefined), 1);
  return OK;
}

/** Rule 55 for one engine tool by its own name, for a quiet path that runs before any verdict (Rules 55, 63.1): a missing or malformed
 *  required field is never an allow. A tool the table does not name reads through the generic table. */
export function engineToolFields(engine: "claude" | "codex" | "pi", name: string, input: unknown): ContractRead {
  if (!isObject(input)) return bad("input");
  const table = engine === "claude" ? CLAUDE : engine === "codex" ? CODEX : PI;
  const row = table[name];
  return row ? row(input) : generic(name, input);
}

/**
 * Rule 55's shared reader: whether the resolved call carries every field its
 * contract needs. Applied only for an ask a driver filed (`call.engine`).
 * A proven identity with no visible arguments is unread (Rule 7); a field the
 * driver reported missing (F5) is unread.
 */
export function requiredFields(engine: EngineKind | undefined, resolved: ResolvedCall, call: GrantCall | undefined): ContractRead {
  if (!engine) return OK;
  if (call?.inputMissing) return bad(call.inputMissing);
  if (resolved.kind === "unproven") return OK; // unproven already holds
  const input = resolved.kind === "unstamped" ? call?.toolCall?.input : resolved.input;
  if (input === undefined) return bad("input");
  if (!isObject(input)) return bad("input");
  if (resolved.kind === "mcp") return generic(`mcp__${resolved.name}`, input);
  if (resolved.kind === "engine" && engine === "acp") {
    // A native tool the engine stamped (Fuigo's or Grok Build's run_terminal_command,
    // write, delete) is held to the contract of the protocol kind it was filed under,
    // as an unstamped one is: an execute needs its command, an edit or delete a path.
    const kind = resolved.byKind ? resolved.name : !resolved.wrapped && STAMPED_KIND_ROWS.has(call?.toolKind ?? "") ? call!.toolKind! : undefined;
    const row = kind ? ACP[kind] : undefined;
    return row ? row(input, call ?? {}) : OK;
  }
  const name = resolved.kind === "engine" ? resolved.name : call?.toolCall?.name ?? "";
  const table = engine === "claude" ? CLAUDE : engine === "codex" ? CODEX : engine === "pi" ? PI : {};
  const row = table[name];
  return row ? row(input) : generic(name, input);
}
