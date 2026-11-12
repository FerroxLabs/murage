// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT 1.0.20 server fill (design r4 3.2 M2/M3, 6.3, C2): what index.ts calls at an engine tool's
// item.started and when it builds an ask's AutoContext. Fail closed: any engine tool that is not local marks, every
// own tool but the clean readers marks, a shell text the marking scan hits (or an empty one) marks.
import { OWN_BUILTINS } from "../shared/own-servers.ts";
import { commandCwdFromToolInput, commandFromToolInput } from "../shared/exact-command.ts";
import type { AutoContext } from "./auto-approve.ts";
import {
  downloadRegistry, markTurnOutside, noteSessionEdits, noteSessionWrote, outsideTurnKey, ownWrite, ownWritten, readOnlySoFar, runningOutsideInstance, sessionEdits,
  SESSION_EDITS_OVERFLOW, turnBegunAt, turnOutsideExempt, turnOutsideRead, type OutsideSource,
} from "./email/external-marks.ts";
import { engineEnvDenied, enginePathOf, installPrograms, scanFailClosed, noteEnginePath, outsideScanMarks, readOnlyShape, type DiskProbe, type OutsideScanHooks, type ReadOnlyHooks } from "./outside-scan.ts";
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { TextBudget, type DlLabel, type DownloadRegistry, type FsHooks, type MatchOptions, type RegistryEntry } from "./download-registry.ts";
import { nodeFsHooks, scanRegistryHook, scanRepoHook } from "./outside-dl.ts";
import { registerText, registerToolWrite } from "./outside-register.ts";

/** M2 LOCAL_TOOLS (closed): Claude names, Codex item types (lower case). */
const LOCAL_NAMES: ReadonlySet<string> = new Set([
  "read", "write", "edit", "multiedit", "notebookedit", "notebookread", "glob", "grep", "ls", "todowrite", "bash", "bashoutput",
  "killshell", "exitplanmode", "commandexecution", "filechange", "reasoning", "plan",
  // 1.0.19 A6: Codex's shell identity and the stamped engine shell; 4.6: Claude's own local tools
  "shell", "run_terminal_command", "run_terminal_cmd", "askuserquestion", "skill", "slashcommand", "enterplanmode",
]);
/** M2: ACP `toolKind` values that are local (contracts.ts). */
const LOCAL_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "switch_mode"]);
const SHELL_NAMES: ReadonlySet<string> = new Set(["bash", "commandexecution", "shell", "run_terminal_command", "run_terminal_cmd"]);
/** 1.0.19 O1: the engine's own stamp namespaces (Fuigo; Grok Build's three map to these, grok.ts toolStamp). A tool stamped
 *  with one is the engine's builtin, never an outside server. */
const ENGINE_OWN_NAMESPACES: ReadonlySet<string> = new Set(["fuigo_build", "fuigo_build_concise", "fuigo_build_hashline"]);
/** O1: the builtin's canonical stamp kind (fuigo-tools ToolKind, snake_case) as an ACP kind, or the source it marks. */
const ENGINE_OWN_KINDS: Readonly<Record<string, string | OutsideSource>> = {
  read: "read", list_dir: "search", list: "search", search: "search", lsp: "read", memory_search: "read", memory_get: "read",
  edit: "edit", write: "edit", delete: "delete", move: "move", execute: "execute",
  plan: "think", enter_plan: "think", exit_plan: "think", ask_user: "think", search_tool: "think", skill: "read",
  background_task_action: "think", wait_tasks_action: "think", kill_task_action: "think", monitor: "think", goal_update: "think",
  web_search: "web search", web_fetch: "web page", task: "helper", active_agent_message: "helper", workflow: "helper",
};
/** O1: a stamped builtin that carries no kind, by its wire name (fuigo-tools tool_taxonomy wire names; rig assert pending). */
const ENGINE_OWN_NAMES: Readonly<Record<string, string>> = {
  read_file: "read", read: "read", grep: "search", glob: "search", list_dir: "search", ls: "search", file_search: "search",
  write: "write", write_file: "write", edit: "edit", edit_file: "edit", search_replace: "edit", hashline_edit: "edit", apply_patch: "edit",
  delete_file: "delete", run_terminal_command: "execute", run_terminal_cmd: "execute", bash: "execute", todo_write: "plan",
  todowrite: "plan", ask_user_question: "ask_user", web_search: "web_search", web_fetch: "web_fetch", search_tool: "search_tool",
};
/** M1 OWN_READ_CLEAN (closed): pure readers of the owner's or this bot's own saved state or fixed Murage text. */
const OWN_READ_CLEAN: ReadonlySet<string> = new Set([
  "list_bots", "get_bot", "get_permission_status", "list_routines", "list_reference_packs", "list_prompt_blocks", "get_prompt_block",
  "list_image_models", "murage_help", "dweb_status",
]);
const OWN_SERVERS: readonly string[] = Object.values(OWN_BUILTINS).map((name) => name.toLowerCase());
/** An own mount's server name: the builtin name, or the builtin name with its per-install suffix (`murage-memory-<hex>`). */
const ownServer = (server: string) => OWN_SERVERS.some((name) => server === name || new RegExp(`^${name.replace(/[-]/g, "\\-")}-[0-9a-f]{8,}$`).test(server));
const ownCleanRead = (server: string, tool: string) => ownServer(server) && OWN_READ_CLEAN.has(tool);
/** 6.3: calls that read only (no session write): local readers by name or kind. */
const READ_NAMES: ReadonlySet<string> = new Set(["read", "notebookread", "glob", "grep", "ls", "todowrite", "exitplanmode", "reasoning", "plan", "webfetch", "websearch",
  "askuserquestion", "skill", "slashcommand", "enterplanmode"]);
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "switch_mode", "fetch"]);

export interface ToolStart {
  origin: "engine" | "murage";
  title?: string;
  input?: unknown;
  toolKind?: string;
  toolIdentity?: { namespace?: string; name?: string; kind?: string };
  /** ACP (Astra r1 4): the title is the qualified tool a wrapper call names in its arguments, not the engine's own title */
  wrapped?: boolean;
  /** 1.0.19 4.5: the paths an ACP call's `locations` name (read with the input's own paths) */
  paths?: string[];
  /** Astra r1 H3: the call named more locations than `paths` holds, so it is judged closed */
  pathsOverflow?: boolean;
  /** 1.0.19 A3: the call's key (ACP toolCallId, Claude tool + sorted input, Codex item id); the mark it sets carries it */
  callKey?: string;
  lateFrame?: boolean;
}

/** The call's identity: an outside or own `server`, or `engine` (O1: the engine's own stamped builtin, with its kind as an
 *  ACP kind in `kind`, or the source it marks in `mark`). */
