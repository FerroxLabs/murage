// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Muse Code (Meta's coding agent) over its own Muse Session Protocol (MSP): `muse serve` hosts sessions over stdio and
// Murage speaks MSP to it through Meta's SDK (@muse-code/sdk, MIT, Copyright (c) Meta Platforms, Inc. and affiliates;
// see NOTICE and third_party/muse-code-sdk). Portions ported from OpenMausBot (Apache-2.0), upstream
// eea36bdb1cd76f5fda659e68f564f106d177cbc1 server/drivers/muse-code.ts (driver history head ead27095b), changed for
// Murage's levels (handoffs/BRIEF-1016-MUSE-BUILD.md, plan handoffs/GAP-MUSE-CHECK-1101.md):
//   - never `allowAll` and never `--disable-sandbox`: every level runs the session at `promptUnmatched` with Muse's
//     sandbox on, and every ask reaches Murage, which answers it through its own level decision (Full access and No
//     limits keep the stop line). An allow picks Muse's ONCE choice only, never a session grant or a policy rule.
//     Meta's own approval judge is off on every child (MUSE_DISABLE_APPROVAL_JUDGE=1): probe 2 showed it approving a
//     shell ask with no card otherwise.
//   - Ask runs read-only: `serve --disable-shell --disable-write`, every approval that is not a file read is refused
//     with no card, and a shell or write that completes anyway stops the turn (ask-stop.ts). A read-only launch that
//     fails does not run the turn.
//   - Auto runs `serve --disable-write`: Muse never asks before a file write (probe 2), so writes are open only at Full
//     access until a real write gate is proven (MUSE-WRITE-GATE, 1.0.18). Shell asks still reach the owner's card.
//   - no `--trust-workspace`: a folder's own `.muse` hooks must not run outside the sandbox and approvals.
//   - Contributor is a MODEL on Muse, and Muse's served default is one (probe 3): every session/start and session/resume
//     names a regular model (MUSE_DEFAULT_MODEL unless the owner picked another), and a turn Muse will not run on a
//     regular model is refused before the message goes. `--contributor-mode off` and MUSE_CONTRIBUTOR_MODE=0 are on
//     every launch as well, with no self-update (MUSE_NO_AUTO_UPDATE=1), set last.
//   - META_API_KEY only from this instance's own environment, never inherited.
//   - live `model/list` only: no invented model list, and every Contributor model is dropped.
//   - Murage's mounts (mcp-mounts.ts) as required session MCP servers; a host that does not grant `sessionMcp` fails
//     the turn instead of dropping them.
// Muse is launched through Murage's own launcher (procs.ts spawnCli), never the SDK's own spawn. The CLI is never
// shipped, mirrored or installed by Murage: the owner installs it from Meta.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Connection, MspError, type DuplexTransport } from "@muse-code/sdk";
import { z } from "zod";
import { deleteEnvNames, PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import type {
  EffortLevel, ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot, RequestOutcome, RuntimeEvent,
  RuntimeEventListener, SendTurnInput, SteerDelivery,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { awaitCliTreeStopped, describeSpawnFailure, engineJob, killCliTree, spawnCli } from "../procs.ts";
import { redactSecretsInText } from "../redact.ts";
import { answersFromMessage, fromCodex, type QuestionAnswer, type QuestionSpec } from "../question-normalize.ts";
import { ASK_STOP_NOTE, ASK_STOP_PROMPT, ASK_STOP_REASON, askStopUnavailableLine, replyCarriesAskStopNote } from "./ask-stop.ts";
import { buildMcpServers } from "./mcp-mounts.ts";

const DRIVER_KIND = "museCode";
const ENGINE = "Muse Code";
/** Meta's model provider id on `session/start` and `session/setModel`. */
export const MUSE_PROVIDER_ID = "meta";
const CLIENT_INFO = { name: "murage", title: "Murage", version: "1" };
const MUSE_CONTEXT_WINDOW = 1_048_576;
const STARTUP_TIMEOUT_MS = 30_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 15_000;
const INTERRUPT_CONFIRM_MS = 5_000;
const SHUTDOWN_DRAIN_MS = 3_000;
const MAX_TOOL_OUTPUT = 4_000;

/** The one approval mode every Muse session runs at, on every level: Muse asks for whatever its policy does not
 *  already allow, and Murage answers. Never `allowAll`. */
export const MUSE_APPROVAL_MODE = "promptUnmatched";
/** Set on every Muse child, after the instance's own environment, so nothing overrides them. */
export const MUSE_FORCED_ENV: Readonly<Record<string, string>> = {
  MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0", MUSE_DISABLE_APPROVAL_JUDGE: "1",
};
/** On every `muse serve` launch, alongside the env. */
export const MUSE_CONTRIBUTOR_OFF_ARGS: readonly string[] = ["--contributor-mode", "off"];
/** The regular model every Muse session runs on unless the owner picked another regular one. Never a Contributor
 *  model, never the first listed row, never Muse Wonder by default. */
export const MUSE_DEFAULT_MODEL = "muse-spark-1.3";
export const MUSE_NO_REGULAR_MODEL_LINE = "Murage couldn't start Muse on a regular model, so it didn't send your message.";
export const MUSE_KEY_ENV = "META_API_KEY";
export const MUSE_SIGN_IN_NOTE = "Sign in to Muse Code: run `muse login` in a terminal.";
export const MUSE_NOT_INSTALLED_NOTE = "Muse Code isn't installed on this computer.";
export const MUSE_MODELS_LOADING_NOTE = "Muse Code is still listing its models.";
export const MUSE_MOUNTS_REFUSED_LINE = "This Muse Code cannot take Murage's tools (memory, connected apps, teammates, computer), so the turn did not run. Update Muse Code and try again.";

/** Muse has no "none" for its reasoning models, so the control starts at low. */
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const configSchema = z.object({
  cli: z.string().trim().min(1).default("muse"),
  model: z.string().trim().min(1).optional(),
});
type MuseConfig = z.output<typeof configSchema>;

/** Where a turn stands: Ask (read-only), Auto (cards), or Full access / No limits (stop line). */
export type MusePosture = "ask" | "auto" | "full";
export function musePosture(turn: Pick<SendTurnInput, "askLevel" | "stopLine" | "routeAsks">): MusePosture {
  if (turn.askLevel) return "ask";
  if (turn.stopLine) return "full";
  return "auto";
}

/** The launch: read-only at Ask, no file writes at Auto, Contributor off on all; never `--trust-workspace`, never
 *  `--disable-sandbox`. */
export function museServeArgs(posture: MusePosture): string[] {
  const limits = posture === "ask" ? ["--disable-shell", "--disable-write"] : posture === "auto" ? ["--disable-write"] : [];
  return ["serve", ...limits, ...MUSE_CONTRIBUTOR_OFF_ARGS];
}

/** The environment of every Muse child (serve and --version). Every credential list and routing switch is removed,
 *  META_API_KEY included, then the instance's own key goes back alone, then the forced switches last. */
export function museChildEnv(
  base: Record<string, string | undefined>, instance: Record<string, string>, platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...instance, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env, platform);
  deleteEnvNames(env, PROVIDER_CREDENTIAL_ENV, platform);
  stripRoutingEnv(env, platform);
  deleteEnvNames(env, [MUSE_KEY_ENV, ...Object.keys(MUSE_FORCED_ENV)], platform);
  const key = instance[MUSE_KEY_ENV];
  if (key?.trim()) env[MUSE_KEY_ENV] = key;
  Object.assign(env, MUSE_FORCED_ENV);
  return env;
}

/** Signed in: this instance has its own key, or Muse's saved sign-in file EXISTS (never opened, never read).
 *  Windows' `%APPDATA%\muse` is probe 6 (handoffs/GAP-MUSE-PROBES.md). */
export function museSignedIn(
  instance: Record<string, string>, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (instance[MUSE_KEY_ENV]?.trim()) return true;
  const home = env.HOME || env.USERPROFILE || homedir();
  const places = [
    ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, "muse", "auth.json")] : []),
    join(home, ".config", "muse", "auth.json"),
    ...(platform === "win32" && env.APPDATA ? [join(env.APPDATA, "muse", "auth.json")] : []), // probe 6
  ];
  return places.some((path) => exists(path));
}

