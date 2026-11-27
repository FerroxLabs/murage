// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Command Code over ACP (`command-code acp`), billed to the Command Code account `cmd login` stored. The behaviour
// (program name, ACP flag, one `model` config option for its catalog, sign-in file, the -32000 login refusal) follows
// upstream OpenMausBot PR #4624; this file is written for Murage's levels:
//   - never Command Code's "bypass" mode: every level, Full access and No limits included, runs the session in its
//     "default" mode, which asks, so every ask reaches Murage and Murage's own level decision answers it.
//   - the mode is set every turn, so a person's own default mode can never skip Murage's approvals.
// The CLI is the owner's own install (`npm install -g command-code`); it runs as `command-code`, because `cmd` is the
// Windows shell. Its model catalog is read through ACP only, and the discovery session's files are removed.
import { readFileSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { engineReach } from "../../flux-engine-reach.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";
import { NotModelRequest } from "../../../shared/engine-transport.ts";
import { registerBusyloopPayloadSite } from "../../../shared/flux-route.ts";

const userHome = (env: Record<string, string | undefined>): string => env.HOME || env.USERPROFILE || homedir();

/** Leaves the session on the model the person picked in Command Code itself. */
const AGENT_DEFAULT = { id: "agent-default", label: "Command Code default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp"];
const SIGN_IN = "cmd login";
const API_KEY_ENV = "COMMAND_CODE_API_KEY";
const LOGIN_NOTE = `Command Code is not signed in. Run ${SIGN_IN} in a terminal, or set ${API_KEY_ENV}, then check again.`;
/** The one mode Murage ever sets: Command Code asks, and Murage answers at the person's level. */
export const COMMAND_CODE_MODE = "default";
/** `COMMANDCODE_API_ENV` picks the account file the CLI reads. */
const AUTH_FILES: Record<string, string> = { prod: "auth.json", staging: "auth.staging.json", local: "auth.local.json" };

/** The account file `cmd login` writes: `<home>/.commandcode/auth.json`, holding `{apiKey, userName}`. */
export function commandCodeAuthFile(env: Record<string, string | undefined>): string {
  const variant = env.COMMANDCODE_API_ENV;
  return join(userHome(env), ".commandcode", variant && Object.hasOwn(AUTH_FILES, variant) ? AUTH_FILES[variant]! : AUTH_FILES.prod!);
}

/** The CLI takes `COMMAND_CODE_API_KEY` before the stored login, as either one signs it in. */
export function commandCodeSignedIn(env: Record<string, string | undefined>): boolean {
  if (env[API_KEY_ENV]?.trim()) return true;
  try {
    const stored = registerBusyloopPayloadSite("read", JSON.parse(readFileSync(commandCodeAuthFile(env), "utf8"))) as { apiKey?: unknown } | null;
    return typeof stored?.apiKey === "string" && stored.apiKey.trim() !== "";
  } catch {
    return false;
  }
}

/** Discovery switches its session through the catalog, which Command Code records under the discovery's own
 * temporary folder's project; only that session's files, and then its emptied project folder, are removed. */
export async function forgetCommandCodeDiscoverySession({ sessionId, cwd, env }: { sessionId: string; cwd: string; env: Record<string, string | undefined> }): Promise<void> {
  const workspace = basename(cwd);
  if (!/^[\w-]{1,128}$/.test(sessionId) || !/^murage-acp-models-[a-zA-Z0-9]+$/.test(workspace)) return;
  const projects = join(userHome(env), ".commandcode", "projects");
  const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory() || !folder.name.endsWith(workspace)) continue;
    const project = join(projects, folder.name);
    const files = await readdir(project, { withFileTypes: true }).catch(() => []);
    const ours = files.filter(file => file.isFile() && file.name.startsWith(`${sessionId}.`));
    if (!ours.length) continue;
    await Promise.all(ours.map(file => rm(join(project, file.name), { force: true })));
    await rmdir(project).catch(() => {});
  }
}

const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, exitGraceMs: 1_000, forgetSession: forgetCommandCodeDiscoverySession };

export function resolveCommandCodeModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
}

/** ACP's -32000 is `auth_required`; only the login refusal's own words make it one. */
export function classifyCommandCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error !== null && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const text = typeof value?.message === "string" ? value.message.toLowerCase() : "";
  return value?.code === -32000 && /\bnot authenticated\b|\bcmd login\b/.test(text) ? "invalid_credentials" : undefined;
}

export const commandCodeSupport: AcpSupport = {
  driverKind: "commandCodeAgent",
  // Command Code runs on its own account's service, never a Flux address.
  fluxReach: (env) => engineReach(env, { compiledDefault: "https://api.commandcode.ai" }),
  displayName: "Command Code",
  models: MODELS,
  defaultCli: "command-code",
  nativeSource: "command-code.acp",
  images: true,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "npm install -g command-code", linux: "npm install -g command-code", win32: "npm install -g command-code" },
    needsNode: true,
    docsUrl: "https://commandcode.ai/docs/acp",
    signInCommand: SIGN_IN,
  },
  spawnArgs: () => SPAWN_ARGS,
  credentialEnv: [API_KEY_ENV],
  resolveModels: (env, config) => resolveCommandCodeModels(env, config),
  // The catalog comes from the startup cache and refreshes when the engine is picked: nothing starts on create.
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  // `cmd login` opens a browser; there is no login the CLI could be walked through over ACP.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => commandCodeSignedIn(env),
  classifyError: classifyCommandCodeError,
  async configureSession({ request, sessionId }) {
    try {
      await NotModelRequest("ACP session configuration sets the permission mode on an existing session; no session/prompt is submitted", request("session/set_mode", { sessionId, modeId: COMMAND_CODE_MODE }));
    } catch (error) {
      throw new Error(`Command Code rejected permission mode "${COMMAND_CODE_MODE}": ${(error as Error).message}`);
    }
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const CommandCodeAgentDriver = createAcpDriver(commandCodeSupport);
