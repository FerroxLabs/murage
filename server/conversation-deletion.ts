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
import { inScopeFolder, privateScopeHome, scopeCandidates } from "./engine-closed.ts";
import { runEngineHistoryOffThread, type EngineDiscovery, type EngineHistoryJob, type EngineHistoryResult } from "./engine-history-offthread.ts";
import { hasContentSteps, homeKey, pathApiFor, type EnginePlanData, type HomePlanData } from "./engine-plan-core.ts";
import { scrubWalAfterDelete } from "./wal-maintenance.ts";
import { runningAppVersion } from "./memory/app-version.ts";
import { OPEN_PASS_ENGINES } from "./engine-history-run.ts";
import { closeThreadLog, threadLogNames, threadSessionLines, threadTempFiles, type SessionReadOptions } from "./harness/event-log.ts";

const ID = /^[\w-]+$/;
/** How long a synced-folder line stays on screen. */
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
  antigravityAgent: "Antigravity", hermesAgent: "Hermes", openclawAgent: "OpenClaw", clineAgent: "Cline", customAcp: "your custom engine",
};
const engineLabel = (kind: string) => ENGINE_LABEL[kind] ?? "An engine";
/** The driver kind whose label names an engine (codex -> Codex, grok -> Grok). */
const labelOfEngine = (engine: string) => engineLabel(Object.entries(ENGINE_FOR_DRIVER).find(([, value]) => value === engine)?.[0] ?? engine);

/** Which provider instances hold each engine home while a deletion runs (index.ts holdHomes). An owner home is held through the
 * instances whose engine runs in it. A PRIVATE scope of Murage's (engine-closed.ts) is held through EVERY instance of its engine: the
 * scope is found from its own marker, not from an instance's environment, so no instance lists it, and any instance of that engine
 * may run the bot's turns there. Holding more than needed only closes idle warm processes. `byHome`: by home key, the instances whose
 * running turn makes that home skipped this attempt. */
export function instancesForHomes(homes: readonly DeletionEngineHome[], instances: ReadonlyArray<{ instanceId: string; engine: DeletionEngine; homes: readonly DeletionEngineHome[] }>, nativeDir: string): { ids: string[]; byHome: Map<string, string[]> } {
  const byHome = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const home of homes) {
    const key = homeKey(home.engine, home.home);
    const holders = privateScopeHome(home.engine, home.home, nativeDir)
      ? instances.filter((item) => item.engine === home.engine)
      : instances.filter((item) => item.homes.some((owned) => owned.engine === home.engine && owned.home === home.home));
    byHome.set(key, holders.map((item) => item.instanceId));
    for (const item of holders) ids.add(item.instanceId);
  }
  return { ids: [...ids], byHome };
}
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
  /** Attachment files only these conversations seemed to name, but the attachment-name index was not yet complete
   * for every row, so a reference elsewhere could not be ruled out: kept, and decided on a later pass (reconcile). */
  deferredAttachments?: string[];
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
export type OwedCode = "engine-open" | "engine-unchecked" | "held" | "aside" | "using" | "unreadable" | "unopenable" | "helper" | "helper-unloadable" | "other";
/** One engine home this deletion still owes, as the last attempt left it. `named`: the owner may be told about it (an engine that
 * is open or cannot be told, a file another program has, at once; anything else once the retry schedule has run out). `since`: when
 * this engine first became owed for this deletion (the grace before anything is shown counts from it). `dismissedAt`: the owner
 * dismissed the line that covered it; it keeps being retried and clears itself when done, it is only not shown. `version`: for
 * "helper-unloadable", the version of Murage whose helper would not load; the next start of ANOTHER version tries again. */
export interface OwedItem { engine: DeletionEngine; code: OwedCode; /** the desktop application that is open (Claude, Cursor), when that is why */ app?: string; /** `engine\0home` */ home?: string; named?: boolean; since: number; dismissedAt?: number; version?: string }
/** What is still owed for one deletion. 1.0.3 saved `homes` (one per failing home, every one named); it is read as `items`. */
export interface OwedStatus { since: number; items: OwedItem[] }
/** What the owner is told about engine copies that are still owed: one line per engine. `covers`: the obligations (`<deletion id>:<engine>`)
 * the line stands for, which Dismiss names, so a newer deletion owed by the same engine is never dismissed with it. */
export interface OwnerNotice { id: string; text: string; /** the owner may ask Murage to try again now (false for a line that says a copy is gone) */ tryAgain: boolean; covers?: string[];
  /** the engine is open: a retry cannot change that, and Murage finishes by itself once it closes, so the window offers no "Try again now" for it */
  byItself?: true;
  /** Murage's helper cannot load on this system: the copy is not cleared by itself, it is tried again after Murage's next update */
  waitsForUpdate?: true;
  /** the bots whose conversations the line is about */
  botIds?: string[];
  /** the engine's name as the owner knows it (Claude Code, Grok), for the one quiet line in Settings that sums up what is owed */
  label?: string }
/** What "Try again now" did: the engines whose copies are now gone, those still owed (one per engine), whether anything changed at all,
 * and one short line saying so. */
export interface RetryResult { started: number; finished: DeletionEngine[]; still: Array<{ engine: DeletionEngine; code: OwedCode; app?: string }>; unchanged: boolean; line: string }

/** The journal of pending deletions exists but could not be read or parsed. Never read as "nothing pending": nothing is written over it,
 * and the owner is told Murage could not read its list. */
export class JournalUnreadableError extends Error {
  constructor(why: string) { super(`the pending deletions could not be read: ${why}`); this.name = "JournalUnreadableError"; }
}
/** The line shown when the journal cannot be read. */
export const JOURNAL_UNREADABLE_TEXT = "Murage could not read its list of deleted conversations to finish. It tries again by itself.";
/** How long an owed copy waits before the owner is told about it (a Codex session lets go of its files about a minute after its terminal closes). */
export const OWED_GRACE_MS = 120_000;
/** The bots whose conversations a deletion removed (its desks, and bots deleted whole), sorted: where its lines are shown. */
function deletionBotIds(entry: Pick<PendingConversationDeletion, "desks" | "botIds">): string[] {
  return [...new Set([...entry.desks.map((desk) => desk.botId), ...(entry.botIds ?? [])].filter((id) => ID.test(id)))].sort();
}
/** The grace before an owed line is shown: none for a helper that cannot load (it never clears by itself), else `grace`. */
const graceOf = (item: Pick<OwedItem, "code">, grace: number): number => item.code === "helper-unloadable" ? Math.min(grace, UNLOADABLE_GRACE_MS) : grace;
/** An undismissed owed line is told again on an automatic retry only when the window was last told at least this long ago: a window
 * that dropped the broadcast gets it on the next retry after this, and fast retries do not repeat the same notice. */
export const OWED_RETELL_MS = 60_000;

/** 1.0.3's `owed.homes` as items (every one was shown), and anything that is not an owed record as none. */
export function normalizeOwed(owed: unknown): OwedStatus | undefined {
  if (!owed || typeof owed !== "object") return undefined;
  const raw = owed as { since?: unknown; items?: unknown; homes?: unknown };
  const since = typeof raw.since === "number" && Number.isFinite(raw.since) ? raw.since : Date.now();
  const valid = (item: unknown): item is { engine: DeletionEngine; code: OwedCode } => !!item && typeof (item as { engine?: unknown }).engine === "string" && typeof (item as { code?: unknown }).code === "string";
  const items: OwedItem[] = Array.isArray(raw.items)
    ? raw.items.filter(valid).map((item) => ({ ...(item as OwedItem), since: typeof (item as OwedItem).since === "number" ? (item as OwedItem).since : since }))
    : Array.isArray(raw.homes) ? raw.homes.filter(valid).map((home) => { const app = (home as { app?: unknown }).app; return { engine: home.engine, code: home.code, ...(typeof app === "string" && app ? { app } : {}), named: true, since }; }) : [];
  return items.length ? { since: Math.min(since, ...items.map((item) => item.since)), items } : undefined;
}

/** When one engine is owed for different reasons, the line says the one the owner can most act on. A helper that cannot load comes first:
 * nothing of that engine is cleared before Murage's next update, whatever else holds another of its homes, so no other line is true. */
const CODE_RANK: readonly OwedCode[] = ["helper-unloadable", "engine-open", "held", "aside", "engine-unchecked", "helper", "using", "unopenable", "unreadable", "other"];
const rankOf = (code: OwedCode): number => { const at = CODE_RANK.indexOf(code); return at < 0 ? CODE_RANK.length : at; };

/** The codes that mean "tried and not touched, try again soon": an engine that is open or cannot be told, a file another program has, a
 * file the engine started anew. Each is asked about every 10 minutes at most (the owner closes an engine whenever they like) and told on
 * the FIRST attempt. */
