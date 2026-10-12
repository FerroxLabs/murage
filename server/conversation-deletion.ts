// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deleting a conversation removes what it left on disk, not only its rows.
//
// A conversation's content lives in more places than messages.db: the
// harness event log and the engine protocol log (events/, native/), the
// conversation's own working folder (workspaces/<bot>/threads/<thread>),
// its pinned skill bundles (skill-state/<bot>/task-bundles/<thread>), the
// checkpoints of that folder, pictures and files it produced, and the
// engine's own transcript of the session it ran in that folder. Delete
// promises the conversation is gone, so every one of those goes with it.
//
// Rules this module keeps:
//  - Every path is built from checked ids under a known root, and removal
//    refuses anything that is not strictly inside that root or that passes
//    through a symlink on the way. A symlink is removed, never followed.
//  - A folder another conversation may use is never removed: the bot's own
//    folder and any folder the person picked stay. What the engine kept for
//    such a folder is reported as a leftover instead.
//  - Engine transcripts are removed only where the engine's own key for a
//    folder maps exactly to this conversation's working folder. Where the
//    key cannot be computed or confirmed, the place is reported, not guessed.
//  - The work is durable: a pending record is written before the rows go
//    and cleared only after the files are gone; boot finishes any record a
//    crash left behind.
import { DEFAULT_HERMES_PROFILE, hermesHome, isHermesProfileName } from "./hermes-profiles.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "./atomic.ts";
import { lstatOrNull, removeConfined, type RemoveOutcome } from "./engine-exec.ts";
import type { AcpHistoryEngine } from "./engine-history-deletion.ts";
import { applyFactsDelta, MAX_ENGINE_ROUNDS } from "./engine-history-run.ts";
import { runEngineHistoryOffThread, type EngineDiscovery, type EngineHistoryJob, type EngineHistoryResult } from "./engine-history-offthread.ts";
import { hasContentSteps, homeKey, pathApiFor, type EnginePlanData, type HomePlanData } from "./engine-plan-core.ts";
import { scrubWalAfterDelete } from "./wal-maintenance.ts";

const ID = /^[\w-]+$/;
/** How long a "Removed from <Engine>." line stays on screen. */
const DONE_LINE_MS = 5 * 60_000;
const ATTACHMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/i;
const ATTACHMENT_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}/gi;
const ARTIFACT_BLOB = /^[a-f0-9]{64}\.[a-z0-9]{1,12}$/;

export type DeletionEngine = "fuigo" | "grok" | "claude" | "codex" | AcpHistoryEngine;
export interface DeletionEngineHome {
  engine: DeletionEngine;
  home: string;
  /** Codex: CODEX_SQLITE_HOME when set */
  sqliteHome?: string;
  /** Qwen: ~/.qwen beside the runtime dir; Cursor: the config dir */
  secondary?: string;
  /** OpenCode: OPENCODE_DB when set */
  db?: string;
  /** The real paths of the programs Murage is configured to run for this engine: a renamed copy of one still counts as the engine
   * when the process check looks for it (engine-closed.ts). */
  identities?: string[];
}
/** Something this deletion could not remove, in words the owner can act on. */
/** Something this deletion could not remove, in plain words the app shows
 * as "<what>, in <where>." Never a path to another conversation. */
export interface DeletionLeftover { what: string; where: string }

/** How the app names each engine. */
export const ENGINE_LABEL: Readonly<Record<string, string>> = {
  fuigoAgent: "Fuigo", grokAgent: "Grok", claudeAgent: "Claude Code", codex: "Codex", piAgent: "Pi", opencodeGo: "OpenCode",
  geminiAgent: "Gemini CLI", qwenAgent: "Qwen Code", kimiAgent: "Kimi", cursorAgent: "Cursor", droidAgent: "Droid",
  antigravityAgent: "Antigravity", hermesAgent: "Hermes", openclawAgent: "OpenClaw", customAcp: "your custom engine",
};
const engineLabel = (kind: string) => ENGINE_LABEL[kind] ?? "An engine";
export interface DeletionReport { leftovers: DeletionLeftover[]; failed: string[] }

/** A deletion that has started. Everything a crash needs to finish it. */
export interface PendingConversationDeletion {
  id: string;
  createdAt: number;
  threadIds: string[];
  /** one entry per working folder found for a thread (a channel has one per member) */
  desks: Array<{ botId: string; threadId: string; checkpointKey?: string; memoryFolder?: string }>;
  engineHomes: DeletionEngineHome[];
  /** bots deleted with these conversations: their own folder was theirs alone */
  botIds?: string[];
  /** engine session ids the conversations used, by engine */
  engineSessions?: Partial<Record<DeletionEngine, string[]>>;
  attachments: string[];
  artifactBlobs: string[];
  leftovers: DeletionLeftover[];
  /** What the engines' removal needs, found by a read-only pass and saved BEFORE the first engine file is removed: session and
   * thread ids, slugs, and the engine databases still owed a verified checkpoint. A retry works from this list, not from
   * files an interrupted run may already have removed. */
  engineDiscovery?: EngineDiscovery;
  /** The engines' removal as a PLAN, saved BEFORE the first engine step runs: every step (a removal, a file rewrite, a SQL
   * delete, a checkpoint...) with a `done` mark, per engine home. It is the record of what this attempt is doing. Every attempt
   * begins with a fresh plan of ALL homes and nothing in an earlier plan counts as proof that a home is finished. */
  enginePlan?: EnginePlanData;
  /** What is still owed to the owner after the retry schedule has run out: since when, and per engine home why, as a code. The
   * words shown come from ownerNoticeText (never a path or an error). Cleared when the deletion finishes. */
  owed?: OwedStatus;
}
export type OwedCode = "engine-open" | "engine-unchecked" | "engine-unseen" | "held" | "aside" | "using" | "unreadable" | "unopenable" | "helper" | "other";
export interface OwedStatus { since: number; homes: Array<{ engine: DeletionEngine; code: OwedCode; /** the desktop application that is open (Claude, Cursor), when that is why */ app?: string }> }
/** What the owner is told about an engine copy that is still owed. */
export interface OwnerNotice { id: string; text: string; /** the owner may ask Murage to try again now (false for a line that says a copy is gone) */ tryAgain: boolean }

/** The codes that mean "tried and not touched, try again soon": an engine that is open or cannot be told, a file another program has, a
 * file the engine started anew. Each is asked about every 10 minutes at most (the owner closes an engine whenever they like) and told on
 * the FIRST attempt. */
