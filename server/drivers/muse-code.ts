// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Muse Code (Meta's coding agent) over its own Muse Session Protocol (MSP): `muse serve` hosts sessions over stdio and
// Murage speaks MSP to it through Meta's SDK (@muse-code/sdk, MIT, Copyright (c) Meta Platforms, Inc. and affiliates;
// see NOTICE and third_party/muse-code-sdk). Portions ported from OpenMausBot (Apache-2.0), upstream
// eea36bdb1cd76f5fda659e68f564f106d177cbc1 server/drivers/muse-code.ts (driver history head ead27095b), changed for
// Murage's levels (BRIEF-1016-MUSE-BUILD.md, plan GAP-MUSE-CHECK-1101.md):
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
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Connection, MspError, type DuplexTransport } from "@muse-code/sdk";
import { z } from "zod";
import { deleteEnvNames, PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import type {
  EffortLevel, ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot, RequestOutcome, RuntimeEvent,
  RuntimeEventListener, SendTurnInput, SteerDelivery,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { awaitCliTreeStopped, describeSpawnFailure, engineJob, spawnCli } from "../procs.ts";
import { botFolderOrThrow } from "../bot-folder.ts";
import { probeFolder } from "../probe-folder.ts";
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
 *  Windows' `%APPDATA%\muse` is probe 6 (GAP-MUSE-PROBES.md). */
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
  resolving?: boolean;
  host: Host;
  active: ActiveTurn;
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
  pendingNativeCommandId?: string;
  startAdmission?: MuseAdmission;
  earlyTerminal?: Record<string, unknown>;
  fatalPending?: boolean;
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

type Classification = "regular" | "Contributor" | "unclassified";
interface Selection {
  model?: string;
  revision: number;
  classification: Classification;
  source: "requested" | "session response" | "switch acknowledgment" | "notification";
  generation: number;
  sessionId?: string;
  provisional?: boolean;
}
interface Host {
  generation: number;
  catalogGeneration: number;
  observationRevision: number;
  observations: Map<string, Selection>;
  unsafeObserved: Set<string>;
  selection?: Selection;
  sessionId?: string;
  requested?: string;
  switch?: { target: string; revision: number; generation: number; sessionId: string; owner?: string };
  fatal?: boolean;
  retirement?: Promise<void>;
  state?: ThreadState;
  role: "catalog" | "session";
  phase: "initialize" | "initialized" | "ready" | "listing";
  requestMcp: boolean;
  receipts: Set<number>;
  rootExit: Promise<void>;
  localRefusal?: Error;
  commands: number;
  shutdownFailed?: boolean;
  admissions: Map<string, MuseAdmission>;
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
  /** The folder the current host runs in: a relative file path in an ask is placed against it. */
  cwd?: string;
  active?: ActiveTurn;
  pending: Map<string, Pending>;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** A one-use capability for exactly one SDK command, checked only at the physical write.
 * The SDK queues writes; retaining a token never retains admission. The hook and Stop check run afresh at stdin. */
export interface MuseAdmission {
  method: string;
  params: string;
  beforeSubmit?: () => void;
  notWritten?: () => void;
  stopped: () => boolean;
  onWrite?: () => void;
  onSubmit?: (admission: MuseAdmission) => void;
  possible?: boolean;
  confirmed?: boolean;
  received?: boolean;
  settleWrite?: (error?: Error | null) => void;
  written?: boolean;
}
export const MUSE_PROMPT_METHODS = new Set(["turn/start", "turn/steer"]);
const MUSE_OWNED_METHODS = new Set([...MUSE_PROMPT_METHODS, "approval/decide", "userInput/answer", "userInput/cancel", "session/start", "session/resume", "session/setModel", "session/setApprovalMode", "turn/interrupt"]);
const keysOnly = (object: Record<string, unknown>, keys: string[]) => Object.keys(object).every(key => keys.includes(key));
const validId = (id: unknown) => typeof id === "string" && id.length > 0;

const museId = z.string().min(1);
const museInput = z.array(z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image"), mediaType: z.string(), base64Data: z.string() }).strict(),
]));
const museCommandFields = { sessionId: museId, commandId: museId };
const museConfig = z.object({ mcpServers: z.record(z.string(), z.object({
  transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(), mode: z.literal("required"),
}).strict()) }).strict().optional();
const museWriteShapes: Record<string, z.ZodType> = {
  "turn/start": z.object({ ...museCommandFields, input: museInput, reasoningEffort: z.enum(EFFORT_LEVELS).optional() }).strict(),
  "turn/steer": z.object({ ...museCommandFields, input: museInput, expectedTurnId: museId }).strict(),
  "approval/decide": z.object({ ...museCommandFields, approvalId: museId, requirementId: z.unknown(), choiceId: museId }).strict(),
  "userInput/answer": z.object({ ...museCommandFields, userInputId: museId, answers: z.array(z.object({
    questionId: museId, selectedLabel: z.string().optional(), selectedLabels: z.array(z.string()).optional(), freeText: z.string().optional(),
  }).strict()) }).strict(),
  "userInput/cancel": z.object({ ...museCommandFields, userInputId: museId, reason: z.string() }).strict(),
  "session/start": z.object({ commandId: museId, workspaceRoot: z.string(), providerId: z.literal(MUSE_PROVIDER_ID), approvalMode: z.literal(MUSE_APPROVAL_MODE), modelId: museId, config: museConfig }).strict(),
  "session/resume": z.object({ ...museCommandFields, excludeItems: z.literal(true), modelId: museId, config: museConfig }).strict(),
  "session/setModel": z.object({ ...museCommandFields, model: z.object({ modelId: museId, providerId: z.literal(MUSE_PROVIDER_ID) }).strict() }).strict(),
  "session/setApprovalMode": z.object({ ...museCommandFields, mode: z.literal(MUSE_APPROVAL_MODE) }).strict(),
  "turn/interrupt": z.object({ ...museCommandFields, turnId: museId }).strict(),
};

/** Mandatory policy supplied by each host, called again after reentrant owner hooks. */
export type MuseWriteCheck = (frame: Record<string, unknown>, submitting: boolean) => void;
export function checkMuseWrite(frame: Record<string, unknown>, host: Host, ready: boolean, classify: (model: unknown) => Classification, submitting: boolean): void {
  const refuse = () => { throw new Error("MUSE_UNADMITTED_WRITE"); };
  if (host.closed || host.fatal || frame.jsonrpc !== "2.0") return refuse();
  const method = frame.method;
  if (method === undefined) {
    if (!keysOnly(frame, ["jsonrpc", "id", "result"]) || typeof frame.id !== "number" || !host.receipts.has(frame.id) || JSON.stringify(frame.result) !== "{}" || !ready || host.selection?.classification !== "regular" || host.selection.provisional || !host.state?.active || host.state.active.finished || host.state.active.stopping || host.owner !== host.state.active.turnId) return refuse();
    if (submitting) host.receipts.delete(frame.id);
    return;
  }
  if (!keysOnly(frame, ["jsonrpc", "id", "method", "params"])) return refuse();
  if (method === "initialized") {
    if (host.phase !== "initialized" || "id" in frame || "params" in frame) return refuse();
    if (submitting) host.phase = "ready";
    return;
  }
  if (!(typeof frame.id === "string" || (typeof frame.id === "number" && Number.isInteger(frame.id)))) return refuse();
  if (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) return refuse();
  const params = asRecord(frame.params);
  if (method === "initialize") {
    const expected = { clientInfo: CLIENT_INFO, capabilities: { requestedCapabilities: host.requestMcp ? ["sessionMcp"] : [] } };
    if (host.phase !== "initialize" || JSON.stringify(params) !== JSON.stringify(expected)) return refuse();
    if (submitting) host.phase = "initialized";
    return;
  }
  if (method === "model/list") {
    if (host.role !== "catalog" || host.phase !== "ready" || JSON.stringify(params) !== "{}") return refuse();
    if (submitting) host.phase = "listing";
    return;
  }
  if (typeof method !== "string" || !museWriteShapes[method]?.safeParse(params).success) return refuse();
  const active = host.state?.active;
  if (!ready || host.role !== "session" || host.phase !== "ready" || !active || active.finished || host.owner !== active.turnId || host.state?.host !== host) return refuse();
  if (active.stopping && method !== "turn/interrupt") return refuse();
  const selection = host.selection;
  if (method === "session/start" || method === "session/resume") {
    if (classify(params.modelId) !== "regular" || params.modelId !== host.requested) return refuse();
    if (method === "session/resume" && (params.sessionId !== host.sessionId || host.unsafeObserved.has(String(params.sessionId)) || host.observations.get(String(params.sessionId))?.classification !== undefined && host.observations.get(String(params.sessionId))?.classification !== "regular")) return refuse();
    return;
  }
  if (!selection || selection.classification !== "regular" || classify(selection.model) !== "regular" || params.sessionId !== host.sessionId) return refuse();
  if (selection.provisional && !["session/setModel", "session/setApprovalMode"].includes(method)) return refuse();
  if (method === "session/setModel") {
    const target = asRecord(params.model);
    if (!keysOnly(target, ["modelId", "providerId"]) || target.providerId !== MUSE_PROVIDER_ID || classify(target.modelId) !== "regular") return refuse();
    if (submitting) host.switch = { target: String(target.modelId), generation: host.generation, revision: host.observationRevision, sessionId: host.sessionId!, owner: host.owner };
  }
  if (method === "session/setApprovalMode" && params.mode !== MUSE_APPROVAL_MODE) return refuse();
  if (method === "turn/steer" && (!active.nativeTurnId || params.expectedTurnId !== active.nativeTurnId)) return refuse();
  if (method === "turn/interrupt" && (!active.nativeTurnId || params.turnId !== active.nativeTurnId)) return refuse();
}

export async function musePromptCommand(
  connection: Connection, admissions: Map<string, MuseAdmission>, method: string,
  params: Record<string, unknown>, admission: Omit<MuseAdmission, "method" | "params">,
  commandId = connection.mintCommandId(),
): Promise<Record<string, unknown>> {
  let settleWrite!: (error?: Error | null) => void;
  const completion = new Promise<void>((resolve, reject) => { settleWrite = error => error ? reject(error) : resolve(); });
  void completion.catch(() => {});
  const token: MuseAdmission = { ...admission, method, params: JSON.stringify({ ...params, commandId }), settleWrite };
  admissions.set(commandId, token);
  try {
    // Retries need a new admission; never let the SDK replay a prompt under a consumed token.
    const result = await connection.command(method, params, { commandId, maxAttempts: 1 }).catch(error => {
      // An engine error response is receipt evidence too, even before the write callback.
      if (error instanceof MspError) token.received = true;
      throw error;
    });
    token.received = true;
    if (!token.written) throw new Error("MUSE_SDK_UNWRITTEN_COMMAND");
    await completion;
    return result;
  } finally {
    admissions.delete(commandId);
  }
}

/** MSP over the stdio of a spawnCli child (never the SDK's own spawn, which starts Muse outside Murage's launcher). */
export function stdioTransport(child: ReturnType<typeof spawnCli>, exited: Promise<void>, admissions: Map<string, MuseAdmission>, check: MuseWriteCheck, refused?: (error: Error) => void): DuplexTransport {
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const pending = new Set<(error: Error) => void>();
  return {
    incoming: child.stdout as AsyncIterable<string>,
    write: (chunk) => new Promise<void>((resolve, reject) => {
      let frame: Record<string, unknown>;
      try {
        if (!chunk.endsWith("\n")) throw new Error();
        frame = JSON.parse(chunk);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
      } catch { throw new Error("MUSE_UNADMITTED_WRITE"); }
      let p: MuseAdmission | undefined;
      let admitted = false, attempted = false, settled = false, withdrawn = false;
      const withdraw = () => {
        if (withdrawn) return;
        withdrawn = true;
        if (p) { p.possible = false; p.written = false; }
        if (admitted) p?.notWritten?.();
      };
      const terminate = (error: Error) => { p?.settleWrite?.(error); reject(error); };
      pending.add(terminate);
      const done = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        pending.delete(terminate);
        if (error) {
          if (!p?.received && ["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes((error as NodeJS.ErrnoException).code ?? "")) withdraw();
          p?.settleWrite?.(error);
          reject(error);
        } else {
          let callbackError: Error | undefined;
          try {
            if (p) { p.confirmed = true; if (!p.stopped()) p.onWrite?.(); }
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
          } finally {
            // Confirmation hooks can replay early terminals and invoke external listeners.
            p?.settleWrite?.(callbackError);
            if (callbackError) reject(callbackError); else resolve();
          }
        }
      };
      try {
        if (MUSE_OWNED_METHODS.has(String(frame.method))) {
          const params = asRecord(frame.params);
          const id = String(params.commandId ?? "");
          p = admissions.get(id);
          admissions.delete(id);
          if (!p || p.method !== frame.method || p.params !== JSON.stringify(params)) throw new Error("MUSE_UNADMITTED_WRITE");
          if (p.stopped()) throw new Error("MUSE_STOPPED_BEFORE_WRITE");
        }
        check(frame, false);
        if (p) {
          p.beforeSubmit?.();
          admitted = true;
        }
        if (p?.stopped()) throw new Error("MUSE_STOPPED_BEFORE_WRITE");
        check(frame, true);
        if (p?.stopped()) throw new Error("MUSE_STOPPED_BEFORE_WRITE");
        if (p) { p.written = true; p.possible = true; p.onSubmit?.(p); }
        attempted = true;
        child.stdin.write(chunk, "utf8", (error) => {
          // These stream errors prove Node rejected the write before handing any bytes to the OS.
          if (error && ["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            if (!p?.received) withdraw();
          }
          done(error);
          if (error) reject(error); else resolve();
        });
      } catch (error) {
        if (!attempted) { withdraw(); refused?.(error instanceof Error ? error : new Error(String(error))); }
        done(error instanceof Error ? error : new Error(String(error)));
      }
    }),
    async close(flushed) {
      admissions.clear();
      void flushed?.catch(() => {});
      if (!await awaitCliTreeStopped(child).catch(() => false)) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
      await exited;
      for (const terminate of pending) terminate(new Error("Muse transport closed."));
      pending.clear();
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
    let regularIds = new Set<string>();
    /** Every Muse child still running (serve hosts from spawn on, including one still initializing): dispose ends them. */
    const liveChildren = new Map<ReturnType<typeof spawnCli>, Promise<void>>();
    let disposed = false;
    let generation = 0, catalogGeneration = 0;
    let auxiliaryShutdownUnconfirmed = false;
    let refreshing: Promise<void> | undefined;
    const auxiliary = new Set<ReturnType<typeof spawnCli>>();
    const auxiliaryCleanup = new Map<ReturnType<typeof spawnCli>, () => Promise<void>>();
    const guardSpawn = () => {
      if (auxiliaryShutdownUnconfirmed) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
      if (disposed) throw new Error(`${ENGINE} is shutting down.`);
    };
    const classify = (model: unknown): Classification => {
      if (!catalogLoaded || typeof model !== "string" || !model) return "unclassified";
      if (contributorIds.has(model) || museContributorModel(model)) return "Contributor";
      return regularIds.has(model) ? "regular" : "unclassified";
    };
    /** Every host shutdown still under way, including one a Stop during setup started on a turn that is already
     *  finished: stopAll and dispose wait for all of them. */
    const shutting = new Set<Promise<unknown>>();

    const emit = (event: Record<string, unknown> & { type: RuntimeEvent["type"]; threadId: string }) => {
      const full = { eventId: newEventId(), provider: DRIVER_KIND, providerInstanceId: instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
      for (const listener of listeners) listener(full);
    };
    const childEnv = () => museChildEnv(process.env, input.environment);

    const startHost = async (args: string[], cwd: string, key: string, requestMcp: boolean, register?: (host: Host) => void): Promise<Host> => {
      guardSpawn();
      const child = spawnCli(config.cli, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] }, engineJob());
      let spawnError: NodeJS.ErrnoException | undefined;
      child.once("error", (error) => { spawnError = error as NodeJS.ErrnoException; });
      let rootDone!: () => void;
      const rootExit = new Promise<void>(resolve => { rootDone = resolve; });
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.once("error", () => { if (!child.pid) rootDone(); });
      liveChildren.set(child, exited);

      const admissions = new Map<string, MuseAdmission>();
      const connection = new Connection(stdioTransport(child, exited, admissions, (frame, submitting) =>
        checkMuseWrite(frame, host, catalogLoaded && host.catalogGeneration === catalogGeneration, classify, submitting), error => { host.localRefusal = error; }));
      let closing: Promise<unknown> | undefined;
      const host: Host = {
        connection, admissions, exited, rootExit, key, closed: false, commands: 0,
        generation: ++generation, catalogGeneration, observationRevision: 0, observations: new Map(), unsafeObserved: new Set(),
        role: key === "models" ? "catalog" : "session", phase: "initialize", requestMcp, receipts: new Set(),
        grantedMcp: false,
        // One shutdown per host, and every caller (Stop, dispose, a late setup) waits for the same one.
        close: () => {
          host.closed = true;
          admissions.clear();
          if (!closing) {
            const done = closing = connection.close().then(async () => {
              await rootExit; await exited;
              liveChildren.delete(child); auxiliary.delete(child); auxiliaryCleanup.delete(child);
            }, (error) => {
              if (host.role === "catalog") auxiliaryShutdownUnconfirmed = true;
              host.shutdownFailed = true;
              throw error;
            });
            shutting.add(done);
            void done.then(() => shutting.delete(done), () => shutting.delete(done));
          }
          return closing;
        },
      };
      if (host.role === "catalog") {
        auxiliary.add(child);
        auxiliaryCleanup.set(child, async () => { await host.close(); });
      }
      register?.(host);
      child.once("exit", () => {
        if (!host.closed) void retireHost(host, "Muse Code stopped unexpectedly.").catch(() => {});
        rootDone();
      });
      attach(host);
      connection.onServerRequest(async request => {
        if (!["approval/request", "userInput/request"].includes(request.method) || host.fatal || host.closed || host.selection?.classification !== "regular" || host.selection.provisional || asRecord(request.params).sessionId !== host.sessionId) {
          void retireHost(host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {});
          throw new Error("Muse request unavailable.");
        }
        host.receipts.add(Number(request.id));
        return {};
      });
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
        host.grantedMcp = Array.isArray(granted) && granted.includes("sessionMcp");
        return host;
      } catch (error) {
        await retireHost(host, spawnError ? describeSpawnFailure(spawnError, config.cli).message : "Muse Code startup failed.");
        throw spawnError ? new Error(describeSpawnFailure(spawnError, config.cli).message) : error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const refreshModels = (): Promise<void> => {
      if (refreshing) return refreshing;
      catalogLoaded = false;
      regularIds.clear();
      const current = ++catalogGeneration;
      for (const state of threads.values()) if (state.host) {
        if (state.host.selection) state.host.selection.classification = "unclassified";
        void retireHost(state.host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {});
      }
      const work = async () => {
        guardSpawn();
        const cwd = mkdtempSync(join(tmpdir(), "murage-muse-models-"));
        let host: Host | undefined;
        let result: unknown;
        try {
          host = await startHost(["serve", "--disable-shell", "--disable-write", "--no-session-log", ...MUSE_CONTRIBUTOR_OFF_ARGS], cwd, "models", false, launch => { host = launch; });
          let timer: NodeJS.Timeout | undefined;
          result = await Promise.race([
            host.connection.request("model/list", {}),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Muse model list unavailable.")), MODEL_LIST_TIMEOUT_MS); timer.unref?.(); }),
          ]).finally(() => { if (timer) clearTimeout(timer); });
        } catch (error) {
          if (auxiliaryShutdownUnconfirmed) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
        } finally {
          if (host) {
            await host.close();
            if (dirname(cwd) === resolvePath(tmpdir()) && basename(cwd).startsWith("murage-muse-models-")) rmSync(cwd, { recursive: true, force: true });
          }
        }
        if (current !== catalogGeneration || disposed || auxiliaryShutdownUnconfirmed) return;
        const rows = asRecord(result).models;
        if (!Array.isArray(rows) || rows.some(row => {
          const id = asRecord(row).modelId;
          return typeof id !== "string" || !id || id.trim() !== id;
        })) return;
        contributorIds = museContributorIds(result);
        regularIds = new Set(rows.flatMap(row => {
          const id = asRecord(row).modelId;
          return typeof id === "string" && id.trim() === id && id && !contributorIds.has(id) && !museContributorModel(id, asRecord(row)) ? [id] : [];
        }));
        catalog = museCatalog(result, config.model) ?? { default: "", options: [], source: "live" };
        catalogLoaded = true;
      };
      // Publish before work can await or invoke callbacks.
      refreshing = Promise.resolve().then(work).finally(() => { refreshing = undefined; });
      return refreshing;
    };

    let version: string | null | undefined;
    let versionProbe: Promise<string | null> | undefined;
    const probeVersion = (): Promise<string | null> => {
      guardSpawn();
      if (versionProbe) return versionProbe;
      versionProbe = Promise.resolve().then(async () => {
        guardSpawn();
        let child: ReturnType<typeof spawnCli>;
        try { child = spawnCli(config.cli, ["--version"], { cwd: probeFolder(), env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }, engineJob()); }
        catch { return null; }
        let rootDone!: () => void;
        const rootExit = new Promise<void>(resolve => { rootDone = resolve; });
        const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
        liveChildren.set(child, closed); auxiliary.add(child);
        let cleanup: Promise<void> | undefined;
        const clean = () => cleanup ??= (async () => {
          if (!child.pid) {
            await closed; liveChildren.delete(child); auxiliary.delete(child); auxiliaryCleanup.delete(child); return;
          }
          if (!await awaitCliTreeStopped(child).catch(() => false)) {
            auxiliaryShutdownUnconfirmed = true;
            throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
          }
          await rootExit; await closed;
          liveChildren.delete(child); auxiliary.delete(child); auxiliaryCleanup.delete(child);
        })();
        auxiliaryCleanup.set(child, clean);
        let out = "", failed = false;
        child.stdout.setEncoding("utf8"); child.stderr.resume();
        child.stdout.on("data", (chunk: string) => { out = (out + chunk).slice(0, 4096); });
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>(resolve => {
          child.once("exit", () => { rootDone(); resolve(); });
          child.once("error", () => { failed = true; if (!child.pid) rootDone(); resolve(); });
          timer = setTimeout(() => { failed = true; resolve(); }, VERSION_TIMEOUT_MS); timer.unref?.();
        });
        if (timer) clearTimeout(timer);
        await clean();
        return failed || child.exitCode !== 0 || !out.trim() ? null : /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] ?? out.trim();
      });
      const probe = versionProbe;
      void probe.then(result => {
        // Null is retryable only after the probe has confirmed cleanup (or never spawned).
        if (result === null && versionProbe === probe) versionProbe = undefined;
      }, () => {});
      return versionProbe;
    };

    const threadOf = (threadId: string) => {
      let state = threads.get(threadId);
      if (!state) threads.set(threadId, state = { threadId, pending: new Map() });
      return state;
    };

    const finishTurn = (state: ThreadState, active: ActiveTurn, completed: { ok: boolean; stopReason?: string; usage?: { input: number; output: number; cachedInput?: number } }) => {
      if (active.finished || active.fatalPending) return;
      active.finished = true;
      active.onFinished?.();
      if (state.active === active) state.active = undefined;
      const unresolved = [...state.pending.keys()];
      state.pending.clear();
      for (const requestId of unresolved) {
        emit({ type: "request.resolved", threadId: state.threadId, turnId: active.turnId, requestId, behavior: "deny", source: "system" });
      }
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
      await host?.close();
      if (state.host === host) state.host = undefined;
    };

    /** The Ask hard stop: a change ran anyway, so the host ends at once and the turn ends with the note. */
    const haltForAskStop = (state: ThreadState, active: ActiveTurn) => {
      if (active.finished) return;
      active.askRefused = true;
      active.stopping ??= closeHost(state).then(() => finishTurn(state, active, { ok: true, stopReason: ASK_STOP_REASON }));
      void active.stopping.catch(() => {});
    };

    const ownedCommand = async (state: ThreadState, host: Host, active: ActiveTurn, method: string, params: Record<string, unknown>) => {
      host.commands++;
      try {
        return await musePromptCommand(host.connection, host.admissions, method, params, {
          stopped: () => host.closed || state.host !== host || host.owner !== active.turnId || state.active !== active || active.finished || Boolean(active.stopping),
        });
      } finally { host.commands--; }
    };
    const decide = (state: ThreadState, approval: MuseApproval, choice: MuseChoice, host = state.host!, active = state.active!) =>
      ownedCommand(state, host, active, "approval/decide", {
        sessionId: approval.sessionId, approvalId: approval.approvalId,
        requirementId: approval.currentRequirementId, choiceId: choice.choiceId,
      });

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
      state.pending.set(approval.approvalId, { host: state.host!, active, kind: "approval", sessionId: approval.sessionId, approval });
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
      if (host.closed || host.fatal || state.host !== host || params.sessionId !== host.sessionId) return;
      const active = state.active;
      const threadId = state.threadId;
      // A correlated native notification is delivery evidence even before an ack.
      // A later stream error cannot withdraw an admission the engine already used.
      const receivedTurnId = params.turnId ?? asRecord(params.item).turnId;
      if (active?.startAdmission && receivedTurnId === active.pendingNativeCommandId) active.startAdmission.received = true;
      switch (method) {

        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = params.item as MuseItem | undefined;
          if (!active || !item || item.turnId !== (active.nativeTurnId ?? active.pendingNativeCommandId)) return;
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
          if (active && params.turnId === (active.nativeTurnId ?? active.pendingNativeCommandId)) {
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
          if (active?.fatalPending) { void retireHost(host, "Muse Code protocol error.").catch(() => {}); return; }
          if (!active || params.turnId !== (active.nativeTurnId ?? active.pendingNativeCommandId)) return;
          const usage = asRecord(params.usage);
          const tokens = typeof usage.inputTokens === "number"
            ? { input: usage.inputTokens, output: Number(usage.outputTokens) || 0, ...(typeof usage.cachedTokens === "number" ? { cachedInput: usage.cachedTokens } : {}) }
            : undefined;
          if (!active.nativeTurnId) { active.earlyTerminal = params; return; }
          const terminal = String(params.terminal);
          if (terminal === "completed") finishTurn(state, active, { ok: true, usage: tokens });
          else if (terminal === "cancelled") finishTurn(state, active, { ok: false, stopReason: "interrupted", usage: tokens });
          else void retireHost(host, "Muse Code turn failed.").catch(() => {});
          return;
        }
        case "approval/requested": {
          const approval = params as unknown as MuseApproval;
          if (!active || active.stopping || params.turnId !== (active.nativeTurnId ?? active.pendingNativeCommandId) || !Array.isArray(approval.availableChoices) || typeof approval.approvalId !== "string") return;
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
          if (!active || active.stopping || params.turnId !== (active.nativeTurnId ?? active.pendingNativeCommandId) || typeof params.userInputId !== "string") return;
          const questions = museQuestions(params.questions);
          if (!questions?.length) return;
          state.pending.set(params.userInputId, { host, active, kind: "question", sessionId: String(params.sessionId), questions });
          emit({ type: "request.opened", threadId, turnId: active.turnId, requestId: params.userInputId, requestType: "question",
            tool: String(params.toolName ?? "ask_user"), summary: questions[0]!.question, questions });
          return;
        }
      }
    };

    const retireHost = (host: Host, cause: string): Promise<void> => {
      if (host.retirement) return host.retirement;
      if (host.closed && host.state?.active?.stopping && !host.fatal) return host.state.active.stopping;
      host.fatal = true;
      const state = host.state;
      const active = state?.active && state.active.turnId === host.owner ? state.active : undefined;
      let resolve!: () => void, reject!: (error: unknown) => void;
      host.retirement = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      if (active) { active.fatalPending = true; active.stopping = host.retirement; }
      host.admissions.clear(); host.receipts.clear(); host.switch = undefined;
      if (host.selection) host.selection.classification = "unclassified";
      const pending = state ? [...state.pending.keys()] : [];
      state?.pending.clear();
      // Ownership is published before cleanup, event callbacks, or promise continuations.
      void (async () => {
        try {
          for (const requestId of pending) if (state) {
            try { emit({ type: "request.resolved", threadId: state.threadId, requestId, behavior: "deny", source: "system" }); }
            catch { /* A listener cannot prevent captured-host termination or the other resolutions. */ }
          }
          await host.close();
          if (state?.host === host) { state.host = undefined; state.sessionId = undefined; }
          if (state && active) {
            active.fatalPending = false;
            failTurn(state, active, active.posture === "ask" && host.phase !== "ready" ? askStopUnavailableLine(ENGINE) : cause);
          }
          resolve();
        } catch (error) { host.shutdownFailed = true; reject(error); }
      })();
      void host.retirement.catch(() => {});
      return host.retirement;
    };

    const observe = (host: Host, params: Record<string, unknown>) => {
      const revision = ++host.observationRevision;
      if (host.fatal || host.closed) return;
      const sessionId = params.sessionId;
      if (!validId(sessionId) || (!host.observations.has(String(sessionId)) && host.observations.size >= 128)) {
        void retireHost(host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {}); return;
      }
      const selection: Selection = { model: typeof params.modelId === "string" ? params.modelId : undefined,
        revision, classification: classify(params.modelId), source: "notification", generation: host.generation, sessionId: String(sessionId) };
      host.observations.set(String(sessionId), selection);
      if (selection.classification !== "regular") host.unsafeObserved.add(String(sessionId));
      if (sessionId === host.sessionId) {
        host.selection = selection;
        if (selection.classification !== "regular") void retireHost(host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {});
      }
    };

    const attach = (host: Host) => {
      host.connection.onNotification(notification => {
        try {
          const params = asRecord(notification.params);
          if (notification.method === "session/modelChanged") { observe(host, params); return; }
          if (!host.closed && !host.fatal && host.state) onNotification(host.state, host, notification.method, params);
        } catch {
          void retireHost(host, "Muse Code notification failed.").catch(() => {});
        }
      });
      host.connection.onProtocolError(() => { void retireHost(host, "Muse Code protocol error.").catch(() => {}); });
      void host.connection.closed.then(() => {
        if (!host.closed) void retireHost(host, host.localRefusal?.message ?? "Muse Code connection closed.").catch(() => {});
      });
    };

    const bindSelection = (host: Host, sessionId: string, model: unknown, revision: number, source: Selection["source"], provisional = false) => {
      if (host.closed || host.fatal) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
      host.sessionId = sessionId;
      const observed = host.observations.get(sessionId);
      if (host.unsafeObserved.has(sessionId) || classify(model) !== "regular") {
        void retireHost(host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {});
        throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
      }
      host.selection = observed && observed.revision > revision ? observed : {
        model: typeof model === "string" ? model : undefined, classification: classify(model), revision,
        source, generation: host.generation, sessionId, provisional,
      };
      if (host.selection.classification !== "regular") {
        void retireHost(host, MUSE_NO_REGULAR_MODEL_LINE).catch(() => {});
        throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
      }
    };
    const switchModel = async (state: ThreadState, host: Host, active: ActiveTurn, model: string) => {
      const result = await ownedCommand(state, host, active, "session/setModel", { sessionId: host.sessionId, model: { modelId: model, providerId: MUSE_PROVIDER_ID } });
      const pending = host.switch;
      if (host.closed || host.fatal || state.active !== active || host.owner !== active.turnId || !pending || pending.generation !== host.generation || pending.owner !== host.owner || pending.sessionId !== host.sessionId) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
      host.switch = undefined;
      const response = asRecord(result.session);
      const explicit = Object.hasOwn(result, "modelId") ? result.modelId : Object.hasOwn(response, "modelId") ? response.modelId : model;
      bindSelection(host, pending.sessionId, explicit, pending.revision, "switch acknowledgment");
    };

    const museTurnModel = (model: string | undefined) => {
      const regular = museRegularModel(model, contributorIds);
      return regular && regularIds.has(regular) ? regular : undefined;
    };

    /** Muse goes on working until it confirms the interrupt; a turn it does not confirm stops only with its host. */
    const endUnconfirmed = async (state: ThreadState, active: ActiveTurn): Promise<void> => {
      if (active.finished || state.active !== active) return;
      await closeHost(state);
      finishTurn(state, active, { ok: false, stopReason: "interrupted" });
    };

    const ensureSession = async (state: ThreadState, turn: SendTurnInput, active: ActiveTurn): Promise<{ started: boolean; host: Host }> => {
      await initialModels;
      guardSpawn();
      if (active.finished || active.stopping || state.active !== active) throw new Error(`${ENGINE} was stopped while it was starting.`);
      const selected = turn.model !== undefined ? museTurnModel(turn.model) : museTurnModel(catalog.default) ?? museTurnModel(MUSE_DEFAULT_MODEL);
      if (!selected) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
      const cwd = botFolderOrThrow(turn);
      state.cwd = cwd;
      const mcpServers = museMcpServers(turn);
      const args = museServeArgs(active.posture);
      const key = JSON.stringify([cwd, args, mcpServers]);
      // Stop (and a newer turn) can land while an old host shuts down: a turn that lost the thread touches nothing.
      const lostThread = () => active.finished || Boolean(active.stopping) || state.active !== active;
      if (turn.sessionReset) {
        await closeHost(state);
        if (lostThread()) throw new Error(`${ENGINE} was stopped while it was starting.`);
        state.sessionId = undefined;
      }
      const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
      if (state.host && !state.host.closed && !state.host.fatal && state.host.commands === 0 && state.host.key === key && state.sessionId && (!cursor || cursor === state.sessionId)) {
        state.host.owner = active.turnId;
        return { started: false, host: state.host };
      }
      await closeHost(state);
      if (lostThread()) throw new Error(`${ENGINE} was stopped while it was starting.`);
      let host: Host;
      try {
        host = await startHost(args, cwd, key, mcpServers !== null, (launch) => { launch.owner = active.turnId; launch.state = state; launch.requested = selected; launch.selection = { model: selected, classification: classify(selected), revision: 0, generation: launch.generation, source: "requested", provisional: true }; state.host = launch; });
      } catch (error) {
        // A turn whose read-only launch fails does not run.
        if (active.posture === "ask") throw new Error(askStopUnavailableLine(ENGINE));
        throw error;
      }
      if (state.active !== active || active.finished || active.stopping) {
        await host.close().catch(() => {});
        throw new Error(`${ENGINE} was stopped while it was starting.`);
      }
      if (mcpServers && !host.grantedMcp) {
        await retireHost(host, MUSE_MOUNTS_REFUSED_LINE);
        throw new Error(MUSE_MOUNTS_REFUSED_LINE);
      }
      host.owner = active.turnId;
      state.host = host;

      // A Stop (or a newer turn) can land during any await below: a late answer then writes nothing to the thread, and
      // only this turn's own host is closed.
      const stale = () => active.finished || Boolean(active.stopping) || state.active !== active || state.host !== host;
      const stopped = () => new Error(`${ENGINE} was stopped while it was starting.`);
      // Contributor is a model on Muse and its served default is one: every start and resume names a regular model.
      // A host is reusable only once its session runs at Murage's approval mode: any failure before that closes it, so the
      // next turn launches again and sets the mode again instead of taking the reuse shortcut under an unknown policy.
      try {
        await initialModels;
        if (stale()) throw stopped();
        const model = selected;
        if (!catalogLoaded || !model) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
        const sessionConfig = mcpServers ? { config: { mcpServers } } : {};
        const resumeId = cursor ?? state.sessionId;
        if (resumeId) {
          let resumed = false;
          try {
            host.sessionId = resumeId;
            const response = await ownedCommand(state, host, active, "session/resume", { sessionId: resumeId, excludeItems: true, modelId: model, ...sessionConfig });
            const data = asRecord(response.session);
            bindSelection(host, resumeId, Object.hasOwn(data, "modelId") ? data.modelId : model, -1, "session response", !Object.hasOwn(data, "modelId"));
            resumed = true;
          } catch (error) {
            const kind = error instanceof MspError ? error.kind : undefined;
            if (kind !== "sessionNotFound" && kind !== "notFound") throw error;
          }
          if (resumed) {
            if (stale()) throw stopped();
            await ownedCommand(state, host, active, "session/setApprovalMode", { sessionId: resumeId, mode: MUSE_APPROVAL_MODE });
            if (stale()) throw stopped();
            // A resumed session keeps the model it had (probe 3), so the regular model is set again, explicitly.
            await switchModel(state, host, active, model)
              .catch(() => { throw new Error(MUSE_NO_REGULAR_MODEL_LINE); });
            if (stale()) throw stopped();
            state.sessionId = resumeId;

            return { started: true, host };
          }
          if (stale()) throw stopped();
        }
        const started = asRecord(await ownedCommand(state, host, active, "session/start", {
          workspaceRoot: cwd, providerId: MUSE_PROVIDER_ID, approvalMode: MUSE_APPROVAL_MODE, modelId: model, ...sessionConfig,
        }).catch((error: unknown) => { throw museModelRefusal(error) ? new Error(MUSE_NO_REGULAR_MODEL_LINE) : error; }));
        if (stale()) throw stopped();
        const session = asRecord(started.session);
        if (typeof session.sessionId !== "string") throw new Error(`${ENGINE} started a session without an id.`);
        bindSelection(host, session.sessionId, session.modelId, -1, "session response");
        state.sessionId = session.sessionId;

        return { started: true, host };
      } catch (error) {
        await retireHost(host, error instanceof Error ? error.message : "Muse setup failed.");
        throw error;
      }
    };

    /** A turn that ended (or lost the thread) before Muse had a turn of its own stops here. It closes the host only when
     *  that host is still the thread's and was set up or reused for THIS turn: a newer turn's host, idle or busy, stays.
     *  Synchronous, so no Stop can land between this check and what the caller does next. */
    const stoppedBeforeTurn = (state: ThreadState, active: ActiveTurn, host: Host): boolean => {
      if (!active.finished && !active.stopping && !host.fatal && state.active === active && state.host === host) return false;
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
        if (session.started) emit({ type: "session.started", threadId, turnId: active.turnId, sessionId, model: host.selection?.model ?? turn.model ?? null });
        const model = museTurnModel(turn.model);
        if (model && model !== host.selection?.model) {
          // The owner's regular model, or no message at all.
          await switchModel(state, host, active, model)
            .catch(() => { throw new Error(MUSE_NO_REGULAR_MODEL_LINE); });
          if (stoppedBeforeTurn(state, active, host)) return;

        }
        if (!museTurnModel(host.selection?.model)) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
        let text = turn.system && session.started ? `${turn.system}\n\n${turn.text}` : turn.text;
        if (active.posture === "ask") text = `${ASK_STOP_PROMPT}\n\n${text}`;
        const images = (turn.images ?? []).map((image) => ({ type: "image", mediaType: image.mimeType, base64Data: image.data }));
        if (stoppedBeforeTurn(state, active, host)) return;
        emit({ type: "turn.started", threadId, turnId: active.turnId });
        const effort = turn.effort && turn.effort !== "none" ? turn.effort : undefined;
        if (stoppedBeforeTurn(state, active, host)) return;
        const commandId = host.connection.mintCommandId();
        host.commands++;
        try {
          await musePromptCommand(host.connection, host.admissions, "turn/start", {
            sessionId, input: [{ type: "text", text }, ...images], ...(effort ? { reasoningEffort: effort } : {}),
          }, {
            beforeSubmit: () => {
              if (!museTurnModel(host.selection?.model)) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
              turn.beforeSubmit?.();
            }, notWritten: turn.notWritten,
            stopped: () => host.closed || Boolean(active.stopping) || stoppedBeforeTurn(state, active, host),
            onSubmit: admission => { active.pendingNativeCommandId = commandId; active.startAdmission = admission; },
            onWrite: () => {
              if (state.active !== active || host.fatal || active.stopping || active.finished) return;
              active.nativeTurnId = commandId;
              if (active.earlyTerminal) { const terminal = active.earlyTerminal; active.earlyTerminal = undefined; onNotification(state, host, "turn/completed", terminal); }
            },
          }, commandId);
        } catch (error) {
          // A refused/invalid write poisons the SDK connection. Retire only this turn's host.
          if (state.host === host && host.owner === active.turnId) await retireHost(host, error instanceof Error ? error.message : "Muse command failed.");
          throw error;
        } finally { host.commands--; }
      } catch (error) {
        const captured = state.host;
        if (captured && captured.owner === active.turnId && !active.finished) {
          await retireHost(captured, error instanceof Error ? error.message : "Muse command failed.").catch(() => {});
          return;
        }
        if (active.stopping || state.host?.shutdownFailed) return;
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
        guardSpawn();
        const state = threadOf(turn.threadId);
        if (state.host?.shutdownFailed) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
        if (state.host?.fatal) throw new Error(`${ENGINE} is still stopping on this thread.`);
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
        if (state.host && !state.host.fatal && state.host.selection?.classification === "regular" && state.sessionId && active.nativeTurnId) {
          const host = state.host;
          const interruptMethod = "turn/interrupt";
          const interrupt = musePromptCommand(host.connection, host.admissions, interruptMethod, { sessionId: state.sessionId, turnId: active.nativeTurnId }, {
            stopped: () => host.closed || Boolean(host.fatal) || state.active !== active || active.finished,
          });
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
        const stopping = active.stopping = endUnconfirmed(state, active);
        return stopping;
      },
      async respondToRequest(threadId, requestId, decision): Promise<RequestOutcome> {
        const state = threads.get(threadId);
        const pending = state?.pending.get(requestId);
        if (!state?.host || !pending || pending.host !== state.host || pending.active !== state.active || pending.active.stopping || pending.active.finished || pending.resolving) return "unavailable";
        // Each ask is answered once: a second answer finds nothing.
        pending.resolving = true;
        const turnId = state.active?.turnId;
        const resolved = (behavior: "deny" | "allow" | "answer", source: "system" | "user") => {
          if (state.pending.get(requestId) !== pending) return;
          state.pending.delete(requestId);
          emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior, source });
        };
        try {
          if (pending.kind === "approval" && pending.approval) {
            const choices = pending.approval.availableChoices;
            if (decision.behavior === "allow") {
              const once = museAllowOnce(choices);
              if (!once) {
                // No one-off allow on offer: nothing broader is ever picked, so the ask is refused.
                const deny = museDeny(choices);
                if (deny) await decide(state, pending.approval, deny, pending.host, pending.active);
                resolved("deny", "system");
                return "unavailable";
              }
              await decide(state, pending.approval, once, pending.host, pending.active);
              resolved("allow", "user");
              return "allowed-once";
            }
            const deny = museDeny(choices);
            if (!deny) return "unavailable";
            await decide(state, pending.approval, deny, pending.host, pending.active);
            resolved("deny", "user");
            return "rejected";
          }
          const questions = pending.questions ?? [];
          const answers = decision.behavior === "answer"
            ? decision.answers ?? (decision.message ? answersFromMessage(questions, decision.message) : null)
            : null;
          if (!answers?.length) {
            await ownedCommand(state, pending.host, pending.active, "userInput/cancel", { sessionId: pending.sessionId, userInputId: requestId,
              reason: "The person closed this question without answering." });
            resolved("deny", "user");
            return "rejected";
          }
          await ownedCommand(state, pending.host, pending.active, "userInput/answer", { sessionId: pending.sessionId, userInputId: requestId, answers: museAnswers(questions, answers) });
          resolved("answer", "user");
          return "answered";
        } catch {
          resolved("deny", "system");
          return "unavailable";
        }
      },
      async steer(threadId, text, beforeWrite): Promise<SteerDelivery> {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state?.host || !state.sessionId || !active?.nativeTurnId || active.finished) return "rejected";
        const host = state.host;
        let written = false;
        host.commands++;
        try {
          await musePromptCommand(host.connection, host.admissions, "turn/steer", {
            sessionId: state.sessionId, expectedTurnId: active.nativeTurnId,
            input: [{ type: "text", text: active.posture === "ask" ? `${ASK_STOP_PROMPT}\n\n${text}` : text }],
          }, {
            beforeSubmit: () => {
              if (!museTurnModel(host.selection?.model)) throw new Error(MUSE_NO_REGULAR_MODEL_LINE);
              beforeWrite?.();
            },
            stopped: () => host.closed || state.host !== host || state.active !== active || active.finished || Boolean(active.stopping),
            onSubmit: () => { written = true; },
            notWritten: () => { written = false; },
          });
          return "delivered";
        } catch (error) {
          if (state.host === host && host.owner === active.turnId) {
            try { await retireHost(host, error instanceof Error ? error.message : "Muse steer failed."); } catch { return "uncertain"; }
          }
          return written ? "uncertain" : "rejected";
        } finally { host.commands--; }
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
        const results = await Promise.allSettled([...threads.values()].map(async (state) => {
          if (state.active) await (state.active.stopping ??= endUnconfirmed(state, state.active));
          await closeHost(state);
        }));
        // A host a setup Stop detached, the Ask stop's host and the model list's host all finish shutting down too.
        while (shutting.size) await Promise.allSettled([...shutting]);
        if (results.some(result => result.status === "rejected") || auxiliaryShutdownUnconfirmed) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const initialModels = refreshModels();
    void initialModels.catch(() => {});
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() { return catalog; },
      refreshModels,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        guardSpawn();
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
        const results = await Promise.allSettled([
          adapter.stopAll(),
          ...[...auxiliaryCleanup.values()].map(clean => clean()),
          ...(versionProbe ? [versionProbe] : []),
        ]);
        if (results.some(result => result.status === "rejected") || liveChildren.size) throw new Error("MUSE_SHUTDOWN_UNCONFIRMED");
        threads.clear();
        listeners.clear();
      },
    };
  },
};