/** "muse-spark-1.3" → "Muse Spark 1.3". */
export function museModelLabel(id: string, displayLabel?: string): string {
  if (displayLabel && displayLabel !== id) return displayLabel;
  if (!/^muse-/i.test(id)) return id;
  return id.split("-").map((word) => /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** A Contributor model trains on what it is sent: never offered, never picked. */
export function museContributorModel(id: string | undefined, row?: Record<string, unknown>): boolean {
  if (id && /contributor/i.test(id)) return true;
  if (!row) return false;
  if (row.contributor === true || row.isContributor === true) return true;
  return ["displayLabel", "profileId", "designation", "dataUse"].some((field) => typeof row[field] === "string" && /contributor/i.test(row[field] as string));
}

/** The live catalog from `model/list`, Contributor rows dropped. Null when nothing usable was listed: the caller keeps
 *  what it had (empty, or the configured model) and never invents one. */
/** Every model id `model/list` marks as Contributor by its id or any of its labels. A model in this set is never
 *  offered, configured, started, resumed or switched to, even when its id alone looks regular. */
export function museContributorIds(result: unknown): Set<string> {
  const rows = (result as { models?: unknown } | null)?.models;
  const ids = new Set<string>();
  if (!Array.isArray(rows)) return ids;
  for (const raw of rows) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof row.modelId === "string" && museContributorModel(row.modelId, row)) ids.add(row.modelId.trim());
  }
  return ids;
}

export function museCatalog(result: unknown, preferred?: string): ModelCatalog | null {
  const rows = (result as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) return null;
  const options: ModelCatalog["options"] = [];
  const contributors = museContributorIds(result);
  for (const raw of rows) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = row.modelId;
    if (typeof id !== "string" || !id.trim() || options.some((option) => option.id === id)) continue;
    if (contributors.has(id.trim()) || museContributorModel(id, row)) continue;
    options.push({
      id, label: museModelLabel(id, typeof row.displayLabel === "string" ? row.displayLabel : undefined),
      contextWindow: typeof row.contextLimit === "number" && row.contextLimit > 0 ? row.contextLimit : MUSE_CONTEXT_WINDOW,
    });
  }
  if (!options.length) return null;
  const pick = museRegularModel(preferred, contributors);
  if (pick && !options.some((option) => option.id === pick)) options.unshift({ id: pick, label: museModelLabel(pick), custom: true });
  // Never Muse's own default (a Contributor model), never the first row, never Muse Wonder: Muse Spark 1.3 unless the
  // owner configured another regular model (a Muse that does not take it refuses the turn).
  return { default: pick ?? MUSE_DEFAULT_MODEL, options, source: "live" };
}

/** The model itself when it is regular: not Contributor by its id, nor by the live list's labels. */
export function museRegularModel(model: string | undefined, contributors: ReadonlySet<string> = new Set()): string | undefined {
  const id = model?.trim();
  return id && !museContributorModel(id) && !contributors.has(id) ? id : undefined;
}

/** The model a session is started or resumed on: the first regular one of the candidates, else MUSE_DEFAULT_MODEL.
 *  Never empty, never a Contributor model. */
export function museSessionModel(contributors: ReadonlySet<string>, ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const model = museRegularModel(candidate, contributors);
    if (model) return model;
  }
  return MUSE_DEFAULT_MODEL;
}

/** Before the live list answers: empty, or only the configured model. */
export function museInitialCatalog(model: string | undefined): ModelCatalog {
  if (!model || museContributorModel(model)) return { default: "", options: [] };
  return { default: model, options: [{ id: model, label: museModelLabel(model), custom: true }], source: "static" };
}

export interface MuseChoice { choiceId: string; label?: string; decision: string; scope?: string }
export interface MuseSubject {
  kind?: string; access?: string; command?: string; path?: string; host?: string; target?: string; toolName?: string; workspaceRoot?: string;
}
interface MuseApproval {
  approvalId: string;
  sessionId: string;
  turnId?: string;
  toolName?: string;
  rawArgs?: string;
  currentRequirementId: unknown;
  availableChoices: MuseChoice[];
  subject?: MuseSubject;
}

