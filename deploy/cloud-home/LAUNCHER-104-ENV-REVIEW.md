# 104 launcher: FUIGO_CONFIG / OPENCODE_CONFIG_CONTENT secret review (not committed)
Base 1e52e11c5. Reviewer: MurageMain's Fable. Launcher edits: deploy/cloud-home/murage-turn-launch.py.

## What the drivers put in each var
- FUIGO_CONFIG (fuigo.ts, binary-matched; call at ~:624 `env.FUIGO_CONFIG = fuigoConfigOverlay(decision.headers, env.FUIGO_CONFIG)`).
  Builder server/flux-memory-headers.ts:482-494. Output: `{...existing, models:{...models, extra_headers:{<non-x-flux-memory entries kept>, ...headers}}}`.
  Grok has the same builder into GROK_CONFIG (server/drivers/acp/grok.ts:466-468), see "Off audit text".
- OPENCODE_CONFIG_CONTENT (server/drivers/acp/opencode-go.ts:650-658, builder flux-memory-headers.ts:510-524).
  Output: `{...existing, provider:{...providers, flux:{...entry, options:{...options, headers:{<kept>, ...headers}}}}}`.
  A second writer, opencode-go.ts:477-492 (isolateOpenCodeFromPersonalSetup), adds `mcp:{<owner server name>:{...,enabled:false}}`.
- `headers` = decision.headers, flux-memory-headers.ts:294-304: only x-flux-memory-app=murage, x-flux-memory-capture=off,
  x-flux-memory-inject=off, x-flux-memory-space=<id>, x-flux-memory-read=<ids joined by ,>. Names enforced by
  assertNoForbiddenFluxHeaders (flux-memory-headers.ts:44-56). space/read are Murage space ids (not credentials).

## Could either carry a key or token?
- Built by the drivers from an empty `existing` on a Cloud home, neither carries one: the Flux key travels separately as
  FUIGO_API_KEY / OPENCODE_API_KEY, both already in ENGINE_ENV_ALLOW (launcher ~2037-2038 at base; credential model unchanged).
- BUT both builders spread `...existing`/`...entry`/`...options` unchanged, so the var is only as clean as what the server
  fed in. A value built from a polluted base (provider apiKey, baseURL, plugin list, mcp command, instructions path) would
  reach the engine. The launcher therefore does NOT pass these blindly.

## Decision: validate the shape, fail closed (launcher ENGINE_ENV_VALUE, ~2101)
- `fuigo_config_value`: JSON object, keys exactly {models}; models exactly {extra_headers}; extra_headers only the five
  x-flux-memory-* names (lower-case, exact), x-flux-memory-app required and == "murage", capture/inject == "off" only,
  space/read printable ASCII 1..1024. Anything else (apiKey, base_url, Authorization header, forbidden -scope/-required) refuses the turn (see below).
- `opencode_config_value`: top-level keys subset of {provider, mcp}; provider exactly {flux:{options:{headers}}} with the same
  header rules; mcp optional, each entry exactly {"enabled": false} (only narrows, so the isolation writer still works).
- Both: duplicate JSON keys rejected, 8192-byte cap, non-JSON (a file path) rejected. The var is allowed only for its own engine; for any other engine it is dropped and logged in `dropped`
  like any unlisted env (values never printed). Per-engine only: keyed by (engine, name) in ENGINE_ENV_VALUE.
- The two names contain CONFIG, which PATH_NAME_SHAPE (~2077) forbids at load; check_env_allowlist exempts exactly the
  (engine, name) pairs that have a value check. A path value cannot pass the check (must parse as that JSON object).
- Consequence to know: if the server ever puts a legitimate extra key in these vars on a Cloud home (e.g. a second flux
  provider option), the turn is refused (Fable follow-up 2: engine_environment raises Refusal "<NAME> is malformed", naming the var, never the value) rather than run without the memory headers. An absent var still runs: the driver decided no overlay. The drift test
  (server/cloud-home/launcher-driver-drift.test.ts) feeds the real fuigoConfigOverlay/opencodeConfigOverlay output through
  the validators so a builder change that adds keys fails CI.

## GROK_CONFIG (follow-up commit)
- Contents: grok.ts applyGrokFluxMemory (called by support.applyFluxMemory) sets `env.GROK_CONFIG = fuigoConfigOverlay(headers, env.GROK_CONFIG)`;
  headless-text-only.ts:265 builds it the same way. Output is the FUIGO_CONFIG document: `{models:{extra_headers:{x-flux-memory-*}}}`.
- Secret verdict: none. Grok runs on its own grok.com login in $GROK_HOME/auth.json (launcher state allowlist), never an env key; the
  document carries only the five memory headers (app=murage, capture/inject=off, Murage space ids).
- Launcher: GROK_CONFIG added to grokAgent ENGINE_ENV_ALLOW, validated by the same fuigo_config_value, keyed ("grokAgent","GROK_CONFIG");
  the CONFIG-name exemption is limited to that (engine, name) pair. Dropped for every other engine.
- Header value rules now follow the builder exactly (flux-memory-headers.ts SPACE_CHARSET, FLUX_READ_LIMIT): space = [A-Za-z0-9._:#-]{1,128},
  read = up to 8 of those joined by ",". A non-owner turn emits app + capture=off + inject=off (no space/read); an owner turn emits app, off
  headers only for gates that close, and space/read when spaces are on. All accepted (drift test "per audience").

## Grok argv (follow-up commit)
- Image installs Grok 1.0.52 (build-image.sh grok_version), so grokIsolationArgs emits `--no-leader` plus `--plugin-dir <stub>` per personal plugin.
- Rule adds `--no-leader` and a repeatable `--plugin-dir` accepting only `/tmp/murage-grok-isolation-<6 alnum>/<plugin name>` (grok.ts grokPluginStub);
  no `..`, one level. The stub is in the server's tmpdir, so a turn sandbox may not see it; accepted for fail-closed parity.

## Fable follow-ups (this commit)
- (1) grokAgent now requires --no-memory and --no-leader. spawnArgs emits --no-memory unconditionally (grok.ts:443); --no-leader comes from
  grokIsolationArgs, which fails open on unknown/<1.0 versions (grok.ts:373-376), BUT Grok's applyMountEnv = scopeGrokHome
  (grok.ts:479, grok-scope.ts:283) throws on an unknown or <1.0.50 CLI before any spawn (core.ts:2137-2166; spawnNeedsCliVersion and scopeKind set),
  so spawnArgs never runs on a version where --no-leader is absent. Image pins 1.0.52. Driver unchanged.
- (2) a present-but-malformed FUIGO_CONFIG / GROK_CONFIG / OPENCODE_CONFIG_CONTENT refuses the turn; absent stays allowed.
- (3) drift test runs the real isolateOpenCodeFromPersonalSetup output (acp/opencode-go.ts:480) through opencode_config_value.
- opencode_config_value now also accepts {"mcp": {name: {"enabled": false}}} without a provider block (the isolation writer emits that when no overlay exists); still needs a provider or a non-empty mcp.