interface Split { server?: string; tool: string; engine?: boolean; kind?: string; mark?: OutsideSource }
function split(item: ToolStart, options: ToolJudgeOptions = {}): Split {
  const raw = (item.toolIdentity?.name ?? item.title ?? "").trim();
  const namespace = item.toolIdentity?.namespace?.trim();
  if (namespace && ENGINE_OWN_NAMESPACES.has(namespace.toLowerCase())) return engineOwnSplit(item, raw.toLowerCase());
  if (namespace) return { server: namespace.toLowerCase(), tool: raw.toLowerCase() };
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(raw);
  if (mcp) return { server: mcp[1]!.toLowerCase(), tool: mcp[2]!.toLowerCase() };
  // Astra r1 (4): an ACP engine's raw title is its own display text (a command, a path), not a qualified name; only the
  // tool a wrapper names (`wrapped`) is read as `server__tool` or `server.tool`
  if (options.acpRaw) {
    const qualified = item.wrapped === true ? /^([^./]+?)(?:__|[./])(.+)$/.exec(raw) : null;
    return qualified ? { server: qualified[1]!.toLowerCase(), tool: qualified[2]!.toLowerCase() } : { tool: raw.toLowerCase() };
  }
  const dotted = /^([^./]+)[./](.+)$/.exec(raw);
  if (dotted) return { server: dotted[1]!.toLowerCase(), tool: dotted[2]!.toLowerCase() };
  return { tool: raw.toLowerCase() };
}

/** O1: a builtin stamped with the engine's own namespace. `use_tool` is judged on the tool it wraps (a qualified name is
 *  that server's tool; a bare one is a builtin by name). Otherwise the stamp's kind, else the ACP kind, else the wire name
 *  table; a builtin none of them names marks `outside tool`. */
function engineOwnSplit(item: ToolStart, tool: string): Split {
  if (tool === "use_tool") {
    const wrapped = item.wrapped === true ? (item.title ?? "").trim() : "";
    const qualified = /^mcp__(.+?)__(.+)$/i.exec(wrapped) ?? /^([^./]+?)(?:__|[./])(.+)$/.exec(wrapped);
    if (qualified) return { server: qualified[1]!.toLowerCase(), tool: qualified[2]!.toLowerCase() };
    if (!wrapped) return { tool, engine: true, mark: "outside tool" };
    return engineOwnSplit({ ...item, wrapped: false, toolIdentity: { namespace: "fuigo_build", name: wrapped } }, wrapped.toLowerCase());
  }
  const stampKind = item.toolIdentity?.kind?.toLowerCase() || ENGINE_OWN_NAMES[tool];
  const own = stampKind ? ENGINE_OWN_KINDS[stampKind] : undefined;
  const acpKind = item.toolKind?.toLowerCase();
  if (own === undefined) {
    if (acpKind && (LOCAL_KINDS.has(acpKind) || acpKind === "fetch")) return { tool, engine: true, kind: acpKind };
    return { tool, engine: true, mark: "outside tool" };
  }
  if (!LOCAL_KINDS.has(own)) return { tool, engine: true, mark: own as OutsideSource };
  // the ACP kind says fetch: the builtin brings a page in, whatever its stamp
  if (acpKind === "fetch") return { tool, engine: true, kind: "fetch" };
  return { tool, engine: true, kind: own };
}

/** 4.5: the call's input with the paths its `locations` name, so classification, DL and registration read them too. */
function inputOf(item: ToolStart): unknown {
  if (!item.paths?.length) return item.input;
  const base = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input as Record<string, unknown> : {};
  const own = Array.isArray(base.paths) ? base.paths.filter((p): p is string => typeof p === "string") : [];
  return { ...base, paths: [...item.paths, ...own] };
}
/** The kind a call is judged by: an engine builtin's own (O1), else the ACP kind. */
const kindOf = (item: ToolStart, s: Split): string | undefined => (s.engine ? s.kind : item.toolKind?.toLowerCase());

/** 4.4: an unstamped `search` names a local target (a path, folder, glob or pattern field), no URL and no `query`. */
const SEARCH_LOCAL_FIELDS = ["path", "dir", "directory", "pattern", "glob", "include", "file_pattern", "paths"];
function localSearch(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if ("query" in record) return false;
  if (readInputShape(input) === "url") return false;
  return SEARCH_LOCAL_FIELDS.some((field) => {
    const value = record[field];
    return (typeof value === "string" && value.trim() !== "") || (Array.isArray(value) && value.some((v) => typeof v === "string" && v));
  });
}

/** v1 Astra r1 (4): the kindless names an ACP call may carry and still be a local reader, when it names a local path and no URL. */
const ACP_RAW_READERS: ReadonlySet<string> = new Set(["read", "notebookread", "glob", "grep", "ls"]);

/** How a call is read. `acpRaw` (Astra r1 (4)): the call is an ACP engine's own protocol fields (the raw title or the
 *  qualified tool a wrapper names, rawInput, kind, stamp), not a display label, and a missing kind with no stamp marks
 *  unless the call is a local reader by the F5 rule. */
export interface ToolJudgeOptions {
  acpRaw?: boolean;
  /** GrokBuild review (NOLIMITS 1.0.18): the disk the shell scan reads (scanDisk), when the turn's folder is known. */
  scan?: ScanDisk;
}
/** The disk part of the shell scan's hooks (scanDisk). */
export type ScanDisk = Pick<OutsideScanHooks, "cwd" | "home" | "probe" | "lookupProgram" | "temp" | "xdgConfig" | "sessionEdits" | "engineEnv">;
/** The 2-byte native executable headers: ELF, Mach-O (32/64, both byte orders, fat), PE. */
const NATIVE_HEADS = new Set(["7f45", "cffa", "cefa", "feed", "cafe", "beba", "4d5a"]);

/** GrokBuild #5, #6, #8, #10, #12-#14, #17: the scan's disk for a text run in `cwd` (absolute) on this thread's turn. One stat
 *  (following symlinks) and one realpath per path; the first two bytes of a regular file when asked. A missing path is null;
 *  any other error throws, and the caller's catch marks. `fresh`: changed since the running turn began (2 s slack). */
