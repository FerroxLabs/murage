// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cline over ACP (item 175, design MCP-118-175 section 2). Adapted from
// OpenMausBot 83c10b390 server/drivers/acp/cline.ts (Apache-2.0, see NOTICE),
// narrowed for Murage's privacy design (section 5):
//   - providers.json is read only at a snapshot, a version probe's availability
//     answer and a spawn, capped at 256 KiB, and only the SELECTED provider's
//     block is read as a member; no other provider's block is ever touched.
//   - the snapshot learns {provider, model, auth} only, never the key.
//   - the key goes to the child alone through secretEnv: never into the
//     retained hand, the hands list, an exec-env digest, a log or an error.
//   - the spawn fingerprint covers provider, model, auth and the file's mtime
//     and size, never key bytes.
// Cline always starts as `cline --acp --auto-approve false`, so Murage's
// approval levels decide what it may do.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { ModelCatalog } from "../../contracts.ts";
import { splitCliString } from "../../env-path.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

export const CLINE_DEFAULT_MODEL = "cline-default";
const MODELS: ModelCatalog = {
  default: CLINE_DEFAULT_MODEL,
  options: [{ id: CLINE_DEFAULT_MODEL, label: "Cline default (from cline auth)" }],
};
export const CLINE_MAX_SETTINGS_BYTES = 256 * 1024;
/** Providers whose sign-in is an account (OAuth), not a key: never handed a key. */
const OAUTH_PROVIDERS = new Set(["cline", "cline-pass", "openai-codex"]);
const PROVIDER_NAME = /^[\w.-]{1,100}$/;
export const CLINE_LOGIN_NOTE = "Sign in to Cline in a terminal: cline auth";
export const CLINE_AUTO_APPROVE_REFUSAL = "Cline must run with --auto-approve false, so Murage's approval levels decide what it may do. Remove --auto-approve true from its command.";

export type ClineAuth = "oauth" | "key" | "none";
export interface ClineSaved { provider: string; model?: string; auth: ClineAuth }

/** The flags of the configured command, after the program. */
function cliFlags(config: AcpConfig): string[] {
  return splitCliString(config.cli || "cline").slice(1);
}

/** The value of `--name value` or `--name=value` in the command, last one wins. */
function flagValue(args: readonly string[], name: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === name && index + 1 < args.length) found = args[index + 1];
    else if (arg.startsWith(`${name}=`)) found = arg.slice(name.length + 1);
  }
  return found;
}

/** Every `--auto-approve` occurrence in the command, in order. A bare flag (last,
 * or followed by another flag) counts as "true", as Cline reads it. */
function autoApproveValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--auto-approve") values.push(index + 1 < args.length && !args[index + 1]!.startsWith("-") ? args[index + 1]! : "true");
    else if (arg.startsWith("--auto-approve=")) values.push(arg.slice("--auto-approve=".length));
  }
  return values;
}

/** Where Cline keeps its provider settings, by its own rules:
 * (--config | CLINE_DIR | ~/.cline)/(--data-dir | CLINE_DATA_DIR | data)/settings/providers.json,
 * or CLINE_PROVIDER_SETTINGS_PATH. */
export function clineSettingsPath(env: Record<string, string | undefined>, config: AcpConfig): string {
  if (env.CLINE_PROVIDER_SETTINGS_PATH) return env.CLINE_PROVIDER_SETTINGS_PATH;
  const args = cliFlags(config);
  const home = flagValue(args, "--config") || env.CLINE_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".cline");
  const data = flagValue(args, "--data-dir") || env.CLINE_DATA_DIR || join(home, "data");
  return join(data, "settings", "providers.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

type SelectedBlock = { provider: string; model?: string; auth: ClineAuth; key?: string };

/** Read the file once and return the selected provider's block, or null for
 * anything that is not a well-formed version 1 file with a usable selection:
 * absent, over the cap, malformed, another version, a missing or ill-typed
 * block. Only the selected block is touched, and its key is copied out only
 * when `withKey` (the spawn); a snapshot or probe learns that one exists.
 * Never throws and never logs. */
function selectedBlock(env: Record<string, string | undefined>, config: AcpConfig, withKey = false): SelectedBlock | null {
  try {
    const path = clineSettingsPath(env, config);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > CLINE_MAX_SETTINGS_BYTES) return null;
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(stored) || stored.version !== 1 || !isRecord(stored.providers)) return null;
    const provider = env.CLINE_PROVIDER || stored.lastUsedProvider;
    if (typeof provider !== "string" || !PROVIDER_NAME.test(provider) || !Object.hasOwn(stored.providers, provider)) return null;
    const entry = stored.providers[provider];
    if (!isRecord(entry) || !isRecord(entry.settings)) return null;
    const settings = entry.settings;
    if (settings.provider !== provider || !optionalText(settings.model) || !optionalText(settings.apiKey)) return null;
    if (settings.auth !== undefined && (!isRecord(settings.auth) || !optionalText(settings.auth.accessToken) || !optionalText(settings.auth.apiKey))) return null;
    const signIn = settings.auth as { accessToken?: string; apiKey?: string } | undefined;
    const model = settings.model as string | undefined;
    let auth: ClineAuth;
    let key: string | undefined;
    if (OAUTH_PROVIDERS.has(provider)) {
      auth = signIn?.accessToken?.trim() ? "oauth" : "none";
    } else {
      const candidate = (settings.apiKey as string | undefined) || signIn?.apiKey;
      auth = candidate?.trim() ? "key" : "none";
      if (withKey && auth === "key") key = candidate!.trim();
    }
    return { provider, ...(model ? { model } : {}), auth, ...(key ? { key } : {}) };
  } catch {
    return null;
  }
}