const WAITS_FOR_OWNER: ReadonlySet<OwedCode> = new Set<OwedCode>(["engine-open", "engine-unchecked", "engine-unseen", "held", "aside"]);

/** The code for a home's first failure reason. */
export function owedCodeOf(reason: string | undefined): OwedCode {
  const text = reason ?? "";
  if (text === "engine-open") return "engine-open";
  if (text === "engine-unchecked") return "engine-unchecked";
  if (text === "engine-unseen") return "engine-unseen";
  if (text === "held") return "held";
  if (text === "aside") return "aside";
  if (/^(EACCES|EPERM|EROFS)$/.test(text)) return "unopenable";
  if (/^(EIO|EMFILE|ENFILE|ENAMETOOLONG|ENOENT|ENOTDIR|EISDIR)$/.test(text)) return "unreadable";
  if (/^(busy|changed|locked|engine-running)$/.test(text) || /locked by its engine|kept changing|still being written/.test(text)) return "using";
  if (text === "worker-unavailable" || text === "helper") return "helper";
  return "other";
}
/** The words for one owed engine copy. Authored here, keyed by code; no paths, no errors. */
export function ownerNoticeText(label: string, code: OwedCode, app?: string): string {
  const head = `${label}'s copy of this conversation could not be removed yet`;
  const tail = "Murage will try again when it starts.";
  switch (code) {
    // the approved lines (DESIGN-r20 section 7): the engine, or, when its desktop app matched, the engine or that app by the app's own name
    // (the Claude app holds Claude Code's files too)
    case "engine-open": {
      const shown = app?.trim();
      return shown
        ? `${label} or the ${shown} app is open. Close them and Murage will finish removing this conversation from ${label}.`
        : `${label} is open. Close ${label} and Murage will finish removing this conversation from it.`;
    }
    case "engine-unchecked": return `Murage will check again within 10 minutes whether ${label} is open.`;
    // a program of the owner's that the system will not let Murage look into may still have the file open from before it was set aside;
    // after a restart nothing running can, and Murage finishes on its own (engine-exec.ts noWriters)
    case "engine-unseen": return `Murage will finish removing this conversation from ${label} after your computer restarts. Until then a program of yours may still have ${label}'s files open.`;
    case "held": return `Another program is using ${label}'s files. Murage will try again in 10 minutes.`;
    case "aside": return `${label} started a new file while Murage had the old one set aside. Murage will join them and try again in 10 minutes.`;
    case "using": return `${head} because ${label} was using its history. ${tail}`;
    case "unreadable": return `${head} because ${label}'s history could not be read. ${tail}`;
    case "unopenable": return `${head} because Murage was not allowed to open ${label}'s history. ${tail}`;
    case "helper": return `${head} because Murage could not start its cleanup helper. ${tail}`;
    default: return `${head}. ${tail}`;
  }
}

export interface DeletionInput {
  threadIds: string[];
  /** folders these conversations ran in that are not their own working folder */
  sharedFolders?: string[];
  /** engine kinds (driverKind) the conversations ran on */
  engineKinds?: string[];
  engineHomes?: DeletionEngineHome[];
  /** the bot is being deleted too: its own folder, and the engine history
   * kept for it, belonged to it alone */
  botIds?: string[];
  /** engine session ids Murage holds for these conversations (resume cursors), by driver kind */
  sessionIds?: Record<string, string[]>;
  /** the driver kind of a provider instance, to read session ids from the event log */
  instanceKind?: (instanceId: string) => string | undefined;
}