export function scanDisk(threadId: string, cwd: string | undefined): ScanDisk {
  if (!cwd || !isAbsolute(cwd)) return {};
  const begun = turnBegunAt(threadId);
  const probe = (absolute: string, magic: boolean): DiskProbe | null => {
    const stat = (() => {
      try { return statSync(absolute); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    })();
    if (stat === null) return null;
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    const fresh = begun !== undefined && Math.max(stat.mtimeMs, stat.ctimeMs) >= begun - 2000;
    let zip = false;
    let native = false;
    if (magic && kind === "file") {
      const fd = openSync(absolute, "r");
      try {
        const head = Buffer.alloc(2);
        if (readSync(fd, head, 0, 2, 0) === 2) { zip = head[0] === 0x50 && head[1] === 0x4b; native = NATIVE_HEADS.has(head.toString("hex")); }
      } finally { closeSync(fd); }
    }
    return { kind, real: realpathSync.native(absolute), fresh, zip, native };
  };
  const xdg = process.env.XDG_CONFIG_HOME;
  // Astra acct5 r1 H1: the files this engine session wrote (noteSessionEditsOf, any turn, clean or marked): running one marks.
  // A session past the cap holds the overflow key, and then every interpreter or shell text marks (engineEnv).
  const instanceId = runningOutsideInstance(threadId);
  const edits = instanceId ? sessionEdits(threadId, instanceId) : undefined;
  const lexical = lookupProgramFor(threadId, cwd);
  return {
    cwd, home: homedir(), probe, lookupProgram: (name) => resolvedProgram(lexical(name), cwd), temp: [tmpdir()], ...(xdg ? { xdgConfig: xdg } : {}),
    ...(edits?.size ? { sessionEdits: edits } : {}), ...(edits?.has(SESSION_EDITS_OVERFLOW) ? { engineEnv: true } : {}),
  };
}
/** Astra acct5 r1 H1: at most this many paths per engine session; past it the session holds SESSION_EDITS_OVERFLOW. */
const SESSION_EDITS_MAX_PATHS = 4096;
/** Astra L1 r6: each path may now bring two more spellings (normalized, real), so the entry cap is three times the path cap.
 *  The session overflows only once it holds as many entries as 4096 paths with every extra can: never earlier, in paths, than before. */
const SESSION_EDITS_MAX = SESSION_EDITS_MAX_PATHS * 3;
/** Astra acct5 r1 H1: every path an engine file tool writes is recorded on its session at the call's start, on a clean turn
 *  as on a marked one, so a later run of that file (this turn or a later one) marks through the scan's `sessionEdits`. A
 *  relative path is placed against the call's folder; one that cannot be placed (no folder) puts the session past its cap. */
function noteSessionEditsOf(threadId: string, item: ToolStart, cwd: string | undefined, options: ToolJudgeOptions): void {
  const instanceId = runningOutsideInstance(threadId);
  if (!instanceId) return;
  const s = split(item, options);
  if (s.server !== undefined) return;
  const kind = kindOf(item, s);
  if (!(kind !== undefined && kind !== "" ? WRITE_KINDS.has(kind) : WRITE_NAMES.has(s.tool))) return;
  const edits = sessionEdits(threadId, instanceId);
  if (edits.has(SESSION_EDITS_OVERFLOW)) return;
  const seenPaths = new Set<string>();
  const budget: RealBudget = { left: REALPATH_BUDGET };
  for (const p of toolPaths(inputOf(item))) {
    const absolute = isAbsolute(p) ? p : cwd && isAbsolute(cwd) ? join(cwd, p) : undefined;
    if (absolute === undefined) { noteSessionEdits(threadId, instanceId, [SESSION_EDITS_OVERFLOW]); return; }
    // Astra L1 r7 Medium: the path and its new spellings are ONE journal line (noteSessionEdits), never one write per spelling.
    const list = [absolute];
    // Fable (S4-INTERP-L1): the scan compares exact strings, so the same file under another spelling must be held too: the
    // normalized spelling and the realpath. Only adds. Each extra counts inside the cap like any path (past it: overflow).
    // Astra L1 r4 Medium: a repeated path is looked up once, and one call has one shared budget of realpath attempts. Past it
    // the paths still get their own and normalized spellings (no disk), only the realpath extra is skipped (Astra r5: never
    // overflow or drop a path here, that would lose the edit).
    if (!seenPaths.has(absolute)) {
      seenPaths.add(absolute);
      for (const extra of otherSpellings(absolute, budget)) if (!edits.has(extra)) list.push(extra);
    }
    const newCount = new Set(list.filter((entry) => !edits.has(entry))).size;
    if (edits.size + newCount > SESSION_EDITS_MAX) { noteSessionEdits(threadId, instanceId, [SESSION_EDITS_OVERFLOW]); return; }
    noteSessionEdits(threadId, instanceId, list);
  }
}
/** Astra L1 r4 Medium: the realpath attempts one tool call may spend (the first lookup counts); past it no lookup is made. */
const REALPATH_BUDGET = 64;
interface RealBudget { left: number }
function budgeted(budget: RealBudget, file: string): string {
  if (budget.left <= 0) throw new Error("realpath budget spent");
  budget.left--;
  return realpathSync.native(file);
}
/** A path that does not exist yet (a tool may create its folders): the realpath of its nearest existing ancestor, resolved
 *  before any `..` is collapsed, plus the remaining segments. At most 64 steps up; a failure adds nothing. */
function realOfMissing(absolute: string, budget: RealBudget): string | undefined {
  const tail: string[] = [];
  let at = absolute;
  for (let step = 0; step < 64; step++) {
    const parent = dirname(at);
    tail.unshift(basename(at));
    if (parent === at) return undefined;
    try { return join(budgeted(budget, parent), ...tail); } catch { if (budget.left <= 0) return undefined; at = parent; }
  }
  return undefined;
}
/** The normalized spelling and the realpath of an absolute path (the file need not exist yet: then its folder's realpath plus
 *  the name). Synchronous; a failing realpath adds nothing. */
function otherSpellings(absolute: string, budget: RealBudget): string[] {
  const out: string[] = [];
  const normalized = normalize(absolute);
  if (normalized !== absolute) out.push(normalized);
  let real: string | undefined;
  try { real = budgeted(budget, absolute); } catch { real = realOfMissing(absolute, budget); }
  if (real !== undefined && real !== absolute && real !== normalized) out.push(real);
  return out;
}

/** M2 / M3 / M1 (coarse): the source an engine tool start marks, or null when it is local and its shell text (if any)
 *  does not hit the marking scan. Murage's own wait lines (origin "murage") are not engine tools and do not mark here. */
export function toolStartOutside(item: ToolStart, dl?: DlScan, options: ToolJudgeOptions = {}): OutsideSource | null {
  if (item.origin !== "engine") return null;
  const s = split(item, options);
  const { server, tool } = s;
  // 1.0.19 4.2: an own server's tool never marks at the item, whatever its name: M1 marks by evidence in its handler (the
  // own-tool gate). Only a server that is not Murage's own marks here.
  if (server !== undefined) return ownServer(server) ? null : "outside tool";
  if (s.mark) return s.mark;
  if (tool === "webfetch" || (!s.engine && tool === "web_fetch")) return "web page";
  if (tool === "websearch" || (!s.engine && tool === "web_search")) return "web search";
  const kind = kindOf(item, s);
  const input = inputOf(item);
  // O1: the engine's own builtin with the fetch kind brings a page in (an unstamped fetch kind marks below, as before)
  if (s.engine && kind === "fetch") return "web page";
  // O1: a stamped reader that names a URL fetches it
  if (s.engine && (kind === "read" || kind === "search") && readInputShape(input) === "url") return "web page";
  if (options.acpRaw && (kind === undefined || kind === "") && item.toolIdentity === undefined) {
    const shape = readInputShape(input);
    if (shape === "url") return "web page";
    if (!(ACP_RAW_READERS.has(tool) && shape === "local")) return "outside tool";
  }
  // v1 F5: an ACP item with no tool identity stamp (Gemini, Cursor) says only its kind, so `search` may be a web search
  // and `read` may fetch a URL. 1.0.19 4.4: search is local when it names a local target and no URL or query; read is
  // local only when it names a local path (its input or its locations) and no URL
  if (kind !== undefined && kind !== "" && item.toolIdentity === undefined) {
    if (kind === "search" && !localSearch(input)) return "web search";
    if (kind === "read") {
      const shape = readInputShape(input);
      if (shape === "url") return "web page";
      if (shape === "none") return "outside tool";
    }
  }
  const local = kind !== undefined && kind !== "" ? LOCAL_KINDS.has(kind) : LOCAL_NAMES.has(tool);
  if (!local) return "outside tool";
  // Astra r1 H3: a call whose locations overflowed the cap is never judged on part of them: anything registered marks
  if (item.pathsOverflow && dl) return "downloaded file";
  if (SHELL_NAMES.has(tool) || kind === "execute") {
    const text = commandFromToolInput(item.input);
    if (text === undefined || text.trim() === "") return "outside tool";
    // GrokBuild #16: an engine started with a DENY_ENV variable marks every interpreter or shell text
    const hooks: OutsideScanHooks = { ...(options.scan ?? {}), ...(dl ? dlHooks(dl) : {}), ...(engineEnvDenied() ? { engineEnv: true } : {}) };
    return outsideScanMarks(text, hooks)[0] ?? null;
  }
  // v1 V4 (c), DL 4: a local file tool Matches each path it names, or the folder it runs in when it names none
  if (dl && (kind !== undefined && kind !== "" ? FILE_TOOL_KINDS.has(kind) : FILE_TOOL_NAMES.has(tool))) {
    const hit = fileToolMatch(input, tool, dl, kind);
    if (hit) return hit;
    // v1 F6: Claude loads a CLAUDE.md beside a file it reads, in each folder from the cwd down to that file
    if (kind === undefined || kind === "") return claudeNestedInstructionMark(input, tool, dl);
  }
  return null;
}

/** 1.0.19 A5: the drivers on drivers/acp/core.ts, whose every call core.ts judges on its protocol fields at the source
 *  (setAcpOutsideHooks). The server does not judge their item.started chip again (index.ts). */
export const ACP_SOURCE_JUDGED_DRIVERS: readonly string[] = [
  "fuigoAgent", "grokAgent", "geminiAgent", "cursorAgent", "kimiAgent", "droidAgent", "customAcp", "clineAgent", "opencodeGo",
];
export function acpJudgedAtSource(driverKind: string | undefined): boolean {
  return driverKind !== undefined && ACP_SOURCE_JUDGED_DRIVERS.includes(driverKind);
}

/** F5: what an unstamped `read` names. `url`: any value is a URL (or `www.`); `local`: a value is a path (absolute, `~`,
 *  a drive, or the value of a path-named field); `none`: neither. Two levels deep, arrays included. */
const URL_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const LOCAL_VALUE = /^(?:\/|~(?:[\\/]|$)|\.{1,2}[\\/]|[a-zA-Z]:[\\/])/;
const PATH_FIELD = /path|file|dir|folder|location/i;
function readInputShape(input: unknown): "url" | "local" | "none" {
  let local = false;
  let url = false;
  const visit = (value: unknown, field: string, depth: number): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (URL_VALUE.test(text)) url = true;
      else if (text !== "" && (LOCAL_VALUE.test(text) || PATH_FIELD.test(field))) local = true;
      return;
    }
    if (depth >= 2 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const one of value.slice(0, 64)) visit(one, field, depth + 1); return; }
    for (const [key, one] of Object.entries(value as Record<string, unknown>).slice(0, 64)) visit(one, key, depth + 1);
  };
  visit(input, "", 0);
  return url ? "url" : local ? "local" : "none";
}

