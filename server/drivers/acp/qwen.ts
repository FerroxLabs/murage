// Qwen Code — Alibaba's `qwen --acp` CLI. Custom-only in Murage:
// the official pane has no Qwen Cloud catalog; live local hosts land in
// Custom and are written into ~/.qwen/settings.json modelProviders.
//
// FLUX ROUTING IS ENV-ONLY, AND NOTHING BELOW MAY WRITE THE KEY TO DISK.
// `ensureQwenInjectModel` upserts the provider key in PLAINTEXT into
// ~/.qwen/settings.json (the `env[keyName]` entry and the final
// `writeFileSync` in ensureQwenInjectModel)
// with no rollback — it survives turning Flux off, uninstalling the bot, and
// changing the model. That is Kimi finding B
// (docs/plans/flux-router-integration.md), and it is why a Flux id short-
// circuits `resolveTurnModel` below instead of falling through to the writer.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { fluxKey } from "../../flux-config.ts";
import { applyFluxSurface, isFluxModel } from "../../flux-routing.ts";
import { mergeFluxCatalog } from "../../flux-surface.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject, type LocalHost } from "../local-inject.ts";
import { displayConfigPath, isPlainObject, NativeConfigRefusal, readNativeJsonConfig } from "../native-config-file.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function qwenHome(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".qwen");
}