const WAITS_FOR_OWNER: ReadonlySet<OwedCode> = new Set<OwedCode>(["engine-open", "engine-unchecked", "held", "aside"]);
/** The codes named on the FIRST attempt: those above, and a helper that cannot load on this system (no retry before Murage's next
 * update can change that, so waiting out the schedule would only keep the owner from knowing for 45 minutes). */
const NAMED_AT_ONCE: ReadonlySet<OwedCode> = new Set<OwedCode>([...WAITS_FOR_OWNER, "helper-unloadable"]);
/** How long a line for a helper that cannot load waits before it is shown: none. It never clears by itself, so it cannot flash. */
export const UNLOADABLE_GRACE_MS = 0;

/** How long a hold gives Murage's own running turn to end, by the attempts this deletion already lost to one: 250 ms, 1 s, 4 s, then 15 s.
 * New turns of those instances wait for that long at most, once per attempt (harness/instance-holds.ts). */
export const HOLD_WAIT_STEPS_MS: readonly number[] = [250, 1_000, 4_000, 15_000, 60_000, 240_000];
/** Looks at an unchanged holder set after which the attempt runs anyway (the main process's view of a home can differ from the worker's
 * for a private scope; a look is 10 minutes, so an hour at most passes before the worker judges for itself). */
export const OPEN_LOOKS_MAX = 6;
export function holdWaitMs(ownTurnLosses: number): number { return HOLD_WAIT_STEPS_MS[Math.max(0, Math.min(HOLD_WAIT_STEPS_MS.length - 1, ownTurnLosses))]!; }
/** The code for a home's first failure reason. */
export function owedCodeOf(reason: string | undefined): OwedCode {
  const text = reason ?? "";
  if (text === "engine-open") return "engine-open";
  if (text === "engine-unchecked") return "engine-unchecked";
  if (text === "held") return "held";
  if (text === "aside") return "aside";
  if (/^(EACCES|EPERM|EROFS)$/.test(text)) return "unopenable";
  if (/^(EIO|EMFILE|ENFILE|ENAMETOOLONG|ENOENT|ENOTDIR|EISDIR)$/.test(text)) return "unreadable";
  if (/^(busy|changed|locked|engine-running)$/.test(text) || /locked by its engine|kept changing|still being written/.test(text)) return "using";
  if (text === "helper-unloadable") return "helper-unloadable";
  if (text === "worker-unavailable" || text === "helper") return "helper";
  return "other";
}
/** The line for an engine that keeps its files in a synced folder (shown once, after the conversation is removed from it). */
export function syncedHomeText(label: string): string {
  return `This conversation is removed from ${label}. ${label} keeps its files in a synced folder, so your cloud provider may still hold older copies in its version history.`;
}
/** The words for one engine whose copies are still owed, for `count` deletions. Authored here, keyed by code; no paths, no errors. Short,
 * and they say what Murage is doing: it finishes this by itself, nothing is needed from the owner. */
