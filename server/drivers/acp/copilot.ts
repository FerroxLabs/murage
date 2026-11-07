// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GitHub Copilot CLI over ACP (adapted from upstream af59c2ec4, #3740). Murage starts the person's own
// installed `copilot --acp --stdio` as a child process, signed in with their own GitHub account and billed to
// their own Copilot plan. Murage never bundles, downloads or installs the CLI: when it is missing, the setup
// card links to GitHub's own install instructions and offers no install command. GitHub documents ACP mode as
// a public preview (docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
//
// The model stays the CLI's own choice (one passthrough id, like customAcp): Copilot reads it from the
// person's Copilot settings and plan. Copilot's own `allow_all` stays off: the ACP broker answers every
// permission request, so COPILOT_ALLOW_ALL is never inherited.
import type { ProviderErrorCode } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const COPILOT_SPAWN_ARGS: readonly string[] = ["--acp", "--stdio"];
export const COPILOT_SIGN_IN = "copilot login";
export const COPILOT_INSTALL_URL = "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli";
export const COPILOT_LOGIN_NOTE = `GitHub Copilot is not signed in. Run ${COPILOT_SIGN_IN} in a terminal, then check again.`;
export const COPILOT_DEFAULT_MODEL = "copilot-default";

/** A general GitHub token on this computer (gh, CI) would outrank the Copilot login. Copilot's own
 *  COPILOT_GITHUB_TOKEN is the one a person sets on purpose, so it is kept. */
const GENERAL_GITHUB_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/** Would approve every tool inside Copilot without asking the broker. */
const ALLOW_ALL = "COPILOT_ALLOW_ALL";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
  models: { default: COPILOT_DEFAULT_MODEL, options: [{ id: COPILOT_DEFAULT_MODEL, label: "Copilot default" }] },
  defaultCli: "copilot",
  nativeSource: "copilot.acp",
  images: true,
  loginNote: COPILOT_LOGIN_NOTE,
  // No `command`: Murage never runs an installer for Copilot. The card links GitHub's own instructions.
  install: { docsUrl: COPILOT_INSTALL_URL, signInCommand: COPILOT_SIGN_IN },
  spawnArgs: () => [...COPILOT_SPAWN_ARGS],
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
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The login sits in the OS credential store and only the CLI can check it; Murage does not start Copilot just
  // to ask. The Engines screen says "sign-in not verified", and a turn refused for the login says how to sign in.
  isAuthenticated: () => undefined,
  authUnknownIsUnverified: true,
  classifyError: classifyCopilotError,
};

export const CopilotAgentDriver = createAcpDriver(copilotSupport);
