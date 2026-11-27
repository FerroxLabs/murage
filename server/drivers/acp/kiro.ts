// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Kiro CLI over ACP (`kiro-cli acp --agent-engine=v3 --auth-method=cli`), billed to the Kiro account `kiro-cli login`
// signed in, or to a Kiro Pro key in KIRO_API_KEY. Behaviour from upstream OpenMausBot PR #4888 (checked there against
// kiro-cli 3.1.0), implemented for Murage's levels:
//   - never Autopilot: Kiro's `autopilot` config option is set to "off" on every turn at every level, Full access and No
//     limits included, so Kiro asks before each write or command and Murage's own level decision answers.
//   - `--auth-method=cli` keeps the access tokens inside Kiro; the V2 flags are refused by V3.
//   - `clientCapabilities._meta.kiro.hooks` keeps Kiro's own hooks running inside Kiro instead of asking the client.
//   - Kiro's own cloud-settings tool and its steering echo never reach the chat.
import { join } from "node:path";
import { homedir } from "node:os";

import type { ModelCatalog } from "../../contracts.ts";
import { engineReach } from "../../flux-engine-reach.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";
import { NotModelRequest } from "../../../shared/engine-transport.ts";

/** Leaves the session on the model the person picked in Kiro itself. */
const AGENT_DEFAULT = { id: "agent-default", label: "Kiro default" };
const MODELS: ModelCatalog = { default: AGENT_DEFAULT.id, options: [AGENT_DEFAULT] };
const SPAWN_ARGS = ["acp", "--agent-engine=v3", "--auth-method=cli"];
const SIGN_IN = "kiro-cli login";
const API_KEY_ENV = "KIRO_API_KEY";
const LOGIN_NOTE = `Kiro is not signed in. Run ${SIGN_IN} in a terminal, or set ${API_KEY_ENV}, then check again.`;
const AUTH_METHODS = ["aws-builder-id", "aws-iam-identity-center", "kiro-login"];
/** The one Autopilot value Murage ever sets. */
export const KIRO_AUTOPILOT = "off";
/** Kiro's own hooks run inside Kiro; without this, V3 sends its `_kiro/hooks/*` requests to the client. */
export const KIRO_CLIENT_META = { kiro: { hooks: { enabled: true, v2: true } } };
/** A tool Kiro runs on its own at the start of a session to read its cloud settings; it is not the person's work. */
const CLOUD_CONFIG_TOOL = "fetch_cloud_config";
/** Where Kiro echoes a message sent while a turn runs back into the reply's text. */
const STEERING_ECHO = "[STEERING steer-";

const userHome = (env: Record<string, string | undefined>): string => env.HOME || env.USERPROFILE || homedir();

/** Kiro keeps its sign-in in `data.sqlite3` in the system's local data folder: `~/Library/Application Support/kiro-cli`
 * on macOS, `$XDG_DATA_HOME/kiro-cli` (`~/.local/share/kiro-cli`) on Linux, and `%LOCALAPPDATA%\kiro-cli` on Windows. */
export function kiroDataDir(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const home = userHome(env);
  if (platform === "darwin") return join(home, "Library", "Application Support", "kiro-cli");
  if (platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "kiro-cli");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "kiro-cli");
}

/** Signed in by KIRO_API_KEY, or by a token `kiro-cli login` stored in the `auth_kv` table (`kirocli:social:token`,
 * `kirocli:odic:token`, or the older `codewhisperer:odic:token`). The store is only read, never written, and a runtime
 * without `node:sqlite` simply reports not signed in. */
export async function kiroSignedIn(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (env[API_KEY_ENV]?.trim()) return true;
  let db: { prepare(sql: string): { get(): unknown }; close(): void } | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(join(kiroDataDir(env, platform), "data.sqlite3"), { readOnly: true });
    return db.prepare("SELECT 1 FROM auth_kv WHERE key IN ('kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token') AND length(value) > 0 LIMIT 1").get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, clientCapabilitiesMeta: KIRO_CLIENT_META, exitGraceMs: 1_000 };

export function resolveKiroModels(env: Record<string, string | undefined>, config: Pick<AcpConfig, "cli">): Promise<ModelCatalog> {
  return discoverAcpModels(env, config.cli, SPAWN_ARGS, DISCOVERY);
}

/** Hides Kiro's own cloud-settings tool, start to end, and cuts the steering echo out of the reply's text. */
export function kiroUpdateFilter(): (update: Record<string, any>) => Record<string, any> | null {
  const hiddenTools = new Set<string>();
  return (update) => {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (update._meta?.kiro?.toolId === CLOUD_CONFIG_TOOL) {
      if (toolCallId && update.status !== "completed" && update.status !== "failed") hiddenTools.add(toolCallId);
      else hiddenTools.delete(toolCallId);
      return null;
    }
    if (toolCallId && hiddenTools.has(toolCallId)) {
      if (update.status === "completed" || update.status === "failed") hiddenTools.delete(toolCallId);
      return null;
    }
    const text = update.sessionUpdate === "agent_message_chunk" ? update.content?.text : undefined;
    if (typeof text !== "string" || !text.includes(STEERING_ECHO)) return update;
    const kept = text.slice(0, text.indexOf(STEERING_ECHO)).trimEnd();
    return kept ? { ...update, content: { ...update.content, text: kept } } : null;
  };
}

export const kiroSupport: AcpSupport = {
  driverKind: "kiroAgent",
  // Kiro runs on its own account's service, never a Flux address.
  fluxReach: (env) => engineReach(env, { compiledDefault: "https://kiro.dev" }),
  displayName: "Kiro",
  models: MODELS,
  defaultCli: "kiro-cli",
  nativeSource: "kiro.acp",
  images: false,
  loginNote: LOGIN_NOTE,
  install: {
    command: { darwin: "curl -fsSL https://cli.kiro.dev/install | bash", linux: "curl -fsSL https://cli.kiro.dev/install | bash", win32: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
    docsUrl: "https://kiro.dev/docs/getting-started/installation/",
    signInCommand: SIGN_IN,
  },
  spawnArgs: () => SPAWN_ARGS,
  credentialEnv: [API_KEY_ENV],
  clientCapabilitiesMeta: KIRO_CLIENT_META,
  resolveModels: (env, config) => resolveKiroModels(env, config),
  // The catalog comes from the startup cache and refreshes when the engine is picked: nothing starts on create.
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  pickAuthMethod: (methods) => AUTH_METHODS.find((id) => methods.some((method) => method.id === id)) ?? null,
  authFailure: "continue",
  isAuthenticated: (env) => kiroSignedIn(env),
  async configureSession({ request, sessionId }) {
    try {
      await NotModelRequest("ACP session configuration sets the permission mode on an existing session; no session/prompt is submitted", request("session/set_config_option", { sessionId, configId: "autopilot", value: KIRO_AUTOPILOT }));
    } catch (error) {
      throw new Error(`Kiro rejected permission mode "${KIRO_AUTOPILOT}": ${(error as Error).message}`);
    }
  },
  updateFilter: kiroUpdateFilter,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KiroAgentDriver = createAcpDriver(kiroSupport);
