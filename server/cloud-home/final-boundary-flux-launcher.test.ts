// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 hole 6: the root launcher refuses a Flux key or address for Claude Code / Codex at the last boundary: the proposed env, the argv,
// the typed render the launcher renders every config file from, and the files it rendered (the launcher stages nothing the server sends).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINIMAL_ARGV, fixtureEngineBytes } from "./engine-launch-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
// Direct: the scan itself, over env / argv / files as (path -> text).
const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("final_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2])
try:
 m.refuse_flux_for_sign_in_engine(c["engine"],c.get("env"),c.get("args"),c.get("files"))
 print(json.dumps({"ok":True}))
except ValueError as e:
 print(json.dumps({"error":str(e)}))`;
const run = (c: object) => JSON.parse(execFileSync("python3", ["-I", "-c", script, launcher, JSON.stringify(c)], { encoding: "utf8" })) as { ok?: boolean; error?: string };
const KEY = `sk-flux-home-${"k".repeat(30)}`;
const managed = (engine: string) => ({ [`/fixture/home/${engine === "codex" ? ".codex/config.toml" : ".claude/settings.json"}`]: engine === "codex" ? "" : "{}" });
it.each(["codex", "claudeAgent"])("hole 6: %s refuses a Flux key in env, argv and rendered files", engine => {
  expect(run({ engine, env: { T: KEY }, files: managed(engine) }).error).toMatch(/sign-in/);
  expect(run({ engine, env: {}, args: ["-c", "u=https://api.fluxrouter.ai/v1"], files: managed(engine) }).error).toMatch(/sign-in/);
  expect(run({ engine, env: { FLUX_API_KEY: "x" }, files: managed(engine) }).error).toMatch(/sign-in/);
  expect(run({ engine, files: { ...managed(engine), "/tmp/murage-render-0123456789abcdef/mcp.json": JSON.stringify({ mcpServers: { a: { env: { T: KEY } } } }) } }).error).toMatch(/sign-in/);
  expect(run({ engine, files: { ...managed(engine), "/fixture/home/x.json": '{"a":"\\u0073k-flux-' + "z".repeat(20) + '"}' } }).error).toMatch(/sign-in/);
  expect(run({ engine, env: { T: "fine" }, files: managed(engine) }).ok).toBe(true);
});
it("hole 6: other engines are not affected by the sign-in rule", () => {
  expect(run({ engine: "fuigoAgent", env: { T: KEY }, files: {} }).ok).toBe(true);
});

// finding 6 (round 3): effective configuration, not spelling. The launcher parses every staged TOML / JSON and
// scans the PARSED strings, and scans Codex -c overrides as TOML.
const U = String.fromCharCode(92); // one backslash, so the fixtures below read like the TOML they are
const toml = (text: string) => text.replaceAll("@", U);
const codexFile = (text: string) => ({ "/fixture/home/.codex/config.toml": text });
describe("finding 6: the launcher scans effective TOML and JSON values", () => {
  const SK = "sk-flux-" + "z".repeat(24);
  it.each([
    ["escaped key", toml('token = "@u0073k-@u0066lux-' + "z".repeat(24) + '"')],
    ["escaped host", toml('base_url = "https://api.' + "@" + 'u0066luxrouter.ai/v1"')],
    ["long escape", toml('token = "@U00000073k-flux-' + "z".repeat(24) + '"')],
    ["hex escape", toml('token = "@x73k-flux-' + "z".repeat(24) + '"')],
    ["line continuation split", toml('base_url = "https://api.flux@\n      router.ai/v1"')],
    ["escaped table key", toml('[model_providers."@u0066luxrouter"]\nname = "x"')],
    ["plain", 'base_url = "https://api.fluxrouter.ai/v1"'],
  ])("codex: TOML %s is refused", (_name, text) => {
    expect(run({ engine: "codex", files: codexFile(text) }).error).toMatch(/sign-in/);
  });
  it("codex: unparsable TOML is refused; clean TOML is accepted", () => {
    expect(run({ engine: "codex", files: codexFile('key = "unterminated') }).error).toMatch(/sign-in/);
    expect(run({ engine: "codex", files: codexFile('check_for_update_on_startup = false\n[tui]\nnotifications = true\n') }).ok).toBe(true);
  });
  it("claudeAgent: unparsable JSON and JSON with an escaped Flux host are refused", () => {
    expect(run({ engine: "claudeAgent", files: { "/fixture/home/.claude/settings.json": "{not json" } }).error).toMatch(/sign-in/);
    expect(run({ engine: "claudeAgent", files: { "/fixture/home/.claude/settings.json": '{"a":{"b":"https://api.\\u0066luxrouter.ai"}}' } }).error).toMatch(/sign-in/);
  });
  it("claudeAgent: settings may not set apiKeyHelper or an Anthropic key / address", () => {
    for (const text of ['{"apiKeyHelper":"/bin/get-key"}', '{"env":{"ANTHROPIC_BASE_URL":"https://example.com"}}', '{"env":{"anthropic_api_key":"x"}}', '{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}'])
      expect(run({ engine: "claudeAgent", files: { "/fixture/home/.claude/settings.json": text } }).error, text).toMatch(/sign-in/);
    expect(run({ engine: "claudeAgent", files: { "/fixture/home/.claude/settings.json": '{"env":{"FOO":"bar"},"theme":"dark"}' } }).ok).toBe(true);
  });
  it("codex: -c / --config overrides are parsed as TOML (escapes undone), raw text is the fallback", () => {
    for (const args of [["-c", toml('x="https://api.' + "@" + 'u0066luxrouter.ai"')], ["--config", toml('model_providers.f.base_url="@u0073k-flux-' + "z".repeat(24) + '"')], ["--config=" + toml('x="https://api.' + "@" + 'u0066luxrouter.ai"')], ["-c" + toml('x="@x66luxrouter.ai"')], ["-c", "x=" + SK]])
      expect(run({ engine: "codex", args, files: managed("codex") }).error, args.join(" ")).toMatch(/sign-in/);
    expect(run({ engine: "codex", args: ["-c", 'model="gpt-5"', "-c", "sandbox_mode=read-only"], files: managed("codex") }).ok).toBe(true);
  });
});

// The real request path: validate_request and turn_mount_args against a fixture manifest and throwaway engine homes.
describe("hole 6: the launcher refuses at both boundaries of a real request", () => {
  const harness = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
request=json.loads(sys.argv[2])
try:
 engine,home,cwd,command,args,env,render,bot=m.validate_request(request,manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=sys.argv[4],cache_root=sys.argv[5])
 if sys.argv[6]=="rendered":
  m.render_plan=lambda *a,**k:([(home+"/.codex/config.toml",'base_url = "https://api.fluxrouter.ai/v1"',"codex.config")],[])
 m.turn_mount_args(engine,([("/fixture/anchor/cwd",cwd)] if cwd!=home else []),home,cwd,command,args,render,request.get("scratch",[]))
 print(json.dumps({"ok":True}))
except (ValueError,m.Refusal) as e:
 print(json.dumps({"error":str(e)}))`;
  let root: string, engineRoot: string, command: string, manifest: string;
  beforeEach(() => {
    root = mkdtempSync(join(process.cwd(), ".murage-final-boundary-")); engineRoot = join(root, "engine-homes");
    for (const engine of ["claudeAgent", "codex", "fuigoAgent"]) mkdirSync(join(engineRoot, engine), { recursive: true });
    mkdirSync(join(root, "bin")); command = join(root, "bin", "fixture-engine"); const bytes = fixtureEngineBytes();
    writeFileSync(command, bytes, { mode: 0o755 }); const sha256 = createHash("sha256").update(bytes).digest("hex");
    manifest = join(root, "engine-manifest.json");
    writeFileSync(manifest, JSON.stringify(Object.fromEntries(["claudeAgent", "codex", "fuigoAgent"].map(engine => [engine, [{ path: command, sha256 }]]))), { mode: 0o644 });
  });
  afterEach(() => removeTempDirSync(root));
  const real = (request: object, mode = "request") => JSON.parse(execFileSync("python3", ["-I", "-c", harness, launcher, JSON.stringify(request), manifest, engineRoot, join(root, "digest-cache"), mode], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { ok?: boolean; error?: string };
  const req = (engine: "claudeAgent" | "codex", extra: object = {}) => ({ engine, bot: "fixture-bot", command, args: MINIMAL_ARGV[engine], cwd: join(engineRoot, engine), env: {}, ...extra });
  it("refuses a Flux address in the final env, in a system prompt key, and accepts a prompt that only names the service", () => {
    expect(real(req("claudeAgent", { env: { ANTHROPIC_BASE_URL: "https://api.fluxrouter.ai/anthropic" } })).error).toMatch(/sign-in/);
    expect(real(req("codex", { env: { OPENAI_BASE_URL: "https://api.fluxrouter.ai/v1" } })).error).toMatch(/sign-in/);
    expect(real(req("claudeAgent", { render: { systemPrompt: `use ${KEY} please` } })).error).toMatch(/sign-in/);
    expect(real(req("claudeAgent", { render: { systemPrompt: "Compare Fluxrouter.ai pricing for me" } })).ok).toBe(true);
    expect(real(req("codex")).ok).toBe(true);
  });
  it("refuses a Flux address in a Codex route and in a rendered file", () => {
    expect(real(req("codex", { render: { route: { provider: "flux", baseUrl: "https://api.fluxrouter.ai/v1", model: "m", apiKey: KEY } } })).error).toMatch(/sign-in/);
    expect(real(req("codex"), "rendered").error).toMatch(/sign-in/);
  });
  it("does not touch a router engine", () => {
    expect(real({ engine: "fuigoAgent", bot: "fixture-bot", command, args: MINIMAL_ARGV.fuigoAgent, cwd: join(engineRoot, "fuigoAgent"), env: { T: "x" } }).ok).toBe(true);
  });
});