/** The selected provider's non-secret fields, or null ("unconfigured"). */
export function savedProvider(env: Record<string, string | undefined>, config: AcpConfig): ClineSaved | null {
  const block = selectedBlock(env, config);
  if (!block) return null;
  return { provider: block.provider, ...(block.model ? { model: block.model } : {}), auth: block.auth };
}

/** The selected provider's key, on request only (the spawn). Undefined for an
 * OAuth provider, a provider with no key, or an unconfigured file. */
export function savedProviderKey(env: Record<string, string | undefined>, config: AcpConfig): string | undefined {
  return selectedBlock(env, config, true)?.key;
}

/** The flags Cline always runs with, added when the command lacks them. A
 * command that turns Cline's own auto-approval on is refused. */
export function clineForcedArgs(config: AcpConfig): string[] {
  const args = cliFlags(config);
  const values = autoApproveValues(args);
  // Any occurrence other than exactly "false" is refused; last-wins is not relied on.
  if (values.some((value) => value !== "false")) throw new Error(CLINE_AUTO_APPROVE_REFUSAL);
  return [...(args.includes("--acp") ? [] : ["--acp"]), ...(values.length === 0 ? ["--auto-approve", "false"] : [])];
}

/** The driver's ACP hooks, exported for its tests. */
export const clineSupport: AcpSupport = {
  driverKind: "clineAgent",
  displayName: "Cline",
  models: MODELS,
  defaultCli: "cline",
  nativeSource: "cline.acp",
  images: true,
  loginNote: CLINE_LOGIN_NOTE,
  install: {
    command: { darwin: "npm install -g cline", linux: "npm install -g cline", win32: "npm install -g cline" },
    needsNode: true,
    docsUrl: "https://docs.cline.bot/usage/acp",
    signInCommand: "cline auth",
  },
  spawnArgs: (config) => clineForcedArgs(config),
  credentialEnv: ["CLINE_API_KEY"],
  // 175-3: the key goes to the child alone. A key already in the environment is
  // used as it is and the file is not opened.
  secretEnv(env, config): Record<string, string> {
    if (env.CLINE_API_KEY?.trim()) return {};
    const key = savedProviderKey(env, config);
    return key ? { CLINE_API_KEY: key } : {};
  },
  // 175-5: provider, model, auth and the file's mtime and size; never key bytes.
  spawnFingerprint(env, config) {
    const saved = savedProvider(env, config);
    if (!saved) return "unconfigured";
    let mtime = 0, size = 0;
    try { const stat = statSync(clineSettingsPath(env, config)); mtime = stat.mtimeMs; size = stat.size; } catch { /* the read above decides */ }
    return createHash("sha256").update(JSON.stringify([saved.provider, saved.model ?? null, saved.auth, mtime, size])).digest("hex");
  },
  restartOnMcpChange: true,
  skipAuthWhenSignedIn: true,
  // 175-4: an account provider signs in with its own method id; a key provider
  // needs no authenticate call (null with isAuthenticated true is a skip).
  pickAuthMethod(methods, env = {}, config) {
    if (!config || env.CLINE_API_KEY?.trim()) return null;
    const saved = savedProvider(env, config);
    if (saved?.auth !== "oauth") return null;
    return methods.some((method) => method.id === saved.provider) ? saved.provider : null;
  },
  authFailure: "fail",
  isAuthenticated(env, config) {
    if (env.CLINE_API_KEY?.trim()) return true;
    const auth = savedProvider(env, config)?.auth;
    return auth === "key" || auth === "oauth";
  },
  requireAuthenticationBeforeSpawn: true,
  // One pinned id: Cline runs the model chosen in `cline auth`, set on the session.
  resolveTurnModel(_model, env, config) {
    return config ? savedProvider(env, config)?.model : undefined;
  },
  async configureSession({ request, sessionId, turn, currentModelId }) {
    // Cline falls back when a saved custom model is missing from its own list:
    // pin the saved id after session/new, before the first prompt.
    const model = turn.model?.trim();
    if (model && model !== CLINE_DEFAULT_MODEL && model !== currentModelId) {
      await request("session/set_model", { sessionId, modelId: model });
    }
  },
};

const base = createAcpDriver(clineSupport);

export const ClineAgentDriver: typeof base = {
  ...base,
  // An edited command keeps both flags; `--auto-approve true` is a settings error.
  decodeConfig(raw) {
    const decoded = base.decodeConfig(raw);
    clineForcedArgs(decoded);
    return decoded;
  },
};