/** F6: one folder listing (name and whether it is a folder; a link counts as a folder). Null when the folder is gone;
 *  any other failure throws (fail closed at the caller). */
export type ListDir = (p: string) => Array<{ name: string; dir: boolean }> | null;
export const nodeListDir: ListDir = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() || entry.isSymbolicLink() }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
};
const INSTRUCTION_SET = (): ReadonlySet<string> => new Set(INSTRUCTION_NAMES.map((name) => name.toLowerCase()));
/** F6: at most this many folders between the cwd and a read path; a deeper path marks. */
const NESTED_MAX_FOLDERS = 64;

/** v1 F6 (Claude): a local file tool on Claude also loads the instruction files in each folder from the cwd down to the
 *  path it reads (or the folder it searches). Each one found is Matched (a span, a window, an entry); a listing that
 *  fails, a path too deep, or a spent budget marks. A path outside the cwd checks its own folder. */
function claudeNestedInstructionMark(input: unknown, tool: string, dl: DlScan): DlLabel | null {
  const list = dl.listDir ?? nodeListDir;
  const names = INSTRUCTION_SET();
  const options = matchOptions(dl);
  const root = dl.cwd.replace(/[\\/]+$/, "") || "/";
  const paths = toolPaths(input);
  const targets = paths.length ? paths.map((p) => (SEARCH_TOOLS.has(tool) ? p : dirname(p))) : [];
  try {
    for (const target of targets) {
      if (!isAbsolute(target)) continue;
      const rel = relative(root, target);
      const chain: string[] = [];
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) chain.push(target);
      else {
        const parts = rel.split(/[\\/]+/).filter(Boolean);
        if (parts.length > NESTED_MAX_FOLDERS) return "cloned folder";
        // the cwd itself was checked at turn start (V2); each folder below it on the way to the path
        for (let i = 1; i <= parts.length; i++) chain.push(join(root, ...parts.slice(0, i)));
      }
      for (const folder of chain) {
        const entries = list(folder);
        if (!entries) continue;
        for (const entry of entries) {
          if (!names.has(entry.name.toLowerCase())) continue;
          if (dl.registry.matchPath(join(folder, entry.name), options)) return "cloned folder";
        }
        if (dl.budget.spent()) return "cloned folder";
      }
    }
  } catch {
    return "cloned folder";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// NOLIMITS v1 V4 (designs/NOLIMITS-V1-CUT.md): the built registration and DL Match, wired at the server seams.

/** DL 4: local file tools whose paths are Matched (Claude names, Codex `fileChange`; 4.6 / Astra r1 H5: Claude `Skill`, by
 *  the folder it loads), and the ACP kinds that read. */
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "notebookread", "edit", "multiedit", "grep", "glob", "ls", "filechange", "skill"]);
const FILE_TOOL_KINDS: ReadonlySet<string> = new Set(["read", "search", "edit"]);
/** DL 2c: a tool that searches the folder it is given (or the cwd). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "glob", "ls", "search"]);
/** R5: engine file tools that write a path. */
const WRITE_NAMES: ReadonlySet<string> = new Set(["write", "edit", "multiedit", "notebookedit", "filechange"]);
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/** One text's DL inputs: the registry, the folder it runs in, one TextBudget, the PATH folders (2c). */
export interface DlScan { registry: DownloadRegistry; cwd: string; home: string; budget: TextBudget; pathFolders: readonly string[]; listDir?: ListDir }

/** The DL inputs for a tool on this thread, or undefined when the registry is empty (nothing can Match: today's bytes). */
function dlFor(threadId: string, cwd: string | undefined): DlScan | undefined {
  const registry = downloadRegistry();
  if (registry.empty()) return undefined;
  const home = homedir();
  return { registry, cwd: cwd ?? home, home, budget: new TextBudget(nodeFsHooks()), pathFolders: pathFoldersFor(threadId) };
}
function matchOptions(dl: DlScan): MatchOptions {
  return { cwd: dl.cwd, budget: dl.budget, home: dl.home, pathFolders: dl.pathFolders.filter((folder) => folder !== SEARCH_ALL) };
}
/** A found program's realpath: the exclusions (work folder, session edits, registry) judge where the file really is, so a PATH
 *  entry that is a link into the work folder never reads as a system reader. A realpath that fails, or one inside the work
 *  folder (itself resolved), answers undefined: the call reads as a write (fail closed). */
