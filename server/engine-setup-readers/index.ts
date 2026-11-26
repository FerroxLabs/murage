// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAbsolute, join, relative, sep } from "node:path";
import {
  AnchoredImport, checkBudget, IMPORT_NAME, looksSecret, MAX_CLAUDE_JSON_BYTES, MAX_IMPORT_SERVERS, MAX_IMPORT_SKILLS,
  MAX_JSON_DEPTH, newBudget, planServer, privateSkillPath, READ_TIMEOUT_MS, readConfinedFile, ReadRefused,
  readWholeSkills, realImportFs, shownName,
  type Budget, type ImportFs, type ImportScope, type PlannedServer, type ReadSkill,
} from "../claude-code-import.ts";
import { CLAUDE_GLOBAL_CONFIG, ownerClaudeMcpServers } from "../drivers/headless-text-only.ts";
import { isHarnessOwnedMcpEnvName, isRefusedMcpHeaderName, MAX_MCP_HEADERS } from "../mcp-registry.ts";
import { readTomlServers } from "./toml.ts";

export interface EngineSetupRead {
  engine: "fuigo" | "claude" | "codex" | "grok";
  home: string;
  /** The selected owner's pre-scope engine instance, resolved by the caller. */
  engineHome?: string;
  scope: ImportScope;
  optedIn?: boolean;
  existingNames?: readonly string[];
}

export interface ReaderResult {
  status: "ready" | "off" | "unavailable" | "outside-home" | "unreadable" | "too-much";
  servers: Array<PlannedServer & { bearerEnv?: string }>;
  skills: Array<ReadSkill & { root: "personal" | "shared" }>;
  skipped: Array<{ name: string; file?: string }>;
}

const empty = (status: ReaderResult["status"]): ReaderResult => ({ status, servers: [], skills: [], skipped: [] });
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const COMPONENT = /^\.?[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const COPY_REASON = "Copied from engine setup; turn on to use it";
const MCP_FIELDS = new Set(["command", "args", "env", "url", "type", "headers", "http_headers", "bearer_token_env_var", "enabled"]);

function safeComponent(part: string): boolean {
  return COMPONENT.test(part) && !/[ .]$/.test(part) && !privateSkillPath(part);
}

function validEnvName(name: string): boolean {
  return ENV_NAME.test(name) && !looksSecret(name) && !isHarnessOwnedMcpEnvName(name);
}

function stringMap(value: unknown, validName: (name: string) => boolean, cap: number): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= cap && entries.every(([name, value]) => validName(name) && typeof value === "string" && !value.includes("\0"));
}

function planEntry(
  name: string, raw: unknown, taken: readonly string[], engine: EngineSetupRead["engine"],
): ReaderResult["servers"][number] | null {
  if (looksSecret(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some(key => !MCP_FIELDS.has(key))) return null;
  const { command, args, env, url, type, headers, http_headers: httpHeaders, bearer_token_env_var: bearerEnv, enabled } = source;
  const disabledReason = engine === "claude" ? undefined : COPY_REASON;
  if (enabled !== undefined && typeof enabled !== "boolean") return null;
  const isString = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
  const validHeader = (name: string) => /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) && !looksSecret(name);
  if (url !== undefined) {
    if (!isString(url) || command !== undefined || args !== undefined || env !== undefined) return null;
    if (type !== undefined && (!isString(type) || !["http", "sse", "streamable-http"].includes(type))) return null;
    if (headers !== undefined && httpHeaders !== undefined) return null;
    const sourceHeaders = headers === undefined ? httpHeaders : headers;
    if (sourceHeaders !== undefined && !stringMap(sourceHeaders, validHeader, MAX_MCP_HEADERS)) return null;
    if (bearerEnv !== undefined && (!isString(bearerEnv) || !validEnvName(bearerEnv)
      || Object.keys(sourceHeaders ?? {}).some(header => header.toLowerCase() === "authorization")
      || Object.keys(sourceHeaders ?? {}).filter(header => !isRefusedMcpHeaderName(header)).length >= MAX_MCP_HEADERS)) return null;
    const planned = planServer(name, { url, type, headers: { ...sourceHeaders, ...(bearerEnv ? { Authorization: "" } : {}) } }, taken, disabledReason);
    return planned && { ...planned, ...(bearerEnv ? { bearerEnv } : {}) };
  }
  if (!isString(command) || (type !== undefined && type !== "stdio")
    || headers !== undefined || httpHeaders !== undefined || bearerEnv !== undefined) return null;
  if (args !== undefined && (!Array.isArray(args) || args.length > 64 || args.some(arg => !isString(arg) || arg.length > 4096))) return null;
  if (env !== undefined && !stringMap(env, validEnvName, 64)) return null;
  return planServer(name, { command, args, env }, taken, disabledReason);
}

