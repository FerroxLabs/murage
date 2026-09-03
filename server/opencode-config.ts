// Everything that knows the shape of OpenCode's own `opencode.json`: where it
// lives, how a provider is upserted into it, and the Flux connector plan.
//
// This file exists as its own module rather than inside the driver for one
// structural reason: `flux-surface.ts` has to ask whether the OpenCode
// connector is installed before it may offer a Flux row (a `configWrite`
// engine is not routable until the file has been written), and the driver
// imports `flux-surface.ts` for `mergeFluxCatalog`. Putting the file format
// here breaks that cycle and leaves exactly ONE implementation of the
// provider upsert, shared by the local-inject writer and the Flux connector.
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ConnectorPaths,
  type ConnectorPlan,
  type ConnectorStatus,
  type InstallResult,
  type RemoveResult,
  connectorStatus,
  installConnector,
  murageStateDir,
  removeConnector,
} from "./flux-connector.ts";
import { FLUX_MODELS, FLUX_OPENAI_BASE } from "./flux-routing.ts";

/** The `provider.<id>` key this app owns inside opencode.json. */
export const OPENCODE_FLUX_PROVIDER = "flux";

/** The tool name the receipt is filed under. */
export const OPENCODE_CONNECTOR_TOOL = "opencode";

/**
 * `@ai-sdk/openai-compatible` is not a default — it is the load-bearing part.
 * It is what makes OpenCode talk `/v1/chat/completions` instead of its own
 * provider protocol (Wayland opencode.ts:16-18, which records an earlier
 * `/v1/responses` + catalog-reject failure this value fixed).
 */
const OPENCODE_COMPAT_NPM = "@ai-sdk/openai-compatible";

/** OpenCode reads this key camelCase. It is case-sensitive; `baseUrl` is
 *  silently ignored and the provider then points at nothing. */
const BASE_URL_KEY = "baseURL";

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Where the CLI reads its config, in the CLI's own precedence order:
 * `OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME/opencode` → `~/.config/opencode`.
 * Writing anywhere else produces a connector that reports success and changes
 * nothing, which is the worst failure available here.
 */
export function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export function opencodeConfigPath(env: Record<string, string | undefined>): string {
  return join(opencodeConfigDir(env), "opencode.json");
}

/** Snapshot/receipt locations, all inside the app's own data dir — never
 *  beside the user's config, where an editor or a sync tool would pick them up. */
export function opencodeConnectorPaths(env: Record<string, string | undefined> = process.env): ConnectorPaths {
  const dir = opencodeConfigDir(env);
  const state = murageStateDir(env);
  return {
    configPath: join(dir, "opencode.json"),
    allowedRoot: dir,
    manifestPath: join(state, "flux-connectors.json"),
    backupDir: join(state, "flux-connector-backups"),
  };
}

interface JsonStyle {
  indent: string | number;
  trailingNewline: boolean;
}

/**
 * Reuse the file's own formatting instead of imposing ours.
 *
 * Without this a connect/disconnect round trip reformats a user's 4-space or
 * minified config and leaves a diff behind after we have supposedly removed
 * ourselves. Key ORDER survives for free: we only add and delete the
 * `provider` key, and assigning an existing key keeps its position.
 */