export function ownerNoticeText(label: string, code: OwedCode, app?: string, count = 1): string {
  const what = count > 1 ? `these ${count.toLocaleString("en-US")} conversations` : "this conversation";
  const tail = "Nothing is needed from you.";
  switch (code) {
    case "engine-open": {
      const shown = app?.trim();
      return shown
        ? `${label} or the ${shown} app is open. Murage finishes removing ${what} from ${label} by itself once they are closed. ${tail}`
        : `${label} is open. Murage finishes removing ${what} from it by itself once ${label} is closed. ${tail}`;
    }
    case "engine-unchecked": return `Murage could not check whether ${label} is open. It checks again within 10 minutes and finishes removing ${what} by itself.`;
    case "held": return `Another program is using ${label}'s files. Murage tries again in 10 minutes and finishes removing ${what} by itself.`;
    case "aside": return `${label} started a new file while Murage was removing ${what}. Murage joins them and finishes by itself.`;
    case "unopenable": return `Murage was not allowed to open ${label}'s history. It tries again when it starts and finishes removing ${what} once it can.`;
    case "using": return `${label} was using its history. Murage tries again by itself and finishes removing ${what}.`;
    case "unreadable": return `Murage could not read ${label}'s history yet. It tries again by itself and finishes removing ${what}.`;
    case "helper": return `Murage could not start its cleanup helper. It tries again by itself and finishes removing ${what} from ${label}.`;
    case "helper-unloadable": return `Murage removed ${what}, but could not clear ${count > 1 ? "them" : "it"} from ${label}'s own history on this system. Murage tries again after its next update.`;
    default: return `Murage is still removing ${what} from ${label}. It finishes this by itself. ${tail}`;
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
  /** tests: the shortest gap between two `home not read` lines for one home another program keeps open (FOREIGN_RELOG_MS) */
  foreignRelogMs?: number;
  /** The pause between replays once the list above has run out (default 6 hours). */
  slowRetryMs?: number;
  /** The pause between tries while an engine is open (default 10 minutes). */
  openRetryMs?: number;
  /** Reads the engine homes' state without a plan (a process-list read: no worker thread, no pause of the background runs, no plan line
   * in the log): whether an engine process holds each home, with a fingerprint of the holders (SELF-OVERLOAD-105 item 2). Before a retry,
   * homes held by the SAME holders as after the last attempt are not planned again; the look is repeated every openRetryMs until the
   * holders change or go, then the attempt runs as before. */
  probeHomes?: (homes: DeletionEngineHome[]) => Array<{ key: string; open: boolean; holders: string }>;
  /** Looks at an unchanged holder set before an attempt runs anyway (default OPEN_LOOKS_MAX). */
  openLooksMax?: number;
  /** Calls `wake` once, when no Murage turn is running on any instance that uses these homes and one of them saw a turn end at or
   * after `since` (harness/instance-holds.ts `whenFree`). A home skipped because Murage's own turn was running (`engine-running`)
   * is tried again as soon as that turn ends, not on the schedule. Returns how to stop waiting. */
  whenEnginesFree?: (homes: DeletionEngineHome[], since: number, wake: () => void) => () => void;
  /** The pause between Murage's own turn ending and the try it wakes (default 1 s, so a burst of turn ends settles first). */
  freeRetryMs?: number;
  /** Murage's own sessions on these engine homes wait while the steps run. Resolves with `release` and the homes that could not be
   * held (a turn of theirs was still running after the wait): those are skipped this attempt and stay pending. */
  /** Pauses Murage's own background one-shot runs of these engines before the deletion plans (they would read as the engine being
   * open); resolves when they are gone or the wait ran out, and returns how to let them start again. */
  pauseBackgroundRuns?: (engines: DeletionEngine[]) => Promise<() => void>;
  /** `waitMs`: how long a running turn of Murage's own gets to end before the home is skipped (SELF-OVERLOAD-105 item 2: it grows with
   * every attempt the same deletion lost to a running turn, 250 ms, 1 s, 4 s, 15 s, so a bot whose turns never stop cannot keep a deletion
   * owed for days; new turns wait only for that long, once per attempt). */
  holdHomes?: (homes: DeletionEngineHome[], waitMs?: number) => Promise<{ release: () => void; skipped: DeletionEngineHome[] }>;
  /** What is owed to the owner changed (a notice appeared, changed or went away). */
  onOwed?: (notices: OwnerNotice[], rev: number) => void;
  /** How long a home that keeps changing is left alone before it is planned again (default 10 s). */
  staleQuietMs?: number;
  /** How long a copy is owed before the owner is told about it (default OWED_GRACE_MS, 2 minutes). Retries go on meanwhile. */
  owedGraceMs?: number;
  /** The least time between two tellings of an unchanged owed line on automatic retries (default OWED_RETELL_MS, 1 minute). */
  owedRetellMs?: number;
  /** The running Murage version (default runningAppVersion). A copy owed because the helper cannot load is tried again at a start of a
   * different version than the one it failed under; null (unknown) always tries. */
  appVersion?: () => string | null;
}

/** A home skipped because another program has it open is still given one whole attempt (pause, hold, plan) every this many tries
 * (an hour at the ten-minute pace), so a home held by a process of Murage's own that the probe cannot place still gets the hold. */
export const FULL_TRY_EVERY = 6;
/** While another program keeps an engine home open, a changed holder is logged again at most this often. */
export const FOREIGN_RELOG_MS = 3_600_000;

export class ConversationDeletions {
  readonly journal: string;
  private readonly options: DeletionServiceOptions;
  constructor(options: DeletionServiceOptions) {
    this.options = options;
    this.journal = nodePath.join(options.dataDir, "pending-deletions.json");
  }

  private get redoDir(): string { return nodePath.join(this.options.dataDir, "engine-redo"); }
  /** The pending deletions. No journal is none; a journal that is there but cannot be read or parsed throws JournalUnreadableError
   * (never read as none: a save made from that would drop every deletion it holds). */
  pending(): PendingConversationDeletion[] {
    let text: string;
    try { text = readFileSync(this.journal, "utf8"); } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return [];
      throw new JournalUnreadableError(code ?? String(error));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new JournalUnreadableError("it does not parse"); }
    if (!Array.isArray(parsed)) throw new JournalUnreadableError("it is not a list");
    return (parsed as PendingConversationDeletion[]).filter((entry) => entry && typeof entry.id === "string" && Array.isArray(entry.threadIds));
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
  begin(input: DeletionInput, logSessions?: Partial<Record<DeletionEngine, string[]>>): PendingConversationDeletion {
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
    const attached = this.attachmentsOnlyIn(threadIds);
    const entry: PendingConversationDeletion = {
      id: randomUUID(),
      createdAt: Date.now(),
      threadIds,
      desks,
      botIds: [...new Set(input.botIds ?? [])].filter((id) => ID.test(id)),
      engineSessions: this.engineSessionsOf(input, logSessions),
      engineHomes: (input.engineHomes ?? []).filter((home) => Object.values(ENGINE_FOR_DRIVER).includes(home.engine) && typeof home.home === "string" && pathApiFor(home.home).isAbsolute(home.home)),
      attachments: attached.remove,
      ...(attached.deferred.length ? { deferredAttachments: attached.deferred } : {}),
      artifactBlobs: this.artifactBlobsOf(threadIds),
      leftovers,
    };
    this.active.add(entry.id);
    this.save([...this.pending(), entry]);
    return entry;
  }

  /** Deletions between begin and finish in this process: never settled early by `settleDeferred`. */
  private readonly active = new Set<string>();

  /** The attachment-name index has reached every row (or a later pass cleared deferrals): decide the files a deletion had to keep, now,
   * without a restart. Returns how many records it finished. A deletion that fails here stays pending for the next pass or the next boot. */
  async settleDeferred(isLive: (threadId: string) => boolean): Promise<number> {
    let finished = 0;
    try {
      for (const entry of this.pending()) {
        if (!entry.deferredAttachments?.length || this.active.has(entry.id) || entry.threadIds.some(isLive)) continue;
        try { await this.finish(entry); finished++; } catch (error) { console.error("conversation deletion: could not settle deferred attachments", error); }
      }
    } catch (error) {
      console.error("conversation deletion: could not settle deferred attachments", error);
    }
    return finished;
  }

  /** The deletion was refused or failed before it committed. */
  abandon(entry: PendingConversationDeletion): void {
    this.active.delete(entry.id);
    const rest = this.pending().filter((other) => other.id !== entry.id);
    if (rest.length !== this.pending().length) this.save(rest);
  }

  /** Remove everything the record names, then clear the record. If anything in it throws while the record is still pending, the
   * retry schedule is armed again before the error goes on: a scheduled retry, "Try again now" and the start-up pass can all
   * fail on a transient fault (a busy database), and none of them may leave the record with no next attempt. */
  async finish(entry: PendingConversationDeletion, options: { allHomes?: boolean } = {}): Promise<DeletionReport> {
    // One attempt per deletion at a time: two plan/execute loops on one engine home could each rewrite a file from a stale copy and
    // put back lines the other just removed (engine-history-offthread.ts). A call that arrives while an attempt runs (a woken wait, a
    // timer, "Try again now") gets that attempt's answer, and one more attempt follows it at once when the record is still pending.
    if (options.allHomes) this.allHomes.add(entry.id);
    const running = this.inFlight.get(entry.id);
    if (running) { this.again.add(entry.id); return running; }
    const attempt = (async () => {
      let current = entry;
      try {
        for (;;) {
          this.again.delete(current.id);
          const allHomes = this.allHomes.delete(current.id);
          const report = await this.finishGuarded(current, allHomes);
          if (!this.again.has(current.id) || this.disposed) return report;
          let next: PendingConversationDeletion | undefined;
          try { next = this.pending().find((item) => item.id === current.id); } catch { next = undefined; }
          if (!next) return report;
          const state = this.retries.get(current.id);
          if (state?.timer) { clearTimeout(state.timer); state.timer = undefined; }
          current = next;
        }
      } finally {
        this.inFlight.delete(entry.id);
        this.again.delete(entry.id);
        this.allHomes.delete(entry.id);
      }
    })();
    this.inFlight.set(entry.id, attempt);
    return attempt;
  }

  /** The attempt in flight for each deletion, and the deletions asked for again while theirs ran. */
  private readonly inFlight = new Map<string, Promise<DeletionReport>>();
  private readonly again = new Set<string>();
  /** The deletions whose next attempt plans every home, a home that waits for Murage's next update too ("Try again now"). */
  private readonly allHomes = new Set<string>();

  private async finishGuarded(entry: PendingConversationDeletion, allHomes = false): Promise<DeletionReport> {
    // The wait for Murage's own turns that the last attempt armed ends here: this attempt plans every home again, and arms a new
    // wait (from its own start time) if a turn still holds one back. A turn that ends meanwhile can never start a second attempt.
    this.ownTurnWaits.get(entry.id)?.();
    this.ownTurnWaits.delete(entry.id);
    try {
      return await this.finishOnce(entry, allHomes);
    } catch (error) {
      let pending = true;
      try { pending = this.pending().some((item) => item.id === entry.id); } catch { /* the record could not be read: try again */ }
      if (pending) this.scheduleRetry(entry);
      throw error;
    }
  }

  private async finishOnce(entry: PendingConversationDeletion, allHomes = false): Promise<DeletionReport> {
    const startedAt = Date.now();
    const dirs = this.dir;
    const removed: string[] = [];
    const failed: string[] = [];
    const leftovers = [...entry.leftovers];
    const threadIds = entry.threadIds.filter((id) => ID.test(id));
    this.deleteArtifactRows(threadIds);
    for (const threadId of threadIds) {
      // a late event from a turn still winding down never brings the log back
      closeThreadLog(threadId);
      // the event log with its rotation, its sessions file and any rewrite in flight (harness/event-log.ts)
      for (const name of [...threadLogNames(threadId), ...threadTempFiles(dirs.events, threadId)]) record(removeConfined(dirs.events, nodePath.join(dirs.events, name)), nodePath.join(dirs.events, name), removed, failed);
      for (const name of [`${threadId}.ndjson`, `${threadId}.previous.ndjson`]) record(removeConfined(dirs.native, nodePath.join(dirs.native, name)), nodePath.join(dirs.native, name), removed, failed);
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
    const removeAttachment = (name: string) => {
      const path = nodePath.join(dirs.attachments, name);
      if (this.options.deleteAttachment) {
        try { this.options.deleteAttachment(path); } catch { failed.push(path); }
        if (lstatOrNull(path)) failed.push(path);
        else removed.push(path);
      } else record(removeConfined(dirs.attachments, path), path, removed, failed);
    };
    for (const name of entry.attachments.filter((item) => ATTACHMENT_NAME.test(item))) removeAttachment(name);
    // files the index could not yet vouch for: decided now if it can (no reference elsewhere: gone; one: kept), else left for a later pass
    const stillDeferred: string[] = [];
    for (const name of (entry.deferredAttachments ?? []).filter((item) => ATTACHMENT_NAME.test(item))) {
      const verdict = this.referencedElsewhere(name, threadIds);
      if (verdict === "unknown") stillDeferred.push(name);
      else if (verdict === "no" && lstatOrNull(nodePath.join(dirs.attachments, name))?.isFile()) removeAttachment(name);
    }
    for (const name of entry.artifactBlobs.filter((item) => ARTIFACT_BLOB.test(item))) {
      if (this.artifactBlobStillUsed(name)) continue;
      const path = nodePath.join(dirs.artifacts, name);
      record(removeConfined(dirs.artifacts, path), path, removed, failed);
    }
    const memoryFolders = entry.desks.filter((desk) => threadIds.includes(desk.threadId) && typeof desk.memoryFolder === "string" && desk.memoryFolder.endsWith(desk.threadId)).map((desk) => desk.memoryFolder!);
    // Murage's private Codex and Grok scopes of these bots join the homes (saved in the record before anything is planned).
    if (folders.length) this.mergeScopes(entry, leftovers);
    // A home whose helper would not load under this same version waits for Murage's next update: an automatic attempt (the schedule,
    // the end of Murage's own turn, a start) leaves it as it is owed and works on the other homes. "Try again now" plans it too.
    const deferred = allHomes ? [] : this.deferredHomes(entry);
    const deferredKeys = new Set(deferred.map((home) => homeKey(home.engine, home.home)));
    const homes = deferred.length ? entry.engineHomes.filter((home) => !deferredKeys.has(homeKey(home.engine, home.home))) : entry.engineHomes;
    // The engines' history and messages.db's log are independent: both start now, and neither waits for the other (an engine
    // job can take as long as its own timeout).
    const engineWork = folders.length ? this.removeEngineHistory(entry, { homes, folders: [...new Set(folders)], memoryFolders, sessions: entry.engineSessions ?? {}, redoDir: this.redoDir, nativeDir: this.dir.native }) : undefined;
    // The rows are gone and overwritten (secure_delete); the write-ahead log still holds the old pages until the log is
    // copied and restarted. That happens without holding the writer lock (wal-maintenance.ts); if a reader holds the log
    // for now, the scrub stays owed there and is retried, and the next start's TRUNCATE settles it after a crash.
    const walWork = scrubWalAfterDelete().catch((error) => { console.warn("conversation deletion: the write-ahead log was not scrubbed yet", error); return false; });
    const ran = await engineWork;
    await walWork;
    // the homes left for Murage's next update are still owed, for the same reason
    const engines = ran && deferred.length ? {
      ...ran,
      failed: [...new Set([...ran.failed, ...deferred.map((home) => home.home)])],
      failedHomes: [...ran.failedHomes, ...deferredKeys],
      homeReasons: { ...ran.homeReasons, ...Object.fromEntries([...deferredKeys].map((key) => [key, "helper-unloadable"])) },
    } : ran;
    if (engines) { removed.push(...engines.removed); failed.push(...engines.failed); leftovers.push(...engines.leftovers); }
    // Once the retry schedule has run out, what is still owed is named for the owner (it is NOT done) and tried again every few
    // hours and at each start. The words come from ownerNoticeText by reason code; nothing from the engine's error is shown.
    let owedSaved = false;
    if (engines && failed.length) {
      // Every home still owed is kept (what "Try again now" compares). An engine that has its files open is named at once (the line
      // still waits for the grace period); every other reason only once the retry schedule has run out.
      const exhausted = this.retriesExhausted(entry);
      const version = this.appVersion();
      const items = engines.failedHomes.map((key) => {
        const code = owedCodeOf(engines.homeReasons?.[key]);
        return { engine: key.split("\0")[0] as DeletionEngine, code, home: key, ...(engines.homeApps?.[key] ? { app: engines.homeApps[key] } : {}), ...(exhausted || NAMED_AT_ONCE.has(code) ? { named: true } : {}), ...(code === "helper-unloadable" && version ? { version } : {}) };
      });
      owedSaved = this.setOwed(entry, items);
    } else if (!failed.length) this.setOwed(entry, []);
    // A home in a synced folder: once its copy is gone the owner is told, once, that the cloud provider may keep older copies.
    if (engines) this.tellSynced(entry, engines);
    if (stillDeferred.length) leftovers.push({ what: `${stillDeferred.length === 1 ? "An attachment file" : `${stillDeferred.length} attachment files`} still being checked against your other conversations`, where: "your attachments folder; removed automatically once the check finishes" });
    this.active.delete(entry.id);
    // files the attachment index could not yet vouch for keep the record (settleDeferred decides them later); only a failure schedules a retry
    if (stillDeferred.length) {
      this.save(this.pending().map((other) => other.id === entry.id ? { ...other, attachments: [], deferredAttachments: stillDeferred } : other));
    }
    // A home skipped because Murage's own turn on the engine was still running is tried again as soon as that turn ends.
    const ownTurnKeys = failed.length && engines ? engines.failedHomes.filter((key) => engines.homeReasons?.[key] === "engine-running") : [];
    this.waitForOwnTurns(entry, ownTurnKeys.length ? entry.engineHomes.filter((home) => ownTurnKeys.includes(homeKey(home.engine, home.home))) : [], startedAt);
    if (!failed.length && !stillDeferred.length) {
      this.abandon(entry);
      const retry = this.retries.get(entry.id);
      if (retry?.timer) clearTimeout(retry.timer);
      this.retries.delete(entry.id);
    } else if (failed.length) {
      const state = this.retries.get(entry.id) ?? { attempts: 0 };
      state.ownTurn = ownTurnKeys.length > 0;
      state.ownTurnLosses = ownTurnKeys.length > 0 ? (state.ownTurnLosses ?? 0) + 1 : 0;
      state.holders = this.holdersOf(entry); state.looks = 0;
      this.retries.set(entry.id, state);
      // Only engine homes whose helper would not load under THIS version are owed: no retry can change that before Murage is updated,
      // so no timer is armed (the 6-hour cadence would run for good). Every start still runs reconcile in full (rows, records, Murage's
      // own files) and leaves only those homes out; a start of another version, and "Try again now", plan them too. Anything else
      // owed (a file of Murage's own, another home, an unknown version, a notice the journal did not keep) keeps the schedule.
      const onlyUnloadable = !!engines && !!this.appVersion() && !ownTurnKeys.length && failed.length === engines.failed.length && engines.failedHomes.length > 0
        && engines.failedHomes.every((key) => owedCodeOf(engines.homeReasons?.[key]) === "helper-unloadable");
      if (onlyUnloadable && owedSaved) { if (state.timer) { clearTimeout(state.timer); state.timer = undefined; } }
      else this.scheduleRetry(entry);
    }
    return { leftovers: dedupeLeftovers(leftovers), failed };
  }

  /** The waits for Murage's own turns to end, by deletion. At most one per deletion; each attempt replaces it. */
  private readonly ownTurnWaits = new Map<string, () => void>();

  /** Waits for Murage's own turns on these homes to end, then replaces the scheduled try with one a moment later. No homes: any
   * wait this deletion had is cancelled. */
  private waitForOwnTurns(entry: PendingConversationDeletion, homes: DeletionEngineHome[], since: number): void {
    this.ownTurnWaits.get(entry.id)?.();
    this.ownTurnWaits.delete(entry.id);
    if (!homes.length || this.disposed || !this.options.whenEnginesFree) return;
    let cancel: (() => void) | undefined;
    let woke = false;
    const wake = () => {
      woke = true;
      if (this.ownTurnWaits.get(entry.id) === cancel) this.ownTurnWaits.delete(entry.id);
      if (this.disposed) return;
      const state = this.retries.get(entry.id) ?? { attempts: 0 };
      this.retries.set(entry.id, state);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        let current: PendingConversationDeletion | undefined;
        try { current = this.pending().find((item) => item.id === entry.id); } catch { current = entry; }
        if (!current || this.disposed) { this.retries.delete(entry.id); return; }
        void this.finish(current).catch((error) => console.warn("conversation deletion: a retry could not finish", error));
      }, this.options.freeRetryMs ?? 1_000);
      state.timer.unref?.();
    };
    try { cancel = this.options.whenEnginesFree(homes, since, wake); } catch (error) { console.warn("conversation deletion: could not wait for Murage's own turns to end", error); return; }
    if (!woke) this.ownTurnWaits.set(entry.id, cancel);
  }

  /** Bumped on every change to what is owed, seeded with the clock so a restarted server never goes backwards. It rides on every
   * broadcast and every answer, and the app drops anything older than the newest it has seen (a slow answer to an old question
   * must not undo a newer event). */
  private rev = Date.now();
  /** The synced-folder lines (a copy is gone, and the cloud provider may keep older ones); shown for a few minutes. There is no
   * "Removed from <Engine>." line: when nothing is owed, nothing is shown. */
  private doneLines: Array<{ id: string; text: string; at: number; botIds?: string[] }> = [];
  private readonly expiryTimers = new Set<ReturnType<typeof setTimeout>>();

  currentRev(): number { return this.rev; }

  private appVersion(): string | null {
    try { return (this.options.appVersion ?? runningAppVersion)() ?? null; } catch { return null; }
  }

  /** The homes of this deletion owed because the helper would not load under THIS version (none when the version is unknown). */
  private deferredHomes(entry: PendingConversationDeletion): DeletionEngineHome[] {
    const version = this.appVersion();
    if (!version) return [];
    const keys = new Set((normalizeOwed(entry.owed)?.items ?? []).filter((item) => item.code === "helper-unloadable" && item.version === version && item.home).map((item) => item.home!));
    return keys.size ? entry.engineHomes.filter((home) => keys.has(homeKey(home.engine, home.home))) : [];
  }

  private labelFor(engine: DeletionEngine): string {
    const kind = Object.keys(ENGINE_FOR_DRIVER).find((driver) => ENGINE_FOR_DRIVER[driver] === engine);
    return kind ? engineLabel(kind) : "An engine";
  }

  /** The notices owed to the owner right now: ONE line per engine, whatever the number of deletions or homes behind it, for the copies
   * that may be named, have waited out the grace period and were not dismissed; then the synced-folder lines. A journal that cannot be
   * read is one line that says so (never "nothing owed"). */
  notices(): OwnerNotice[] {
    let entries: PendingConversationDeletion[];
    try { entries = this.pending(); } catch { return [{ id: "owed:journal", text: JOURNAL_UNREADABLE_TEXT, tryAgain: true, covers: [] }]; }
    const grace = this.options.owedGraceMs ?? OWED_GRACE_MS;
    const now = Date.now();
    const byEngine = new Map<DeletionEngine, { code: OwedCode; app?: string; deletions: Set<string>; covers: Set<string>; bots: Set<string> }>();
    for (const entry of entries) {
      for (const item of normalizeOwed(entry.owed)?.items ?? []) {
        if (!item.named || item.dismissedAt !== undefined || now - item.since < graceOf(item, grace)) continue;
        const line = byEngine.get(item.engine) ?? { code: item.code, deletions: new Set<string>(), covers: new Set<string>(), bots: new Set<string>() };
        for (const id of deletionBotIds(entry)) line.bots.add(id);
        if (rankOf(item.code) < rankOf(line.code)) { line.code = item.code; line.app = item.app; }
        else if (item.code === line.code && !line.app && item.app) line.app = item.app;
        line.deletions.add(entry.id);
        line.covers.add(`${entry.id}:${item.engine}`);
        byEngine.set(item.engine, line);
      }
    }
    const out: OwnerNotice[] = [...byEngine].map(([engine, line]) => ({ id: `owed:${engine}`, text: ownerNoticeText(this.labelFor(engine), line.code, line.app, line.deletions.size), tryAgain: true, covers: [...line.covers], label: this.labelFor(engine), ...(line.code === "engine-open" ? { byItself: true as const } : {}), ...(line.code === "helper-unloadable" ? { waitsForUpdate: true as const } : {}), ...(line.bots.size ? { botIds: [...line.bots].sort() } : {}) }));
    this.expireDoneLines();
    for (const line of this.doneLines) out.push({ id: line.id, text: line.text, tryAgain: false, covers: [line.id], ...(line.botIds?.length ? { botIds: line.botIds } : {}) });
    return out;
  }

  /** The owner dismissed the lines that covered these obligations (`<deletion id>:<engine>`, as `covers` listed them). Saved in the
   * journal before anyone is told; the copies keep being retried and clear themselves when done. A newer deletion owed by the same
   * engine is another obligation and shows again. Throws when the journal cannot be read or written (the line stays). */
  async dismiss(covers: readonly string[]): Promise<OwnerNotice[]> {
    const wanted = new Set(covers.filter((item) => typeof item === "string"));
    const lines = this.doneLines.length;
    this.doneLines = this.doneLines.filter((line) => !wanted.has(line.id));
    const entries = this.pending();
    const now = Date.now();
    let changed = false;
    for (const entry of entries) {
      const owed = normalizeOwed(entry.owed);
      if (!owed) continue;
      let touched = false;
      for (const item of owed.items) if (wanted.has(`${entry.id}:${item.engine}`) && item.dismissedAt === undefined) { item.dismissedAt = now; touched = true; }
      if (touched) { entry.owed = { since: owed.since, items: owed.items }; changed = true; }
    }
    if (changed) this.save(entries);
    if (changed || lines !== this.doneLines.length) this.publish();
    return this.notices();
  }

  /** Tells the window what is owed now, under a new revision, and arms the timer that shows a line once its grace period ends. Called
   * only after what changed was saved. */
  private lastPublishAt = 0;
  private publish(): void {
    this.lastPublishAt = Date.now();
    this.rev = Math.max(this.rev + 1, Date.now());
    try { this.options.onOwed?.(this.notices(), this.rev); } catch { /* telling the owner never blocks the deletion */ }
    this.armGrace();
  }

  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** A line that is still inside its grace period is shown when that ends: the window is told then, even if nothing else happens. */
  private armGrace(): void {
    if (this.disposed) return;
    let entries: PendingConversationDeletion[];
    try { entries = this.pending(); } catch { return; }
    const grace = this.options.owedGraceMs ?? OWED_GRACE_MS;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const entry of entries) for (const item of normalizeOwed(entry.owed)?.items ?? []) {
      if (item.named && item.dismissedAt === undefined && now - item.since < graceOf(item, grace)) next = Math.min(next, item.since + graceOf(item, grace));
    }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = undefined; }
    if (!Number.isFinite(next)) return;
    this.graceTimer = setTimeout(() => { this.graceTimer = undefined; this.publish(); }, Math.max(0, next - now) + 20);
    this.graceTimer.unref?.();
  }

  /** A synced-folder line is shown for five minutes. When one runs out the notice list has changed: the revision
   * advances and the app is told (a window that is still open would otherwise keep the old line on screen), and an answer older
   * than the expiry can no longer put it back. */
  private expireDoneLines(): void {
    const kept = this.doneLines.filter((line) => Date.now() - line.at < DONE_LINE_MS);
    if (kept.length === this.doneLines.length) return;
    this.doneLines = kept;
    this.rev = Math.max(this.rev + 1, Date.now());
    try { this.options.onOwed?.(this.notices(), this.rev); } catch { /* telling the owner never blocks the deletion */ }
  }

  /** The line for an engine whose files live in a synced folder, shown with the other deletion results. Once per conversation and engine. */
  private tellSynced(entry: PendingConversationDeletion, engines: EngineHistoryResult): void {
    const failing = new Set(engines.failedHomes ?? []);
    let added = false;
    for (const key of engines.syncedHomes ?? []) {
      if (failing.has(key)) continue;
      const engine = key.split("\0")[0] as DeletionEngine;
      const id = `${entry.id}:${engine}:synced`;
      if (this.doneLines.some((line) => line.id === id)) continue;
      const botIds = deletionBotIds(entry);
      this.doneLines.push({ id, text: syncedHomeText(this.labelFor(engine)), at: Date.now(), ...(botIds.length ? { botIds } : {}) });
      const timer = setTimeout(() => { this.expiryTimers.delete(timer); this.expireDoneLines(); }, DONE_LINE_MS + 50);
      timer.unref?.();
      this.expiryTimers.add(timer);
      added = true;
    }
    if (!added) return;
    this.rev = Math.max(this.rev + 1, Date.now());
    try { this.options.onOwed?.(this.notices(), this.rev); } catch { /* telling the owner never blocks the deletion */ }
  }

  /** Saves what is owed with the pending record, then tells the owner. What the owner did with a line (`dismissedAt`) and when an engine
   * first became owed (`since`) are merged from the record as it is saved NOW, never from the copy this attempt started with: a dismiss
   * made while the attempt ran stays. When the record cannot be read or written nothing is published (the window keeps what it showed).
   * True when what is owed is in the journal now (saved, unchanged, or the record is no longer pending); false when it could not be. */
  private setOwed(entry: PendingConversationDeletion, items: Array<Omit<OwedItem, "since">>): boolean {
    let entries: PendingConversationDeletion[];
    try { entries = this.pending(); } catch (error) { console.warn("conversation deletion: could not read what is owed", error); return false; }
    const at = entries.findIndex((item) => item.id === entry.id);
    const saved = at >= 0 ? normalizeOwed(entries[at]!.owed) : normalizeOwed(entry.owed);
    const now = Date.now();
    const merged: OwedItem[] = items.map((item) => {
      const same = saved?.items.find((old) => old.engine === item.engine && old.home === item.home) ?? saved?.items.find((old) => old.engine === item.engine);
      const dismissedAt = saved?.items.find((old) => old.engine === item.engine && old.dismissedAt !== undefined)?.dismissedAt;
      return { ...item, since: same?.since ?? now, ...(dismissedAt !== undefined ? { dismissedAt } : {}) };
    });
    const owed: OwedStatus | undefined = merged.length ? { since: Math.min(...merged.map((item) => item.since)), items: merged } : undefined;
    const current = at >= 0 ? entries[at]!.owed : entry.owed;
    if (JSON.stringify(current ?? null) === JSON.stringify(owed ?? null)) {
      if (owed) entry.owed = owed; else delete entry.owed;
      // Nothing changed. The line was broadcast when it appeared; repeating it on every fast retry is noise. But a window that dropped
      // that broadcast (a dismiss answered while this deletion became owed) must still get it without a reconnect: an undismissed line
      // is told again once the window was last told at least owedRetellMs ago.
      const retell = this.options.owedRetellMs ?? OWED_RETELL_MS;
      if (owed?.items.some((item) => item.dismissedAt === undefined) && Date.now() - this.lastPublishAt >= retell) this.publish();
      return true;
    }
    if (at >= 0) {
      if (owed) entries[at] = { ...entries[at]!, owed }; else delete entries[at]!.owed;
      try { this.save(entries); } catch (error) { console.warn("conversation deletion: could not save what is owed", error); return false; }
    }
    if (owed) entry.owed = owed; else delete entry.owed;
    this.publish();
    return true;
  }

  /** Every engine still owed, by engine (the code the owner can most act on), across all pending deletions. */
  private owedEngines(): Map<DeletionEngine, { code: OwedCode; app?: string }> {
    const out = new Map<DeletionEngine, { code: OwedCode; app?: string }>();
    for (const entry of this.pending()) for (const item of normalizeOwed(entry.owed)?.items ?? []) {
      const seen = out.get(item.engine);
      if (!seen || rankOf(item.code) < rankOf(seen.code)) out.set(item.engine, { code: item.code, ...(item.app ? { app: item.app } : {}) });
    }
    return out;
  }

  /** "Try again now": every unfinished deletion is replayed at once (after any attempt already running on it), whatever the schedule
   * says, and the answer says what changed: the engines now finished, those still owed, or nothing. Throws when the journal cannot be read. */
  async retryNow(): Promise<RetryResult> {
    const before = this.owedEngines();
    let started = 0;
    for (const entry of this.pending()) {
      const state = this.retries.get(entry.id);
      if (state?.timer) clearTimeout(state.timer);
      this.retries.delete(entry.id);
      started++;
      try { await this.finish(entry, { allHomes: true }); } catch (error) { console.warn("conversation deletion: a retry could not finish", error); }
    }
    // The owner asked: tell the window what is owed now, once, so a window that missed or dropped an earlier broadcast (a dismiss
    // answered while a deletion became owed) shows it without a reconnect. A line the owner dismissed is not told again.
    if (started && this.hasUndismissedOwed()) this.publish();
    const after = this.owedEngines();
    const finished = [...before.keys()].filter((engine) => !after.has(engine));
    const still = [...after].map(([engine, value]) => ({ engine, ...value }));
    const unchanged = !finished.length && before.size === after.size && [...after].every(([engine, value]) => before.get(engine)?.code === value.code);
    return { started, finished, still, unchanged, line: this.retryLine(started, finished, still, unchanged) };
  }

  /** True when a pending deletion still owes a line the owner has not dismissed. False when the journal cannot be read. */
  private hasUndismissedOwed(): boolean {
    try { return this.pending().some((entry) => normalizeOwed(entry.owed)?.items.some((item) => item.dismissedAt === undefined) ?? false); } catch { return false; }
  }

  /** One short line for the answer to "Try again now". */
  private retryLine(started: number, finished: DeletionEngine[], still: RetryResult["still"], unchanged: boolean): string {
    const names = (engines: DeletionEngine[]) => { const labels = engines.map((engine) => this.labelFor(engine)); return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0] ?? ""; };
    if (!started) return "Nothing is waiting to be removed.";
    const parts: string[] = [];
    if (finished.length) parts.push(`Removed from ${names(finished)}.`);
    const update = still.filter((item) => item.code === "helper-unloadable").map((item) => item.engine);
    const others = still.filter((item) => item.code !== "helper-unloadable").map((item) => item.engine);
    if (!finished.length && unchanged) {
      // an engine whose helper cannot load is never promised a try before Murage's next update
      if (!update.length) parts.push("Nothing changed yet. Murage keeps trying by itself.");
      else if (!others.length) parts.push("Nothing changed. Murage tries again after its next update.");
      else parts.push(`Nothing changed yet. Murage keeps trying ${names(others)} by itself, and tries ${names(update)} again after its next update.`);
    } else {
      const open = still.filter((item) => item.code === "engine-open").map((item) => item.engine);
      const waiting = still.filter((item) => item.code !== "engine-open" && item.code !== "helper-unloadable").map((item) => item.engine);
      if (open.length) parts.push(`${names(open)} ${open.length > 1 ? "are" : "is"} still open.`);
      if (waiting.length) parts.push(`Still finishing ${names(waiting)}.`);
      if (update.length) parts.push(`Murage tries ${names(update)} again after its next update.`);
    }
    return parts.join(" ");
  }

  /** The pauses between replays. Codex's app-server daemon keeps a rollout open for about a minute after the terminal closes
   * (real-engine qualification), so a deletion made right after closing Codex is tried again every 30 s for 3 minutes before the
   * normal schedule. */
  private delaysFor(entry: PendingConversationDeletion): number[] {
    if (this.options.retryDelaysMs) return this.options.retryDelaysMs;
    const normal = [30_000, 120_000, 600_000, 1_800_000];
    const codexBusy = (normalizeOwed(entry.owed)?.items ?? []).some((item) => item.engine === "codex" && item.code === "engine-open");
    return codexBusy ? [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, ...normal.slice(1)] : normal;
  }

  /** True once every pause of the retry schedule has been used. */
  private retriesExhausted(entry: PendingConversationDeletion): boolean {
    const delays = this.delaysFor(entry);
    const state = this.retries.get(entry.id);
    return delays.length > 0 && !!state && !state.timer && state.attempts >= delays.length;
  }

  /** Replays: after the pauses of the list, one more every `slowRetryMs` (6 hours), and the next start's reconcile. */
  private readonly retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout; /** the last attempt was held back by Murage's own turn */ ownTurn?: boolean;
    /** the holders of the owed homes after the last attempt (probeHomes), and the looks since that found them unchanged */ holders?: string; looks?: number;
    /** attempts in a row lost to Murage's own running turn (engine-running): the next hold waits longer */ ownTurnLosses?: number }>();
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
    // Murage's own turn on the engine ends on its own: it is never left to the hours-long cadence either.
    const engineOpen = state.ownTurn === true || (normalizeOwed(entry.owed)?.items ?? []).some((item) => WAITS_FOR_OWNER.has(item.code));
    // No gap above 10 minutes while an engine, a file or a new file is what is being waited for.
    const delay = engineOpen
      ? Math.min(state.attempts < delays.length ? delays[state.attempts]! : this.options.openRetryMs ?? 600_000, 600_000)
      : state.attempts < delays.length ? delays[state.attempts]! : this.options.slowRetryMs ?? 6 * 3_600_000;
    state.attempts++;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      let current: PendingConversationDeletion | undefined;
      // a journal that cannot be read now is not "finished": the record stays and is looked at again on the schedule
      try { current = this.pending().find((item) => item.id === entry.id); } catch (error) { console.warn("conversation deletion: the pending deletions could not be read; trying again later", error); this.scheduleRetry(entry); return; }
      if (!current || this.disposed) { this.retries.delete(entry.id); return; }
      // The owed homes are still held by the same programs as after the last attempt: nothing an attempt could do has changed, so none is
      // made (no worker, no pause of the background runs, no plan line in the log). The look is repeated every openRetryMs.
      if (this.heldBySameHolders(current, state)) {
        state.looks = (state.looks ?? 0) + 1;
        if (state.looks === 1) console.warn("conversation deletion: the engine history is still open by the same program; looked at again every 10 minutes, planned again once it changes");
        this.retryAfter(entry, state, Math.min(this.options.openRetryMs ?? 600_000, 600_000));
        return;
      }
      void this.finish(current).catch((error) => console.warn("conversation deletion: a retry could not finish", error));
    }, delay);
    state.timer.unref();
  }

  /** A look at the owed homes with no plan: `probeHomes` over the homes still owed (every home when nothing is owed yet). Undefined when
   * there is no probe, or any owed home is not open (closed or unknown): then the attempt runs as before. */
  private holdersOf(entry: PendingConversationDeletion): string | undefined {
    if (!this.options.probeHomes || !entry.engineHomes.length) return undefined;
    const owed = new Set((normalizeOwed(entry.owed)?.items ?? []).map((item) => item.home));
    const homes = owed.size ? entry.engineHomes.filter((home) => owed.has(homeKey(home.engine, home.home))) : entry.engineHomes;
    if (!homes.length) return undefined;
    let probe: Array<{ key: string; open: boolean; holders: string }>;
    try { probe = this.options.probeHomes(homes); } catch { return undefined; }
    if (!probe.length || probe.some((item) => !item.open)) return undefined;
    return probe.map((item) => `${item.key}=${item.holders}`).sort().join("|");
  }
  /** Whether every owed home is still held by the holders seen after the last attempt (a probe, no plan), and the attempt is skipped
   * for it: after OPEN_LOOKS_MAX unchanged looks the attempt runs anyway (the worker's own judgement of the home). */
  private heldBySameHolders(entry: PendingConversationDeletion, state: { holders?: string; looks?: number }): boolean {
    if (state.holders === undefined) return false;
    const now = this.holdersOf(entry);
    if (now === undefined || now !== state.holders) { state.holders = now; state.looks = 0; return false; }
    if ((state.looks ?? 0) >= (this.options.openLooksMax ?? OPEN_LOOKS_MAX)) { state.looks = 0; return false; }
    return true;
  }
  /** The next look at `pause`, outside the schedule's own delays: a probe, and the attempt only once the holders changed or went. */
  private retryAfter(entry: PendingConversationDeletion, state: { timer?: NodeJS.Timeout }, pause: number): void {
    if (this.disposed) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      let current: PendingConversationDeletion | undefined;
      try { current = this.pending().find((item) => item.id === entry.id); } catch { this.retryAfter(entry, state, pause); return; }
      if (!current || this.disposed) { this.retries.delete(entry.id); return; }
      const held = this.retries.get(entry.id);
      if (held && this.heldBySameHolders(current, held)) { held.looks = (held.looks ?? 0) + 1; this.retryAfter(entry, held, pause); return; }
      void this.finish(current).catch((error) => console.warn("conversation deletion: a retry could not finish", error));
    }, pause);
    state.timer.unref();
  }

  /** Stops the retry timers (shutdown). The pending records stay. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.retries.values()) if (state.timer) clearTimeout(state.timer);
    this.retries.clear();
    for (const timer of this.expiryTimers) clearTimeout(timer);
    this.expiryTimers.clear();
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = undefined; }
    for (const cancel of this.ownTurnWaits.values()) cancel();
    this.ownTurnWaits.clear();
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
    const syncedHomes = new Set<string>();
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
    let unpause: (() => void) | undefined;
    const giveUp = (key: string, reason: string, path: string) => {
      stuck.add(key); failedHomes.add(key); failed.add(path);
      homeReasons[key] ??= reason;
      // diagnostic for CI on Windows: which home was left, and why, in the log of the run
      console.warn(`conversation deletion: home left pending (${key.split("\0")[0]}): ${reason}; recorded ${homeReasons[key]}`);
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
      // A home a program Murage did not start has open (the owner's own Claude Code or Grok in a terminal) is left as it is before
      // anything is paused or held: the full gate below would only find it open again, after closing Murage's own idle sessions on it
      // and pausing its background runs for nothing, every ten minutes for as long as that program runs. A probe that fails or sees
      // nothing changes nothing: the attempt goes on exactly as before.
      const foreign = await this.foreignHomes(base, keys);
      const logged: string[] = []; // homes on their hourly whole try whose holder line is already written: the plan adds no second one
      for (const [key, seen] of Object.entries(foreign)) {
        // Every FULL_TRY_EVERY-th skip of a home runs the whole attempt anyway: a process of Murage's own that is not under this
        // process in the list (a parent that exited before it) reads as another program here, and only the hold can close it.
        const skips = (this.foreignSkips.get(key) ?? 0) + 1;
        // a full map never renews a skip allowance: a home with no counter left is given its whole attempt now
        if (skips >= FULL_TRY_EVERY || (!this.foreignSkips.has(key) && this.foreignSkips.size >= 256)) { this.foreignSkips.delete(key); if (this.foreignLogged.has(key)) logged.push(key); continue; }
        this.foreignSkips.set(key, skips);
        stuck.add(key); failedHomes.add(key); failed.add(homeOf(key).home);
        homeReasons[key] ??= "engine-open";
        if (seen.app) homeApps[key] = seen.app;
      }
      // DELETION-WHILE-OPEN-107: a home the owner's own CLI keeps open (Claude Code, Fuigo, Grok in a terminal, all day) still has the
      // conversation's OWN files removed now: its project or session folder and its session side files, each under the per-file hold,
      // with no database opened (engine-history-run.ts openHomePass). Its shared files and databases stay owed for the closed pass.
      const openPass = [...stuck].filter((key) => foreign[key] !== undefined && OPEN_PASS_ENGINES.has(homeOf(key).engine));
      if (openPass.length) {
        try {
          // the plan first, and the ids it found saved, before anything they name is removed: a transcript removed now is where the
          // closed pass would otherwise learn the session id of a side file that stays owed
          const planned = await runEngineHistoryOffThread({ ...base, kind: "openPass", known: entry.engineDiscovery ?? {}, only: openPass });
          const ready = Object.keys(planned.plans ?? {});
          if (ready.length) {
            const merged = { ...(entry.engineDiscovery ?? {}), ...(planned.discovery ?? {}) };
            if (Object.keys(merged).length) entry.engineDiscovery = merged;
            this.saveEngineState(entry);
            const ran = await runEngineHistoryOffThread({ ...base, kind: "openPass", known: entry.engineDiscovery ?? {}, only: ready, plans: planned.plans });
            removed.push(...ran.removed);
          }
        } catch (error) { console.warn("conversation deletion: the open-engine pass did not run; the closed pass still does it all", error); }
      }
      const open = keys.filter((key) => !stuck.has(key));
      if (this.options.pauseBackgroundRuns && open.length) {
        try { unpause = await this.options.pauseBackgroundRuns([...new Set(open.map((key) => homeOf(key).engine))]); } catch (error) { console.warn("conversation deletion: the background runs were not paused", error); }
      }
      // A fresh plan of everything: a plan saved by an earlier attempt, and any mark in it, is not evidence of anything now.
      entry.enginePlan = { v: 3, homes: {} };
      const plans = entry.enginePlan.homes;
      const settleQuiet = async (quiet: string[]) => {
        // A home that keeps changing is left alone until its planned inputs have stopped changing (at most twice).
        const fingerprint = (key: string) => JSON.stringify((plans[key]?.steps ?? []).map(({ done: _done, ...step }) => step));
        for (let waits = 0; waits < 2; waits++) {
          const before = new Map(quiet.map((key) => [key, fingerprint(key)]));
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.options.staleQuietMs ?? 10_000); timer.unref(); });
          const replanned = await runEngineHistoryOffThread({ ...base, kind: "plan", known: entry.engineDiscovery ?? {}, only: quiet, ...(logged.length ? { quiet: logged } : {}) });
          for (const [key, plan] of Object.entries(replanned.plans ?? {})) plans[key] = plan;
          if (replanned.discovery) entry.engineDiscovery = { ...(entry.engineDiscovery ?? {}), ...replanned.discovery };
          this.saveEngineState(entry);
          if (quiet.every((key) => fingerprint(key) === before.get(key))) return;
        }
      };
      /** Holds Murage's own sessions on these homes while their steps run, and keeps them held for the verifying plan. */
      const holdFor = async (candidates: string[]): Promise<void> => {
        const wanted = candidates.filter((key) => !held.has(key));
        if (!wanted.length || !this.options.holdHomes) return;
        try {
          const taken = await this.options.holdHomes(wanted.map(homeOf), holdWaitMs(this.retries.get(entry.id)?.ownTurnLosses ?? 0));
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
      };
      for (let round = 0; round <= MAX_ENGINE_ROUNDS; round++) {
        // plan: every home that is not stuck, every round, so the last plan covers all of them.
        // Murage's own sessions on these homes are held BEFORE the plan is made: a warm idle process of the engine reads as the engine
        // being open, so a plan made first would leave the home unread (on Windows it did, for good). The hold closes the idle ones
        // and waits until they have really exited; a live owner turn is never stopped, and its home stays pending (`skipped`).
        await holdFor(keys.filter((key) => !stuck.has(key)));
        const only = keys.filter((key) => !stuck.has(key));
        if (only.length) {
          const planned = await runEngineHistoryOffThread({ ...base, kind: "plan", known: entry.engineDiscovery ?? {}, only, ...(logged.length ? { quiet: logged } : {}) });
          Object.assign(reasons, planned.reasons);
          Object.assign(homeReasons, planned.homeReasons);
          Object.assign(homeApps, planned.homeApps);
          for (const path of planned.failed) failed.add(path);
          closedOfLastPlan = planned.closedHomes ?? [];
          uncheckedOfLastPlan = new Set(planned.uncheckedHomes ?? []);
          for (const key of planned.syncedHomes ?? []) syncedHomes.add(key);
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
      return { removed, failed: [...failed], leftovers, reasons, homeReasons, homeApps, failedHomes: [...failedHomes], syncedHomes: [...syncedHomes] };
    } catch (error) {
      console.warn("conversation deletion: the engine history was not removed yet", error);
      return homesFailed();
    } finally {
      for (const release of new Set(held.values())) { try { release(); } catch { /* released */ } }
      try { unpause?.(); } catch { /* released */ }
    }
  }

  /** The last foreign-holder line written per engine home (`engine\0home`): what held it and when, so a home held open for hours logs
   * once, not on every try. */
  private readonly foreignLogged = new Map<string, { signature: string; at: number }>();
  /** How many attempts in a row skipped each home for another program (see FULL_TRY_EVERY). */
  private readonly foreignSkips = new Map<string, number>();

  /** The homes of this attempt that a program Murage did not start has open (engine-history-run.ts probeEngineHomes, off the thread).
   * Logs one `home not read` line per home when another program starts holding it, then at most once an hour while it is still held,
   * and only when what holds it changed (by program and rule, not by pid). The owner's own Claude Code starts a shell or a search
   * for every tool call, so its holder list changes all day; a line per change was a line every few seconds (Sean's 1.0.6 log). */
  private async foreignHomes(base: Omit<EngineHistoryJob, "kind" | "known" | "only" | "plans">, keys: string[]): Promise<NonNullable<EngineHistoryResult["foreignHomes"]>> {
    let probed: EngineHistoryResult;
    try { probed = await runEngineHistoryOffThread({ ...base, kind: "probe", only: keys }); } catch { return {}; }
    const found = probed.foreignHomes ?? {};
    for (const key of keys) {
      const seen = found[key];
      if (!seen) { this.foreignLogged.delete(key); this.foreignSkips.delete(key); continue; }
      const holders = seen.holders ?? [];
      const signature = JSON.stringify([seen.app ?? null, seen.kinds ?? [...new Set(holders.map((item) => `${item.name ?? ""}|${item.by}`))].sort()]);
      const last = this.foreignLogged.get(key);
      const now = Date.now();
      if (last && (last.signature === signature || now - last.at < (this.options.foreignRelogMs ?? FOREIGN_RELOG_MS))) continue;
      if (!last && this.foreignLogged.size >= 256) this.foreignLogged.delete(this.foreignLogged.keys().next().value!);
      this.foreignLogged.set(key, { signature, at: now });
      console.warn(`engine history: ${key.split("\0")[0]} home not read: open by process holders ${JSON.stringify(holders)} (another program; tried again in the background, logged again at most hourly while it changes)`);
    }
    return found;
  }

  /** Codex and Grok run a bot's turns in a scope of Murage's own (`<data folder>/native/<engine>-scope/<id>`), which no instance's
   * environment names. Every PRIVATE scope whose marker names one of the record's bots (its desks and deleted bots) joins
   * `entry.engineHomes`, found from the markers on disk, so a record written by 1.0.3 (which never listed scopes), a removed instance or
   * a changed CODEX_HOME / GROK_HOME still finds them; a scope that is gone later is planned, finds nothing and is done. A scope that is
   * no longer PRIVATE (it has login generations, or its marker no longer holds) is never planned: it leaves the homes, nothing in it is
   * touched, and the owner is told what stays there. The record is saved before anything is planned. */
  private mergeScopes(entry: PendingConversationDeletion, leftovers: DeletionLeftover[]): void {
    const native = this.dir.native;
    const bots = new Set([...entry.desks.map((desk) => desk.botId), ...(entry.botIds ?? [])].filter((id) => ID.test(id)));
    const found = scopeCandidates(native, bots);
    const tell = (engine: string) => { const label = labelOfEngine(engine); leftovers.push({ what: `${label}'s own copy of this conversation`, where: `Murage's private ${label} folder for this bot` }); };
    const homes: DeletionEngineHome[] = [];
    for (const home of entry.engineHomes) {
      if (inScopeFolder(home.engine, home.home, native) && !privateScopeHome(home.engine, home.home, native)) { tell(home.engine); continue; }
      homes.push(home);
    }
    for (const scope of found) {
      if (scope.kind === "generations") { if (!homes.some((home) => home.engine === scope.engine && home.home === scope.home)) tell(scope.engine); continue; }
      // the programs configured for this engine (a renamed copy still counts as the engine when its arguments name the scope)
      const identities = [...new Set(entry.engineHomes.filter((home) => home.engine === scope.engine).flatMap((home) => home.identities ?? []))];
      if (!homes.some((home) => home.engine === scope.engine && home.home === scope.home)) homes.push({ engine: scope.engine as DeletionEngine, home: scope.home, ...(identities.length ? { identities } : {}) });
    }
    const changed = homes.length !== entry.engineHomes.length || homes.some((home, at) => homeKey(home.engine, home.home) !== homeKey(entry.engineHomes[at]!.engine, entry.engineHomes[at]!.home));
    if (!changed) return;
    entry.engineHomes = homes;
    const entries = this.pending();
    const at = entries.findIndex((item) => item.id === entry.id);
    if (at >= 0) { entries[at] = { ...entries[at]!, engineHomes: homes }; this.save(entries); }
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
  private engineSessionsOf(input: DeletionInput, fromLogs?: Partial<Record<DeletionEngine, string[]>>): Partial<Record<DeletionEngine, string[]>> {
    if (input.instanceKind && !fromLogs) throw new Error("conversation deletion: read the event-log sessions first (collectLogSessions); a planning step never scans a log");
    const found = new Map<DeletionEngine, Set<string>>();
    const addTo = (engine: DeletionEngine | undefined, id: unknown) => {
      if (!engine || typeof id !== "string" || !/^[\w.-]{1,200}$/.test(id)) return;
      if (!found.has(engine)) found.set(engine, new Set());
      found.get(engine)!.add(id);
    };
    for (const [kind, ids] of Object.entries(input.sessionIds ?? {})) for (const id of ids) addTo(ENGINE_FOR_DRIVER[kind], id);
    for (const [engine, ids] of Object.entries(fromLogs ?? {})) for (const id of ids ?? []) addTo(engine as DeletionEngine, id);
    return Object.fromEntries([...found].map(([engine, ids]) => [engine, [...ids]]));
  }

  /** The engine sessions in the conversations' event logs, read from each
   * thread's compact sessions file in short slices (never a sync scan; a
   * pre-1.0.2 log is scanned once, sliced, then answered from the compact file). */
  async collectLogSessions(threadIds: string[], input: Pick<DeletionInput, "instanceKind">, options?: SessionReadOptions): Promise<Partial<Record<DeletionEngine, string[]>>> {
    const found = new Map<DeletionEngine, Set<string>>();
    if (!input.instanceKind) return {};
    for (const threadId of threadIds.filter((id) => ID.test(id))) {
      for (const line of await threadSessionLines(this.dir.events, threadId, options)) {
        try {
          const event = JSON.parse(line) as { type?: unknown; sessionId?: unknown; providerInstanceId?: unknown };
          if (event.type !== "session.started" || typeof event.providerInstanceId !== "string" || typeof event.sessionId !== "string") continue;
          const kind = input.instanceKind(event.providerInstanceId);
          const engine = kind ? ENGINE_FOR_DRIVER[kind] : undefined;
          if (!engine) continue;
          if (!found.has(engine)) found.set(engine, new Set());
          found.get(engine)!.add(event.sessionId);
        } catch { /* a torn line */ }
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
      // Before any hold: the journals of Murage's private scopes wait for the attempt that holds them (engine-history-run.ts).
      await runEngineHistoryOffThread({ kind: "recover", homes, folders: [], memoryFolders: [], sessions: {}, redoDir: this.redoDir, nativeDir: this.dir.native, skipScopes: true });
    } catch (error) { console.warn("conversation deletion: the crash journals were not checked", error); }
    let entries: PendingConversationDeletion[];
    try { entries = this.pending(); } catch (error) { console.error("conversation deletion: the pending deletions could not be read; they stay as they are", error); return 0; }
    for (const entry of entries) {
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

  /** Whether a message outside `threadIds` names this attachment file. Answered from the attachment-name index (a keyed read, each
   * pointer re-checked against its row), never by a scan of every message. "unknown" when the index has not reached every row yet:
   * the file is then kept, never removed on a guess. A database without the index (an old or partial file) is scanned. */
  private referencedElsewhere(name: string, threadIds: string[]): "yes" | "no" | "unknown" {
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    if (!this.hasTable("attachment_name") || !this.hasTable("transcript_index_state")) {
      return db.prepare(`SELECT 1 FROM messages WHERE thread_id NOT IN (${marks}) AND instr(lower(json), ?) > 0 LIMIT 1`).get(...threadIds, name) ? "yes" : "no";
    }
    const check = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ? AND instr(lower(json), ?) > 0 LIMIT 1");
    for (const pointer of db.prepare(`SELECT thread_id, id FROM attachment_name WHERE name = ? AND thread_id NOT IN (${marks})`).iterate(name, ...threadIds) as Iterable<{ thread_id: string; id: string }>) {
      if (check.get(pointer.thread_id, pointer.id, name)) return "yes";
    }
    const state = db.prepare("SELECT done FROM transcript_index_state WHERE name = 'attachment_name'").get() as { done: number } | undefined;
    return state?.done ? "no" : "unknown";
  }

  /** Attachment files these threads' messages name that no other thread names (`remove`), and those the index could not yet vouch for (`deferred`). */
  private attachmentsOnlyIn(threadIds: string[]): { remove: string[]; deferred: string[] } {
    const none = { remove: [] as string[], deferred: [] as string[] };
    if (!threadIds.length || !this.hasTable("messages")) return none;
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    const names = new Set<string>();
    for (const row of db.prepare(`SELECT json FROM messages WHERE thread_id IN (${marks})`).all(...threadIds) as Array<{ json: string }>) {
      for (const match of row.json.matchAll(ATTACHMENT_IN_TEXT)) names.add(match[0].toLowerCase());
    }
    for (const name of names) {
      if (!ATTACHMENT_NAME.test(name) || !lstatOrNull(nodePath.join(this.dir.attachments, name))?.isFile()) continue;
      const verdict = this.referencedElsewhere(name, threadIds);
      if (verdict === "no") none.remove.push(name);
      else if (verdict === "unknown") none.deferred.push(name);
    }
    return none;
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
  const entry = deletions.begin(input, await deletions.collectLogSessions(input.threadIds, input));
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
