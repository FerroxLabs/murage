// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine "/" commands (shared/engine-commands.ts): what each driver may
// report, which commands Murage keeps out of the menu, and the per-bot cache
// that keeps the menu filled between runs.
//
// Drivers report the list on an `engine.commands` runtime event; the harness
// files it under the bot that ran the turn (recordEngineCommands) and the
// composer reads it back (engineCommandsView). The cache lives in
// DATA_DIR/engine-commands.json, owner-only, written atomically. It is a
// convenience, not a source of truth: a damaged file reads as empty and the
// next turn fills it again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { ENGINE_COMMAND_NAME, type EngineCommand, type EngineCommandsView } from "../shared/engine-commands.ts";

const CACHE_FILE = "engine-commands.json";
const MAX_COMMANDS = 300;
const MAX_DESCRIPTION = 300;
const MAX_HINT = 120;

/** The group heading in the composer, per driver: the engine's own name,
 * which for the ACP engines is their driver's display name. A custom ACP
 * engine is named by the owner, so it uses the instance's display name. */
const ENGINE_LABELS: Record<string, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  fuigoAgent: "Fuigo",
  grokAgent: "Grok Build",
  opencodeGo: "OpenCode",
  geminiAgent: "Gemini",
  cursorAgent: "Cursor",
  qwenAgent: "Qwen",
  kimiAgent: "Kimi",
  droidAgent: "Droid",
  hermesAgent: "Hermes",
};

/** Drivers that can report commands. Every ACP engine goes through the
 * shared core, which reads `available_commands_update` for all of them and
 * sends a command turn as the bare command, so each is listed; whether one
 * actually sends the update is its own business and the menu says "Start a
 * chat to load …" until it has. Verified to send it and run "/name" prompts:
 * Fuigo and Grok Build (fuigo-shell session_setup.rs, slash_authority.rs),
 * OpenCode 1.15.11 (its ACP agent advertises `command.list` plus `compact`
 * after session/new, and `prompt` runs text starting with "/" through
 * `session.command`, or `session.summarize` for /compact). Pi is not listed:
 * no Pi install or package here to verify an RPC command list against. The Grok API
 * driver (and every other transcript-replay driver) has no commands of its
 * own: its bots show only Murage's. */
const REPORTING_DRIVERS = new Set([
  "claudeAgent", "codex",
  "fuigoAgent", "grokAgent", "geminiAgent", "qwenAgent", "kimiAgent", "hermesAgent",
  "cursorAgent", "droidAgent", "opencodeGo", "customAcp",
]);

/** Commands that are never offered, for any engine.
 *
 * - Screen-bound: they draw a terminal UI or change the terminal itself, and
 *   there is no terminal behind a Murage chat (login, logout, config,
 *   settings, theme, vim, terminal-setup, ide, statusline, keybindings, exit,
 *   quit, help, doctor, mcp, agents).
 * - Session-bound: Murage owns which engine session a conversation resumes,
 *   which model it runs and when it starts over. /clear (and /new, /reset)
 *   would wipe the engine's context while the chat still shows the whole
 *   conversation, so the bot would silently forget what the owner can see;
 *   Murage's own new-chat does the same thing honestly. /resume, /rewind,
 *   /fork and /model would put the engine on a different session or model
 *   than the one Murage records and shows. /compact stays: it keeps the
 *   conversation, only shorter.
 * - Approval-bound: Murage asks the owner before an engine acts. Commands
 *   that widen what an engine may do without asking (permissions, add-dir,
 *   Fuigo's always-approve and hook and plugin trust) would go around that,
 *   so they stay in the engine's own terminal. Read-only relatives
 *   (hooks-list) are kept.
 * - Murage's own: /learn and /setup mean Murage's commands in every
 *   composer, so an engine command of the same name could never be reached
 *   and would only confuse the menu. (/goal is Murage's in rooms only, and
 *   the engine group is offered in one-to-one chats, so an engine's /goal
 *   stays.) */
const HIDDEN_EVERYWHERE = new Set([
  "login", "logout", "config", "settings", "theme", "vim", "terminal-setup", "ide", "statusline",
  "keybindings", "exit", "quit", "help", "doctor", "mcp", "agents",
  "clear", "new", "reset", "resume", "continue", "rewind", "fork", "branch", "model",
  "permissions", "allowed-tools", "add-dir", "approvals", "sandbox", "install-github-app", "upgrade",
  "always-approve", "hooks", "hooks-add", "hooks-remove", "hooks-trust", "hooks-untrust", "plugins", "plugin",
  "learn", "setup",
]);

/** Codex's app-server has no command list of its own. These are the useful
 * TUI commands it exposes as calls (drivers/codex.ts maps each one), plus
 * the skills `skills/list` reports, which the driver appends. */