function detectJsonStyle(text: string): JsonStyle {
  const indented = /\{\r?\n([ \t]+)/.exec(text);
  const multiline = /\r?\n/.test(text.trim());
  return {
    indent: indented ? indented[1]! : multiline ? 2 : "",
    trailingNewline: text.endsWith("\n"),
  };
}

const NEW_FILE_STYLE: JsonStyle = { indent: 2, trailingNewline: true };

function render(config: Record<string, unknown>, style: JsonStyle): string {
  const body = JSON.stringify(config, null, style.indent);
  return style.trailingNewline ? `${body}\n` : body;
}

export interface OpenCodeProviderSpec {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Record<string, { name: string }>;
  npm?: string;
}

export interface UpsertOptions {
  /** Replace an apiKey that is already there. The local-inject writer must
   *  not (the user's own key wins); the Flux connector must (a rotated
   *  `sk-flux-…` has to land, and the key is ours to begin with). */
  overwriteApiKey?: boolean;
  /** Throw instead of coercing when a key we are about to touch holds
   *  something other than an object. Off for local inject, which has always
   *  been lenient; on for the Flux connector, where "the user put something
   *  unexpected here" must stop the write, not silently replace it. */
  strict?: boolean;
}

/**
 * Merge one openai-compatible provider into a parsed opencode.json, in place.
 * Everything not named here — other providers, other top-level keys, an
 * existing `models` map — is left exactly as it was.
 */
export function upsertOpenCodeProvider(
  config: Record<string, unknown>,
  id: string,
  spec: OpenCodeProviderSpec,
  options: UpsertOptions = {},
): void {
  const rawProviders = config.provider;
  if (options.strict && rawProviders !== undefined && plainObject(rawProviders) === null) {
    throw new Error(`refusing to write: opencode.json "provider" is not an object`);
  }
  const providers = { ...(plainObject(rawProviders) ?? {}) };

  const rawPrevious = providers[id];
  if (options.strict && rawPrevious !== undefined && plainObject(rawPrevious) === null) {
    throw new Error(`refusing to write: opencode.json "provider.${id}" is not an object`);
  }
  const previous = plainObject(rawPrevious);
  const existing: Record<string, unknown> = previous
    ? { ...previous }
    : { npm: spec.npm ?? OPENCODE_COMPAT_NPM, name: spec.name, options: {}, models: {} };

  const rawOptions = existing.options;
  if (options.strict && rawOptions !== undefined && plainObject(rawOptions) === null) {
    throw new Error(`refusing to write: opencode.json "provider.${id}.options" is not an object`);
  }
  const providerOptions = { ...(plainObject(rawOptions) ?? {}) };
  providerOptions[BASE_URL_KEY] = spec.baseUrl;
  if (options.overwriteApiKey || !providerOptions.apiKey) providerOptions.apiKey = spec.apiKey;

  const rawModels = existing.models;
  if (options.strict && rawModels !== undefined && plainObject(rawModels) === null) {
    throw new Error(`refusing to write: opencode.json "provider.${id}.models" is not an object`);
  }
  const models = { ...(plainObject(rawModels) ?? {}) };
  // Never overwrite a models entry the user already shaped.
  for (const [modelId, model] of Object.entries(spec.models)) if (!models[modelId]) models[modelId] = model;

  providers[id] = {
    ...existing,
    npm: existing.npm || spec.npm || OPENCODE_COMPAT_NPM,
    name: existing.name || spec.name,
    options: providerOptions,
    models,
  };
  config.provider = providers;
}

/** Render one opencode.json from a parsed object, honouring the source file's
 *  formatting. Exported so the local-inject writer produces the same bytes. */
export function renderOpenCodeConfig(config: Record<string, unknown>, source: string | null): string {
  return render(config, source === null ? NEW_FILE_STYLE : detectJsonStyle(source));
}

function parseConfig(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`refusing to write: opencode.json is not valid JSON (${(error as Error).message})`);
  }
  const config = plainObject(parsed);
  if (!config) throw new Error("refusing to write: opencode.json is not a JSON object");
  return config;
}

/** The identifying line of our block, hashed into the receipt.
 *
 *  The apiKey is deliberately NOT in it (Wayland opencode.ts:64-67): rotating
 *  a Flux key must not read as the user having edited our provider. */
function managedSubject(baseUrl: string): string {
  return `provider.${OPENCODE_FLUX_PROVIDER}.options.${BASE_URL_KEY}=${baseUrl}`;
}

const FLUX_PROVIDER_MODELS: Record<string, { name: string }> = Object.fromEntries(
  FLUX_MODELS.map((tier) => [tier.id, { name: tier.label }]),
);

/**
 * The three text transforms the safety envelope drives. Only `write` needs the
 * key, which is why `openCodeFluxStatus` can classify the file without one.
 */