/** An allow is Muse's ONCE choice and nothing broader, whatever the owner's card said. */
export function museAllowOnce(choices: readonly MuseChoice[]): MuseChoice | undefined {
  return choices.find((choice) => choice.decision === "approved" && (choice.scope === undefined || choice.scope === "once"));
}

/** A deny is Muse's own one-off deny, or its Reject (abort) where a shell ask offers no deny. Never a policy rule. */
export function museDeny(choices: readonly MuseChoice[]): MuseChoice | undefined {
  return choices.find((choice) => choice.decision === "denied") ?? choices.find((choice) => choice.decision === "abort");
}

/** At Ask the only ask that reaches a card is a file read. */
export function museAskRead(subject: MuseSubject | undefined): boolean {
  return subject?.kind === "fileAccess" && subject.access === "read";
}

export interface MuseItem {
  itemId: string;
  kind: string;
  status: string;
  turnId?: string | null;
  text?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  commandText?: string;
  exitCode?: number;
  objective?: string;
  role?: string;
  summary?: string[];
  fallbackText?: string;
  result?: { summary?: string; text?: string };
  retracted?: boolean;
  patchRef?: unknown;
  patchSummary?: unknown;
}

const TOOL_KINDS = new Set(["toolCall", "userShell", "webSearch", "subagent", "workflow"]);
const isRunning = (status: string) => /^(?:inProgress|pending|awaiting|queued|running|held)/i.test(status);
const CHANGE_TOOL = /(?:^|[_\-.\s])(?:bash|shell|sh|exec|execute|run|command|terminal|powershell|pwsh|write|edit|multi_?edit|patch|apply_?patch|create|delete|remove|rm|move|mv|rename|mkdir|replace|str_replace)(?:$|[_\-.\s])/i;

/** A completed item that ran a command or changed a file: seen on an Ask turn, the read-only launch did not hold. */
export function museChangeItem(item: MuseItem): boolean {
  if (item.status !== "completed") return false;
  if (item.kind === "userShell") return true;
  if (item.kind !== "toolCall") return false;
  if (item.patchRef !== undefined || item.patchSummary !== undefined || typeof item.commandText === "string") return true;
  return typeof item.tool === "string" && CHANGE_TOOL.test(item.tool);
}

function parseArgs(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined; // streaming model-written arguments may not be JSON yet
  }
}

const oneLine = (text: string, max = 200) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function museToolStart(item: MuseItem): { title: string; summary?: string; input?: unknown } {
  const args = parseArgs(item.args);
  const title = item.kind === "subagent" ? item.objective || item.role || "Muse agent"
    : item.kind === "webSearch" ? "web_search"
      : item.tool || item.kind;
  const command = item.commandText ?? (typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : undefined);
  const summary = command ? redactSecretsInText(oneLine(command)) : undefined;
  return { title, ...(summary ? { summary } : {}), ...(args ? { input: args } : {}) };
}

export function museToolOutput(item: MuseItem): { ok: boolean; result?: string; detail?: string } {
  const ok = item.status === "completed" && (item.exitCode === undefined || item.exitCode === 0);
  const text = item.visibleOutput ?? item.result?.summary ?? item.text ?? item.summary?.join("\n") ?? item.fallbackText ?? "";
  const result = text ? redactSecretsInText(text.slice(0, MAX_TOOL_OUTPUT)) : undefined;
  const detail = item.status !== "completed" ? redactSecretsInText(item.failureReason || `Muse reported ${item.status}.`) : undefined;
  return { ok, ...(result ? { result } : {}), ...(detail ? { detail } : {}) };
}

/** Muse's questions as card questions, keyed by Muse's own ids. */
export function museQuestions(questions: unknown): QuestionSpec[] | null {
  if (!Array.isArray(questions)) return null;
  const normalized = fromCodex({ questions: questions.map((entry) => {
    const q = (entry ?? {}) as { id?: unknown; header?: unknown; question?: unknown; options?: unknown };
    return { id: q.id, header: q.header, question: q.question, options: q.options, isOther: true };
  }) });
  if (!normalized.ok) return null;
  return normalized.questions.map((question, index) => {
    const mode = ((questions[index] ?? {}) as { selection?: { mode?: unknown } }).selection?.mode;
    return { ...question, multiSelect: mode === "multiple" };
  });
}

/** Card answers as Muse's: picked labels, or the owner's own words. */
export function museAnswers(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[]): Array<Record<string, unknown>> {
  return questions.flatMap((question): Array<Record<string, unknown>> => {
    const answer = answers.find((entry) => entry.id === question.id);
    if (!answer) return [];
    const labels = question.options.map((option) => option.label);
    const picked = answer.selected.filter((label) => labels.includes(label));
    const words = answer.other?.trim();
    if (question.multiSelect && picked.length) return [{ questionId: question.id, selectedLabels: picked, ...(words ? { freeText: words } : {}) }];
    if (!question.multiSelect && picked.length === 1 && !words) return [{ questionId: question.id, selectedLabel: picked[0] }];
    const text = words || picked.join(", ");
    return text ? [{ questionId: question.id, freeText: text }] : [];
  });
}

