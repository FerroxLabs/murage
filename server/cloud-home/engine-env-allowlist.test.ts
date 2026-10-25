// SPDX-License-Identifier: AGPL-3.0-or-later
// The launcher builds each Cloud engine's environment from an explicit allowlist
// (lanes/release102/ENGINES-ENV-ALLOWLIST-DESIGN.md): every home, config, cache and XDG
// path is pinned by the launcher, each engine gets exactly the names it needs, and
// every other request variable is dropped. Astra r3 found XDG_CONFIG_HOME and
// OPENCODE_TEST_HOME surviving the old strip list, which let a request point OpenCode
// 1.19.0 at a writable config directory where it installs packages and imports tool
// files regardless of OPENCODE_PURE. These tests drive the real Python.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINIMAL_ARGV, fixtureEngineBytes } from "./engine-launch-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const ENGINES = ["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo"] as const;
const CONFIG_VAR: Record<string, string> = { claudeAgent: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grokAgent: "GROK_HOME", kimiAgent: "KIMI_CODE_HOME", opencodeGo: "OPENCODE_CONFIG_DIR" };
// Validate the request, then stage the turn's mounts exactly as launch() does.
const harness = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request=json.loads(sys.argv[2])
engine,home,cwd,command,args,env,render,bot=module.validate_request(request,manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=sys.argv[4],cache_root=sys.argv[5])
argv,blobs=module.turn_mount_args(engine,([("/fixture/anchor/cwd",cwd)] if cwd!=home else []),home,cwd,command,args,render,request.get("scratch",[]))
staged=[argv[i+2] for i,a in enumerate(argv) if a=="--ro-bind-data"]
config=[p[len(home)+1:] for p,_,_ in module.render_plan(engine,home,cwd,render,module.scratch_paths(engine,home,request.get("scratch",[])))[0] if p.startswith(home+"/")]
print(json.dumps({"env":env,"configPaths":config,"staged":staged}))`;
const shape = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
names=json.loads(sys.argv[2])
try:
    module.check_env_allowlist({"fixture":frozenset({"EVIL_CONFIG_DIR"})});refused=False
except ValueError:
    refused=True
print(json.dumps({"refused":refused,"matched":[n for n in names if module.PATH_NAME_SHAPE.search(n)],"allowed":sorted(set().union(module.COMMON_ENV,*module.ENGINE_ENV_ALLOW.values()))}))`;
const login = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request={"mode":"login","engine":sys.argv[2],"action":"login"}
if sys.argv[2]!="claudeAgent": request["bot"]="fixture-bot"  # B sign-ins name their bot (r9)
turn=module.validate_login_request(request,engine_root=sys.argv[4])
turn["command"]=sys.argv[6]
turn["env"]["XDG_CONFIG_HOME"]=turn["cwd"]+"/tmp/xdg"
result=module.validate_request(turn,manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=sys.argv[4],cache_root=sys.argv[5],login=True)
print(json.dumps({"env":result[5]}))`;

let root: string, engineRoot: string, command: string, manifest: string;
const home = (engine: string) => join(engineRoot, engine);
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".murage-env-allowlist-")); engineRoot = join(root, "engine-homes");
  for (const engine of [...ENGINES, "fuigoAgent"]) mkdirSync(home(engine), { recursive: true });
  mkdirSync(join(root, "bin")); command = join(root, "bin", "fixture-engine"); const bytes = fixtureEngineBytes();
  writeFileSync(command, bytes, { mode: 0o755 }); const sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest = join(root, "engine-manifest.json");
  writeFileSync(manifest, JSON.stringify(Object.fromEntries([...ENGINES, "fuigoAgent"].map(engine => [engine, [{ path: command, sha256 }]]))), { mode: 0o644 });
});
afterEach(() => removeTempDirSync(root));

// Every path override Astra and the engine sources name, all pointed at a writable place.
function hostile(h: string): Record<string, string> {
  const evil = `${h}/tmp/evil`;
  return {
    XDG_CONFIG_HOME: `${evil}/xdg`, XDG_CACHE_HOME: `${evil}/cache`, XDG_DATA_HOME: `${evil}/data`, XDG_STATE_HOME: `${evil}/state`,
    OPENCODE_TEST_HOME: evil, OPENCODE_CONFIG_DIR: `${evil}/occonf`, OPENCODE_CONFIG: `${evil}/occonf/opencode.json`, OPENCODE_PURE: "0",
    CODEX_HOME: `${evil}/codex`, CLAUDE_CONFIG_DIR: `${evil}/claude`, CLAUDE_CODE_PLUGIN_DIRS: `${evil}/plugins`, CLAUDE_ENV_FILE: `${evil}/env`, CLAUDE_CODE_TMPDIR: evil,
    GROK_HOME: `${evil}/grok`, GROK_AUTH_PATH: `${evil}/auth.json`, GROK_CONFIG_PATH: `${evil}/config.toml`, GROK_DISABLE_AUTOUPDATER: "0",
    KIMI_CODE_HOME: `${evil}/kimi`, KIMI_SHARE_DIR: `${evil}/share`, KIMI_PLUGIN_ROOT: `${evil}/plugins`, KIMI_CODE_NO_AUTO_UPDATE: "0",
    FUIGO_HOME: `${evil}/fuigo`, EVIL_CONFIG_DIR: evil, HOME: evil, USERPROFILE: evil, TMPDIR: evil, PATH: `${evil}/bin`,
    LD_PRELOAD: `${evil}/x.so`, NODE_OPTIONS: "--require /fixture/loader.js", MURAGE_CLOUD_TURN_FILES: "{}",
  };
}
const HOSTILE_NAMES = Object.keys(hostile("/fixture/home"));
function run(request: object): { env: Record<string, string>; configPaths: string[]; staged: string[] } {
  return JSON.parse(execFileSync("python3", ["-I", "-c", harness, launcher, JSON.stringify(request), manifest, engineRoot, join(root, "digest-cache")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
function request(engine: string, env: Record<string, string>, extra: object = {}) {
  return { engine, bot: "fixture-bot", command, args: MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV], cwd: home(engine), env, ...extra };
}

describe.each(ENGINES)("%s", engine => {
  it("pins every home, config and XDG path itself and drops the request's", () => {
    const h = home(engine);
    const { env } = run(request(engine, { ...hostile(h), LANG: "C.UTF-8", TERM: "xterm-256color" }));
    expect(env).toMatchObject({ HOME: h, USERPROFILE: h, TMPDIR: `${h}/tmp`, PATH: "/opt/murage/bin:/usr/local/bin:/usr/bin:/bin",
      XDG_CONFIG_HOME: `${h}/.config`, XDG_CACHE_HOME: `${h}/.cache`, XDG_DATA_HOME: `${h}/.local/share`, XDG_STATE_HOME: `${h}/.local/state`, LANG: "C.UTF-8", TERM: "xterm-256color" });
    const pinned: Record<string, Record<string, string>> = {
      claudeAgent: { CLAUDE_CONFIG_DIR: `${h}/.claude`, DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      codex: { CODEX_HOME: `${h}/.codex` },
      grokAgent: { GROK_HOME: `${h}/.grok`, GROK_DISABLE_AUTOUPDATER: "1" },
      kimiAgent: { KIMI_CODE_HOME: `${h}/.kimi-code`, KIMI_CODE_NO_AUTO_UPDATE: "1" },
      opencodeGo: { OPENCODE_CONFIG: `${h}/.config/opencode/opencode.json`, OPENCODE_CONFIG_DIR: `${h}/.config/opencode`, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PURE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1" },
    };
    expect(env).toMatchObject(pinned[engine]);
    // Nothing the request named survives unless it was pinned to the launcher's value.
    for (const name of HOSTILE_NAMES) if (!(name in pinned[engine]) && !["HOME", "USERPROFILE", "TMPDIR", "PATH"].includes(name) && !name.startsWith("XDG_")) expect(env, name).not.toHaveProperty(name);
    for (const name of Object.keys(env)) expect(env[name], name).not.toContain("/tmp/evil");
    // The other engines' homes never ride along.
    for (const other of ENGINES) if (other !== engine) expect(env).not.toHaveProperty(CONFIG_VAR[other]);
  });

  it("starts with its managed config read-only at the pinned location", () => {
    const h = home(engine);
    const { env, configPaths, staged } = run(request(engine, hostile(h)));
    expect(configPaths.length).toBeGreaterThan(0);
    const managed = `${h}/${configPaths[0]}`;
    expect(env[CONFIG_VAR[engine]]).toBe(dirname(managed));
    if (engine === "opencodeGo") expect(env.OPENCODE_CONFIG).toBe(managed);
    for (const path of configPaths) expect(staged).toContain(`${h}/${path}`);
  });
});

it("keeps each engine's own credentials and runtime settings, nothing else", () => {
  const common = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "America/Chicago", TERM: "xterm-256color" };
  const claude = run(request("claudeAgent", { ...common, ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://fixture.example/v1", ANTHROPIC_MODEL: "claude-sonnet-5", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000", OPENAI_API_KEY: "fixture-foreign", NPM_CONFIG_LOGLEVEL: "error" })).env;
  expect(claude).toMatchObject({ ...common, ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://fixture.example/v1", ANTHROPIC_MODEL: "claude-sonnet-5", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
  expect(claude).not.toHaveProperty("OPENAI_API_KEY"); expect(claude).not.toHaveProperty("NPM_CONFIG_LOGLEVEL");
  const codex = run(request("codex", { OPENAI_BASE_URL: "http://127.0.0.1:8080/v1", OPENAI_MODEL: "fixture", MURAGE_PROVIDER_API_KEY: "fixture-key", ANTHROPIC_API_KEY: "fixture-foreign" })).env;
  expect(codex).toMatchObject({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1", OPENAI_MODEL: "fixture", MURAGE_PROVIDER_API_KEY: "fixture-key" }); expect(codex).not.toHaveProperty("ANTHROPIC_API_KEY");
  const kimi = run(request("kimiAgent", { KIMI_MODEL_NAME: "fixture", KIMI_MODEL_API_KEY: "fixture-key", MOONSHOT_API_KEY: "fixture-foreign" })).env;
  expect(kimi).toMatchObject({ KIMI_MODEL_NAME: "fixture", KIMI_MODEL_API_KEY: "fixture-key" }); expect(kimi).not.toHaveProperty("MOONSHOT_API_KEY");
  // OPENCODE_AUTH_CONTENT is the launcher's own (the C store's api entries plus the route), never the request's;
  // with neither it is unset, so OpenCode reads the bot's staged auth.json (r9 "OpenCode").
  const opencode = run(request("opencodeGo", { OPENCODE_API_KEY: "fixture-key", OPENCODE_AUTH_CONTENT: '{"evil":{"type":"wellknown"}}' })).env;
  expect(opencode.OPENCODE_API_KEY).toBe("fixture-key"); expect(opencode).not.toHaveProperty("OPENCODE_AUTH_CONTENT");
  // Grok runs on its own login: no request variable beyond the common set reaches it.
  const grok = run(request("grokAgent", { ...common, XAI_API_KEY: "fixture-foreign", GROK_MODELS_BASE_URL: "https://fixture.example" })).env;
  expect(grok).toMatchObject(common); expect(grok).not.toHaveProperty("XAI_API_KEY"); expect(grok).not.toHaveProperty("GROK_MODELS_BASE_URL");
});

it("drops a path-shaped value in an allowed non-credential variable", () => {
  const env = run(request("claudeAgent", { TZ: ":/fixture/zone", LANG: "/fixture/lang", TERM: "../evil", ANTHROPIC_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "/looks/like/a/path" })).env;
  for (const name of ["TZ", "LANG", "TERM"]) expect(env).not.toHaveProperty(name);
  expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  expect(env.ANTHROPIC_API_KEY).toBe("/looks/like/a/path");
});

// OPENCODE_CONFIG_CONTENT and FUIGO_CONFIG are the two deliberate exceptions (1.0.4 audit 11-2): allowed only through a value shape check
// (ENGINE_ENV_VALUE), tested in "Flux memory header overlays" below.
it("refuses a path-shaped name in the allowlist at load and the shape covers every known override", () => {
  const names = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_TEST_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_DIRS", "CLAUDE_ENV_FILE", "CLAUDE_CODE_TMPDIR", "GROK_HOME", "GROK_AUTH_PATH", "GROK_CONFIG_PATH", "GROK_TEST_PROMPT_BLACKHOLE", "KIMI_CODE_HOME", "KIMI_SHARE_DIR", "KIMI_PLUGIN_ROOT", "FUIGO_HOME", "EVIL_CONFIG_DIR", "HOME", "PATH", "TMPDIR"];
  const result = JSON.parse(execFileSync("python3", ["-I", "-c", shape, launcher, JSON.stringify(names)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  expect(result.refused).toBe(true);
  expect(result.matched).toEqual(names);
  for (const name of result.allowed) expect(names, name).not.toContain(name);
});

it("logs dropped names to stderr without their values", () => {
  const input = request("claudeAgent", { EVIL_CONFIG_DIR: "/fixture/secret-value", LANG: "C.UTF-8" });
  const child = spawnSync("python3", ["-I", "-c", harness, launcher, JSON.stringify(input), manifest, engineRoot, join(root, "digest-cache")], { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(child.stderr).toContain("Cloud turn environment dropped: EVIL_CONFIG_DIR");
  expect(child.stderr).not.toContain("secret-value");
});

it("gives a routed Fuigo turn the launcher's own scratch home, never the request's", () => {
  const h = home("fuigoAgent"); const relative = "native/provider-turns/fuigoAgent-0123456789ab";
  const env = { FUIGO_HOME: `${h}/tmp/evil`, FUIGO_API_KEY: "fixture-key", FUIGO_API_BASE_URL: "https://fixture.example/v1", FUIGO_CLAUDE_MCPS_ENABLED: "0", XDG_CONFIG_HOME: `${h}/tmp/evil` };
  const routed = run(request("fuigoAgent", env, { scratch: [relative] })).env;
  expect(routed).toMatchObject({ FUIGO_HOME: `${h}/${relative}`, FUIGO_API_KEY: "fixture-key", FUIGO_API_BASE_URL: "https://fixture.example/v1", FUIGO_CLAUDE_MCPS_ENABLED: "0", XDG_CONFIG_HOME: `${h}/.config` });
  // The 19 compat gates are pinned to "0" (CLOUD-ENGINES-DESIGN.md 5.1): a request "1" is ignored.
  expect(run(request("fuigoAgent", { FUIGO_CLAUDE_MCPS_ENABLED: "1", FUIGO_CODEX_HOOKS_ENABLED: "1" })).env).toMatchObject({ FUIGO_CLAUDE_MCPS_ENABLED: "0", FUIGO_CODEX_HOOKS_ENABLED: "0", FUIGO_AGENTS_SKILLS_ENABLED: "0" });
  expect(run(request("fuigoAgent", env)).env.FUIGO_HOME).toBe(`${h}/.fuigo`);
});

it.each(["codex", "claudeAgent", "grokAgent", "kimiAgent"])("keeps a %s sign-in on its pinned home", engine => {
  const h = home(engine);
  const { env } = JSON.parse(execFileSync("python3", ["-I", "-c", login, launcher, engine, manifest, engineRoot, join(root, "digest-cache"), command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  expect(env).toMatchObject({ [CONFIG_VAR[engine]]: `${h}/${{ codex: ".codex", claudeAgent: ".claude", grokAgent: ".grok", kimiAgent: ".kimi-code" }[engine]}`, XDG_CONFIG_HOME: `${h}/.config`, LANG: "C.UTF-8", TERM: "xterm-256color" });
});

// 1.0.4 audit 11-2: the Flux memory headers ride FUIGO_CONFIG (Fuigo) and OPENCODE_CONFIG_CONTENT (OpenCode) as
// an inline JSON overlay (flux-memory-headers.ts fuigoConfigOverlay / opencodeConfigOverlay). Each is passed for
// its own engine only and only when its value is exactly that shape; anything that could carry more is dropped.
describe("Flux memory header overlays (11-2)", () => {
  const headers = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };
  const fuigo = JSON.stringify({ models: { extra_headers: headers } });
  const opencode = JSON.stringify({ provider: { flux: { options: { headers } } } });
  const opencodeMcp = JSON.stringify({ provider: { flux: { options: { headers: { ...headers, "x-flux-memory-read": "a1,b2" } } } }, mcp: { composio: { enabled: false } } });
  const envOf = (engine: string, env: Record<string, string>) => run(request(engine, env)).env;

  it("passes each overlay for its own engine and drops it for every other", () => {
    expect(envOf("fuigoAgent", { FUIGO_CONFIG: fuigo }).FUIGO_CONFIG).toBe(fuigo);
    expect(envOf("opencodeGo", { OPENCODE_CONFIG_CONTENT: opencode }).OPENCODE_CONFIG_CONTENT).toBe(opencode);
    expect(envOf("opencodeGo", { OPENCODE_CONFIG_CONTENT: opencodeMcp }).OPENCODE_CONFIG_CONTENT).toBe(opencodeMcp);
    for (const engine of ENGINES) {
      if (engine !== "opencodeGo") expect(envOf(engine, { OPENCODE_CONFIG_CONTENT: opencode, FUIGO_CONFIG: fuigo }), engine).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
      expect(envOf(engine, { FUIGO_CONFIG: fuigo }), engine).not.toHaveProperty("FUIGO_CONFIG");
    }
    expect(envOf("fuigoAgent", { OPENCODE_CONFIG_CONTENT: opencode })).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    // A shape for one engine is not the other's.
    // (refused, not dropped: see "refuses the turn" below)
    expect(refusal("fuigoAgent", "FUIGO_CONFIG", opencode).status).not.toBe(0);
    expect(refusal("opencodeGo", "OPENCODE_CONFIG_CONTENT", fuigo).status).not.toBe(0);
  });

  // Fable follow-up 2: a config var that is present but malformed refuses the turn (the driver meant an overlay;
  // dropping it would silently lose the memory opt-out). The refusal names the var, never the value.
  const refusal = (engine: string, name: string, value: string) =>
    spawnSync("python3", ["-I", "-c", harness, launcher, JSON.stringify(request(engine, { [name]: value })), manifest, engineRoot, join(root, "digest-cache")], { encoding: "utf8" });
  it.each([["fuigoAgent", "FUIGO_CONFIG"], ["grokAgent", "GROK_CONFIG"], ["opencodeGo", "OPENCODE_CONFIG_CONTENT"]])("%s refuses a malformed %s without echoing it", (engine, name) => {
    const secret = "sk-fixture-leak-check";
    for (const value of ["/fixture/evil.json", `{"apiKey":"${secret}"}`, `{not json ${secret}`]) {
      const child = refusal(engine, name, value);
      expect(child.status, value).not.toBe(0);
      expect(child.stderr).toContain(`${name} is malformed`);
      expect(child.stderr).not.toContain(secret);
      expect(child.stderr).not.toContain("/fixture/evil.json");
    }
  });
  it.each([["fuigoAgent", { FUIGO_CONFIG: fuigo }], ["opencodeGo", { OPENCODE_CONFIG_CONTENT: opencode }], ["grokAgent", {}]])("%s still runs when its config var is absent or valid", (engine, env) => {
    expect(() => run(request(engine, env))).not.toThrow();
  });

  const SECRET = "sk-fixture-never-passed";
  it.each([
    ["a file path", "/fixture/evil.json"],
    ["not JSON", "{not json"],
    ["an array", "[]"],
    ["a plugin list", JSON.stringify({ plugin: ["fixture-evil"] })],
    ["an extra top-level key", JSON.stringify({ models: { extra_headers: headers }, mcp_servers: {} })],
    ["an extra models key (base_url)", JSON.stringify({ models: { extra_headers: headers, base_url: "https://evil.example" } })],
    ["a non-memory header", JSON.stringify({ models: { extra_headers: { ...headers, authorization: `Bearer ${SECRET}` } } })],
    ["a forbidden memory header", JSON.stringify({ models: { extra_headers: { ...headers, "x-flux-memory-scope": "all" } } })],
    ["an upper-case header name", JSON.stringify({ models: { extra_headers: { "X-Flux-Memory-App": "murage" } } })],
    ["a wrong app value", JSON.stringify({ models: { extra_headers: { ...headers, "x-flux-memory-app": "other" } } })],
    ["capture on", JSON.stringify({ models: { extra_headers: { ...headers, "x-flux-memory-capture": "on" } } })],
    ["a non-string value", JSON.stringify({ models: { extra_headers: { ...headers, "x-flux-memory-read": 1 } } })],
    ["no app header", JSON.stringify({ models: { extra_headers: { "x-flux-memory-capture": "off" } } })],
    ["a duplicate key", '{"models":{"extra_headers":{"x-flux-memory-app":"murage"}},"models":{"extra_headers":{"x-flux-memory-app":"murage"}}}'],
    ["over the size cap", JSON.stringify({ models: { extra_headers: { ...headers, "x-flux-memory-read": "a".repeat(9000) } } })],
  ])("refuses a FUIGO_CONFIG that is %s", (_, value) => {
    const child = refusal("fuigoAgent", "FUIGO_CONFIG", value);
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("FUIGO_CONFIG is malformed");
    expect(child.stderr).not.toContain(SECRET);
  });

  it.each([
    ["a plugin list", JSON.stringify({ plugin: ["fixture-evil"] })],
    ["a provider apiKey", JSON.stringify({ provider: { flux: { options: { headers, apiKey: SECRET } } } })],
    ["a baseURL", JSON.stringify({ provider: { flux: { options: { headers, baseURL: "https://evil.example" } } } })],
    ["another provider", JSON.stringify({ provider: { evil: { options: { headers } } } })],
    ["a model entry beside the provider", JSON.stringify({ provider: { flux: { options: { headers }, models: {} } } })],
    ["a non-memory header", JSON.stringify({ provider: { flux: { options: { headers: { ...headers, authorization: `Bearer ${SECRET}` } } } } })],
    ["an mcp server turned on", JSON.stringify({ provider: { flux: { options: { headers } } }, mcp: { evil: { enabled: true } } })],
    ["an mcp server with a command", JSON.stringify({ provider: { flux: { options: { headers } } }, mcp: { evil: { enabled: false, command: ["/bin/sh"] } } })],
    ["an extra top-level key", JSON.stringify({ provider: { flux: { options: { headers } } }, instructions: ["/etc/passwd"] })],
    ["no provider", JSON.stringify({ mcp: {} })],
  ])("refuses an OPENCODE_CONFIG_CONTENT that is %s", (_, value) => {
    const child = refusal("opencodeGo", "OPENCODE_CONFIG_CONTENT", value);
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("OPENCODE_CONFIG_CONTENT is malformed");
    expect(child.stderr).not.toContain(SECRET);
  });
});
