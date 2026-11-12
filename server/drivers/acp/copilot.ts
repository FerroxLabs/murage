import { CopilotMcpConfig } from "./copilot-mcp-config.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GitHub Copilot CLI over ACP (adapted from upstream af59c2ec4, #3740). Murage starts the person's own
// installed `copilot --acp --stdio` as a child process, signed in with their own GitHub account and billed to
// their own Copilot plan. Murage never bundles, downloads or installs the CLI: when it is missing, the setup
// card links to GitHub's own install instructions and offers no install command. GitHub documents ACP mode as
// a public preview (docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
//
// The model list and premium multipliers come from an empty native ACP session. Copilot's own `allow_all` stays off: the ACP broker answers every
// permission request, so COPILOT_ALLOW_ALL is never inherited.
import { createHash } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AcpDiscoveryRpcError, discoverAcpModels, DISCOVERY_CLIENT_NAME, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";
import { ACP_LABEL_LIMIT, offeredModels } from "./config-options.ts";
import type { AcpConfig } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const COPILOT_SPAWN_ARGS: readonly string[] = ["--acp", "--stdio"];
export const COPILOT_SIGN_IN = "copilot login";
export const COPILOT_INSTALL_URL = "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli";
export const COPILOT_LOGIN_NOTE = `GitHub Copilot is not signed in. Run ${COPILOT_SIGN_IN} in a terminal, then check again.`;
export const COPILOT_DEFAULT_MODEL = "auto";
const AUTO = COPILOT_DEFAULT_MODEL;
const SPAWN_ARGS = [...COPILOT_SPAWN_ARGS];
const TOKEN_ENV = ["COPILOT_GITHUB_TOKEN"] as const;
const SIGNED_IN_FOR_MS = 300_000, SIGNED_OUT_FOR_MS = 60_000, UNPROVEN_FOR_MS = 15_000, SIGN_IN_WAIT_MS = 3_000;

/** A general GitHub token on this computer (gh, CI) would outrank the Copilot login. Copilot's own
 *  COPILOT_GITHUB_TOKEN is the one a person sets on purpose, so it is kept. */
const GENERAL_GITHUB_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/** Would approve every tool inside Copilot without asking the broker. */
const ALLOW_ALL = "COPILOT_ALLOW_ALL";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The multiplier beside a model label is what a prompt costs in premium requests. */
export function copilotModelLabel(model: { id: string; label: string }, sessionNew: unknown): string {
  const configOptions = record(sessionNew)?.configOptions;
  const option = Array.isArray(configOptions)
    ? configOptions.map(record).find((entry) => entry?.type === "select" && (entry.id === "model" || entry.category === "model"))
    : undefined;
  const values = Array.isArray(option?.options) ? option.options.map(record) : [];
  const usage = record(values.find((value) => value?.value === model.id)?._meta)?.copilotUsage;
  if (typeof usage !== "string" || usage.length > ACP_LABEL_LIMIT || !/^\d+(?:\.\d+)?x$/.test(usage)) return model.label;
  const label = `${model.label} · ${usage}`;
  return label.length <= ACP_LABEL_LIMIT ? label : model.label;
}

