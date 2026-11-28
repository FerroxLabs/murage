// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { engineReach } from "../../flux-engine-reach.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { discoverAcpModels } from "./custom-model-catalog.ts";
import { NotModelRequest } from "../../../shared/engine-transport.ts";

const DEFAULT_MODEL = { id: "agent-default", label: "Devin default" };
const MODELS: ModelCatalog = { default: DEFAULT_MODEL.id, options: [DEFAULT_MODEL] };
const ARGS = ["acp"];
const PERMISSION_MODE = "ask";
const MODEL_LIMIT = 4096;
const API_KEY = "WINDSURF_API_KEY";
const LOGIN_NOTE = "Sign in to Devin in a terminal with devin auth login, or set WINDSURF_API_KEY.";

export function devinSignedIn(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = platform === "win32"
    ? [env.APPDATA?.trim() || join(home, "AppData", "Roaming")]
    : [env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), env.XDG_CONFIG_HOME?.trim() || join(home, ".config")];
  return Boolean(env[API_KEY]?.trim()) || roots.some(root => existsSync(join(root, "devin", "credentials.toml")));
}

function classifyDevinError(error: unknown): ProviderErrorCode | undefined {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === -32000 && typeof message === "string" && /\blog in to use devin\b/i.test(message)) return "invalid_credentials";
}

const support: AcpSupport = {
  driverKind: "devinAgent",
  displayName: "Devin",
  defaultCli: "devin",
  nativeSource: "devin.acp",
  models: MODELS,
  images: true,
  fluxReach: env => engineReach(env, { compiledDefault: "https://cli.devin.ai" }),
  loginNote: LOGIN_NOTE,
  install: {
    command: {
      darwin: "curl -fsSL https://cli.devin.ai/install.sh | bash",
      linux: "curl -fsSL https://cli.devin.ai/install.sh | bash",
      win32: "irm https://static.devin.ai/cli/setup.ps1 | iex",
    },
    docsUrl: "https://docs.devin.ai/cli",
    signInCommand: "devin auth login",
  },
  spawnArgs: () => ARGS,
  credentialEnv: [API_KEY],
  resolveModels: (env, config) => discoverAcpModels(env, config.cli, ARGS, { passthrough: DEFAULT_MODEL, maxModels: MODEL_LIMIT }),
  resolveModelsOnCreate: false,
  maxStartupModels: MODEL_LIMIT,
  selectModel: { configId: "model", agentDefault: DEFAULT_MODEL.id },
  modelVariants: true,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: env => devinSignedIn(env),
  classifyError: classifyDevinError,
  allowOnceOnly: true,
  permissionToolCall(toolCall) {
    const command = toolCall._meta?.["cognition.ai/editableCommand"];
    return typeof command === "string" && command && toolCall.rawInput?.command === undefined
      ? { ...toolCall, kind: toolCall.kind ?? "execute", title: toolCall.title ?? command, rawInput: { ...toolCall.rawInput, command } }
      : toolCall;
  },
  async configureSession({ request, sessionId }) {
    const answer = await NotModelRequest("ACP session configuration sets the permission mode on an existing session; no session/prompt is submitted", request("session/set_config_option", { sessionId, configId: "mode", value: PERMISSION_MODE }));
    const confirmed = answer?.configOptions?.find((option: { id?: unknown }) => option.id === "mode")?.currentValue;
    if (confirmed !== PERMISSION_MODE) throw new Error("Devin did not confirm Ask mode. Check the CLI version and try again.");
  },
};

export const devinSupport = support;
export const DevinAgentDriver = createAcpDriver(support);