function resolvedProgram(found: string | null | undefined, cwd: string | undefined): string | null | undefined {
  if (found === null || found === undefined) return found;
  let real: string;
  try { real = realpathSync.native(found); } catch { return undefined; }
  if (cwd) {
    let realCwd = cwd;
    try { realCwd = realpathSync.native(cwd); } catch { /* the lexical work folder still guards below */ }
    for (const root of new Set([cwd, realCwd])) if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  }
  return real;
}
/** The hooks `readOnlyShape` needs for an external reader (`ls`, `cat`, `grep`): the PATH noted for this thread decides where the
 *  program lives, and a program inside the work folder, one this session edited or one the download registry names never counts
 *  as read-only. A PATH that cannot be searched answers undefined, and the call reads as a write (fail closed). */
function readOnlyHooksFor(threadId: string, cwd: string | undefined): ReadOnlyHooks {
  const dl = dlFor(threadId, cwd);
  const lexical = lookupProgramFor(threadId, cwd);
  return {
    ...(cwd ? { cwd } : {}),
    lookupProgram: (name) => resolvedProgram(lexical(name), cwd),
    ...(dl ? { registryMatches: (found: string) => dl.registry.match(found, matchOptions(dl)) !== null } : {}),
  };
}
/** F3: while an install ran with no known engine PATH and a span exists, every searched folder is a hit. */
function searchAll(dl: DlScan): boolean { return dl.pathFolders.includes(SEARCH_ALL) && dl.registry.spanCount() > 0; }
function dlHooks(dl: DlScan): Pick<OutsideScanHooks, "cwd" | "registry" | "repo"> {
  const options = matchOptions(dl);
  const word = scanRegistryHook(dl.registry, options);
  const all = searchAll(dl);
  return { cwd: dl.cwd, registry: (w, implied, searched) => (all && (implied || searched) ? "downloaded file" : word(w, implied, searched)), repo: scanRepoHook(dl.registry, options) };
}

/** The paths a file tool's input names (Claude `file_path` / `path` / `notebook_path`, Codex `changes`, ACP `paths`). */
function toolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["file_path", "path", "notebook_path", "filePath"]) if (typeof record[key] === "string" && record[key]) out.push(record[key] as string);
  if (Array.isArray(record.paths)) for (const p of record.paths) if (typeof p === "string" && p) out.push(p);
  const changes = record.changes;
  if (Array.isArray(changes)) { for (const c of changes) if (c && typeof (c as { path?: unknown }).path === "string") out.push((c as { path: string }).path); }
  else if (changes && typeof changes === "object") out.push(...Object.keys(changes));
  return out;
}
function fileToolMatch(input: unknown, tool: string, dl: DlScan, kind?: string): DlLabel | null {
  const options = matchOptions(dl);
  const searched = SEARCH_TOOLS.has(tool) || kind === "search";
  const paths = toolPaths(input);
  // Astra r1 H4 / H5: the folders a search names (dir, directory, a glob's literal folder) and the folder a Skill loads,
  // each Matched as a searched folder
  const folders = [...(searched ? searchFolders(input, tool, paths) : []), ...(tool === "skill" ? skillFolders(input, dl) : [])];
  if ((searched || folders.length > 0) && searchAll(dl)) return "downloaded file";
  if (paths.length === 0 && folders.length === 0) return dl.registry.matchPath(dl.cwd, { ...options, searched: true });
  for (const p of paths) {
    const hit = dl.registry.match(p, { ...options, searched });
    if (hit) return hit;
  }
  for (const folder of folders) {
    const hit = dl.registry.match(folder, { ...options, searched: true });
    if (hit) return hit;
  }
  return dl.budget.spent() ? "downloaded file" : null;
}

/** H4: the search fields that name the folder searched, and those that hold a glob (Claude Glob's `pattern` is one). */
const SEARCH_FOLDER_FIELDS = ["dir", "directory"];
const SEARCH_GLOB_FIELDS = ["glob", "include", "file_pattern"];
const ABSOLUTE_WORD = /^(?:[\\/]|~(?:[\\/]|$)|[a-zA-Z]:[\\/])/;
const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? (value.trim() ? [value.trim()] : [])
    : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, 64).map((v) => v.trim()) : [];
/** A glob's literal folder: up to the separator before its first wildcard (`*?[{`); the whole word when it has none; "" when
 *  it starts with one (it searches its base). */
function globFolder(pattern: string): string {
  const at = pattern.search(/[*?[{]/);
  if (at < 0) return pattern;
  const cut = Math.max(pattern.lastIndexOf("/", at), pattern.lastIndexOf("\\", at));
  return cut < 0 ? "" : pattern.slice(0, cut) || pattern[0]!;
}
/** H4: the folders a search reads beyond its own paths: `dir` / `directory`, and each glob field's literal folder, an
 *  absolute one as written, a relative one under each base the call names (its paths and folders, else its cwd). */
function searchFolders(input: unknown, tool: string, paths: readonly string[]): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const folders = SEARCH_FOLDER_FIELDS.flatMap((field) => stringsOf(record[field]));
  const patterns = [...SEARCH_GLOB_FIELDS.flatMap((field) => stringsOf(record[field])), ...(tool === "glob" ? stringsOf(record.pattern) : [])];
  const bases = [...paths, ...folders];
  const out = [...folders];
  for (const pattern of patterns) {
    const folder = globFolder(pattern);
    if (!folder) continue;
    if (ABSOLUTE_WORD.test(folder)) out.push(folder);
    else for (const base of bases.length ? bases : ["."]) out.push(join(base, folder));
  }
  return out.slice(0, 256);
}
/** H5 (4.6): the folder a Claude Skill loads: a path it names as written, else the named skill in the project's and the
 *  user's skill folders; a plugin's skill (`plugin:name`) by the user's whole plugin folder (fail closed). */
function skillFolders(input: unknown, dl: DlScan): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const out: string[] = [];
  for (const name of stringsOf((input as Record<string, unknown>).skill)) {
    if (ABSOLUTE_WORD.test(name) || /^\.{1,2}[\\/]/.test(name) || /[\\/]/.test(name)) { out.push(name); continue; }
    if (name.includes(":")) { out.push(join(dl.home, ".claude", "plugins")); continue; }
    out.push(join(dl.cwd, ".claude", "skills", name), join(dl.home, ".claude", "skills", name));
  }
  return out;
}

/** R1-R8 `roots`: `/`, or every drive root present at boot. */
let rootsAtBoot: readonly string[] | undefined;
export function fsRoots(): readonly string[] {
  if (rootsAtBoot) return rootsAtBoot;
  if (process.platform !== "win32") return (rootsAtBoot = ["/"]);
  const found: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (existsSync(root)) found.push(root); } catch { /* not present */ }
  }
  return (rootsAtBoot = found.length ? found : ["C:\\"]);
}