export function opencodeFluxPlan(key: string, baseUrl: string = FLUX_OPENAI_BASE): ConnectorPlan {
  return {
    read(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      const config = plainObject(parsed);
      const providers = config && plainObject(config.provider);
      const flux = providers && plainObject(providers[OPENCODE_FLUX_PROVIDER]);
      if (!flux) return null;
      const providerOptions = plainObject(flux.options) ?? {};
      const url = providerOptions[BASE_URL_KEY];
      return managedSubject(typeof url === "string" ? url : "");
    },

    write(text) {
      const config = text === null ? { $schema: "https://opencode.ai/config.json" } : parseConfig(text);
      upsertOpenCodeProvider(
        config,
        OPENCODE_FLUX_PROVIDER,
        {
          name: "Flux Router",
          npm: OPENCODE_COMPAT_NPM,
          baseUrl,
          apiKey: key,
          models: FLUX_PROVIDER_MODELS,
        },
        { overwriteApiKey: true, strict: true },
      );
      return { text: renderOpenCodeConfig(config, text), managedSubject: managedSubject(baseUrl) };
    },

    strip(text) {
      const config = parseConfig(text);
      const providers = plainObject(config.provider);
      if (!providers || !(OPENCODE_FLUX_PROVIDER in providers)) return null;
      const next = { ...providers };
      delete next[OPENCODE_FLUX_PROVIDER];
      // An empty `provider` map is not what was there before us. Dropping the
      // key entirely is what makes connect→disconnect byte-identical for a
      // config that never had a `provider` section.
      if (Object.keys(next).length === 0) delete config.provider;
      else config.provider = next;
      return renderOpenCodeConfig(config, text);
    },
  };
}

/** Classify the user's opencode.json without touching it. */
export function openCodeFluxStatus(env: Record<string, string | undefined> = process.env): ConnectorStatus {
  return connectorStatus(opencodeConnectorPaths(env), OPENCODE_CONNECTOR_TOOL, opencodeFluxPlan(""));
}

/** True only in the one state that may offer Flux rows: our block is present
 *  and still ours. `absent`, `unconfigured` and `drifted` all fail closed. */
export function openCodeFluxRouted(env: Record<string, string | undefined> = process.env): boolean {
  return openCodeFluxStatus(env).state === "routed";
}

export interface ConnectOpenCodeOptions {
  /** The `sk-flux-…` key, from `fluxKey()`. Never read off a child env. */
  key: string;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  /** Post-write live probe. Without one, this reports success on a route
   *  nobody has confirmed. */
  verify?: () => Promise<boolean>;
  /** Only ever true when a human has been shown the drift and said yes. */
  force?: boolean;
}

/**
 * Write `provider.flux` into the user's opencode.json.
 *
 * NEVER called from a spawn path. This is the deliberate, user-initiated
 * action; the whole point of the capability split is that an engine which
 * needs a file written is `setup`-class and stays unrouted until someone asks.
 */
export async function connectOpenCodeFlux(options: ConnectOpenCodeOptions): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? FLUX_OPENAI_BASE;
  return await installConnector({
    paths: opencodeConnectorPaths(env),
    tool: OPENCODE_CONNECTOR_TOOL,
    plan: opencodeFluxPlan(options.key, baseUrl),
    baseUrl,
    verify: options.verify,
    force: options.force,
  });
}

/** Remove `provider.flux` and nothing else. */
export async function disconnectOpenCodeFlux(
  options: { env?: Record<string, string | undefined> } = {},
): Promise<RemoveResult> {
  const env = options.env ?? process.env;
  return await removeConnector({
    paths: opencodeConnectorPaths(env),
    tool: OPENCODE_CONNECTOR_TOOL,
    plan: opencodeFluxPlan(""),
  });
}

/** The CLI-native id for a Flux tier on OpenCode. OpenCode addresses models as
 *  `<provider>/<model>`, so the bare picker id `flux-auto` would be read as a
 *  malformed slug and rejected before it reached the provider. */
export function opencodeFluxModelId(tier: string): string {
  return `${OPENCODE_FLUX_PROVIDER}/${tier}`;
}