export const CODEX_BUILTIN_COMMANDS: readonly EngineCommand[] = [
  { name: "review", description: "Review your uncommitted changes, or what you describe after it", hint: "[what to review]" },
  { name: "compact", description: "Summarize the conversation so far to free up room" },
];

export const engineCommandLabel = (driver: string, displayName?: string) =>
  ENGINE_LABELS[driver] ?? displayName ?? driver;

export const engineReportsCommands = (driver: string) => REPORTING_DRIVERS.has(driver);

const clip = (value: unknown, max: number) => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
};

/** One raw report → the commands the menu may show. Accepts the shapes the
 * engines send: ACP `{name, description, input: {hint}}`, Claude's
 * `{name, description, argumentHint}` or a bare name, Codex skills
 * `{name, description}`. Leading "/" is dropped, names are checked, the
 * first spelling of a name wins, and the hidden commands are removed along
 * with any the engine itself marks as terminal-only (`terminalOnly`). */
export function normalizeEngineCommands(raw: unknown, terminalOnly: readonly string[] = []): EngineCommand[] {
  if (!Array.isArray(raw)) return [];
  const hidden = new Set([...HIDDEN_EVERYWHERE, ...terminalOnly.map((name) => String(name).replace(/^\//, "").toLowerCase())]);
  const seen = new Set<string>();
  const commands: EngineCommand[] = [];
  for (const entry of raw) {
    const record = typeof entry === "string" ? { name: entry } : entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.name !== "string") continue;
    const name = record.name.trim().replace(/^\//, "");
    const key = name.toLowerCase();
    if (!ENGINE_COMMAND_NAME.test(name) || seen.has(key) || hidden.has(key)) continue;
    seen.add(key);
    const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : undefined;
    const description = clip(record.description, MAX_DESCRIPTION);
    const hint = clip(record.hint ?? record.argumentHint ?? input?.hint, MAX_HINT);
    commands.push({ name, ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
    if (commands.length >= MAX_COMMANDS) break;
  }
  return commands;
}

interface CacheEntry { commands: EngineCommand[]; at: number }
type CacheFile = { version: 1; bots: Record<string, Record<string, CacheEntry>> };

export class EngineCommandCache {
  private data: CacheFile | null = null;
  private readonly dir: string;
  // A plain field, not a parameter property: the server runs under Node's
  // type stripping, which refuses parameter properties.
  constructor(dir: string = DATA_DIR) {
    this.dir = dir;
  }

  private load(): CacheFile {
    if (this.data) return this.data;
    let parsed: CacheFile = { version: 1, bots: {} };
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, CACHE_FILE), "utf8")) as Partial<CacheFile>;
      if (raw && raw.version === 1 && raw.bots && typeof raw.bots === "object") parsed = { version: 1, bots: raw.bots };
    } catch { /* absent or damaged: start empty, the next turn refills it */ }
    this.data = parsed;
    return parsed;
  }

  /** The list last reported for this bot on this driver, or null. */
  get(botId: string, driver: string): EngineCommand[] | null {
    const entry = this.load().bots[botId]?.[driver];
    return entry && Array.isArray(entry.commands) ? normalizeEngineCommands(entry.commands) : null;
  }

  /** Keep the latest report. Written only when it differs, so an engine that
   * re-announces the same list every turn costs no disk write. */
  record(botId: string, driver: string, commands: EngineCommand[]): boolean {
    const data = this.load();
    const previous = data.bots[botId]?.[driver]?.commands;
    if (previous && JSON.stringify(previous) === JSON.stringify(commands)) return false;
    data.bots[botId] = { ...data.bots[botId], [driver]: { commands, at: Date.now() } };
    try {
      writeFileAtomic(join(this.dir, CACHE_FILE), JSON.stringify(data), { mode: 0o600 });
    } catch (error) {
      console.error("engine-commands: cache write failed", error);
    }
    return true;
  }

  forget(botId: string) {
    const data = this.load();
    if (!data.bots[botId]) return;
    delete data.bots[botId];
    try {
      writeFileAtomic(join(this.dir, CACHE_FILE), JSON.stringify(data), { mode: 0o600 });
    } catch { /* stale entries are harmless */ }
  }
}

/** What the composer shows for a bot on `driver`. Codex is `ready` from the
 * start: its built-in pair needs no report, and skills join after a run. */
export function engineCommandsView(
  cache: EngineCommandCache,
  botId: string,
  driver: string,
  displayName?: string,
): EngineCommandsView {
  const engine = engineCommandLabel(driver, displayName);
  if (!engineReportsCommands(driver)) return { engine, driver, status: "unsupported", commands: [] };
  const cached = cache.get(botId, driver);
  if (cached) return { engine, driver, status: "ready", commands: cached };
  if (driver === "codex") return { engine, driver, status: "ready", commands: [...CODEX_BUILTIN_COMMANDS] };
  return { engine, driver, status: "unknown", commands: [] };
}
