// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenClaw — `openclaw acp`, the ACP stdio bridge OpenClaw ships natively.
// Each OpenClaw isolated agent (workspace + auth + routing) mounts as its own
// engine instance, selected with `{ agent?: string }` in the instance config
// exactly as a Hermes profile is selected with `{ profile? }`.
//
//   { "instances": { "openclaw-agent-fred": {
//       "driver": "openclawAgent",
//       "displayName": "OpenClaw · fred",
//       "config": { "agent": "fred" } } } }
//
// Auth: none. The local bridge advertises `authMethods: []` (verified against
// OpenClaw 2026.9.5), carries its own gateway and model, and reads its own
// state dir. Unlike Hermes there is no Flux home to materialise and no
// provider key to inject: this driver writes NOTHING to disk and puts no
// credential in the child env.
//
// Model: the agent runs whatever it is configured for. One passthrough id is
// advertised and no model is ever sent (`-m` conventions differ per CLI and
// the bridge does not take one).
//
// Tools and approvals: an OpenClaw bot runs on OpenClaw's OWN tools and OWN
// approvals. Verified live against the bridge: (a) it ran shell commands with
// no ACP permission request ever reaching Murage (its approvals sit on the
// gateway/allowlist side), and (b) it ignores `session/new` `mcpServers`
// (a mounted probe tool was reported as absent). So `ownTools: true` below:
// Murage hands the bridge NO mounts and declares no teammates, memory,
// computer, browser or connected-apps capability, and does not claim its
// Ask/stop-line gates this engine. The primer and the permission menu say so,
// the same class as Antigravity's limits. This resolves the earlier
// TODO(openclaw-mcp).
//
// Remote seam: a remote gateway is `openclaw acp --url <ws> --token-file <f>`.
// It is deliberately NOT implemented. `openclawBridgeArgs` is the single place
// argv is built; a future `config.url` / `config.tokenFile` extends it there
// (the token goes in a file, never in argv), and `decodeExtra` below is where
// the new fields would be validated.
import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import {
  DEFAULT_OPENCLAW_AGENT,
  isOpenclawAgentName,
  openclawAgentOf,
  openclawSessionKey,
} from "../../openclaw-profiles.ts";

const DRIVER_KIND = "openclawAgent";

/** Passthrough: the agent's own configured model. Never sent over ACP. */
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw-default";

const CATALOG: ModelCatalog = {
  default: OPENCLAW_DEFAULT_MODEL_ID,
  // `custom: true` so the custom-only picker pane lists it (see hermes.ts).
  options: [{ id: OPENCLAW_DEFAULT_MODEL_ID, label: "OpenClaw agent default", custom: true }],
};

type OpenclawAgentConfig = { agent?: string } | undefined;

/** argv AFTER the binary: enter ACP stdio mode for one named agent. Every
 * spawn names its agent, so nothing OpenClaw keeps as a default can change who
 * answers. The one place to extend for the future remote form. */
export function openclawBridgeArgs(config: OpenclawAgentConfig): string[] {
  return ["acp", "--session", openclawSessionKey(openclawAgentOf(config))];
}

const support: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "OpenClaw",
  access: "custom",
  models: CATALOG,
  ownTools: true,
  defaultCli: "openclaw",
  nativeSource: "openclaw.acp",
  loginNote: "OpenClaw CLI is not installed",
  install: {
    command: {
      darwin: "npm install -g openclaw@latest",
      linux: "npm install -g openclaw@latest",
      win32: "npm install -g openclaw@latest",
    },
    docsUrl: "https://docs.openclaw.ai",
    signInCommand: "openclaw onboard",
  },
  decodeExtra: (raw) => (isOpenclawAgentName(raw.agent) ? { agent: raw.agent } : {}),
  spawnArgs: (config) => openclawBridgeArgs(config),
  // authMethods is empty: nothing to authenticate, and a missing sign-in is
  // OpenClaw's own error to report, not a reason to refuse the spawn.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export { DEFAULT_OPENCLAW_AGENT };
export const OpenclawAgentDriver = createAcpDriver(support);