/** Murage's mounts as Muse session MCP servers, each required. Null when the turn mounts nothing. */
export function museMcpServers(turn: SendTurnInput): Record<string, Record<string, unknown>> | null {
  const servers = buildMcpServers(turn);
  if (!servers) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = raw as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof server.command !== "string") continue;
    out[name] = {
      transport: "stdio", command: server.command, mode: "required",
      ...(Array.isArray(server.args) ? { args: server.args } : {}),
      ...(server.env && typeof server.env === "object" ? { env: server.env } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Muse refused the model itself (an unknown or unavailable model id), not the sign-in or the session. */
export function museModelRefusal(error: unknown): boolean {
  if (!(error instanceof MspError)) return false;
  const text = `${error.kind ?? ""} ${error.message}`;
  return /model/i.test(text) && !/\b(?:auth|login|log in|sign in|401)\b/i.test(text);
}

const AUTH_FAILURE = /\b(?:not signed in|sign in|log ?in|unauthori[sz]ed|unauthenticated|not authenticated|authRequired|401)\b/i;

interface Pending {
  kind: "approval" | "question";
  sessionId: string;
  approval?: MuseApproval;
  questions?: QuestionSpec[];
}

interface ActiveTurn {
  turnId: string;
  posture: MusePosture;
  /** Muse's turn id: the turn/start command id; unset until sent. */
  nativeTurnId?: string;
  items: Map<string, MuseItem>;
  streamed: Map<string, string>;
  reply: string;
  finished: boolean;
  /** A change was refused at Ask: the turn ends with ASK_STOP_NOTE unless the reply already says it. */
  askRefused?: boolean;
  /** Set once Stop sent turn/interrupt: a later Stop and dispose wait for the same shutdown. */
  stopping?: Promise<void>;
  onFinished?: () => void;
}

interface Host {
  connection: Connection;
  close(): Promise<unknown>;
  exited: Promise<unknown>;
  grantedMcp: boolean;
  /** A turn needing another posture or other mounts gets a fresh host resuming the same session. */
  key: string;
  closed: boolean;
  /** The turn this host was set up or reused for: only that turn may close it as its own. */
  owner?: string;
}

interface ThreadState {
  threadId: string;
  host?: Host;
  sessionId?: string;
  model?: string;
  /** The folder the current host runs in: a relative file path in an ask is placed against it. */
  cwd?: string;
  active?: ActiveTurn;
  pending: Map<string, Pending>;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** MSP over the stdio of a spawnCli child (never the SDK's own spawn, which starts Muse outside Murage's launcher). */
function stdioTransport(child: ReturnType<typeof spawnCli>, exited: Promise<void>): DuplexTransport {
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  return {
    incoming: child.stdout as AsyncIterable<string>,
    write: (chunk) => new Promise<void>((resolve, reject) => {
      child.stdin.write(chunk, "utf8", (error) => error ? reject(error) : resolve());
    }),
    async close(flushed) {
      const drained = () => new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref?.());
      await Promise.race([flushed?.catch(() => {}), drained()]);
      try { child.stdin.end(); } catch { /* already closed */ }
      await Promise.race([exited, drained()]);
      // The whole owned tree is stopped and confirmed even when the root has already exited: a descendant can hold the
      // pipes open, so the root's close (and the shared cleanup it starts) never comes on its own.
      const stopped = await awaitCliTreeStopped(child).catch(() => false);
      if (!stopped) { try { killCliTree(child); } catch { /* already gone */ } }
      await Promise.race([exited, drained()]);
    },
  };
}

export const MuseCodeDriver: ProviderDriver<MuseConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: ENGINE, supportsMultipleInstances: true, access: "subscription" },
  models: { default: "", options: [] },
  install: {
    command: {
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      win32: "irm https://dev.meta.ai/install.ps1 | iex",
    },
    docsUrl: "https://dev.meta.ai/docs/muse-code",
    signInCommand: "muse login", // probe 6
  },
  decodeConfig: (raw) => configSchema.parse(raw ?? {}),
  defaultConfig: () => configSchema.parse({}),
  async create(input): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    const threads = new Map<string, ThreadState>();
    let catalog: ModelCatalog = museInitialCatalog(config.model);
    let catalogLoaded = false;
    /** Contributor ids from the live list (by id or label): never configured, started, resumed or switched to. */
    let contributorIds = new Set<string>();
    /** Every Muse child still running (serve hosts from spawn on, including one still initializing): dispose ends them. */
    const liveChildren = new Map<ReturnType<typeof spawnCli>, Promise<void>>();
    let disposed = false;
    /** Every host shutdown still under way, including one a Stop during setup started on a turn that is already
     *  finished: stopAll and dispose wait for all of them. */
    const shutting = new Set<Promise<unknown>>();

    const emit = (event: Record<string, unknown> & { type: RuntimeEvent["type"]; threadId: string }) => {
      const full = { eventId: newEventId(), provider: DRIVER_KIND, providerInstanceId: instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
      for (const listener of listeners) listener(full);
    };
    const childEnv = () => museChildEnv(process.env, input.environment);

    const startHost = async (args: string[], cwd: string, key: string, requestMcp: boolean): Promise<Host> => {
      const child = spawnCli(config.cli, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] }, engineJob());
      let spawnError: NodeJS.ErrnoException | undefined;
      child.once("error", (error) => { spawnError = error as NodeJS.ErrnoException; });
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      liveChildren.set(child, exited);
      void exited.then(() => liveChildren.delete(child));
      const connection = new Connection(stdioTransport(child, exited));
      let timer: NodeJS.Timeout | undefined;
      try {
        const initialized = await Promise.race([
          connection.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { requestedCapabilities: requestMcp ? ["sessionMcp"] : [] } }),
          exited.then(() => { throw new Error(`${ENGINE} closed before it started.`); }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${ENGINE} did not start within 30 seconds.`)), STARTUP_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        connection.notify("initialized");
        await connection.flush();
        const granted = initialized.grantedCapabilities;
        let closing: Promise<unknown> | undefined;
        const host: Host = {
          connection, exited, key, closed: false,
          grantedMcp: Array.isArray(granted) && granted.includes("sessionMcp"),
          // One shutdown per host, and every caller (Stop, dispose, a late setup) waits for the same one.
          close: () => {
            host.closed = true;
            if (!closing) {
              const done = closing = connection.close();
              shutting.add(done);
              void done.then(() => shutting.delete(done), () => shutting.delete(done));
            }
            return closing;
          },
        };
        // Approval and question requests are receipts only: the notifications open the cards, answers go as commands.
        connection.onServerRequest(async (request) => {
          if (request.method === "approval/request" || request.method === "userInput/request") return {};
          throw new Error(`Unsupported ${ENGINE} request: ${request.method}`);
        });
        return host;
      } catch (error) {
        await connection.close().catch(() => {});
        throw spawnError ? new Error(describeSpawnFailure(spawnError, config.cli).message) : error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const refreshModels = async () => {
      const cwd = mkdtempSync(join(tmpdir(), "murage-muse-models-"));
      let host: Host | undefined;
      try {
        host = await startHost(["serve", "--disable-shell", "--disable-write", "--no-session-log", ...MUSE_CONTRIBUTOR_OFF_ARGS], cwd, "models", false);
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          host.connection.request("model/list", {}),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${ENGINE} did not list its models.`)), MODEL_LIST_TIMEOUT_MS); timer.unref?.(); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        const listed = museCatalog(result, config.model);
        if (listed) { catalog = listed; catalogLoaded = true; contributorIds = museContributorIds(result); }
      } catch {
        /* the catalog stays as it was; the snapshot says the models are still loading */
      } finally {
        await host?.close().catch(() => {});
        try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    };

    let version: string | null | undefined;
    const probeVersion = () => new Promise<string | null>((resolve) => {
      let out = "";
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, ["--version"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => { try { killCliTree(child); } catch { /* gone */ } resolve(null); }, VERSION_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !out.trim()) return resolve(null);
        resolve(/(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] ?? out.trim());
      });
    });

    const threadOf = (threadId: string) => {
      let state = threads.get(threadId);
      if (!state) threads.set(threadId, state = { threadId, pending: new Map() });
      return state;
    };

    const finishTurn = (state: ThreadState, active: ActiveTurn, completed: { ok: boolean; stopReason?: string; usage?: { input: number; output: number; cachedInput?: number } }) => {
      if (active.finished) return;
      active.finished = true;
      active.onFinished?.();
      if (state.active === active) state.active = undefined;
      for (const requestId of state.pending.keys()) {
        emit({ type: "request.resolved", threadId: state.threadId, turnId: active.turnId, requestId, behavior: "deny", source: "system" });
      }
      state.pending.clear();
      if (active.askRefused && !replyCarriesAskStopNote(active.reply)) {
        const itemId = `ask-stop-${active.turnId}`;
        emit({ type: "item.started", threadId: state.threadId, turnId: active.turnId, itemId, itemType: "tool", origin: "murage", title: ASK_STOP_NOTE, toolKind: "notice" });
        emit({ type: "item.completed", threadId: state.threadId, turnId: active.turnId, itemId, itemType: "tool", ok: true });
      }
      emit({ type: "turn.completed", threadId: state.threadId, turnId: active.turnId, ok: completed.ok,
        ...(completed.stopReason ? { stopReason: completed.stopReason } : {}), ...(completed.usage ? { usage: completed.usage } : {}) });
    };

    const failTurn = (state: ThreadState, active: ActiveTurn, message: string, extra: Record<string, unknown> = {}) => {
      if (active.finished) return;
      const auth = AUTH_FAILURE.test(message);
      emit({ type: "runtime.error", threadId: state.threadId, turnId: active.turnId,
        message: auth ? MUSE_SIGN_IN_NOTE : redactSecretsInText(message), ...(auth ? { authRequired: true, setup: true } : {}), ...extra });
      finishTurn(state, active, { ok: false, stopReason: "error" });
    };

    const closeHost = async (state: ThreadState) => {
      const host = state.host;
      state.host = undefined;
      await host?.close().catch(() => {});
    };

    /** The Ask hard stop: a change ran anyway, so the host ends at once and the turn ends with the note. */
    const haltForAskStop = (state: ThreadState, active: ActiveTurn) => {
      if (active.finished) return;
      active.askRefused = true;
      const host = state.host;
      state.host = undefined;
      finishTurn(state, active, { ok: true, stopReason: ASK_STOP_REASON });
      void host?.close().catch(() => {});
    };

    const decide = (state: ThreadState, approval: MuseApproval, choice: MuseChoice) =>
      state.host!.connection.command("approval/decide", {
        sessionId: approval.sessionId, approvalId: approval.approvalId,
        requirementId: approval.currentRequirementId, choiceId: choice.choiceId,
      } as Record<string, unknown>);

    const onApproval = (state: ThreadState, active: ActiveTurn, approval: MuseApproval) => {
      const subject = approval.subject ?? {};
      if (active.posture === "ask" && !museAskRead(subject)) {
        // Refused before it runs, with no card. With nothing to refuse it by, the turn stops.
        active.askRefused = true;
        const deny = museDeny(approval.availableChoices);
        if (!deny) return haltForAskStop(state, active);
        void decide(state, approval, deny).catch(() => haltForAskStop(state, active));
        return;
      }
      state.pending.set(approval.approvalId, { kind: "approval", sessionId: approval.sessionId, approval });
      const shell = subject.kind === "shell" && typeof subject.command === "string" ? subject.command : undefined;
      const tool = approval.toolName || subject.toolName || subject.kind || "tool";
      const args = parseArgs(approval.rawArgs);
      const filePath = subject.kind === "fileAccess" && subject.path ? resolvePath(subject.workspaceRoot ?? state.cwd ?? process.cwd(), subject.path) : undefined;
      emit({
        type: "request.opened", threadId: state.threadId, turnId: active.turnId, requestId: approval.approvalId, requestType: "permission",
        tool: shell !== undefined ? "shell" : tool,
        summary: redactSecretsInText(oneLine(shell ?? subject.path ?? subject.host ?? subject.target ?? approval.toolName ?? `${ENGINE} asks to continue`, 500)),
        toolCall: shell !== undefined ? { name: "shell", input: { command: shell } } : { name: tool, input: args ?? subject },
        ...(subject.kind ? { toolKind: subject.kind === "shell" ? "execute" : subject.kind === "fileAccess" ? (subject.access === "read" ? "read" : "edit") : subject.kind } : {}),
        ...(filePath ? { filePaths: [filePath] } : {}),
        ...(shell !== undefined && process.platform === "win32" ? { commandShell: "pwsh" } : {}),
      });
    };

    const onNotification = (state: ThreadState, host: Host, method: string, params: Record<string, unknown>) => {
      if (state.host !== host || params.sessionId !== state.sessionId) return;
      const active = state.active;
      const threadId = state.threadId;
      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = params.item as MuseItem | undefined;
          if (!active || !item || item.turnId !== active.nativeTurnId) return;
          const seen = active.items.get(item.itemId);
          active.items.set(item.itemId, item);
          if (item.kind === "agentMessage") {
            if (item.status !== "completed" || item.retracted) return;
            const text = item.text ?? "";
            const streamed = active.streamed.get(item.itemId) ?? "";
            if (text.startsWith(streamed) && text.length > streamed.length) {
              emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: item.itemId, streamKind: "assistant_text", delta: text.slice(streamed.length) });
            }
            if (text) {
              active.reply += `${text}\n`;
              emit({ type: "item.completed", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "assistant_text", origin: "engine", text });
            }
          } else if (item.kind === "reasoning") {
            if (!seen) emit({ type: "item.started", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "reasoning" });
          } else if (TOOL_KINDS.has(item.kind)) {
            if (!seen) emit({ type: "item.started", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "tool", origin: "engine", ...museToolStart(item) });
            if (!isRunning(item.status) && (!seen || isRunning(seen.status))) {
              emit({ type: "item.completed", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "tool", ...museToolOutput(item) });
            }
            if (active.posture === "ask" && museChangeItem(item)) haltForAskStop(state, active);
          }
          return;
        }
        case "item/delta": {
          if (!active || typeof params.itemId !== "string" || typeof params.delta !== "string") return;
          const item = active.items.get(params.itemId);
          if (item?.kind === "agentMessage" && (params.field === undefined || params.field === "text")) {
            active.streamed.set(params.itemId, (active.streamed.get(params.itemId) ?? "") + params.delta);
            emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: params.itemId, streamKind: "assistant_text", delta: params.delta });
          } else if (item?.kind === "reasoning") {
            emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: params.itemId, streamKind: "reasoning_text", delta: params.delta });
          }
          return;
        }
        case "turn/retryScheduled":
          if (active && params.turnId === active.nativeTurnId) {
            emit({ type: "turn.retrying", threadId, turnId: active.turnId, attempt: Number(params.nextAttempt) || 1,
              delayMs: Number(params.retryDelayMs) || 0, reason: String(params.reason ?? "retry") });
          }
          return;
        case "session/tokenUsage": {
          const usage = asRecord(params.usage);
          if (typeof usage.inputTokens !== "number") return;
          emit({ type: "thread.token-usage.updated", threadId, ...(active ? { turnId: active.turnId } : {}),
            input: usage.inputTokens, output: Number(usage.outputTokens) || 0,
            ...(typeof usage.cachedTokens === "number" ? { cachedInput: usage.cachedTokens } : {}) });
          return;
        }
        case "turn/completed": {
          if (!active || params.turnId !== active.nativeTurnId) return;
          const usage = asRecord(params.usage);
          const tokens = typeof usage.inputTokens === "number"
            ? { input: usage.inputTokens, output: Number(usage.outputTokens) || 0, ...(typeof usage.cachedTokens === "number" ? { cachedInput: usage.cachedTokens } : {}) }
            : undefined;
          const terminal = String(params.terminal);
          if (terminal === "completed") finishTurn(state, active, { ok: true, usage: tokens });
          else if (terminal === "cancelled") finishTurn(state, active, { ok: false, stopReason: "interrupted", usage: tokens });
          else failTurn(state, active, String(asRecord(params.error).message ?? params.reason ?? `Muse turn ${terminal}.`));
          return;
        }
        case "approval/requested": {
          const approval = params as unknown as MuseApproval;
          if (!active || !Array.isArray(approval.availableChoices) || typeof approval.approvalId !== "string") return;
          onApproval(state, active, approval);
          return;
        }
        case "approval/resolved": {
          const approvalId = String(params.approvalId ?? "");
          if (state.pending.delete(approvalId)) {
            emit({ type: "request.resolved", threadId, ...(active ? { turnId: active.turnId } : {}), requestId: approvalId,
              behavior: String(params.decision ?? "").startsWith("approved") ? "allow" : "deny", source: "system" });
          }
          return;
        }
        case "userInput/requested": {
          if (!active || typeof params.userInputId !== "string") return;
          const questions = museQuestions(params.questions);
          if (!questions?.length) return;
          state.pending.set(params.userInputId, { kind: "question", sessionId: String(params.sessionId), questions });
          emit({ type: "request.opened", threadId, turnId: active.turnId, requestId: params.userInputId, requestType: "question",
            tool: String(params.toolName ?? "ask_user"), summary: questions[0]!.question, questions });
          return;
        }
      }
    };

    const attach = (state: ThreadState, host: Host) => {
      host.connection.onNotification((notification) => {
        try {
          onNotification(state, host, notification.method, asRecord(notification.params));
        } catch (error) {
          if (state.active) failTurn(state, state.active, error instanceof Error ? error.message : String(error));
        }
      });
      host.connection.onProtocolError((error) => {
        if (state.host === host && state.active) failTurn(state, state.active, `${ENGINE} protocol error: ${error instanceof Error ? error.message : String(error)}`);
      });
      void host.exited.then(() => {
        if (state.host !== host) return;
        state.host = undefined;
        if (!host.closed && state.active) failTurn(state, state.active, `${ENGINE} stopped unexpectedly. Send the message again to continue.`);
      });
    };

    const museTurnModel = (model: string | undefined) => museRegularModel(model, contributorIds);

    /** Muse goes on working until it confirms the interrupt; a turn it does not confirm stops only with its host. */
    const endUnconfirmed = async (state: ThreadState, active: ActiveTurn): Promise<void> => {
      if (active.finished || state.active !== active) return;
      await closeHost(state);
      finishTurn(state, active, { ok: false, stopReason: "interrupted" });
    };

    const ensureSession = async (state: ThreadState, turn: SendTurnInput, active: ActiveTurn): Promise<{ started: boolean; host: Host }> => {
      const cwd = turn.cwd ?? process.cwd();
      state.cwd = cwd;
      const mcpServers = museMcpServers(turn);
      const args = museServeArgs(active.posture);
      const key = JSON.stringify([cwd, args, mcpServers]);
      // Stop (and a newer turn) can land while an old host shuts down: a turn that lost the thread touches nothing.
      const lostThread = () => active.finished || state.active !== active;
      if (turn.sessionReset) {
        await closeHost(state);
        if (lostThread()) throw new Error(`${ENGINE} was stopped while it was starting.`);
        state.sessionId = undefined;
      }
      const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
      if (state.host && !state.host.closed && state.host.key === key && state.sessionId && (!cursor || cursor === state.sessionId)) {
        state.host.owner = active.turnId;
        return { started: false, host: state.host };
      }
      await closeHost(state);
      if (lostThread()) throw new Error(`${ENGINE} was stopped while it was starting.`);
      let host: Host;
      try {
        host = await startHost(args, cwd, key, mcpServers !== null);
      } catch (error) {
        // A turn whose read-only launch fails does not run.
        if (active.posture === "ask") throw new Error(askStopUnavailableLine(ENGINE));
        throw error;
      }
      if (state.active !== active || active.finished) {
        await host.close().catch(() => {});
        throw new Error(`${ENGINE} was stopped while it was starting.`);
      }
      if (mcpServers && !host.grantedMcp) {
        await host.close().catch(() => {});
        throw new Error(MUSE_MOUNTS_REFUSED_LINE);
      }
      host.owner = active.turnId;
      state.host = host;
      attach(state, host);
      // A Stop (or a newer turn) can land during any await below: a late answer then writes nothing to the thread, and
      // only this turn's own host is closed.
      const stale = () => active.finished || state.active !== active || state.host !== host;
      const stopped = () => new Error(`${ENGINE} was stopped while it was starting.`);
      // Contributor is a model on Muse and its served default is one: every start and resume names a regular model.
      const model = museSessionModel(contributorIds, turn.model, catalog.default);
      // A host is reusable only once its session runs at Murage's approval mode: any failure before that closes it, so the
      // next turn launches again and sets the mode again instead of taking the reuse shortcut under an unknown policy.
      try {
        const sessionConfig = mcpServers ? { config: { mcpServers } } : {};
        const resumeId = cursor ?? state.sessionId;
        if (resumeId) {
          let resumed = false;
          try {
            await host.connection.command("session/resume", { sessionId: resumeId, excludeItems: true, modelId: model, ...sessionConfig });
            resumed = true;
          } catch (error) {
            const kind = error instanceof MspError ? error.kind : undefined;
            if (kind !== "sessionNotFound" && kind !== "notFound") throw error;
          }
          if (resumed) {
            if (stale()) throw stopped();
            await host.connection.command("session/setApprovalMode", { sessionId: resumeId, mode: MUSE_APPROVAL_MODE });
            if (stale()) throw stopped();
            // A resumed session keeps the model it had (probe 3), so the regular model is set again, explicitly.
            await host.connection.command("session/setModel", { sessionId: resumeId, model: { modelId: model, providerId: MUSE_PROVIDER_ID } })
              .catch(() => { throw new Error(MUSE_NO_REGULAR_MODEL_LINE); });
            if (stale()) throw stopped();
            state.sessionId = resumeId;
            state.model = model;
            return { started: true, host };
          }
          if (stale()) throw stopped();
        }
        const started = asRecord(await host.connection.command("session/start", {
          workspaceRoot: cwd, providerId: MUSE_PROVIDER_ID, approvalMode: MUSE_APPROVAL_MODE, modelId: model, ...sessionConfig,
        }).catch((error: unknown) => { throw museModelRefusal(error) ? new Error(MUSE_NO_REGULAR_MODEL_LINE) : error; }));
        if (stale()) throw stopped();
        const session = asRecord(started.session);
        if (typeof session.sessionId !== "string") throw new Error(`${ENGINE} started a session without an id.`);
        if (typeof session.modelId === "string" && museContributorModel(session.modelId)) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
        state.sessionId = session.sessionId;
        state.model = typeof session.modelId === "string" ? session.modelId : model;
        return { started: true, host };
      } catch (error) {
        if (state.host === host) await closeHost(state);
        else await host.close().catch(() => {});
        throw error;
      }
    };

    /** A turn that ended (or lost the thread) before Muse had a turn of its own stops here. It closes the host only when
     *  that host is still the thread's and was set up or reused for THIS turn: a newer turn's host, idle or busy, stays.
     *  Synchronous, so no Stop can land between this check and what the caller does next. */
    const stoppedBeforeTurn = (state: ThreadState, active: ActiveTurn, host: Host): boolean => {
      if (!active.finished && state.active === active && state.host === host) return false;
      if (state.host === host && host.owner === active.turnId && !active.nativeTurnId) void closeHost(state);
      return true;
    };

    const runTurn = async (state: ThreadState, turn: SendTurnInput, active: ActiveTurn) => {
      const threadId = turn.threadId;
      try {
        const session = await ensureSession(state, turn, active);
        const host = session.host;
        if (stoppedBeforeTurn(state, active, host)) return;
        const sessionId = state.sessionId!;
        if (session.started) emit({ type: "session.started", threadId, turnId: active.turnId, sessionId, model: state.model ?? turn.model ?? null });
        const model = museTurnModel(turn.model);
        if (model && model !== state.model) {
          // The owner's regular model, or no message at all.
          await host.connection.command("session/setModel", { sessionId, model: { modelId: model, providerId: MUSE_PROVIDER_ID } })
            .catch(() => { throw new Error(MUSE_NO_REGULAR_MODEL_LINE); });
          if (stoppedBeforeTurn(state, active, host)) return;
          state.model = model;
        }
        let text = turn.system && session.started ? `${turn.system}\n\n${turn.text}` : turn.text;
        if (active.posture === "ask") text = `${ASK_STOP_PROMPT}\n\n${text}`;
        const images = (turn.images ?? []).map((image) => ({ type: "image", mediaType: image.mimeType, base64Data: image.data }));
        if (stoppedBeforeTurn(state, active, host)) return;
        emit({ type: "turn.started", threadId, turnId: active.turnId });
        const effort = turn.effort && turn.effort !== "none" ? turn.effort : undefined;
        try { turn.beforeSubmit?.(); } catch (error) {
          failTurn(state, active, error instanceof Error ? error.message : String(error));
          return;
        }
        // A Stop can land in a turn.started listener or in the fence itself: the last check runs here, with no await
        // between it and the prompt, and nothing is sent after it.
        if (stoppedBeforeTurn(state, active, host)) return;
        // Notifications may settle the turn before turn/start's answer arrives.
        active.nativeTurnId = host.connection.mintCommandId();
        await host.connection.command("turn/start", {
          sessionId, input: [{ type: "text", text }, ...images], ...(effort ? { reasoningEffort: effort } : {}),
        }, { commandId: active.nativeTurnId });
      } catch (error) {
        failTurn(state, active, error instanceof Error ? error.message : String(error));
      }
    };

    const adapter: ProviderInstance["adapter"] = {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "in-session",
        agentsMcp: true,
        memoryMcp: true,
        customMcp: true,
        computerMcp: true,
        composioMcp: true,
        phoneMcp: true,
        images: true,
        imagesInline: true,
        effortLevels: EFFORT_LEVELS,
        queueing: true,
      },
      async sendTurn(turn) {
        if (disposed) throw new Error(`${ENGINE} is shutting down.`);
        const state = threadOf(turn.threadId);
        if (state.active && !state.active.finished) throw new Error(`${ENGINE} is still working on this thread.`);
        const turnId = newId();
        const active: ActiveTurn = { turnId, posture: musePosture(turn), items: new Map(), streamed: new Map(), reply: "", finished: false };
        state.active = active;
        void runTurn(state, turn, active);
        return { turnId };
      },
      async interruptTurn(threadId) {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state || !active || active.finished) return;
        if (active.stopping) return active.stopping;
        if (state.host && state.sessionId && active.nativeTurnId) {
          const interrupt = state.host.connection.command("turn/interrupt", { sessionId: state.sessionId, turnId: active.nativeTurnId });
          const ended = new Promise<void>((resolve) => { active.onFinished = resolve; });
          const stopping = active.stopping = Promise.race([
            interrupt.then(() => ended), // turn/completed (cancelled) settles it
            new Promise((resolve) => setTimeout(resolve, INTERRUPT_CONFIRM_MS).unref?.()),
          ]).catch(() => {}).then(() => endUnconfirmed(state, active));
          return Promise.race([interrupt.then(() => {}, () => stopping), stopping]);
        }
        // Stop before Muse has a turn to interrupt (resume, approval mode, start, model switch): the host it is setting up
        // carries the key, so it ends with the turn and its whole tree is confirmed stopped. The session id stays, and the
        // next turn launches again, resumes and sets the approval mode again.
        const host = state.host;
        state.host = undefined;
        finishTurn(state, active, { ok: false, stopReason: "interrupted" });
        if (host) {
          const stopping = active.stopping = host.close().then(() => {}, () => {});
          return stopping;
        }
      },
      async respondToRequest(threadId, requestId, decision): Promise<RequestOutcome> {
        const state = threads.get(threadId);
        const pending = state?.pending.get(requestId);
        if (!state?.host || !pending) return "unavailable";
        // Each ask is answered once: a second answer finds nothing.
        state.pending.delete(requestId);
        const turnId = state.active?.turnId;
        try {
          if (pending.kind === "approval" && pending.approval) {
            const choices = pending.approval.availableChoices;
            if (decision.behavior === "allow") {
              const once = museAllowOnce(choices);
              if (!once) {
                // No one-off allow on offer: nothing broader is ever picked, so the ask is refused.
                const deny = museDeny(choices);
                if (deny) await decide(state, pending.approval, deny);
                emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "deny", source: "system" });
                return "unavailable";
              }
              await decide(state, pending.approval, once);
              emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "allow", source: "user" });
              return "allowed-once";
            }
            const deny = museDeny(choices);
            if (!deny) return "unavailable";
            await decide(state, pending.approval, deny);
            emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "deny", source: "user" });
            return "rejected";
          }
          const questions = pending.questions ?? [];
          const answers = decision.behavior === "answer"
            ? decision.answers ?? (decision.message ? answersFromMessage(questions, decision.message) : null)
            : null;
          if (!answers?.length) {
            await state.host.connection.command("userInput/cancel", { sessionId: pending.sessionId, userInputId: requestId,
              reason: "The person closed this question without answering." });
            emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "deny", source: "user" });
            return "rejected";
          }
          await state.host.connection.command("userInput/answer", { sessionId: pending.sessionId, userInputId: requestId, answers: museAnswers(questions, answers) });
          emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "answer", source: "user" });
          return "answered";
        } catch {
          return "unavailable";
        }
      },
      async steer(threadId, text, beforeWrite): Promise<SteerDelivery> {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state?.host || !state.sessionId || !active?.nativeTurnId || active.finished) return "rejected";
        try { beforeWrite?.(); } catch { return "rejected"; }
        try {
          await state.host.connection.command("turn/steer", { sessionId: state.sessionId, expectedTurnId: active.nativeTurnId,
            input: [{ type: "text", text: active.posture === "ask" ? `${ASK_STOP_PROMPT}\n\n${text}` : text }] });
          return "delivered";
        } catch (error) {
          return error instanceof MspError ? "rejected" : "uncertain";
        }
      },
      async resetSession(threadId) {
        const state = threads.get(threadId);
        if (!state) return;
        if (state.active) await (state.active.stopping ??= endUnconfirmed(state, state.active));
        await closeHost(state);
        state.sessionId = undefined;
      },
      hasSession: (threadId) => Boolean(threads.get(threadId)?.sessionId),
      async stopAll() {
        await Promise.all([...threads.values()].map(async (state) => {
          if (state.active) await (state.active.stopping ??= endUnconfirmed(state, state.active));
          await closeHost(state);
        }));
        // A host a setup Stop detached, the Ask stop's host and the model list's host all finish shutting down too.
        while (shutting.size) await Promise.allSettled([...shutting]);
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    void refreshModels();
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() { return catalog; },
      refreshModels,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        version ??= await probeVersion();
        if (version === null) {
          version = undefined;
          return { state: "unavailable", reason: MUSE_NOT_INSTALLED_NOTE, authenticated: false };
        }
        if (!museSignedIn(input.environment, childEnv())) {
          return { state: "unavailable", reason: MUSE_SIGN_IN_NOTE, authenticated: false, version };
        }
        return {
          state: "available", authenticated: true, version, billing: input.environment[MUSE_KEY_ENV]?.trim() ? "metered" : "subscription",
          ...(!catalogLoaded ? { versionNote: MUSE_MODELS_LOADING_NOTE } : {}),
        };
      },
      async dispose() {
        disposed = true;
        await adapter.stopAll();
        // No Muse child (each carries the key) outlives dispose: one still initializing, or one whose host never formed,
        // is ended here and waited for.
        await Promise.all([...liveChildren].map(async ([child, exited]) => {
          try { killCliTree(child); } catch { /* already gone */ }
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref?.())]);
        }));
        threads.clear();
        listeners.clear();
      },
    };
  },
};