function readServers(
  reader: AnchoredImport, path: string[], input: EngineSetupRead, budget: Budget, now: () => number, result: ReaderResult,
): void {
  let file;
  try { file = reader.openAnchored(join(reader.realHome, ...path), "file"); } catch (error) {
    if (error instanceof ReadRefused && error.kind === "missing") return;
    throw error;
  }
  const bytes = readConfinedFile(reader, file, MAX_CLAUDE_JSON_BYTES, budget, now, true);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const check = () => checkBudget(budget, now);
  let entries: Map<string, unknown>;
  if (input.engine === "claude") {
    const source = ownerClaudeMcpServers(text, MAX_JSON_DEPTH + 1);
    if (source === undefined) return;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new ReadRefused("refused");
    entries = new Map(Object.entries(source));
  } else entries = readTomlServers(text, check);
  if (entries.size > MAX_IMPORT_SERVERS) throw new ReadRefused("budget");

  for (const name of [...entries.keys()].sort()) {
    check();
    const planned = planEntry(name, entries.get(name), input.existingNames ?? [], input.engine);
    if (planned) result.servers.push(planned);
    else result.skipped.push({ name: looksSecret(name) ? "(unusable name)" : shownName(name) });
  }
}

const beginsWith = (path: readonly string[], root: readonly string[]) => root.every((part, i) => path[i] === part);

/** The owner Review/Check service supplies consent and exactly one configured instance.
 * This internal result contains retained copy bytes, so it must stay server-side. */
export async function readEngineSetup(
  input: EngineSetupRead, fs: ImportFs = realImportFs, now = Date.now,
): Promise<ReaderResult> {
  if (input.optedIn !== true) return empty("off");
  if (input.engine === "fuigo" || (input.engine === "claude" && input.engineHome !== undefined)) return empty("unavailable");
  if (input.engine !== "claude" && input.engine !== "codex" && input.engine !== "grok") return empty("unavailable");
  if (input.scope !== "skills" && input.scope !== "mcp" && input.scope !== "both") return empty("unreadable");
  if (!isAbsolute(input.home)) return empty("outside-home");

  const homePath = input.engineHome === undefined ? [`.${input.engine}`] : relative(input.home, input.engineHome).split(sep);
  if (input.engineHome !== undefined && (!isAbsolute(input.engineHome)
    || input.engineHome.split(/[\\/]/).some(part => part === "." || part === "..")
    || homePath.some(part => !safeComponent(part)) || homePath.length > MAX_JSON_DEPTH)) return empty("outside-home");

  const config = input.engine === "claude" ? [CLAUDE_GLOBAL_CONFIG] : [...homePath, "config.toml"];
  const roots: Array<{ path: string[]; root: "personal" | "shared" }> = [{ path: [...homePath, "skills"], root: "personal" }];
  if (input.engine !== "claude") {
    if (homePath.length === 1 && homePath[0] === ".agents") roots[0]!.root = "shared";
    else roots.push({ path: [".agents", "skills"], root: "shared" });
  }
  const allows = (parts: readonly string[], kind: "file" | "dir") =>
    (input.scope !== "skills" && kind === "file" && parts.length === config.length && beginsWith(parts, config))
    || (input.scope !== "mcp" && roots.some(({ path }) => beginsWith(parts, path)
      && (kind === "dir" || parts.length > path.length + 1)
      && parts.slice(path.length).every(part => IMPORT_NAME.test(part) && safeComponent(part))));

  const result = empty("ready");
  const budget = newBudget(now);
  let reader: AnchoredImport | undefined;
  let failure: ReaderResult["status"] | undefined;
  try {
    reader = new AnchoredImport(fs, input.home, READ_TIMEOUT_MS, allows);
    checkBudget(budget, now);
    if (input.scope !== "skills") readServers(reader, config, input, budget, now, result);
    if (input.scope !== "mcp") {
      let visitedSkills = 0;
      for (const { path, root } of roots) {
        const snapshot = readWholeSkills(reader, join(reader.realHome, ...path), budget, now, MAX_IMPORT_SKILLS - visitedSkills);
        visitedSkills += snapshot.count;
        result.skills.push(...snapshot.skills.map(skill => ({ ...skill, root })));
        result.skipped.push(...snapshot.skipped);
      }
    }
    checkBudget(budget, now);
  } catch (error) {
    failure = error instanceof ReadRefused && error.kind === "budget" ? "too-much" : "unreadable";
  } finally {
    if (reader && !await reader.end()) failure = "unreadable";
  }
  return failure ? empty(failure) : result;
}