// Path and key helpers live with the planners (engine-plan-core.ts, engine-keys.ts) and the confined removal with the executor
// (engine-exec.ts); they stay importable from here.
export { isStrictlyInside, pathApiFor } from "./engine-plan-core.ts";
export { claudeProjectKey, engineSlug, fuigoMemoryKey, fuigoSessionKey, rustUrlEncode } from "./engine-keys.ts";
export { allowOwnerWrites, removeConfined, type RemoveOutcome } from "./engine-exec.ts";
export { removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";

/** Names in `path`; absent or unreadable is empty. Only the deletion service's own folders (workspaces, skill-state) are listed
 * this way: the engines' files are always read through the strict reader (engine-fs.ts). */
function listDir(path: string): string[] {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

/** Is `folder` inside a git repository (a `.git` entry in it or any parent)? */
export function insideGitRepository(folder: string): boolean {
  const api = pathApiFor(folder);
  let at = api.resolve(folder);
  for (;;) {
    if (lstatOrNull(api.join(at, ".git"))) return true;
    const parent = api.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}

/** checkpoints.ts `shadowDir` key for a folder. */
export function checkpointKey(realFolder: string): string {
  return createHash("sha256").update(nodePath.resolve(realFolder)).digest("hex").slice(0, 16);
}

function record(outcome: RemoveOutcome, path: string, removed: string[], failed: string[]): void {
  if (outcome === "removed") removed.push(path);
  else if (outcome === "refused" || outcome === "failed") failed.push(path);
}

/** Where each supported engine keeps its own history, from the environment
 * it is started with (the same resolution as each engine). */
export function engineHomeFor(engine: DeletionEngine, env: Record<string, string | undefined>, claudeConfigDir?: string, hermesProfile: string = DEFAULT_HERMES_PROFILE): DeletionEngineHome[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const withReal = (path: string) => {
    try {
      const real = realpathSync.native(path);
      return real === path ? [path] : [path, real];
    } catch {
      return [path];
    }
  };
  const one = (path: string, extra: Partial<DeletionEngineHome> = {}): DeletionEngineHome[] => [{ engine, home: path, ...extra }];
  switch (engine) {
    case "fuigo": return (env.FUIGO_HOME ? [env.FUIGO_HOME] : withReal(home).map((dir) => nodePath.join(dir, ".fuigo"))).map((dir) => ({ engine, home: dir }));
    case "grok": return (env.GROK_HOME ? [env.GROK_HOME] : withReal(home).map((dir) => nodePath.join(dir, ".grok"))).map((dir) => ({ engine, home: dir }));
    case "claude": return one(claudeConfigDir || env.CLAUDE_CONFIG_DIR || nodePath.join(home, ".claude"));
    case "codex": return one(env.CODEX_HOME || nodePath.join(home, ".codex"), env.CODEX_SQLITE_HOME ? { sqliteHome: env.CODEX_SQLITE_HOME } : {});
    case "gemini": return one(nodePath.join(env.GEMINI_CLI_HOME || home, ".gemini"));
    case "qwen": return one(env.QWEN_RUNTIME_DIR || nodePath.join(home, ".qwen"), { secondary: nodePath.join(home, ".qwen") });
    case "opencode": return one(nodePath.join(env.XDG_DATA_HOME || nodePath.join(home, ".local", "share"), "opencode"), env.OPENCODE_DB ? { db: env.OPENCODE_DB } : {});
    case "kimi": return one(env.KIMI_CODE_HOME || nodePath.join(home, ".kimi-code"));
    case "droid": return one(nodePath.join(env.FACTORY_HOME_OVERRIDE || home, ".factory"));
    case "hermes": {
      // The home the instance's `hermes -p <profile>` child runs in: the root
      // for `default`, `<root>/profiles/<name>` otherwise. The profile comes
      // from the instance config, the selector Hermes honours, never from
      // HERMES_PROFILE (Hermes ignores it when it picks a home).
      return [{ engine, home: hermesHome(env, isHermesProfileName(hermesProfile) ? hermesProfile : DEFAULT_HERMES_PROFILE) }];
    }
    case "antigravity": return one(nodePath.join(home, ".gemini", "antigravity-cli"));
    case "cursor": return one(env.CURSOR_DATA_DIR || nodePath.join(home, ".cursor"), { secondary: env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? nodePath.join(env.XDG_CONFIG_HOME, "cursor") : nodePath.join(home, ".cursor")) });
  }
}

export const ENGINE_FOR_DRIVER: Readonly<Record<string, DeletionEngine>> = {
  fuigoAgent: "fuigo",
  grokAgent: "grok",
  claudeAgent: "claude",
  codex: "codex",
  geminiAgent: "gemini",
  qwenAgent: "qwen",
  opencodeGo: "opencode",
  kimiAgent: "kimi",
  cursorAgent: "cursor",
  droidAgent: "droid",
  hermesAgent: "hermes",
  antigravityAgent: "antigravity",
};
/** Engines that run remotely and keep nothing on this computer. */
const NO_LOCAL_HISTORY = new Set(["grok", "minimax", "openai-compat", "boxAgent",
  // Murage runs Pi with --no-session: its sessions live in memory only
  // (pi main.ts createSessionManager -> SessionManager.inMemory).
  "piAgent"]);

// ── the deletion service ────────────────────────────────────────────────

export interface DeletionServiceOptions {
  dataDir: string;
  database: () => DatabaseSync;
  /** attachments go through the quota-aware remover when one is given */
  deleteAttachment?: (path: string) => void;
  /** other per-conversation records to drop once the rows are gone; runs
   * before the pending record is cleared, so a crash repeats it */
  forgetThreads?: (threadIds: string[]) => void | Promise<void>;
  /** Pauses before each replay of a deletion that could not finish (default 30 s, 2 min, 10 min, 30 min; then every 6 hours and at
   * each start). An empty list turns the replays off. */
  retryDelaysMs?: number[];
  /** The pause between replays once the list above has run out (default 6 hours). */
  slowRetryMs?: number;
  /** The pause between tries while an engine is open (default 10 minutes). */
  openRetryMs?: number;
  /** Murage's own sessions on these engine homes wait while the steps run. Resolves with `release` and the homes that could not be
   * held (a turn of theirs was still running after the wait): those are skipped this attempt and stay pending. */
  holdHomes?: (homes: DeletionEngineHome[]) => Promise<{ release: () => void; skipped: DeletionEngineHome[] }>;
  /** What is owed to the owner changed (a notice appeared, changed or went away). */
  onOwed?: (notices: OwnerNotice[], rev: number) => void;
  /** How long a home that keeps changing is left alone before it is planned again (default 10 s). */
  staleQuietMs?: number;
}

export class ConversationDeletions {
  readonly journal: string;
  private readonly options: DeletionServiceOptions;
  constructor(options: DeletionServiceOptions) {
    this.options = options;
    this.journal = nodePath.join(options.dataDir, "pending-deletions.json");
  }

  pending(): PendingConversationDeletion[] {
    try {
      const parsed = JSON.parse(readFileSync(this.journal, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as PendingConversationDeletion[]).filter((entry) => entry && typeof entry.id === "string" && Array.isArray(entry.threadIds)) : [];
    } catch {
      return [];
    }
  }

  private save(entries: PendingConversationDeletion[]): void {
    writeFileAtomic(this.journal, JSON.stringify(entries), { mode: 0o600 });
  }

  private get dir() {
    const data = this.options.dataDir;
    return {
      events: nodePath.join(data, "events"),
      native: nodePath.join(data, "native"),
      grokContext: nodePath.join(data, "native", "grok-provider-context"),
      workspaces: nodePath.join(data, "workspaces"),
      skillState: nodePath.join(data, "skill-state"),
      checkpoints: nodePath.join(data, "checkpoints"),
      attachments: nodePath.join(data, "attachments"),
      artifacts: nodePath.join(data, "artifact-files"),
    };
  }

  /** Record what a deletion will remove, before any of it is removed. Throws
   * when the record cannot be written, so nothing is deleted without it. */
  begin(input: DeletionInput): PendingConversationDeletion {
    const threadIds = [...new Set(input.threadIds)].filter((id) => ID.test(id));
    const dirs = this.dir;
    const desks: PendingConversationDeletion["desks"] = [];
    for (const botId of listDir(dirs.workspaces).filter((name) => ID.test(name))) {
      for (const threadId of threadIds) {
        const desk = nodePath.join(dirs.workspaces, botId, "threads", threadId);
        const stat = lstatOrNull(desk);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        let real: string | undefined;
        try { real = realpathSync.native(desk); } catch { real = undefined; }
        // Engines that file notes by folder (Fuigo/Grok memory) name them by
        // the canonical path only outside a git repository.
        const memoryFolder = real && !insideGitRepository(real) ? real : undefined;
        desks.push({ botId, threadId, ...(real ? { checkpointKey: checkpointKey(real) } : {}), ...(memoryFolder ? { memoryFolder } : {}) });
      }
    }
    const leftovers: DeletionLeftover[] = [];
    for (const folder of new Set(input.sharedFolders ?? [])) {
      const name = pathApiFor(folder).basename(folder);
      leftovers.push({ what: "Files this conversation made there, and the engine's history for that folder", where: folder === homedir() ? "your home folder" : `the folder "${name}" you chose` });
    }
    for (const kind of new Set(input.engineKinds ?? [])) {
      if (ENGINE_FOR_DRIVER[kind] || NO_LOCAL_HISTORY.has(kind)) continue;
      leftovers.push({ what: `${engineLabel(kind)}'s own copy of this conversation`, where: `${engineLabel(kind)}'s history on this computer` });
    }
    const entry: PendingConversationDeletion = {
      id: randomUUID(),
      createdAt: Date.now(),
      threadIds,
      desks,
      botIds: [...new Set(input.botIds ?? [])].filter((id) => ID.test(id)),
      engineSessions: this.engineSessionsOf(threadIds, input),
      engineHomes: (input.engineHomes ?? []).filter((home) => Object.values(ENGINE_FOR_DRIVER).includes(home.engine) && typeof home.home === "string" && pathApiFor(home.home).isAbsolute(home.home)),
      attachments: this.attachmentsOnlyIn(threadIds),
      artifactBlobs: this.artifactBlobsOf(threadIds),
      leftovers,
    };
    this.save([...this.pending(), entry]);
    return entry;
  }

  /** The deletion was refused or failed before it committed. */
  abandon(entry: PendingConversationDeletion): void {
    const rest = this.pending().filter((other) => other.id !== entry.id);
    if (rest.length !== this.pending().length) this.save(rest);
  }

  /** Remove everything the record names, then clear the record. If anything in it throws while the record is still pending, the
   * retry schedule is armed again before the error goes on: a scheduled retry, "Try again now" and the start-up pass can all
   * fail on a transient fault (a busy database), and none of them may leave the record with no next attempt. */
  async finish(entry: PendingConversationDeletion): Promise<DeletionReport> {
    try {
      return await this.finishOnce(entry);
    } catch (error) {
      let pending = true;
      try { pending = this.pending().some((item) => item.id === entry.id); } catch { /* the record could not be read: try again */ }
      if (pending) this.scheduleRetry(entry);
      throw error;
    }
  }

  private async finishOnce(entry: PendingConversationDeletion): Promise<DeletionReport> {
    const dirs = this.dir;
    const removed: string[] = [];
    const failed: string[] = [];
    const leftovers = [...entry.leftovers];
    const threadIds = entry.threadIds.filter((id) => ID.test(id));
    this.deleteArtifactRows(threadIds);
    for (const threadId of threadIds) {
      for (const dir of [dirs.events, dirs.native]) {
        for (const name of [`${threadId}.ndjson`, `${threadId}.previous.ndjson`]) record(removeConfined(dir, nodePath.join(dir, name)), nodePath.join(dir, name), removed, failed);
      }
      const grok = nodePath.join(dirs.grokContext, createHash("sha256").update(threadId).digest("hex"));
      record(removeConfined(dirs.grokContext, grok), grok, removed, failed);
    }
    const folders: string[] = [];
    let realWorkspaces: string | undefined;
    try { realWorkspaces = realpathSync.native(dirs.workspaces); } catch { realWorkspaces = undefined; }
    for (const desk of entry.desks) {
      if (!ID.test(desk.botId) || !ID.test(desk.threadId) || !threadIds.includes(desk.threadId)) continue;
      for (const root of new Set([dirs.workspaces, realWorkspaces].filter((dir): dir is string => Boolean(dir)))) folders.push(nodePath.join(root, desk.botId, "threads", desk.threadId));
      const folder = nodePath.join(dirs.workspaces, desk.botId, "threads", desk.threadId);
      record(removeConfined(dirs.workspaces, folder), folder, removed, failed);
      const bundles = nodePath.join(dirs.skillState, desk.botId, "task-bundles", desk.threadId);
      record(removeConfined(dirs.skillState, bundles), bundles, removed, failed);
      if (desk.checkpointKey && /^[a-f0-9]{16}$/.test(desk.checkpointKey)) {
        const shadow = nodePath.join(dirs.checkpoints, desk.botId, desk.checkpointKey);
        record(removeConfined(dirs.checkpoints, shadow), shadow, removed, failed);
      }
    }
    for (const botId of (entry.botIds ?? []).filter((id) => ID.test(id))) {
      for (const root of new Set([dirs.workspaces, realWorkspaces].filter((dir): dir is string => Boolean(dir)))) folders.push(nodePath.join(root, botId));
      for (const root of [dirs.workspaces, dirs.skillState, dirs.checkpoints]) record(removeConfined(root, nodePath.join(root, botId)), nodePath.join(root, botId), removed, failed);
    }
    // Antigravity's own per-thread folder when a turn has none
    // (drivers/antigravity.ts: workspaces/<thread id>), and the engine
    // history kept for it.
    for (const threadId of threadIds) {
      const own = nodePath.join(dirs.workspaces, threadId);
      const stat = lstatOrNull(own);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || lstatOrNull(nodePath.join(own, "threads"))) continue;
      for (const root of new Set([dirs.workspaces, realWorkspaces].filter((dir): dir is string => Boolean(dir)))) folders.push(nodePath.join(root, threadId));
      record(removeConfined(dirs.workspaces, own), own, removed, failed);
    }
    // pinned bundles can exist for a thread whose folder was never made
    for (const botId of listDir(dirs.skillState).filter((name) => ID.test(name))) {
      for (const threadId of threadIds) {
        const bundles = nodePath.join(dirs.skillState, botId, "task-bundles", threadId);
        record(removeConfined(dirs.skillState, bundles), bundles, removed, failed);
      }
    }
    for (const name of entry.attachments.filter((item) => ATTACHMENT_NAME.test(item))) {
      const path = nodePath.join(dirs.attachments, name);
      if (this.options.deleteAttachment) {
        try { this.options.deleteAttachment(path); } catch { failed.push(path); }
        if (lstatOrNull(path)) failed.push(path);
        else removed.push(path);
      } else record(removeConfined(dirs.attachments, path), path, removed, failed);
    }
    for (const name of entry.artifactBlobs.filter((item) => ARTIFACT_BLOB.test(item))) {
      if (this.artifactBlobStillUsed(name)) continue;
      const path = nodePath.join(dirs.artifacts, name);
      record(removeConfined(dirs.artifacts, path), path, removed, failed);
    }
    const memoryFolders = entry.desks.filter((desk) => threadIds.includes(desk.threadId) && typeof desk.memoryFolder === "string" && desk.memoryFolder.endsWith(desk.threadId)).map((desk) => desk.memoryFolder!);
    // The engines' history and messages.db's log are independent: both start now, and neither waits for the other (an engine
    // job can take as long as its own timeout).
    const engineWork = folders.length ? this.removeEngineHistory(entry, { homes: entry.engineHomes, folders: [...new Set(folders)], memoryFolders, sessions: entry.engineSessions ?? {}, redoDir: nodePath.join(this.options.dataDir, "engine-redo") }) : undefined;
    // The rows are gone and overwritten (secure_delete); the write-ahead log still holds the old pages until the log is
    // copied and restarted. That happens without holding the writer lock (wal-maintenance.ts); if a reader holds the log
    // for now, the scrub stays owed there and is retried, and the next start's TRUNCATE settles it after a crash.
    const walWork = scrubWalAfterDelete().catch((error) => { console.warn("conversation deletion: the write-ahead log was not scrubbed yet", error); return false; });
    const engines = await engineWork;
    await walWork;
    if (engines) { removed.push(...engines.removed); failed.push(...engines.failed); leftovers.push(...engines.leftovers); }
    // Once the retry schedule has run out, what is still owed is named for the owner (it is NOT done) and tried again every few
    // hours and at each start. The words come from ownerNoticeText by reason code; nothing from the engine's error is shown.
    if (engines && failed.length) {
      const homes = engines.failedHomes.map((key) => ({ engine: key.split("\0")[0] as DeletionEngine, code: owedCodeOf(engines.homeReasons?.[key]), ...(engines.homeApps?.[key] ? { app: engines.homeApps[key] } : {}) }));
      // An engine that has its files open is told about on the FIRST attempt (the owner can close it and choose Try again);
      // every other reason waits until the retry schedule has run out.
      const named = this.retriesExhausted(entry) ? homes : homes.filter((home) => WAITS_FOR_OWNER.has(home.code));
      this.setOwed(entry, named.length ? { since: entry.owed?.since ?? Date.now(), homes: named } : undefined, new Set(homes.map((home) => home.engine)));
    } else if (!failed.length) this.setOwed(entry, undefined);
    if (!failed.length) {
      this.abandon(entry);
      const retry = this.retries.get(entry.id);
      if (retry?.timer) clearTimeout(retry.timer);
      this.retries.delete(entry.id);
    } else this.scheduleRetry(entry);
    return { leftovers: dedupeLeftovers(leftovers), failed };
  }

  /** Bumped on every change to what is owed, seeded with the clock so a restarted server never goes backwards. It rides on every
   * broadcast and every answer, and the app drops anything older than the newest it has seen (a slow answer to an old question
   * must not undo a newer event). */
  private rev = Date.now();
  /** "Removed from <Engine>." lines for copies that were owed and are now gone; shown for a few minutes. */
  private doneLines: Array<{ id: string; text: string; at: number }> = [];
  private readonly expiryTimers = new Set<ReturnType<typeof setTimeout>>();

  currentRev(): number { return this.rev; }

  private labelFor(engine: DeletionEngine): string {
    const kind = Object.keys(ENGINE_FOR_DRIVER).find((driver) => ENGINE_FOR_DRIVER[driver] === engine);
    return kind ? engineLabel(kind) : "An engine";
  }

  /** The notices owed to the owner right now, one per engine copy still waiting, then the lines for copies just finished. */
  notices(): OwnerNotice[] {
    const out: OwnerNotice[] = [];
    for (const entry of this.pending()) {
      for (const home of entry.owed?.homes ?? []) out.push({ id: `${entry.id}:${home.engine}`, text: ownerNoticeText(this.labelFor(home.engine), home.code, home.app), tryAgain: true });
    }
    this.expireDoneLines();
    for (const line of this.doneLines) out.push({ id: line.id, text: line.text, tryAgain: false });
    return out;
  }

  /** A "Removed from <Engine>." line is shown for five minutes. When one runs out the notice list has changed: the revision
   * advances and the app is told (a window that is still open would otherwise keep the old line on screen), and an answer older
   * than the expiry can no longer put it back. */
  private expireDoneLines(): void {
    const kept = this.doneLines.filter((line) => Date.now() - line.at < DONE_LINE_MS);
    if (kept.length === this.doneLines.length) return;
    this.doneLines = kept;
    this.rev = Math.max(this.rev + 1, Date.now());
    try { this.options.onOwed?.(this.notices(), this.rev); } catch { /* telling the owner never blocks the deletion */ }
  }

  /** Saves what is owed with the pending record and tells the owner when it changed. */
  private setOwed(entry: PendingConversationDeletion, owed: OwedStatus | undefined, failing: ReadonlySet<DeletionEngine> = new Set()): void {
    const before = JSON.stringify(entry.owed ?? null);
    if (before === JSON.stringify(owed ?? null)) return;
    // An engine that was owed and no longer is has had its copy removed.
    const still = new Set((owed?.homes ?? []).map((home) => home.engine));
    for (const home of entry.owed?.homes ?? []) {
      if (still.has(home.engine) || failing.has(home.engine)) continue;
      const id = `${entry.id}:${home.engine}:done`;
      if (!this.doneLines.some((line) => line.id === id)) {
        this.doneLines.push({ id, text: `Removed from ${this.labelFor(home.engine)}.`, at: Date.now() });
        // when the line runs out the window is told, even if nothing else happens by then
        const timer = setTimeout(() => { this.expiryTimers.delete(timer); this.expireDoneLines(); }, DONE_LINE_MS + 50);
        timer.unref?.();
        this.expiryTimers.add(timer);
      }
    }
    this.rev = Math.max(this.rev + 1, Date.now());
    if (owed) entry.owed = owed; else delete entry.owed;
    try {
      const entries = this.pending();
      const at = entries.findIndex((item) => item.id === entry.id);
      if (at >= 0) {
        if (owed) entries[at] = { ...entries[at]!, owed }; else delete entries[at]!.owed;
        this.save(entries);
      }
    } catch (error) { console.warn("conversation deletion: could not save what is owed", error); }
    try { this.options.onOwed?.(this.notices(), this.rev); } catch { /* telling the owner never blocks the deletion */ }
  }

  /** "Try again now": every unfinished deletion is replayed at once, whatever the schedule says. */
  async retryNow(): Promise<number> {
    let started = 0;
    for (const entry of this.pending()) {
      const state = this.retries.get(entry.id);
      if (state?.timer) clearTimeout(state.timer);
      this.retries.delete(entry.id);
      started++;
      try { await this.finish(entry); } catch (error) { console.warn("conversation deletion: a retry could not finish", error); }
    }
    return started;
  }

  /** The pauses between replays. Codex's app-server daemon keeps a rollout open for about a minute after the terminal closes
   * (real-engine qualification), so a deletion made right after closing Codex is tried again every 30 s for 3 minutes before the
   * normal schedule. */
  private delaysFor(entry: PendingConversationDeletion): number[] {
    if (this.options.retryDelaysMs) return this.options.retryDelaysMs;
    const normal = [30_000, 120_000, 600_000, 1_800_000];
    const codexBusy = (entry.owed?.homes ?? []).some((home) => home.engine === "codex" && home.code === "engine-open");
    return codexBusy ? [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, ...normal.slice(1)] : normal;
  }

  /** True once every pause of the retry schedule has been used. */
  private retriesExhausted(entry: PendingConversationDeletion): boolean {
    const delays = this.delaysFor(entry);
    const state = this.retries.get(entry.id);
    return delays.length > 0 && !!state && !state.timer && state.attempts >= delays.length;
  }

  /** Replays: after the pauses of the list, one more every `slowRetryMs` (6 hours), and the next start's reconcile. */
  private readonly retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private disposed = false;

  /** An unfinished deletion keeps its pending record, and is tried again after a growing pause (the record is the retry
   * state; this only decides when to look at it again). */
  private scheduleRetry(entry: PendingConversationDeletion): void {
    if (this.disposed) return;
    const delays = this.delaysFor(entry);
    if (delays.length === 0) return;
    const state = this.retries.get(entry.id) ?? { attempts: 0 };
    this.retries.set(entry.id, state);
    if (state.timer) return;
    // An engine that is open is asked about every 10 minutes (the owner closes it whenever they like); anything else waits for hours.
    const engineOpen = (entry.owed?.homes ?? []).some((home) => WAITS_FOR_OWNER.has(home.code));
    // No gap above 10 minutes while an engine, a file or a new file is what is being waited for.
    const delay = engineOpen
      ? Math.min(state.attempts < delays.length ? delays[state.attempts]! : this.options.openRetryMs ?? 600_000, 600_000)
      : state.attempts < delays.length ? delays[state.attempts]! : this.options.slowRetryMs ?? 6 * 3_600_000;
    state.attempts++;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const current = this.pending().find((item) => item.id === entry.id);
      if (!current || this.disposed) { this.retries.delete(entry.id); return; }
      void this.finish(current).catch((error) => console.warn("conversation deletion: a retry could not finish", error));
    }, delay);
    state.timer.unref();
  }

  /** Stops the retry timers (shutdown). The pending records stay. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.retries.values()) if (state.timer) clearTimeout(state.timer);
    this.retries.clear();
    for (const timer of this.expiryTimers) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  /** The engines' own files can be hundreds of megabytes: planned, rewritten and vacuumed in a worker thread, one job at a time.
   * Four stages, never mixed (engine-history-run.ts):
   *   plan     a read-only job; the engine bodies are planners and read strictly (only "not there" is silent). A home that
   *            cannot be read in full gets no plan and nothing in it is touched.
   *   persist  the plans, and the ids they found, are saved in the pending record BEFORE the first step runs.
   *   execute  only the plan's steps, each idempotent; each finished step is marked done in the record as it finishes. The
   *            executor never discovers: a step whose planned inputs changed is STALE (nothing of it was changed) and its home
   *            is planned again, with the new plan saved before the next execute.
   *   verify   plan again. A home is finished only when a plan of EVERY home, made after the last execute of this attempt and
   *            while Murage's own sessions on those homes are still held, has no content step left.
   * Every attempt starts from a fresh plan of all homes; nothing saved by an earlier attempt counts as proof. Up to
   * MAX_ENGINE_ROUNDS plan/execute/verify rounds per attempt; what is still owed stays in the record for the retry schedule.
   * Never throws. */
  private async removeEngineHistory(entry: PendingConversationDeletion, base: Omit<EngineHistoryJob, "kind" | "known" | "only" | "plans">): Promise<EngineHistoryResult & { failedHomes: string[] }> {
    const homesFailed = (): EngineHistoryResult & { failedHomes: string[] } => ({ removed: [], failed: [...new Set(base.homes.map((home) => home.home))], leftovers: [], failedHomes: [...new Set(base.homes.map((home) => homeKey(home.engine, home.home)))] });
    if (!base.homes.length) return { removed: [], failed: [], leftovers: [], failedHomes: [] };
    const removed: string[] = [], leftovers: EngineHistoryResult["leftovers"] = [];
    const failed = new Set<string>();
    const failedHomes = new Set<string>();
    const reasons: Record<string, string> = {};
    const homeReasons: Record<string, string> = {};
    const homeApps: Record<string, string> = {};
    const keys = [...new Set(base.homes.map((home) => homeKey(home.engine, home.home)))];
    const homeOf = (key: string) => base.homes.find((home) => homeKey(home.engine, home.home) === key)!;
    const stuck = new Set<string>(); // could not be planned, or a step failed, or Murage's own turn was still running: left for the retry
    const executed = new Set<string>(); // executed in THIS attempt
    let closedOfLastPlan: string[] = []; // the homes whose engine was closed before and after the last plan was made
    let uncheckedOfLastPlan = new Set<string>(); // the homes whose engine could not be checked when the last plan was made
    const stale = new Map<string, number>();
    const held = new Map<string, () => void>();
    const giveUp = (key: string, reason: string, path: string) => {
      stuck.add(key); failedHomes.add(key); failed.add(path);
      homeReasons[key] ??= reason;
    };
    // Step marks are kept in memory as they arrive and saved with the pending record once the job has ended (below), whether it
    // finished or its worker died. Never while the worker runs: the record is written and fsynced on this thread, and an fsync
    // made while the worker rewrites a large engine file waits behind that file's writes on the same drive (measured: over 100 ms
    // of a stalled event loop under disk load). A mark is never evidence on a replay, which plans everything again, so a crash of
    // the whole process mid-job loses nothing a mark would have saved.
    const onStep = (key: string, index: number) => {
      const step = entry.enginePlan?.homes[key]?.steps[index];
      if (step) step.done = true;
    };
    try {
      // A fresh plan of everything: a plan saved by an earlier attempt, and any mark in it, is not evidence of anything now.
      entry.enginePlan = { v: 3, homes: {} };
      const plans = entry.enginePlan.homes;
      const settleQuiet = async (quiet: string[]) => {
        // A home that keeps changing is left alone until its planned inputs have stopped changing (at most twice).
        const fingerprint = (key: string) => JSON.stringify((plans[key]?.steps ?? []).map(({ done: _done, ...step }) => step));
        for (let waits = 0; waits < 2; waits++) {
          const before = new Map(quiet.map((key) => [key, fingerprint(key)]));
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.options.staleQuietMs ?? 10_000); timer.unref(); });
          const replanned = await runEngineHistoryOffThread({ ...base, kind: "plan", known: entry.engineDiscovery ?? {}, only: quiet });
          for (const [key, plan] of Object.entries(replanned.plans ?? {})) plans[key] = plan;
          if (replanned.discovery) entry.engineDiscovery = { ...(entry.engineDiscovery ?? {}), ...replanned.discovery };
          this.saveEngineState(entry);
          if (quiet.every((key) => fingerprint(key) === before.get(key))) return;
        }
      };
      for (let round = 0; round <= MAX_ENGINE_ROUNDS; round++) {
        // plan: every home that is not stuck, every round, so the last plan covers all of them
        const only = keys.filter((key) => !stuck.has(key));
        if (only.length) {
          const planned = await runEngineHistoryOffThread({ ...base, kind: "plan", known: entry.engineDiscovery ?? {}, only });
          Object.assign(reasons, planned.reasons);
          Object.assign(homeReasons, planned.homeReasons);
          Object.assign(homeApps, planned.homeApps);
          for (const path of planned.failed) failed.add(path);
          closedOfLastPlan = planned.closedHomes ?? [];
          uncheckedOfLastPlan = new Set(planned.uncheckedHomes ?? []);
          const unplanned = planned.failedHomes ?? (planned.plans ? [] : only);
          for (const key of unplanned) { stuck.add(key); failedHomes.add(key); }
          if (!planned.plans) for (const home of base.homes) if (only.includes(homeKey(home.engine, home.home))) failed.add(home.home); // the job itself failed
          leftovers.push(...planned.leftovers);
          for (const [key, plan] of Object.entries(planned.plans ?? {})) plans[key] = plan;
          const merged = { ...(entry.engineDiscovery ?? {}), ...(planned.discovery ?? {}) };
          if (Object.keys(merged).length) entry.engineDiscovery = merged;
          // persist: the plan and its ids are in the record before anything is changed
          this.saveEngineState(entry);
        }
        const closedNow = new Set<string>();
        if (only.length) for (const key of closedOfLastPlan) closedNow.add(key);
        // A home that was changed is finished only when the plan that shows nothing left was made while its engine was closed.
        for (const key of keys) if (!stuck.has(key) && executed.has(key) && plans[key] && !hasContentSteps(plans[key]!) && only.includes(key) && !closedNow.has(key)) giveUp(key, uncheckedOfLastPlan.has(key) ? "engine-unchecked" : "engine-open", homeOf(key).home);
        const todo = (plan: HomePlanData | undefined, key: string): boolean => !!plan && (executed.has(key) ? hasContentSteps(plan) : plan.steps.length > 0);
        const active = keys.filter((key) => !stuck.has(key) && todo(plans[key], key));
        if (round === MAX_ENGINE_ROUNDS || !active.length) {
          // Out of rounds with a home still changing: it is not done, and the owner is told it was in use.
          for (const key of active) giveUp(key, "changed", homeOf(key).home);
          break;
        }
        // hold: Murage's own sessions on these homes wait while the steps run, and stay held for the verifying plan
        const wanted = active.filter((key) => !held.has(key));
        if (wanted.length && this.options.holdHomes) {
          try {
            const taken = await this.options.holdHomes(wanted.map(homeOf));
            const skipped = new Set(taken.skipped.map((home) => homeKey(home.engine, home.home)));
            let released = false;
            const release = () => { if (!released) { released = true; taken.release(); } };
            for (const key of wanted) held.set(key, release);
            for (const key of wanted) if (skipped.has(key)) giveUp(key, "engine-running", homeOf(key).home);
          } catch (error) {
            // Murage's own sessions on these homes could not be held, so one of them could start the engine: nothing is touched. No
            // engine was seen open, so the owner is not told one is: Murage could not make sure it is closed ("could not check").
            console.warn("conversation deletion: Murage's own sessions could not be held; the homes stay as they are", error);
            for (const key of wanted) giveUp(key, "engine-unchecked", homeOf(key).home);
          }
        }
        const run = Object.fromEntries(active.filter((key) => !stuck.has(key)).map((key) => [key, plans[key]!]));
        if (!Object.keys(run).length) break;
        const ran = await runEngineHistoryOffThread({ ...base, kind: "execute", plans: run }, { onStep });
        removed.push(...ran.removed);
        Object.assign(reasons, ran.reasons);
        Object.assign(homeReasons, ran.homeReasons);
        Object.assign(homeApps, ran.homeApps);
        for (const path of ran.failed) failed.add(path);
        if (ran.factsDelta) {
          const merged = { ...(entry.engineDiscovery ?? {}) };
          applyFactsDelta(merged, ran.factsDelta);
          if (Object.keys(merged).length) entry.engineDiscovery = merged; else delete entry.engineDiscovery;
        }
        if (!ran.factsDelta && ran.failed.length) for (const key of Object.keys(run)) { stuck.add(key); failedHomes.add(key); } // the job itself failed
        for (const key of ran.failedHomes ?? []) { stuck.add(key); failedHomes.add(key); }
        // A home with no failed and no stale step ran every step that was not done: all are marked. A stale home is left
        // unmarked; the next round plans it again.
        const quiet: string[] = [];
        for (const key of Object.keys(run)) {
          executed.add(key);
          if ((ran.staleHomes ?? []).includes(key)) {
            const times = (stale.get(key) ?? 0) + 1;
            stale.set(key, times);
            if (times >= 2) quiet.push(key);
            continue;
          }
          if (!stuck.has(key)) for (const step of plans[key]!.steps) step.done = true;
        }
        this.saveEngineState(entry);
        if (quiet.length && round < MAX_ENGINE_ROUNDS - 1) await settleQuiet(quiet);
      }
      return { removed, failed: [...failed], leftovers, reasons, homeReasons, homeApps, failedHomes: [...failedHomes] };
    } catch (error) {
      console.warn("conversation deletion: the engine history was not removed yet", error);
      return homesFailed();
    } finally {
      for (const release of new Set(held.values())) { try { release(); } catch { /* released */ } }
    }
  }

  /** Saves the plan, its step marks and the ids with the pending record. Throws when the record is gone. */
  private saveEngineState(entry: PendingConversationDeletion): void {
    const entries = this.pending();
    const at = entries.findIndex((item) => item.id === entry.id);
    if (at < 0) throw new Error("the pending deletion record is gone");
    entries[at] = { ...entries[at]!, enginePlan: entry.enginePlan, engineDiscovery: entry.engineDiscovery };
    this.save(entries);
  }

  /** Finish every deletion a crash interrupted. A record whose thread is
   * still live never committed and is dropped; the owner can delete again. */
  /** Every engine session a conversation started, by engine: the resume
   * cursors Murage holds plus each `session.started` in its event log (a
   * rewind starts a new session and forgets the old cursor). */
  private engineSessionsOf(threadIds: string[], input: DeletionInput): Partial<Record<DeletionEngine, string[]>> {
    const found = new Map<DeletionEngine, Set<string>>();
    const add = (kind: string | undefined, id: unknown) => {
      const engine = kind ? ENGINE_FOR_DRIVER[kind] : undefined;
      if (!engine || typeof id !== "string" || !/^[\w.-]{1,200}$/.test(id)) return;
      if (!found.has(engine)) found.set(engine, new Set());
      found.get(engine)!.add(id);
    };
    for (const [kind, ids] of Object.entries(input.sessionIds ?? {})) for (const id of ids) add(kind, id);
    if (input.instanceKind) {
      for (const threadId of threadIds) {
        for (const name of [`${threadId}.previous.ndjson`, `${threadId}.ndjson`]) {
          let text = "";
          try { text = readFileSync(nodePath.join(this.dir.events, name), "utf8"); } catch { continue; }
          for (const line of text.split("\n")) {
            if (!line.includes("session.started")) continue;
            try {
              const event = JSON.parse(line) as { type?: unknown; sessionId?: unknown; providerInstanceId?: unknown };
              if (event.type === "session.started" && typeof event.providerInstanceId === "string") add(input.instanceKind(event.providerInstanceId), event.sessionId);
            } catch { /* a torn line */ }
          }
        }
      }
    }
    return Object.fromEntries([...found].map(([engine, ids]) => [engine, [...ids]]));
  }

  /** How many saved files (the Files library) Delete will remove with these conversations. */
  savedFiles(threadIds: string[]): number {
    const ids = threadIds.filter((id) => ID.test(id));
    if (!ids.length || !this.hasTable("artifacts")) return 0;
    const row = this.options.database().prepare(`SELECT count(*) AS n FROM artifacts WHERE thread_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Drop the conversations' other records (handoffs, audit summaries). */
  async forget(threadIds: string[]): Promise<void> {
    try { await this.options.forgetThreads?.(threadIds.filter((id) => ID.test(id))); } catch (error) { console.error("conversation deletion: could not drop records", error); }
  }

  async reconcile(isLive: (threadId: string) => boolean, deleteRows: (threadId: string) => void): Promise<number> {
    let finished = 0;
    // A crash can leave an engine's history row cut in the middle of a value: finish the crash journals before anything is planned.
    try {
      const homes = this.pending().flatMap((entry) => entry.engineHomes);
      await runEngineHistoryOffThread({ kind: "recover", homes, folders: [], memoryFolders: [], sessions: {}, redoDir: nodePath.join(this.options.dataDir, "engine-redo") });
    } catch (error) { console.warn("conversation deletion: the crash journals were not checked", error); }
    for (const entry of this.pending()) {
      if (entry.threadIds.some(isLive)) {
        this.abandon(entry);
        continue;
      }
      try {
        for (const threadId of entry.threadIds) deleteRows(threadId);
        await this.forget(entry.threadIds);
        await this.finish(entry);
        finished++;
      } catch (error) {
        console.error("conversation deletion: could not finish an interrupted delete", error);
      }
    }
    return finished;
  }

  private hasTable(name: string): boolean {
    try {
      return Boolean(this.options.database().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    } catch {
      return false;
    }
  }

  /** Attachment files these threads' messages name that no other thread names. */
  private attachmentsOnlyIn(threadIds: string[]): string[] {
    if (!threadIds.length || !this.hasTable("messages")) return [];
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    const names = new Set<string>();
    for (const row of db.prepare(`SELECT json FROM messages WHERE thread_id IN (${marks})`).all(...threadIds) as Array<{ json: string }>) {
      for (const match of row.json.matchAll(ATTACHMENT_IN_TEXT)) names.add(match[0].toLowerCase());
    }
    const elsewhere = db.prepare(`SELECT 1 FROM messages WHERE thread_id NOT IN (${marks}) AND instr(lower(json), ?) > 0 LIMIT 1`);
    return [...names].filter((name) => ATTACHMENT_NAME.test(name) && !elsewhere.get(...threadIds, name) && lstatOrNull(nodePath.join(this.dir.attachments, name))?.isFile());
  }

  private artifactBlobsOf(threadIds: string[]): string[] {
    if (!threadIds.length || !this.hasTable("artifacts")) return [];
    const marks = threadIds.map(() => "?").join(",");
    const rows = this.options.database().prepare(`SELECT DISTINCT sha256, extension FROM artifacts WHERE thread_id IN (${marks})`).all(...threadIds) as Array<{ sha256: string; extension: string }>;
    return rows.map((row) => `${row.sha256}${row.extension}`).filter((name) => ARTIFACT_BLOB.test(name));
  }

  private artifactBlobStillUsed(name: string): boolean {
    if (!this.hasTable("artifacts")) return false;
    const dot = name.indexOf(".");
    return Boolean(this.options.database().prepare("SELECT 1 FROM artifacts WHERE sha256=? AND extension=? LIMIT 1").get(name.slice(0, dot), name.slice(dot)));
  }

  private deleteArtifactRows(threadIds: string[]): void {
    if (!threadIds.length) return;
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    if (this.hasTable("output_publications")) db.prepare(`DELETE FROM output_publications WHERE thread_id IN (${marks})`).run(...threadIds);
    if (this.hasTable("artifacts")) db.prepare(`DELETE FROM artifacts WHERE thread_id IN (${marks})`).run(...threadIds);
  }
}

function dedupeLeftovers(leftovers: DeletionLeftover[]): DeletionLeftover[] {
  const seen = new Set<string>();
  return leftovers.filter((item) => {
    const key = `${item.what}\0${item.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Begin, commit, settle, finish. `commit` returns a falsy value when it
 * refused; the record is then dropped and nothing is removed. `settle` runs
 * after the commit and before any file goes (retire idle engine sessions, so
 * nothing writes to a transcript after it is removed). */
export async function runConversationDeletion<T>(deletions: ConversationDeletions, input: DeletionInput, commit: () => T, settle?: () => Promise<void>): Promise<{ result: T; report: DeletionReport }> {
  const entry = deletions.begin(input);
  let result: T;
  try {
    result = commit();
  } catch (error) {
    deletions.abandon(entry);
    throw error;
  }
  if (!result) {
    deletions.abandon(entry);
    return { result, report: { leftovers: [], failed: [] } };
  }
  try { await settle?.(); } catch { /* the files go regardless */ }
  await deletions.forget(entry.threadIds);
  return { result, report: await deletions.finish(entry) };
}