/** The folder that holds the CLI's account and session state. */
export function copilotHome(env: Record<string, string | undefined>): string {
  return env.COPILOT_HOME || join((process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir(), ".copilot");
}

/** A workspace.yaml scalar: plain as Copilot CLI 1.0.105 writes it, or quoted. */
function yamlScalar(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (!quoted) return value;
  return quoted[1] === "'" ? quoted[2].replaceAll("''", "'") : quoted[2].replace(/\\(["\\])/g, "$1");
}

/** The CLI may record the cwd resolved (a symlinked temp dir, a long name for an 8.3 one) or, on Windows, in
 * another case; both sides are compared in every form they resolve to. */
async function sameFolder(recorded: string, cwd: string): Promise<boolean> {
  const forms = async (path: string) => {
    const all = [resolve(path)];
    try { all.push(await realpath(path)); } catch {}
    return all.map((form) => (process.platform === "win32" ? form.toLowerCase() : form));
  };
  const ours = new Set(await forms(cwd));
  return (await forms(recorded)).some((form) => ours.has(form));
}

/** Copilot CLI 1.0.103 keeps every ACP session, even an empty one closed with session/close, under
 * `<COPILOT_HOME>/session-state/<id>`, where it would sit in the person's `copilot --resume` list. Only a
 * folder whose workspace.yaml names this discovery's own temporary cwd and client is removed. */
export async function forgetCopilotDiscoverySession({ sessionId, cwd, env }: { sessionId: string; cwd: string; env: Record<string, string | undefined> }): Promise<void> {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return;
  const folder = join(copilotHome(env), "session-state", sessionId);
  let workspace: string;
  try { workspace = await readFile(join(folder, "workspace.yaml"), "utf8"); } catch { return; }
  const field = (name: string) => {
    const value = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(workspace)?.[1];
    return value === undefined ? undefined : yamlScalar(value);
  };
  const recorded = field("cwd");
  if (!recorded || field("client_name") !== DISCOVERY_CLIENT_NAME || !(await sameFolder(recorded, cwd))) return;
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Copilot CLI gets to exit on its own, releasing its session folder, before forgetSession removes that folder.
const DISCOVERY: AcpDiscoveryOptions = {
  default: AUTO, label: copilotModelLabel, exitGraceMs: 2_000, forgetSession: forgetCopilotDiscoverySession,
};

/** The home holds the CLI's stored login, GH_HOST picks the GitHub it signs in to, and a token in the
 * environment outranks both; only its digest is kept. */
const signInKey = (env: Record<string, string | undefined>, cli: string) => {
  const tokens = createHash("sha256").update(TOKEN_ENV.map((name) => env[name]?.trim() ?? "").join("\0")).digest("hex");
  return [cli, copilotHome(env), env.GH_HOST ?? "", tokens].join("\0");
};
const signIns = new Map<string, { signedIn: Promise<boolean>; until: number }>();
const lastSignIns = new Map<string, boolean>();

interface SignInAnswer { signedIn: boolean; forMs: number }

/** Shares one probe between concurrent callers, then keeps its answer for as long as it holds. */
function rememberSignIn(key: string, answer: Promise<SignInAnswer>): Promise<boolean> {
  const signedIn = answer.then((value) => value.signedIn);
  signIns.set(key, { signedIn, until: Number.POSITIVE_INFINITY });
  void answer.then(({ signedIn: value, forMs }) => {
    lastSignIns.set(key, value);
    if (signIns.get(key)?.signedIn === signedIn) signIns.set(key, { signedIn, until: Date.now() + forMs });
  });
  return signedIn;
}

/** Only the refusal a turn would also report as a missing login proves one. Any other failure leaves the
 * engine offered, so the turn reports the real error, but is asked again soon. */
const signedInAfter = (discovery: Promise<unknown>): Promise<SignInAnswer> => discovery.then(
  () => ({ signedIn: true, forMs: SIGNED_IN_FOR_MS }),
  (error) => error instanceof AcpDiscoveryRpcError
    && classifyCopilotError({ code: error.code, message: error.rpcMessage }) === "invalid_credentials"
    ? { signedIn: false, forMs: SIGNED_OUT_FOR_MS }
    : { signedIn: true, forMs: UNPROVEN_FOR_MS });

/** A refresh also answers the sign-in question, so the snapshot after it starts nothing. */
export function resolveCopilotModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  const catalog = discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
  void rememberSignIn(signInKey(env, config.cli), signedInAfter(catalog));
  return catalog;
}

/** The login sits in the OS credential store or in a token, either of which may have expired, and only the
 * CLI checks them, so an empty session/new (no prompt, no premium request) answers. */
export function copilotSignedIn(
  env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">, waitMs = SIGN_IN_WAIT_MS,
): Promise<boolean> {
  const key = signInKey(env, config.cli);
  const cached = signIns.get(key);
  const probe = cached && cached.until > Date.now() ? cached.signedIn
    : rememberSignIn(key, signedInAfter(discoverAcpModels(env, config.cli, SPAWN_ARGS, { ...DISCOVERY, variants: false })));
  return new Promise((done) => {
    const timer = setTimeout(() => done(lastSignIns.get(key) ?? true), waitMs);
    void probe.then((signedIn) => { clearTimeout(timer); done(signedIn); });
  });
}

const QUALIFIER = "(?:github |copilot |oauth |access )";
/** Whole login phrases: a bare "token" or "auth" would also match "max tokens exceeded" or "author". A missing
 *  credential needs the GitHub/Copilot qualifier, as an MCP server's own key can be missing too. */
const LOGIN_REFUSAL = new RegExp([
  String.raw`auth(?:entication|orization)? (?:is )?required`,
  "unauthenticated",
  "unauthorized",
  "authentication failed",
  String.raw`not (?:logged|signed) ?in`,
  String.raw`(?:log|sign) ?in (?:is )?required`,
  String.raw`(?:run|use) .?copilot login`,
  String.raw`(?:invalid|expired|revoked) ${QUALIFIER}?(?:token|credentials?)`,
  String.raw`(?:no|missing) ${QUALIFIER}(?:token|credentials?)`,
  String.raw`(?:token|credentials?) (?:has |have )?expired`,
  String.raw`(?:token|credentials?) (?:is |are )?(?:invalid|revoked)`,
  "bad credentials",
].map((phrase) => String.raw`\b${phrase}\b`).join("|"));
/** A refusal about an MCP server's credentials is that server's, not the Copilot login's. */
const MCP_SERVER = /\bmcp\b/;

/** -32000 is ACP's `auth_required`, but agents reuse it for other failures; the text must agree. */
export function classifyCopilotError(error: unknown): ProviderErrorCode | undefined {
  const value = record(error);
  const text = (typeof value?.message === "string" ? value.message : "").toLowerCase();
  return value?.code === -32000 && LOGIN_REFUSAL.test(text) && !MCP_SERVER.test(text) ? "invalid_credentials" : undefined;
}

/** Names compare case-insensitively because Windows environments do. */
function deleteEnv(env: Record<string, string | undefined>, name: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
}

/** Drop the permission bypass and the general GitHub tokens (COPILOT_GITHUB_TOKEN stays). */
export function scrubCopilotEnv(env: Record<string, string | undefined>): void {
  deleteEnv(env, ALLOW_ALL);
  for (const name of GENERAL_GITHUB_TOKENS) deleteEnv(env, name);
}

export const copilotSupport: AcpSupport = {
  driverKind: "copilotAgent",
  displayName: "GitHub Copilot",
  models: { default: COPILOT_DEFAULT_MODEL, options: [{ id: COPILOT_DEFAULT_MODEL, label: "Auto" }] },
  resolveModels: (env, config) => resolveCopilotModels(env, config),
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", unsetIds: [AUTO] },
  modelVariants: true,
  fallbackModel: (sessionConfig, catalogDefault) => {
    const offered = offeredModels(sessionConfig, "model");
    return offered.includes(catalogDefault) ? catalogDefault : offered.includes(AUTO) ? AUTO : null;
  },
  defaultCli: "copilot",
  nativeSource: "copilot.acp",
  images: true,
  loginNote: COPILOT_LOGIN_NOTE,
  // No `command`: Murage never runs an installer for Copilot. The card links GitHub's own instructions.
  install: { docsUrl: COPILOT_INSTALL_URL, signInCommand: COPILOT_SIGN_IN },
  spawnArgs: (_config, turn) => [...COPILOT_SPAWN_ARGS, ...(turn.integrations?.agents && !(turn.permissionNow?.() ?? turn).noLimits ? ["--excluded-tools=web_fetch"] : [])],
  transformEnv(env) {
    scrubCopilotEnv(env);
  },
  // The owner's captured shell map (Rule 74a) can carry names this process never had, such as a GH_TOKEN or
  // COPILOT_ALLOW_ALL exported in a shell profile when the app was opened from the Dock. The same scrub runs there,
  // so the broker still answers permissions and the Copilot login is not outranked.
  scrubHandedEnv(map) {
    scrubCopilotEnv(map);
  },
  restartOnMcpChange: true,
  mcpServersFromLaunch: true,
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The login sits in the OS credential store and only the CLI can check it; Murage does not start Copilot just
  // to ask. The Engines screen says "sign-in not verified", and a turn refused for the login says how to sign in.
  // Snapshots also run at startup. Only an explicit catalog refresh or sign-in check starts discovery.
  isAuthenticated: (env, config) => {
    const key = signInKey(env, config.cli);
    return (signIns.get(key)?.until ?? 0) > Date.now() ? lastSignIns.get(key) : undefined;
  },
  authUnknownIsUnverified: true,
  classifyError: classifyCopilotError,
};

export const CopilotAgentDriver = {
  ...createAcpDriver(copilotSupport),
  async create(input: Parameters<ReturnType<typeof createAcpDriver>["create"]>[0]) {
    const files = await CopilotMcpConfig.create();
    try {
      const instance = await createAcpDriver({
        ...copilotSupport,
        prepareMcpLaunch(env, { threadId, mcpServers }) {
          const path = files.prepare(threadId, mcpServers);
          env.MURAGE_COPILOT_MCP_CONFIG = path;
          return () => files.release(path);
        },
        spawnArgs(_config, turn, context) {
          const path = context?.env?.MURAGE_COPILOT_MCP_CONFIG;
          if (!path) throw new Error("GitHub Copilot tool configuration was not prepared.");
          return [...copilotSupport.spawnArgs(_config, turn, context), "--additional-mcp-config", `@${path}`];
        },
      }).create(input);
      const dispose = instance.dispose.bind(instance);
      instance.dispose = async () => { await dispose(); await files.dispose(); };
      return instance;
    } catch (error) { await files.dispose(); throw error; }
  },
};