/** F3: the PATH of the engine process each driver spawned for a thread (outside-scan.ts noteEnginePath; spawnCli notes it). */
export { noteEnginePath };
/** F3: the pathFolders marker for "count every searched folder as a hit". */
export const SEARCH_ALL = "\u0000search-all";
const PATH_UNKNOWN_KEY = "install:path-unknown";
/** F3: an install text ran on a turn whose engine PATH was not known (kept in the outside store; not ready: yes). */
export function installPathUnknown(): boolean { return ownWritten(PATH_UNKNOWN_KEY); }
/** 2c / R7 (4): the engine PATH (when known) unioned with the server PATH, at most 64 folders, plus SEARCH_ALL (F3). */
export function pathFoldersFor(threadId: string): string[] {
  const folders = new Set<string>();
  for (const value of [enginePathOf(threadId) ?? "", process.env.PATH ?? ""]) for (const folder of value.split(delimiter)) if (folder && isAbsolute(folder)) folders.add(folder);
  const list = [...folders].slice(0, LOOKUP_FOLDERS_MAX);
  // a list cut at the cap never stands for the whole PATH (Astra acct5 r1 H2): every searched folder counts as a hit
  if (installPathUnknown() || folders.size > LOOKUP_FOLDERS_MAX) list.push(SEARCH_ALL);
  return list;
}
const LOOKUP_FOLDERS_MAX = 64;
/** Astra acct5 r1 H2 / GrokBuild r1 G1 (#8): a bare program's first executable on the PATH this thread's engine was started
 *  with (spawnCli noteEnginePath), the way execvp finds it (an entry that is not an executable file is passed over). undefined
 *  (the run marks) when that PATH cannot be searched completely: the thread was never noted, its PATH is unknown, it holds
 *  more than 64 folders, an empty or relative entry (searched from the run's folder), or a stat that fails for any reason but
 *  "not there". On Windows the run's folder is searched first, as cmd does. Never the server's PATH. */
function lookupProgramFor(threadId: string, cwd?: string): (name: string) => string | null | undefined {
  const win = process.platform === "win32";
  const exts = win ? ["", ".exe", ".cmd", ".bat", ".ps1", ".com"] : [""];
  return (name) => {
    if (isAbsolute(name)) return name;
    const value = enginePathOf(threadId);
    if (value === undefined || value === null) return undefined;
    const folders = value.split(delimiter).filter((folder) => !(win && folder === ""));
    if (win) { if (!cwd || !isAbsolute(cwd)) return undefined; folders.unshift(cwd); }
    if (folders.length > LOOKUP_FOLDERS_MAX + (win ? 1 : 0)) return undefined;
    for (const folder of folders) {
      if (folder === "" || !isAbsolute(folder)) return undefined;
      for (const ext of exts) {
        const file = join(folder, name + ext);
        let stat;
        try { stat = statSync(file); } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          return undefined;
        }
        if (stat.isFile() && (win || (stat.mode & 0o111) !== 0)) return file;
      }
    }
    return null;
  };
}

/** V4 (b): the turns that already hold their one coarse span. */
const spannedTurns = new Set<string>();
/** v1 F6: the (turn, working folder) pairs that already hold their cwd window. */
const windowedTurns = new Set<string>();
/** V4 (b): one `span` on every filesystem root for the running turn, since now - 2 s, until the turn end stamp. Also
 *  called for a Codex helper's notification (V8). */
export function spanTurn(threadId: string, cwd?: string): void {
  const turn = outsideTurnKey(threadId) ?? `${threadId}@unbound`;
  // v1 F6: the span also opens a `window` on the turn's working folder, so an untargeted write below it makes that
  // folder hold an entry (DL step 2) in every later chat there. Once per turn and folder.
  if (cwd && isAbsolute(cwd) && !windowedTurns.has(`${turn}\u0000${cwd}`)) {
    if (windowedTurns.size >= 4096) windowedTurns.delete(windowedTurns.values().next().value!);
    windowedTurns.add(`${turn}\u0000${cwd}`);
    const window: RegistryEntry = { path: cwd, kind: "window", since: Date.now() - 2000, ...(outsideTurnKey(threadId) ? { turn } : {}) };
    try { downloadRegistry().add([window]); } catch { /* the store write failed: the in-memory window holds */ }
  }
  if (spannedTurns.has(turn)) return;
  if (spannedTurns.size >= 4096) spannedTurns.delete(spannedTurns.values().next().value!);
  spannedTurns.add(turn);
  const since = Date.now() - 2000;
  const add: RegistryEntry[] = fsRoots().map((root) => ({ path: root, kind: "span", since, ...(outsideTurnKey(threadId) ? { turn } : {}) }));
  try { downloadRegistry().add(add); } catch { /* the store write failed: the in-memory span holds (registry.add mutates first) */ }
}
/** V4 (b): the item can write somewhere no rule names (any tool but a local one, or a shell text that is not read-only). */
function spanWorthy(item: ToolStart, threadId: string, cwd: string | undefined, options: ToolJudgeOptions = {}): boolean {
  const s = split(item, options);
  const { server, tool } = s;
  if (server !== undefined) return !ownCleanRead(server, tool);
  if (s.mark) return true;
  const kind = kindOf(item, s);
  if (SHELL_NAMES.has(tool) || kind === "execute") {
    const text = commandFromToolInput(item.input);
    return text === undefined || !readOnlyShape(text, readOnlyHooksFor(threadId, cwd));
  }
  if (tool === "webfetch" || tool === "websearch" || (s.engine && kind === "fetch")) return false;
  return !(kind !== undefined && kind !== "" ? LOCAL_KINDS.has(kind) : LOCAL_NAMES.has(tool));
}

/** Record installer provenance before a driver releases a tool for execution. */
export function recordOutsideInstallChange(threadId: string, item: ToolStart, turnCwd?: string, options: ToolJudgeOptions = {}): boolean {
  const identity = split(item, options);
  const tool = identity.tool;
  if (identity.server !== undefined || !(SHELL_NAMES.has(tool) || kindOf(item, identity) === "execute")) return true;
  const text = commandFromToolInput(item.input);
  if (!text || installPrograms(text).length === 0) return true;
  const own = commandCwdOf(item);
  const cwd = typeof own === "string" ? own : turnCwd;
  let unknown = (enginePathOf(threadId) ?? null) === null;
  const lookup = lookupProgramFor(threadId, cwd);
  const home = homedir();
  registerText(text, { cwd: cwd ?? home, home, now: Date.now(), marked: false, readOnly: false,
    budget: new TextBudget(nodeFsHooks()), roots: fsRoots(), lookupProgram: (name) => {
      const found = lookup(name);
      if (found === undefined) unknown = true;
      return found ?? null;
    } });
  return !unknown || ownWrite(PATH_UNKNOWN_KEY);
}

/** V4 (a): register what this engine tool brings in (R1-R4, R6-R8 for a shell text; R5 for a file write on a marked turn,
 *  every level), then (b) the coarse span on a marked turn. Any failure spans every root (fail closed). */