function envKeyFor(hostId: string): string {
  return `MURAGE_QWEN_${hostId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Upsert an OpenAI-compatible provider row so `qwen -m` can reach the host.
 *
 * An existing settings.json that cannot be read, is not a plain JSON object
 * (Qwen Code also accepts comments there, which a rewrite would delete), or
 * holds an unexpected `env` / `modelProviders` shape is REFUSED: this throws a
 * NativeConfigRefusal with repair guidance before anything is written, so the
 * file keeps its bytes and the turn fails before the CLI is spawned (0.1.52
 * A8). An absent file is created. */
export function ensureQwenInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const home = env.HOME || env.USERPROFILE || homedir();
  const dir = qwenHome(env);
  const path = join(dir, "settings.json");
  const settings: Record<string, unknown> = readNativeJsonConfig(path, home)?.value ?? {};
  const refuse = (field: string) => new NativeConfigRefusal(displayConfigPath(path, home), "unexpected-shape", field);
  if (settings.env !== undefined && !isPlainObject(settings.env)) throw refuse("env");
  if (settings.modelProviders !== undefined && !isPlainObject(settings.modelProviders)) throw refuse("modelProviders");
  const providers: Record<string, unknown> = { ...(settings.modelProviders as Record<string, unknown> | undefined) };
  if (providers.openai !== undefined && !Array.isArray(providers.openai)) throw refuse("modelProviders.openai");

  const keyName = envKeyFor(inject.host);
  const key = hostApiKey(host, env);
  settings.env = { ...(settings.env as Record<string, unknown> | undefined), [keyName]: key };

  const openai = Array.isArray(providers.openai) ? [...providers.openai] : [];
  const match = openai.find(
    (row) =>
      row &&
      typeof row === "object" &&
      (row as { id?: unknown }).id === inject.model &&
      (row as { baseUrl?: unknown }).baseUrl === host.baseUrl,
  );
  if (!match) {
    openai.push({
      id: inject.model,
      name: `${inject.model} (${host.label})`,
      baseUrl: host.baseUrl,
      envKey: keyName,
    });
    providers.openai = openai;
    settings.modelProviders = providers;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return inject.model;
}

/** Spec A3: drop the provider row and key Murage wrote for a removed server. */
export function removeQwenLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = join(qwenHome(env), "settings.json");
  const existing = readNativeJsonConfig(path, home);
  if (!existing) return "absent";
  const settings: Record<string, unknown> = { ...existing.value };
  const keyName = envKeyFor(host.id);
  let changed = false;
  if (isPlainObject(settings.env) && Object.hasOwn(settings.env, keyName)) {
    const nextEnv = { ...settings.env };
    delete nextEnv[keyName];
    settings.env = nextEnv;
    changed = true;
  }
  if (isPlainObject(settings.modelProviders) && Array.isArray(settings.modelProviders.openai)) {
    const rows = settings.modelProviders.openai as unknown[];
    const kept = rows.filter((row) => !(isPlainObject(row) && row.baseUrl === host.baseUrl && row.envKey === keyName));
    if (kept.length !== rows.length) {
      settings.modelProviders = { ...settings.modelProviders, openai: kept };
      changed = true;
    }
  }
  if (!changed) return "absent";
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return "removed";
}

const DRIVER_KIND = "qwenAgent";

/**
 * Will this turn actually be routed at Flux?
 *
 * This has to mirror `applyFluxSurface`'s own gate exactly — Flux surface for
 * this engine (constant for qwen), a Flux model id, and a non-empty key — and
 * it exists because `spawnArgs` (core.ts:330) is handed only the turn, never
 * the env, so it cannot see the `applied` flag `applyTurnEnv` got back one
 * line earlier at core.ts:323. Deriving both from the same predicate is what
 * keeps argv and env from disagreeing: `--auth-type openai` on a turn whose
 * OPENAI_* vars were never written forces qwen onto a provider it has no
 * credentials for, which is strictly worse than the native fallback.
 */
function fluxRouted(model: string | null | undefined): boolean {
  return isFluxModel(model) && fluxKey() !== null;
}

async function resolveModels(env: Record<string, string | undefined>): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(EMPTY, env);
  // Qwen has no official catalog, so its default is whatever came first. Flux
  // rows are added after that is settled: they lead the list, but they only
  // become the default when there is nothing else at all.
  return mergeFluxCatalog({ default: catalog.options[0]?.id ?? "", options: catalog.options }, DRIVER_KIND);
}

const support: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "Qwen",
  access: "custom",
  models: EMPTY,
  resolveModels,
  // A Flux id must never reach `ensureQwenInjectModel` — see the file header.
  // `decodeInjectId` already returns null for `flux-*` so the writer would
  // early-return and touch nothing, but the guard is explicit rather
  // than a property of another module: a settings.json write is unrecoverable.
  //
  // The id is also settled HERE and not in `applyTurnEnv`, because argv is
  // built from this return value (core.ts:330 → spawnArgs) one step before
  // applyTurnEnv runs (core.ts:323), and applyTurnEnv cannot change argv.
  // Returning the bare alias is correct: `qwen -m <id>` does NOT require a
  // ~/.qwen modelProviders row — see the note on `applyTurnEnv`.
  resolveTurnModel: (model, env) => {
    if (isFluxModel(model)) return model;
    return model ? ensureQwenInjectModel(model, env) : model;
  },
  defaultCli: "qwen",
  nativeSource: "qwen.acp",
  loginNote: "Qwen Code CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      win32: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    },
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview/",
  },
  // `--auth-type openai` is required, not belt-and-braces. qwen picks its auth
  // type as `argv.authType || settings.security.auth.selectedType ||
  // getAuthTypeFromEnv()` (qwen-code 0.15.6 cli.js, packages/cli/src/config),
  // so a saved `selectedType` OUTRANKS the OPENAI_* env we just wrote. On an
  // install signed in with Qwen OAuth, a Flux turn without this flag dies with
  // "Qwen OAuth credentials expired" and never reaches api.fluxrouter.ai —
  // reproduced live against a real `qwen --acp` on 2026-09-01. Only for a Flux
  // turn: a native turn must keep obeying the user's own saved auth type.
  spawnArgs: (_config, turn) => [
    "--acp",
    ...(fluxRouted(turn.model) ? ["--auth-type", "openai"] : []),
    ...(turn.model ? ["-m", turn.model] : []),
  ],
  /**
   * Point the child at Flux's OpenAI chat-completions surface (spec §4.3).
   *
   * `applyTurnEnv`, not `transformEnv`: transformEnv (core.ts:213) is shared by
   * catalog refresh (core.ts:220) and snapshot, which must not see a per-turn
   * overlay, and it runs before the turn model is known. This hook runs at
   * core.ts:323 — after the routing strip (core.ts:212) and after the model is
   * resolved — so it can decide native-vs-Flux per turn and re-write the very
   * vars the strip removed. Same shape kimi (kimi.ts:540) and droid
   * (droid.ts:254) already use.
   *
   * The key comes from `fluxKey()` (config/`process.env`) and never off `env`:
   * `FLUX_API_KEY` is a workspace credential (config.ts:551) that the core's
   * allowlist loop (core.ts:204-205) has already deleted from this object.
   * That is also why `"FLUX_API_KEY"` is deliberately absent from a
   * `credentialEnv` allowlist here — granting it would put the raw workspace
   * key in every qwen child, including catalog and snapshot spawns.
   *
   * `applyFluxSurface` writes OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL.
   * All three are load-bearing on qwen, OPENAI_MODEL included: qwen infers the
   * OpenAI auth type only when all three are present, so dropping it fails the
   * turn with "No auth type is selected" (verified live, qwen 0.15.6).
   *
   * RESOLVED (the spec's §4.3 open question): `-m <model>` is resolved against
   * OPENAI_BASE_URL, NOT against ~/.qwen modelProviders. In qwen's
   * `resolveCliGenerationConfig`, `argv.model` is taken verbatim as the model
   * id and modelProviders is only an OPTIONAL overlay looked up by
   * `providers.find(p => p.id === resolvedModel)`; with no matching row the
   * baseUrl/apiKey layers fall through to OPENAI_BASE_URL / OPENAI_API_KEY.
   * Proven live: `qwen --acp -m flux-auto` on a HOME with no ~/.qwen at all,
   * env-only, returned a real answer from Flux. So no settings.json row is
   * needed and none is written.
   */
  applyTurnEnv: (env, { model, requestedModel }) => {
    applyFluxSurface(DRIVER_KIND, env, model ?? requestedModel, fluxKey());
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenAgentDriver = createAcpDriver(support);
