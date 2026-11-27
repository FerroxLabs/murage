// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OMP over ACP (`omp acp`). Behaviour from upstream OpenMausBot PR #5399, implemented for Murage: OMP's initialize
// offers the `agent` auth method, and session/new exposes its models as the `model` config option. Written for Murage's
// levels:
//   - OMP has no permission mode or allow-all switch over ACP, so every level, Full access and No limits included, reaches
//     Murage as a session/request_permission and is answered by Murage's own level decision. Nothing sets a mode.
//   - a provider key reaches OMP only from this instance's own environment, and never a workspace credential.
//   - discovery runs in a temporary session folder, so a model refresh leaves no session in the person's history.
// The CLI is the owner's own install (`npm install -g @oh-my-pi/pi-coding-agent`).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { engineReach } from "../../flux-engine-reach.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };
const AGENT_DEFAULT = { id: "agent-default", label: "OMP default (configured)" };
const WORKSPACE_CREDENTIALS = new Set<string>(WORKSPACE_CREDENTIAL_ENV);
// Another engine's own sign-in key is not OMP's provider key.
const OTHER_ENGINE_KEYS = new Set<string>(["COMMAND_CODE_API_KEY", "KIRO_API_KEY", "WINDSURF_API_KEY"]);
const CREDENTIAL_ENV = PROVIDER_CREDENTIAL_ENV.filter((key) => !WORKSPACE_CREDENTIALS.has(key) && !OTHER_ENGINE_KEYS.has(key));
// Murage lists at most ACP_OPTION_LIMIT (128) options of any ACP select, so a larger OMP catalog is cut at its 128th model
// and the catalog says so ("Showing 128 of N models").
const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, custom: true, variants: true };

/** Discovers OMP models in a temporary session directory, so a refresh leaves no session in the person's history. */
export async function resolveOmpModels(
  env: Record<string, string | undefined>,
  config: Pick<AcpConfig, "cli">,
): Promise<ModelCatalog> {
  const sessionDir = await mkdtemp(join(tmpdir(), "murage-omp-discovery-"));
  try {
    return await discoverAcpModels({ ...env, PI_CODING_AGENT_SESSION_DIR: sessionDir }, config.cli, ["acp"], DISCOVERY);
  } finally {
    await rm(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export const ompSupport: AcpSupport = {
  driverKind: "ompAgent",
  // OMP sends to the providers the person configured in it, never to a Flux address Murage did not hand it.
  fluxReach: (env) => engineReach(env, { compiledDefault: "https://omp.sh" }),
  displayName: "OMP",
  access: "custom",
  models: EMPTY,
  defaultCli: "omp",
  nativeSource: "omp.acp",
  images: true,
  loginNote: "OMP has no usable models. Run `omp login` or configure a provider in `~/.omp/agent/models.yml`, then check again.",
  install: {
    command: {
      darwin: "npm install -g @oh-my-pi/pi-coding-agent",
      linux: "npm install -g @oh-my-pi/pi-coding-agent",
      win32: "npm install -g @oh-my-pi/pi-coding-agent",
    },
    needsNode: true,
    docsUrl: "https://omp.sh",
    signInCommand: "omp login",
  },
  spawnArgs: () => ["acp"],
  credentialEnv: CREDENTIAL_ENV,
  resolveModels: resolveOmpModels,
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  pickAuthMethod: (methods) => methods.some((method) => method.id === "agent") ? "agent" : null,
  authFailure: "continue",
  isAuthenticated: () => true,
};

export const OmpAgentDriver = createAcpDriver(ompSupport);