function registerAtStart(threadId: string, item: ToolStart, cwd: string | undefined, marked: boolean, options: ToolJudgeOptions = {}): void {
  const s = split(item, options);
  const { server, tool } = s;
  const kind = kindOf(item, s);
  try {
    const home = homedir();
    const turn = outsideTurnKey(threadId);
    const base = { cwd: cwd ?? home, home, now: Date.now(), ...(turn ? { turn } : {}), budget: new TextBudget(nodeFsHooks()), roots: fsRoots() };
    const add: RegistryEntry[] = [];
    if (server === undefined && (SHELL_NAMES.has(tool) || kind === "execute")) {
      const text = commandFromToolInput(item.input);
      if (text !== undefined && text.trim() !== "") {
        const readOnly = readOnlyShape(text, readOnlyHooksFor(threadId, cwd));
        // MurageMain ruling (1.0.18 envfix r2): registration searches the PATH noted for the thread and fails closed. A lookup
        // that cannot be answered (never noted, unknown, relative or empty entry, past the cap, a failing stat) is never
        // "no installer here": it registers as an unknown PATH (every searched folder counts as a hit, SEARCH_ALL)
        const lookup = lookupProgramFor(threadId, cwd);
        const lookupProgram = (name: string): string | null => {
          const found = lookup(name);
          return found ?? null;
        };
        add.push(...registerText(text, { ...base, marked, readOnly, lookupProgram }));
      }
    } else if (marked && server === undefined && (kind !== undefined && kind !== "" ? WRITE_KINDS.has(kind) : WRITE_NAMES.has(tool))) {
      const paths = toolPaths(inputOf(item));
      for (const p of paths) add.push(...registerToolWrite(p, base));
      // A4: a write on a marked turn that names no path writes where no rule names: the turn's span covers it; so does
      // one whose locations overflowed the cap (Astra r1 H3: the ones past it are never registered one by one)
      if (paths.length === 0 || item.pathsOverflow) spanTurn(threadId, cwd);
    }
    if (add.length) downloadRegistry().add(add);
    if (marked && spanWorthy(item, threadId, cwd, options)) spanTurn(threadId, cwd);
  } catch {
    try { spanTurn(threadId, cwd); } catch { /* the store write failed: the in-memory span holds */ }
  }
}

/** V4 (f): at the ask, the DL read side for the asked shell text and paths, on the state BEFORE the call (the caller sets
 *  the mark after it built the ask's context). Null when nothing Matches or the registry is empty. */
export function askOutsideMark(threadId: string, input: unknown, filePaths: readonly string[] | undefined, cwd: string | undefined): DlLabel | null {
  const dl = dlFor(threadId, cwd);
  if (!dl) return null;
  try {
    const text = commandFromToolInput(input);
    if (text !== undefined && text.trim() !== "") {
      // FAIL_CLOSED_MARKS includes downloaded file: an unread command holds the DL turn too.
      const hit = outsideScanMarks(text, dlHooks(dl)).find((mark) => mark === "downloaded file" || mark === "cloned folder");
      if (hit) return hit;
    }
    const paths = filePaths?.length ? [...filePaths] : toolPaths(input);
    for (const p of paths) {
      const hit = dl.registry.match(p, matchOptions(dl));
      if (hit) return hit;
    }
    return dl.budget.spent() ? "downloaded file" : null;
  } catch {
    return "downloaded file";
  }
}

/** 6.3: the call writes (anything but a local reader, an own clean or 6.1.2 reader, or a read-only shell shape). */
function toolStartWrites(item: ToolStart, threadId: string, cwd: string | undefined, options: ToolJudgeOptions = {}): boolean {
  const s = split(item, options);
  const { server, tool } = s;
  if (server !== undefined) return !ownCleanRead(server, tool);
  if (s.mark) return true;
  const kind = kindOf(item, s);
  if (kind ? READ_KINDS.has(kind) : READ_NAMES.has(tool)) return false;
  if (SHELL_NAMES.has(tool) || kind === "execute") {
    const text = commandFromToolInput(item.input);
    return text === undefined || !readOnlyShape(text, readOnlyHooksFor(threadId, cwd));
  }
  return true;
}

/** Astra acct5 r1 H4: the folder a shell call says it runs in (cwd, workdir, working_directory, directory, dir), for a call
 *  that carries a command only. undefined: it names none (the turn's folder applies); null: what it names cannot be placed
 *  (not a string, relative, malformed, or two fields that disagree). */
function commandCwdOf(item: ToolStart): string | null | undefined {
  const input = item.input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !("command" in input)) return undefined;
  const named = commandCwdFromToolInput(input);
  if (named === undefined || named === null) return named;
  return isAbsolute(named) && !named.includes("\u0000") ? named : null;
}

/** Keep call provenance even when this call cannot earn the one-call exemption. */
export function markCallOutside(threadId: string, source: OutsideSource, item: Pick<ToolStart, "callKey" | "lateFrame">): void {
  const by = item.lateFrame || source === "interpreter" ? undefined : item.callKey; // M-PR-5b
  markTurnOutside(threadId, source, by, { callKey: item.callKey, late: item.lateFrame }, source === "interpreter" ? `item:interpreter branch=${scanFailClosed.interpreterBranches}` : `item:${source}`);
}

/** item.started of an engine tool: mark the running turn first (3.1 timing), then, on a marked turn, note a session write. */
export function noteToolStartOutside(threadId: string, item: ToolStart, turnCwd?: string, options: ToolJudgeOptions = {}): void {
  if (item.origin !== "engine") return;
  if (!recordOutsideInstallChange(threadId, item, turnCwd, options)) throw new Error("Murage could not record this change. Check available disk space.");
  // Astra acct5 r1 H4: a shell call runs in the folder it names (Codex keeps input.cwd), so its disk and registry hooks are
  // built there; a folder it names that cannot be placed marks
  const own = commandCwdOf(item);
  const cwd = typeof own === "string" ? own : turnCwd;
  let source: OutsideSource | null;
  try { source = own === null ? "outside tool" : toolStartOutside(item, dlFor(threadId, cwd), { ...options, scan: scanDisk(threadId, cwd) }); } catch { source = "downloaded file"; }
  try { noteSessionEditsOf(threadId, item, cwd, options); } catch { source ??= "downloaded file"; }
  // v1 V4 (a): registration first, with `marked` = the turn's mark after this text's own marks; then the mark
  registerAtStart(threadId, item, cwd, source !== null || turnOutsideRead(threadId) !== null, options);
  if (source) markCallOutside(threadId, source, item);
  const instanceId = runningOutsideInstance(threadId);
  if (instanceId && turnOutsideRead(threadId) !== null && toolStartWrites(item, threadId, cwd, options)) noteSessionWrote(threadId, instanceId);
}

/** v1 Astra r1 (2)-(4): the ACP core's lane hook. Every call the driver sees (a tool start, each update on the merged call,
 *  an update with no start, every permission request before it is answered) is judged on its protocol fields. A call that
 *  cannot be judged marks `outside tool`. The display item's own judging (item.started) still runs beside it and registers
 *  what the started call brings in, so a start and an ask only mark here; an update that changed the call, or one with no
 *  start (`register`), also registers (V4) and notes the session write (6.3) as a start would. */
export function noteAcpCallOutside(threadId: string, call: ToolStart, cwd?: string, register = false): void {
  const item: ToolStart = { ...call, origin: "engine" };
  try {
    if (register) { noteToolStartOutside(threadId, item, cwd, { acpRaw: true }); return; }
    const own = commandCwdOf(item);
    const at = typeof own === "string" ? own : cwd;
    let source: OutsideSource | null;
    try { source = own === null ? "outside tool" : toolStartOutside(item, dlFor(threadId, at), { acpRaw: true, scan: scanDisk(threadId, at) }); } catch { source = "downloaded file"; }
    // Astra acct5 r1 H1 with the relay 5 rule: no session edit here. Unregistered is an ask before its answer (the owner may
    // deny it; registerOnAllow judges it again with `register` once allowed) or a start its allowed ask already recorded.
    // What an allowed call writes is recorded on the register path above (noteToolStartOutside), so a denied call records nothing.
    if (source) markCallOutside(threadId, source, item);
  } catch {
    markTurnOutside(threadId, "outside tool");
  }
}

/** The ACP lane hooks as the server wires them (index.ts setAcpOutsideHooks; drivers/acp/core.ts AcpOutsideHooks), given the
 *  running turn's folder: `judge` is noteAcpCallOutside (1.0.19 A5: one judge per call, registering at its start); `mark`
 *  (a helper frame, an unknown vendor method, a pre-prompt frame) marks the turn and, 1.0.19 A2, opens its span, so what a
 *  helper wrote Matches in a later chat (as a Codex helper does, codex.ts). */
export function acpOutsideHooks(cwdOf: (threadId: string) => string | undefined): {
  judge(threadId: string, call: ToolStart, register: boolean): void;
  mark(threadId: string, source: OutsideSource, site?: string, lifecycle?: boolean): void;
} {
  return {
    judge: (threadId, call, register) => { noteAcpCallOutside(threadId, call, cwdOf(threadId), register); },
    mark: (threadId, source, site, lifecycle) => { markTurnOutside(threadId, source, undefined, undefined, site, lifecycle); spanTurn(threadId, cwdOf(threadId)); },
  };
}

/** M9 (b), r4 3.2: the union of the project instruction files and folders every engine loads from the working folder and
 *  its ancestors (Claude, Codex, Gemini, Cursor, Fuigo). */
export const INSTRUCTION_NAMES: readonly string[] = [
  ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".cursorrules", ".claude", ".cursor", ".codex", ".fuigo",
];

/** v1 V2 (M9): at turn start, before the prompt is sent. The working folder Matches the registry (DL step 2 in full: it is,
 *  lies under, or holds an entry), or an instruction file found in it or an ancestor up to the repo root (the filesystem
 *  root when there is no repo) Matches. A spent budget, a stat that fails, or a folder that cannot be listed marks. */
export function cwdOutsideMark(
  cwd: string | undefined, registry: DownloadRegistry = downloadRegistry(), fsHooks: FsHooks = nodeFsHooks(), driverKind?: string, listDir: ListDir = nodeListDir,
): OutsideSource | null {
  if (!cwd) return "folder not checked";
  if (registry.empty()) return null;
  const folderMark = cwdAndAncestorsMark(cwd, registry, fsHooks);
  if (folderMark) return folderMark;
  return cwd && loadsInstructionsBelowCwd(driverKind) ? belowCwdInstructionMark(cwd, registry, fsHooks, listDir) : null;
}

/** v1 F6: the engines that may load an instruction file BELOW the working folder at session start (Gemini walks the tree;
 *  Cursor, Fuigo and Grok load nested rules). Claude loads a nested CLAUDE.md only beside a read (checked at each read);
 *  Codex loads AGENTS.md only from the repo root down to the cwd (the ancestor walk). Unknown engines are listed. */
export function loadsInstructionsBelowCwd(driverKind: string | undefined): boolean {
  return driverKind !== "claudeAgent" && driverKind !== "codex";
}
/** v1 F6: the engine's own folder bound (Gemini `discoveryMaxDirs`, default 200). There is no depth limit. */
export const BELOW_CWD_MAX_DIRS = 200;

/** v1 F6 (designs/NOLIMITS-V1-CUT-ASTRA-F6.md): when any span exists, list the tree below the cwd breadth first up to the
 *  engine's folder bound, with no depth cutoff, and Match every instruction file or folder found (its ctime in a span, or
 *  any entry). A listing that reaches the bound before it ends, a folder that cannot be listed, or a spent budget marks. */
function belowCwdInstructionMark(cwd: string, registry: DownloadRegistry, fsHooks: FsHooks, listDir: ListDir): OutsideSource | null {
  const names = INSTRUCTION_SET();
  for (const entry of registry.entriesUnder(cwd)) {
    if (entry.kind === 'file') {
      if (names.has(basename(entry.path).toLowerCase())) return 'cloned folder';
      continue;
    }
    const budget = new TextBudget(fsHooks), options = { cwd, budget };
    const queue = [entry.path]; let listed = 0;
    try {
      for (let at = 0; at < queue.length; at++) {
        if (listed++ >= BELOW_CWD_MAX_DIRS) return 'cloned folder';
        const children = listDir(queue[at]);
        if (!children) continue;
        for (const child of children) {
          const path = join(queue[at], child.name);
          if (names.has(child.name.toLowerCase()) && registry.matchPath(path, options)) return 'cloned folder';
          if (budget.spent()) return 'cloned folder';
          if (child.dir) queue.push(path);
        }
      }
    } catch { return 'cloned folder'; }
  }
  return null;
}

/** v1 V5 (a), NLMI-MARKS 6: Claude opened an ask whose own engine item had not arrived within the readable-time hold. That
 *  ask is judged marked (outsideContextFields with `itemUnseen`); the TURN is not marked here. A late item marks the turn
 *  through noteToolStartOutside when its tool is outside. Kept as the request.opened seam; returns whether the ask is unseen. */
export function noteAskItemUnseen(_threadId: string, event: { itemUnseen?: boolean }): boolean {
  return event.itemUnseen === true;
}

function cwdAndAncestorsMark(cwd: string | undefined, registry: DownloadRegistry, fsHooks: FsHooks): OutsideSource | null {
  if (!cwd) return "cloned folder";
  const budget = new TextBudget(fsHooks);
  const options = { cwd, budget };
  try {
    if (registry.matchPath(cwd, { ...options, holds: false })) return "cloned folder";
    for (let folder = cwd; ; ) {
      for (const name of INSTRUCTION_NAMES) {
        const file = join(folder, name);
        if (fsHooks.lstat(file) === null) continue;
        if (registry.matchPath(file, options)) return "cloned folder";
      }
      if (budget.spent()) return "cloned folder";
      if (fsHooks.lstat(join(folder, ".git")) !== null) break;
      const up = dirname(folder);
      if (up === folder) break;
      folder = up;
    }
  } catch {
    return "cloned folder";
  }
  return budget.spent() ? "cloned folder" : null;
}

/** C2 / 6.2 / 6.3 / 6.1.3: the fields an ask's AutoContext carries. Not wired reads as `outside tool` (marked). */
export function outsideContextFields(
  threadId: string, cwd: string | undefined, ask?: { key?: string; ambiguous?: boolean; itemUnseen?: boolean },
): Pick<AutoContext, "outsideRead" | "readOnlySoFar" | "readOnlyHooks" | "workFolder"> {
  // NLMI-MARKS 6: an ask whose item never came has no proven call to exempt: it reads marked, whatever the exemption says
  // 1.0.19 A3: the call that brought the content in is judged clean, once (its own first mark, read without it)
  const source = ask?.itemUnseen === true ? turnOutsideRead(threadId) ?? "outside tool"
    : ask?.key !== undefined && turnOutsideExempt(threadId, ask.key, ask.ambiguous === true) ? null : turnOutsideRead(threadId);
  const instanceId = runningOutsideInstance(threadId);
  return {
    outsideRead: source === null ? null : [source],
    readOnlySoFar: instanceId ? readOnlySoFar(threadId, instanceId) : false,
    readOnlyHooks: { ...readOnlyHooksFor(threadId, cwd), ...(instanceId ? { sessionEdits: sessionEdits(threadId, instanceId) } : {}) },
    ...(cwd ? { workFolder: cwd } : {}),
  };
}
