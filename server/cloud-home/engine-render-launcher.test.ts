// SPDX-License-Identifier: AGPL-3.0-or-later
// The launcher owns every Cloud engine configuration (lanes/release103/CLOUD-ENGINES-DESIGN.md,
// r3 over r2 over sections 1 to 8). A request carries typed `render` parameters, never file
// bytes or a config path; every config file an engine reads at startup is a launcher-rendered,
// read-only file or a read-only empty shadow. These tests drive the real launcher Python.
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../flux-config.ts", () => ({ fluxKey: () => "fixture-cloud-flux-key", fluxConfigured: () => true }));
import { CLOUD_MCP_PROXIES, cloudRenderMcp, cloudRouteUrl } from "./engine-render.ts";
import { TURN_RENDER, TURN_SCRATCH, cloudTurnEnvironment, cloudTurnLaunch } from "./turn-process.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { applyProviderRoute } from "../provider-routing.ts";
import { stripForeignProviderKeys } from "../drivers/acp/opencode-go.ts";
import { kimiSpawnArgs } from "../drivers/acp/kimi.ts";
import { MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-render-"); });
afterEach(() => { rig.dispose(); vi.unstubAllEnvs(); });
const unit = "murage-turn-0123456789abcdef.scope";
const RENDER_DIR = "/tmp/murage-render-0123456789abcdef";
const socket = "/data/broker/perm-abcd1234.sock";
const ok = (request: Record<string, unknown>) => { const result = rig.plan(request); if (!result.ok) throw new Error(result.error); return result.ok; };
const refused = (request: Record<string, unknown>) => rig.plan(request).error;
const route = { provider: "murage_0123456789abcdef", baseUrl: "https://fixture.example/v1", model: "fixture-model", apiKey: "fixture-route-key" };
const GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore";
// managed-policy.ts at the base checkout (8c81a25ac): the bytes every managed engine started with.
const BASE = {
  claudeAgent: { ".claude/settings.json": "{}\n" },
  codex: { ".codex/config.toml": "check_for_update_on_startup = false\n" },
  grokAgent: { ".grok/config.toml": "[cli]\nauto_update = false\n" },
  opencodeGo: { ".config/opencode/opencode.json": '{"$schema":"https://opencode.ai/config.json","autoupdate":false}\n' },
  kimiAgent: { ".kimi-code/config.toml": "hooks = []\n", ".kimi-code/tui.toml": '[upgrade]\nauto_install = false\n[status_line]\ncommand = ""\n' },
} as const;
const FUIGO_PINS = ["[plugins]\nauto_discover = false\n", "use_leader = false\n", "[claude_compat]\nimported = true\n"];

describe("requests carry typed render parameters, never files (tests 1, 2, 14)", () => {
  it("refuses files in a turn request and as an unknown key in a login request", () => {
    expect(refused(rig.request("claudeAgent", { files: {} }))).toBe("Cloud turn request carries files");
    expect(refused(rig.request("claudeAgent", { pty: true }))).toBe("Cloud turn request has an unknown key");
    expect(() => rig.py(`m.validate_login_request({"mode":"login","engine":"codex","action":"login","files":{}})`)).toThrow(/Invalid cloud login request/u);
  });
  it.each(Object.keys(BASE))("renders %s's base set byte for byte, read-only, with no render", engine => {
    const plan = ok(rig.request(engine));
    for (const [relative, text] of Object.entries(BASE[engine as keyof typeof BASE])) expect(plan.files[`${rig.home(engine)}/${relative}`], relative).toBe(text);
    for (const path of Object.keys(plan.files)) expect(path.startsWith(rig.home(engine)) || path.startsWith(RENDER_DIR)).toBe(true);
  });
  it("renders the exact masks of each engine", () => {
    const h = (engine: string) => rig.home(engine);
    expect(ok(rig.request("claudeAgent")).files).toEqual({ [`${h("claudeAgent")}/.claude/settings.json`]: "{}\n", [`${h("claudeAgent")}/.claude/settings.local.json`]: "{}" });
    expect(ok(rig.request("kimiAgent")).files[`${h("kimiAgent")}/.kimi-code/mcp.json`]).toBe('{"mcpServers":{}}');
    const opencode = ok(rig.request("opencodeGo"));
    expect(opencode.readOnly).toEqual([`${h("opencodeGo")}/.config/opencode`, `${h("opencodeGo")}/.opencode`]);
    for (const dir of opencode.readOnly) expect(opencode.files[`${dir}/.gitignore`]).toBe(GITIGNORE);
  });
  it("turns a login into the exact LOGIN_COMMANDS argv and renders the base set with no route and no MCP", () => {
    const turn = JSON.parse(rig.py(`print(json.dumps(m.validate_login_request({"mode":"login","engine":"codex","action":"login","pty":True,"unit":"${unit}","bot":"fixture-bot"})))`));
    expect(turn).toEqual({ engine: "codex", command: "/opt/murage/bin/codex", args: ["login", "--device-auth"], cwd: "/data/engine-homes/codex", env: expect.any(Object), pty: true, bot: "fixture-bot", unit });
    const plan = rig.plan({ ...turn, command: rig.command, cwd: rig.home("codex"), env: {} }, { login: true }).ok!;
    expect(plan.args).toEqual(["login", "--device-auth"]);
    expect(plan.files).toEqual({ [`${rig.home("codex")}/.codex/config.toml`]: "check_for_update_on_startup = false\n" });
    expect(rig.plan({ ...turn, command: rig.command, cwd: rig.home("codex"), env: {}, render: { route } }, { login: true }).error).toBe("Cloud login request carries render");
  });
});

describe("routes (test 3, r2 R1)", () => {
  it("renders Codex's provider table with env_key and no key in the file", () => {
    const plan = ok(rig.request("codex", { render: { route } }));
    const text = plan.files[`${rig.home("codex")}/.codex/config.toml`];
    expect(text).toBe('check_for_update_on_startup = false\n[model_providers.murage_0123456789abcdef]\nname = "Selected provider"\nbase_url = "https://fixture.example/v1"\nwire_api = "responses"\nenv_key = "MURAGE_PROVIDER_API_KEY"\n');
    expect(JSON.stringify(plan.files)).not.toContain(route.apiKey);
  });
  it("renders Fuigo's routed tiers in the scratch home with the pins and memory rules", () => {
    const scratch = "native/provider-turns/fuigoAgent-0123456789ab", state = `${rig.home("fuigoAgent")}/${scratch}`;
    const plan = ok(rig.request("fuigoAgent", { scratch: [scratch], render: { route: { ...route, protocol: "anthropic" }, memoryTools: true } }));
    const text = plan.files[`${state}/config.toml`];
    for (const pin of FUIGO_PINS) expect(text).toContain(pin);
    expect(text).toContain('[model_providers.murage_0123456789abcdef]\nbase_url = "https://fixture.example/v1"\nenv_key = "MURAGE_PROVIDER_API_KEY"\napi_backend = "messages"\nauth_scheme = "x_api_key"\n');
    expect(text).toContain('[model.murage_selected]\nmodel = "fixture-model"\nmodel_provider = "murage_0123456789abcdef"\n');
    expect(text).toContain('pattern = "murage-memory__memory_search"');
    expect(plan.env.FUIGO_HOME).toBe(state);
    expect(JSON.stringify(plan.files)).not.toContain(route.apiKey);
  });
  it("Fuigo's shell commands ask Murage on every spawn but Full access: [permission] ask = [\"Bash\"], one table with the memory rules", () => {
    const h = rig.home("fuigoAgent"), scratch = "native/provider-turns/fuigoAgent-0123456789ab", state = `${h}/${scratch}`;
    const base = ["--no-memory", "agent", "--no-leader", "stdio"];
    const asking = ok(rig.request("fuigoAgent", { args: ["--permission-mode", "default", ...base] })).files[`${h}/.fuigo/config.toml`];
    expect(asking).toContain('\n[permission]\nask = ["Bash"]\n');
    const withMemory = ok(rig.request("fuigoAgent", { scratch: [scratch], render: { route: { ...route, protocol: "openai" }, memoryTools: true } })).files[`${state}/config.toml`];
    expect(withMemory.split("[permission]")).toHaveLength(2);
    expect(withMemory).toContain('[permission]\nask = ["Bash"]\nrules = [\n');
    expect(withMemory).toContain('pattern = "murage-memory__memory_search"');
    // Full access is the owner's own choice: no ask rule, and no bypass lock anywhere
    const full = ok(rig.request("fuigoAgent", { args: ["--permission-mode", "bypassPermissions", ...base] })).files;
    expect(full[`${h}/.fuigo/config.toml`]).not.toContain("[permission]");
    expect(JSON.stringify(full)).not.toContain("disable_bypass_permissions_mode");
  });
  it("renders OpenCode's provider without options.apiKey; the key reaches it only in OPENCODE_AUTH_CONTENT", () => {
    const plan = ok(rig.request("opencodeGo", { render: { route: { ...route, provider: "flux", models: ["flux-auto", "flux-fast"], label: "Flux Router" } } }));
    const config = JSON.parse(plan.files[`${rig.home("opencodeGo")}/.config/opencode/opencode.json`]);
    expect(config.provider).toEqual({ flux: { npm: "@ai-sdk/openai-compatible", name: "Flux Router", options: { baseURL: route.baseUrl }, models: { "flux-auto": { name: "flux-auto" }, "flux-fast": { name: "flux-fast" } } } });
    expect(JSON.parse(plan.env.OPENCODE_AUTH_CONTENT)).toEqual({ flux: { type: "api", key: route.apiKey } });
    expect(JSON.stringify(plan.files)).not.toContain(route.apiKey);
  });
  it.each(["claudeAgent", "grokAgent", "kimiAgent"])("refuses a route for %s", engine => {
    expect(refused(rig.request(engine, { render: { route } }))).toBe("Cloud turn render part is not allowed: route");
  });
  it.each([
    ["http to a host other than 127.0.0.1", { baseUrl: "http://fixture.example/v1" }, "baseUrl"],
    ["userinfo", { baseUrl: "https://user:pass@fixture.example/v1" }, "baseUrl"],
    ["{env:HOME} in the url", { baseUrl: "https://fixture.example/{env:HOME}" }, "baseUrl"],
    ["${HOME} in the model", { model: "${HOME}" }, "model"],
    ["{file:/etc/passwd} in the model", { model: "{file:/etc/passwd}" }, "model"],
    ["a quote in the provider", { provider: 'x"y' }, "provider"],
    ["a newline in the label", { label: "a\nb" }, "label"],
    ["a backslash in the label", { label: "a\\b" }, "label"],
    ["an unknown key", { extra: 1 }, "unknown key"],
  ])("refuses a file-bound route value with %s (R1.1)", (_name, patch, field) => {
    expect(refused(rig.request("codex", { render: { route: { ...route, ...patch } } }))).toContain(field);
  });
  it("accepts the same bytes in apiKey and keeps them out of every file (R1.1, R1.2)", () => {
    const hostile = '{env:HOME}${HOME}"\\\n{file:/etc/passwd}';
    const a = ok(rig.request("opencodeGo", { render: { route: { ...route, provider: "flux", apiKey: hostile } } }));
    const b = ok(rig.request("opencodeGo", { render: { route: { ...route, provider: "flux", apiKey: "other-key" } } }));
    expect(a.files).toEqual(b.files);
    expect(JSON.parse(a.env.OPENCODE_AUTH_CONTENT).flux.key).toBe(hostile);
    const scratch = "native/provider-turns/fuigoAgent-0123456789ab";
    const fa = ok(rig.request("fuigoAgent", { scratch: [scratch], render: { route: { ...route, protocol: "openai", apiKey: hostile } } }));
    const fb = ok(rig.request("fuigoAgent", { scratch: [scratch], render: { route: { ...route, protocol: "openai", apiKey: "other" } } }));
    expect(fa.files).toEqual(fb.files);
  });
  it("refuses a template patched to emit an interpolation token (R1.3)", () => {
    expect(rig.plan(rig.request("fuigoAgent"), { set: { FUIGO_MANAGED_CONFIG: "x = \"{env:X}\"\n" } }).error).toBe("Cloud rendered file carries an interpolation token");
    expect(rig.plan(rig.request("grokAgent"), { set: { EMPTY_MCP: "${HOME}" } }).error).toBeUndefined();
    expect(rig.plan(rig.request("kimiAgent"), { set: { EMPTY_MCP: "${HOME}" } }).error).toBe("Cloud rendered file carries an interpolation token");
  });
});

describe("MCP proxies (tests 4, 5, r3 M5, Low)", () => {
  const stanzas = {
    muragebox: { proxy: "permission", socket },
    agents: { proxy: "agents", env: { MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_COMMS_TOKEN: "fixture-comms" } },
    "murage-memory": { proxy: "memory", env: { MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_MEMORY_TOKEN: "fixture-memory" } },
    github: { proxy: "remote", server: "github", env: { MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_MCP_TOKEN: "fixture-mcp" }, ask: true },
    docs: { proxy: "url", url: "https://mcp.fixture.example/mcp" },
  };
  it("renders Claude's --mcp-config file from the launcher's own commands, with each stanza's env", () => {
    const plan = ok(rig.request("claudeAgent", { unit, args: [...MINIMAL_ARGV.claudeAgent, "--mcp-config", "@render:mcp"], render: { mcp: stanzas } }));
    const file = JSON.parse(plan.files[`${RENDER_DIR}/mcp.json`]);
    expect(file.mcpServers.muragebox).toEqual({ command: "/usr/local/bin/node", args: [`${rig.proxyRoot}/permission-proxy.js`, socket], env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(file.mcpServers.agents).toEqual({ command: "/usr/local/bin/node", args: [`${rig.proxyRoot}/drivers/agents-proxy.js`], env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_COMMS_TOKEN: "fixture-comms" } });
    expect(file.mcpServers.github.args).toEqual([`${rig.proxyRoot}/drivers/remote-mcp-proxy.js`, "--server", "github"]);
    expect(file.mcpServers.docs).toEqual({ type: "http", url: "https://mcp.fixture.example/mcp" });
    expect(plan.env).not.toHaveProperty("MURAGE_COMMS_TOKEN");
  });
  it("renders Codex's [mcp_servers] with env_vars names only and puts the values in the engine environment", () => {
    const plan = ok(rig.request("codex", { render: { mcp: stanzas } }));
    const text = plan.files[`${rig.home("codex")}/.codex/config.toml`];
    expect(text).toContain(`[mcp_servers.agents]\ncommand = "/usr/local/bin/node"\nargs = ["${rig.proxyRoot}/drivers/agents-proxy.js"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenv_vars = ["MURAGE_COMMS_TOKEN", "MURAGE_HARNESS_URL"]\ntool_timeout_sec = 604800\ndefault_tools_approval_mode = "auto"\n`);
    expect(text).toContain('[mcp_servers.github]\n'); expect(text).toContain("startup_timeout_sec = 60\n");
    expect(text).toContain('[mcp_servers.docs]\nurl = "https://mcp.fixture.example/mcp"\n');
    expect(text).not.toContain("fixture-comms");
    expect(plan.env).toMatchObject({ MURAGE_COMMS_TOKEN: "fixture-comms", MURAGE_MEMORY_TOKEN: "fixture-memory", MURAGE_MCP_TOKEN: "fixture-mcp", MURAGE_HARNESS_URL: "http://127.0.0.1:8787" });
  });
  it("refuses two stanzas that give one name different values, and merges equal ones (r3 M5)", () => {
    expect(ok(rig.request("codex", { render: { mcp: { a: { proxy: "memory", env: { MURAGE_HARNESS_URL: "x" } }, b: { proxy: "remote", server: "b", env: { MURAGE_HARNESS_URL: "x" } } } } })).env.MURAGE_HARNESS_URL).toBe("x");
    expect(refused(rig.request("codex", { render: { mcp: { a: { proxy: "memory", env: { MURAGE_HARNESS_URL: "x" } }, b: { proxy: "remote", server: "b", env: { MURAGE_HARNESS_URL: "y" } } } } })))
      .toBe("Cloud turn MCP env conflicts: MURAGE_HARNESS_URL");
  });
  it.each([
    ["a command key", { x: { proxy: "agents", command: "/bin/sh" } }, "unknown key"],
    ["an unknown kind", { x: { proxy: "shell" } }, "kind is not allowed"],
    ["an env name outside the proxy's list", { x: { proxy: "memory", env: { LD_PRELOAD: "/x.so" } } }, "env name is not allowed"],
    ["another proxy's env name", { x: { proxy: "memory", env: { MURAGE_COMMS_TOKEN: "x" } } }, "env name is not allowed"],
    ["a socket outside /data/broker", { x: { proxy: "permission", socket: "/tmp/x.sock" } }, "socket is outside /data/broker"],
    ["a socket with traversal", { x: { proxy: "permission", socket: "/data/broker/../x.sock" } }, "socket is outside /data/broker"],
    ["a missing socket", { x: { proxy: "permission" } }, "socket is not allowed"],
    ["a socket on a kind without one", { x: { proxy: "agents", socket } }, "socket is not allowed"],
    ["a bad server name", { x: { proxy: "remote", server: "../x" } }, "server is not allowed"],
    ["a name with a dot", { "a.b": { proxy: "memory" } }, "name is not allowed"],
    ["an http url", { x: { proxy: "url", url: "http://fixture.example/mcp" } }, "url is not allowed"],
  ])("refuses a stanza with %s", (_name, mcp, message) => {
    expect(refused(rig.request("codex", { render: { mcp } }))).toContain(message);
  });
  it("refuses an MCP render on an engine whose MCP servers arrive over ACP", () => {
    for (const engine of ["grokAgent", "kimiAgent", "opencodeGo", "fuigoAgent"]) expect(refused(rig.request(engine, { render: { mcp: {} } }))).toBe("Cloud turn render part is not allowed: mcp");
  });
  it("refuses a proxy script whose digest, listing or mode fails (test 5)", () => {
    const render = { mcp: { agents: { proxy: "agents" } } };
    writeFileSync(join(rig.proxyRoot, "drivers/agents-proxy.js"), "// changed\n");
    expect(refused(rig.request("codex", { render }))).toBe("Cloud MCP proxy digest mismatch");
    const manifest = JSON.parse(readFileSync(rig.manifest, "utf8")); manifest.mcpProxies = [];
    writeFileSync(rig.manifest, JSON.stringify(manifest));
    expect(refused(rig.request("codex", { render }))).toBe("Cloud MCP proxy is not listed");
  });
  it("lists every proxy script in the image manifest with a digest (test 5)", () => {
    const build = readFileSync(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url), "utf8");
    for (const row of Object.values(CLOUD_MCP_PROXIES)) if (row.script) expect(build).toContain(`"${row.script}"`);
    expect(build).toContain('manifest["mcpProxies"].append({"path": path, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})');
  });
  it("refuses aggregate render sizes over their limits (r3 Low)", () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`m${i}`, { proxy: "memory" }]));
    expect(refused(rig.request("codex", { render: { mcp: many } }))).toBe("Cloud turn render has too many MCP servers");
    const value = "v".repeat(4000);
    const big = Object.fromEntries(CLOUD_MCP_PROXIES.agents.env.map(name => [name, value]));
    expect(refused(rig.request("claudeAgent", { render: { mcp: { a: { proxy: "agents", env: big }, b: { proxy: "agents", env: big } } } }))).toBe("Cloud turn MCP env exceeds its limit");
    expect(refused(rig.request("claudeAgent", { render: { systemPrompt: "x".repeat(600 * 1024) } }))).toBe("Cloud turn render exceeds its limit");
    expect(refused(rig.request("codex", { render: { route: { ...route, apiKey: "k".repeat(5000) } } }))).toBe("Cloud turn render route apiKey is not allowed");
  });
});

describe("Claude's system prompt is plain TEXT (r3 N1)", () => {
  it("reaches prompt.txt byte for byte, interpolation-looking text included, and the turn starts", () => {
    const prompt = '${HOME}\n{env:X}\n"quoted"\né\u{1F600}\n';
    const plan = ok(rig.request("claudeAgent", { unit, args: [...MINIMAL_ARGV.claudeAgent, "--append-system-prompt-file", "@render:system-prompt"], render: { systemPrompt: prompt } }));
    expect(plan.files[`${RENDER_DIR}/prompt.txt`]).toBe(prompt);
  });
  it("keeps a Windows-sized multiline prompt (claude.test.ts 136 KB case) intact", () => {
    const prompt = Array.from({ length: 2400 }, (_, i) => `line ${i}: section context, skills, memory and playbooks`).join("\n");
    expect(prompt.length).toBeGreaterThan(130_000);
    expect(ok(rig.request("claudeAgent", { unit, render: { systemPrompt: prompt } })).files[`${RENDER_DIR}/prompt.txt`]).toBe(prompt);
  });
  it("refuses a NUL, an unpaired surrogate and more than 256 KiB", () => {
    expect(refused(rig.request("claudeAgent", { render: { systemPrompt: "a\u0000b" } }))).toBe("Cloud turn system prompt is not allowed");
    expect(refused(rig.request("claudeAgent", { render: { systemPrompt: "x".repeat(257 * 1024) } }))).toBe("Cloud turn system prompt is not allowed");
    expect(refused(rig.request("claudeAgent", { render: { systemPrompt: "a\ud800b" } }))).toMatch(/not valid UTF-8|system prompt is not allowed/u);
  });
  it("accepts a Codex resume thread id as a render part (r4) and nothing else as one", () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const codexPolicy = { approval: "on-request", sandbox: "workspace-write" };
    expect(ok(rig.request("codex", { render: { resume: id, codexPolicy } })).args).toEqual(MINIMAL_ARGV.codex);
    expect(JSON.parse(rig.py(`print(json.dumps(m.validate_render("codex",{"resume":"${id}","codexPolicy":{"approval":"never","sandbox":"read-only"}},"0123456789abcdef")["resume"]))`))).toBe(id);
    expect(refused(rig.request("codex", { render: { resume: "../x", codexPolicy } }))).toBe("Cloud turn render resume is not allowed");
    expect(refused(rig.request("codex", { render: { resume: id.toUpperCase(), codexPolicy } }))).toBe("Cloud turn render resume is not allowed");
    expect(refused(rig.request("claudeAgent", { render: { resume: id } }))).toBe("Cloud turn render part is not allowed: resume");
    expect(refused(rig.request("grokAgent", { render: { resume: id } }))).toBe("Cloud turn render part is not allowed: resume");
  });
  it("classifies every rendered file as parsed or plain, prompt.txt alone plain (R1')", () => {
    const out = JSON.parse(rig.py(`print(json.dumps({"plain":sorted(m.PLAIN_FILES),"overlap":sorted(m.PARSED_FILES & m.PLAIN_FILES)}))`));
    expect(out).toEqual({ plain: ["claude.prompt"], overlap: [] });
  });
});

describe("project settings above cwd and under --add-dir (r3 M3, M4)", () => {
  it("masks every Claude project settings source from cwd to the grant root and at each --add-dir", () => {
    const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`, extra = `${rig.workspaces}/other`;
    mkdirSync(extra); mkdirSync(`${ws}/.claude`); writeFileSync(`${ws}/.claude/settings.json`, '{"enabledPlugins":{"x@y":true},"hooks":{"Stop":[]}}');
    for (const dir of [cwd, `${ws}/proj`, ws, extra]) { mkdirSync(`${dir}/.claude`, { recursive: true }); writeFileSync(`${dir}/.mcp.json`, '{"mcpServers":{"x":{"command":"/bin/true"}}}'); }
    const plan = ok(rig.request("claudeAgent", { cwd, args: [...MINIMAL_ARGV.claudeAgent, "--add-dir", extra] }));
    for (const dir of [cwd, `${ws}/proj`, ws, extra]) expect(plan.readOnly, dir).toContain(`${dir}/.claude`);
    // r4: no file mask lands in the workspace; <dir>/.mcp.json is closed by the required --strict-mcp-config.
    for (const path of Object.keys(plan.files)) expect(path.startsWith(`${rig.workspaces}/`), path).toBe(false);
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.readOnly).not.toContain(`${rig.home("claudeAgent")}/.claude`);
    expect(plan.files[`${rig.home("claudeAgent")}/.claude/settings.json`]).toBe("{}\n");
  });
  it("masks Codex project .codex layers from cwd up, never the credential home", () => {
    const ws = `${rig.workspaces}/ws`;
    mkdirSync(`${ws}/proj/.codex`); mkdirSync(`${ws}/.codex`);
    // r5 R5.1: the cwd also carries every other MASK_NAMES mask.
    expect(ok(rig.request("codex", { cwd: `${ws}/proj` })).readOnly).toEqual([`${ws}/proj/.codex`, `${ws}/.codex`, ...[".claude", ".fuigo", ".grok", ".kimi-code", ".opencode"].map(name => `${ws}/proj/${name}`)]);
    const inHome = `${rig.home("codex")}/project`; mkdirSync(inHome);
    expect(ok(rig.request("codex", { cwd: inHome })).readOnly).toEqual([`${inHome}/.codex`]);
  });
});

describe("Fuigo (test 9, r2 R2/R3, r3 N2)", () => {
  it("pins all 19 compat gates to 0 whatever the request sends", () => {
    const gates = JSON.parse(rig.py("print(json.dumps(list(m.FUIGO_COMPAT_GATES)))")) as string[];
    expect(gates).toHaveLength(19);
    for (const env of [{}, Object.fromEntries(gates.map(gate => [gate, "1"]))]) {
      const plan = ok(rig.request("fuigoAgent", { env }));
      for (const gate of gates) expect(plan.env[gate], gate).toBe("0");
    }
  });
  it.each([["cwd = $home", ""], ["cwd = $home/project", "project"]])("unrouted, %s: $home/.fuigo is the writable state mount with read-only tiers inside", (_label, sub) => {
    const h = rig.home("fuigoAgent"), cwd = sub ? `${h}/${sub}` : h; if (sub) mkdirSync(cwd);
    const plan = ok(rig.request("fuigoAgent", { cwd, args: ["--permission-mode", "default", "--trust", "--no-memory", "agent", "--no-leader", "stdio"] }));
    expect(plan.env.FUIGO_HOME).toBe(`${h}/.fuigo`);
    expect(plan.readOnly).not.toContain(`${h}/.fuigo`);
    expect(plan.readOnly).toContain(`${h}/.fuigo/plugins`);
    for (const name of ["config.toml", "managed_config.toml", "requirements.toml", "sandbox.toml", "trusted-plugins", "trusted-hook-projects"]) expect(plan.files, name).toHaveProperty([`${h}/.fuigo/${name}`]);
    expect(plan.files).not.toHaveProperty([`${h}/.fuigo/trusted_folders.toml`]);
    for (const pin of FUIGO_PINS) { expect(plan.files[`${h}/.fuigo/config.toml`]).toContain(pin); expect(plan.files[`${h}/.fuigo/requirements.toml`]).toContain(pin); }
    expect(plan.files[`${h}/.fuigo/managed_config.toml`]).toBe("# managed by the Murage launcher\n");
    if (sub) expect(plan.readOnly).toContain(`${cwd}/.fuigo`);
  });
  it("routed: $home/.fuigo is an empty read-only shadow and the tiers live in the scratch home", () => {
    const h = rig.home("fuigoAgent"), scratch = "native/provider-turns/fuigoAgent-0123456789ab";
    const plan = ok(rig.request("fuigoAgent", { scratch: [scratch], render: { route: { ...route, protocol: "openai" } } }));
    expect(plan.readOnly).toContain(`${h}/.fuigo`);
    expect(plan.files[`${h}/${scratch}/requirements.toml`]).toBeDefined();
    expect(Object.keys(plan.files).some(path => path.startsWith(`${h}/.fuigo/`))).toBe(false);
    expect(plan.tmpfs.indexOf(`${h}/${scratch}`)).toBeLessThan(plan.tmpfs.indexOf(`${h}/${scratch}/plugins`));
  });
  it("masks every path the Claude, Cursor and Codex import would read, along the whole cwd chain (R3.1, R2.1)", () => {
    const h = rig.home("fuigoAgent"), ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`;
    for (const dir of [cwd, `${ws}/proj`, ws]) { for (const name of [".fuigo", ".claude", ".cursor"]) mkdirSync(`${dir}/${name}`); writeFileSync(`${dir}/.mcp.json`, "{}"); }
    const plan = ok(rig.request("fuigoAgent", { cwd }));
    for (const name of [".claude", ".cursor", ".codex", ".agents"]) expect(plan.readOnly).toContain(`${h}/${name}`);
    expect(plan.files[`${h}/.claude.json`]).toBe("{}");
    for (const dir of [cwd, `${ws}/proj`, ws]) for (const name of [".fuigo", ".claude"]) expect(plan.readOnly, `${dir}/${name}`).toContain(`${dir}/${name}`);
    // r4: <dir>/.cursor and <dir>/.mcp.json are closed by the pinned gates and the rendered import marker, never by a workspace file mask.
    for (const path of Object.keys(plan.files)) expect(path.startsWith(`${rig.workspaces}/`), path).toBe(false);
    const gates = JSON.parse(rig.py("print(json.dumps(list(m.FUIGO_COMPAT_GATES)))")) as string[];
    for (const gate of gates) expect(plan.env[gate], gate).toBe("0");
    expect(plan.files[`${h}/.fuigo/config.toml`]).toContain("[claude_compat]\nimported = true\n");
  });
  it("binds the root-owned system tiers read-only and the image ships them with the pins", () => {
    expect(ok(rig.request("fuigoAgent")).roBind).toEqual(expect.arrayContaining(["/etc/fuigo/requirements.toml", "/etc/fuigo/managed_config.toml"]));
    const managed = readFileSync(new URL("../../deploy/cloud-home/managed/fuigo-requirements.toml", import.meta.url), "utf8");
    for (const pin of FUIGO_PINS) expect(managed).toContain(pin);
    const build = readFileSync(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url), "utf8");
    expect(build).toContain("install -o root -g root -m 0644 deploy/cloud-home/managed/fuigo-requirements.toml /etc/fuigo/requirements.toml");
  });
});

describe("OpenCode auth content (r9 \"OpenCode\", supersedes r3 M1)", () => {
  const authPath = () => join(rig.home("opencodeGo"), ".local/share/opencode/auth.json");
  it("never reads the disk home's auth.json: with no C store entry and no route the variable is unset", () => {
    mkdirSync(join(rig.home("opencodeGo"), ".local/share/opencode"), { recursive: true });
    writeFileSync(authPath(), JSON.stringify({ opencode: { type: "api", key: "saved-key" }, anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 } }));
    expect(ok(rig.request("opencodeGo")).env).not.toHaveProperty("OPENCODE_AUTH_CONTENT");
    expect(ok(rig.request("opencodeGo", { env: { OPENCODE_AUTH_CONTENT: '{"evil":{"type":"wellknown"}}' } })).env).not.toHaveProperty("OPENCODE_AUTH_CONTENT");
  });
  it("carries exactly the route when the turn has one, never the request's value", () => {
    const env = ok(rig.request("opencodeGo", { render: { route: { ...route, provider: "opencode" } }, env: { OPENCODE_AUTH_CONTENT: '{"evil":{"type":"wellknown"}}' } })).env;
    expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({ opencode: { type: "api", key: route.apiKey } });
  });
});

describe("path inputs are canonical by construction (test 10)", () => {
  it.each([
    ["..", (ws: string) => `${ws}/ws/proj/..`],
    [".", (ws: string) => `${ws}/ws/./proj`],
    ["a trailing slash", (ws: string) => `${ws}/ws/proj/`],
    ["a doubled slash", (ws: string) => `${ws}/ws//proj`],
    ["outside the grant", () => "/etc"],
  ])("refuses a cwd with %s", (_name, path) => {
    expect(rig.plan(rig.request("codex", { cwd: path(rig.workspaces) })).error).toBeDefined();
  });
  // A Cloud home's volume is case-sensitive (ext4), where a case variant is another path. On a case-insensitive
  // filesystem (macOS APFS by default) the variant opens the same directory, so the case means nothing there.
  const caseInsensitive = existsSync(fileURLToPath(import.meta.url).toUpperCase());
  it.skipIf(caseInsensitive)("refuses a cwd with a case variant (case-sensitive filesystems)", () => {
    expect(rig.plan(rig.request("codex", { cwd: `${rig.workspaces}/ws/PROJ` })).error).toBeDefined();
  });
  it("refuses a symlinked cwd component and an --add-dir outside the workspaces", () => {
    symlinkSync(`${rig.workspaces}/ws/proj`, `${rig.workspaces}/ws/link`);
    expect(rig.plan(rig.request("codex", { cwd: `${rig.workspaces}/ws/link` })).error).toBeDefined();
    expect(rig.plan(rig.request("claudeAgent", { args: [...MINIMAL_ARGV.claudeAgent, "--add-dir", rig.home("claudeAgent")] })).error).toBe("Cloud engine argument is not allowed: --add-dir");
    expect(rig.plan(rig.request("claudeAgent", { args: [...MINIMAL_ARGV.claudeAgent, "--add-dir", `${rig.workspaces}/ws/link`] })).error).toBe("Cloud engine argument is not allowed: --add-dir");
  });
});

describe("state directories and hard links (tests 11, 12)", () => {
  const dirs = (engine: string, setup = "") => JSON.parse(rig.py(`
home=sys.argv[2];engine=sys.argv[3]
${setup}
fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY)
try:
    m.prepare_credential_dirs(fd,engine,None,(os.getuid(),));argv,_=m.turn_mount_args(engine,[],home,home,"/fixture/cli",[],None,turn_home="/turn-home");out={"ok":[[d,oct(os.stat(home+"/"+d).st_mode&0o7777)] for d in m.credential_dirs(engine)],"pinned":[argv[i+2] for i,a in enumerate(argv) if a=="--bind" and argv[i+1].startswith("/turn-home/")]}
except ValueError as e:
    out={"error":str(e)}
print(json.dumps(out))`, rig.home(engine), engine));
  it("creates the missing chain 2770 and pins each rendered state directory as its own mount, Fuigo's .fuigo included", () => {
    expect(dirs("fuigoAgent")).toEqual({ ok: [[".fuigo", "0o2770"]], pinned: [`${rig.home("fuigoAgent")}/.fuigo`] });
    expect(dirs("claudeAgent").pinned).toEqual([`${rig.home("claudeAgent")}/.claude`]);
  });
  it.each([["a file", "open(home+'/.fuigo','w').close()"], ["a symlink", "os.symlink('/tmp',home+'/.fuigo')"], ["a FIFO", "os.mkfifo(home+'/.fuigo')"]])("refuses %s where a state directory belongs and leaves it in place", (_name, setup) => {
    expect(dirs("fuigoAgent", setup)).toEqual({ error: "Cloud engine home path is not a directory: .fuigo" });
    expect(rig.py(`print(os.path.lexists(sys.argv[2]+"/.fuigo"))`, rig.home("fuigoAgent")).trim()).toBe("True");
  });
  it("refuses to report a cleanup done while a token file has a second link, naming the file, and leaves the other link", () => {
    const h = rig.home("kimiAgent"); mkdirSync(join(h, ".kimi-code/credentials"), { recursive: true });
    writeFileSync(join(h, ".kimi-code/credentials/kimi-code.json"), "token"); linkSync(join(h, ".kimi-code/credentials/kimi-code.json"), join(h, "kept.json"));
    const cleanup = JSON.parse(rig.py(`
for e in m.RECOVERY_CREDENTIALS: os.makedirs(sys.argv[2]+"/"+e,exist_ok=True)
try: m.cleanup_engine_signins({"mode":"engine-signin-cleanup"},root=sys.argv[2],owners={os.getuid()},root_owner=os.getuid());r={}
except m.CleanupFailed as e: r=e.results
print(json.dumps(r))`, rig.engineRoot));
    expect(cleanup.kimiAgent).toBe("failed: LinkedCredential kimi-code.json");
    expect(readFileSync(join(h, "kept.json"), "utf8")).toBe("token");
  });
  it("requires fs.protected_hardlinks = 1 before any turn (mocked read)", () => {
    const out = JSON.parse(rig.py(`
p0=sys.argv[2]+"/ph0";open(p0,"w").write("0\\n");p1=sys.argv[2]+"/ph1";open(p1,"w").write("1\\n")
def run(p):
    try: m.check_protected_hardlinks(p);return "ok"
    except ValueError as e: return str(e)
print(json.dumps([run(p1),run(p0),run(sys.argv[2]+"/missing")]))`, rig.root));
    expect(out).toEqual(["ok", "Cloud home requires fs.protected_hardlinks = 1", "Cloud home requires fs.protected_hardlinks = 1"]);
    expect(readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8")).toContain("def launch(request, login=False):\n    check_protected_hardlinks()");
  });
});

describe("import-time self-checks (test 8)", () => {
  it("fails at load for an undeliverable env_key, a path-shaped proxy name, an engine name reused by a proxy, and a missing Fuigo pin", () => {
    const out = JSON.parse(rig.py(`
def refused(fn):
    try: fn();return False
    except ValueError: return True
real=dict(m.TEMPLATE_ENV_KEYS)
m.TEMPLATE_ENV_KEYS={"codex":("MURAGE_UNKNOWN_KEY",)};a=refused(m.check_rendered_tables);m.TEMPLATE_ENV_KEYS=real
m.PROXY_ENV=frozenset({"MURAGE_CRED_FILE"});b=refused(m.check_rendered_tables)
m.PROXY_ENV=frozenset({"ANTHROPIC_API_KEY"});c=refused(m.check_rendered_tables)
m.PROXY_ENV=frozenset();m.FUIGO_REQUIREMENTS="[cli]\\n";d=refused(m.check_rendered_tables)
print(json.dumps([a,b,c,d]))`));
    expect(out).toEqual([true, true, true, true]);
  });
});

it("Kimi's sign-in hosts for --region global are on its egress list (test 15)", () => {
  const login = JSON.parse(rig.py(`print(json.dumps(m.LOGIN_COMMANDS["kimiAgent"][1]["login"]))`));
  expect(login).toEqual(["login", "--region", "global"]);
  // Kimi Code 2.2.0 resolveKimiCodeOAuthKey: the global region signs in at auth.kimi.ai and serves api.kimi.ai/coding/v1.
  const hosts = login.includes("global") ? ["auth.kimi.ai", "api.kimi.ai"] : ["api.kimi.com"];
  const egress = JSON.parse(readFileSync(new URL("../../deploy/cloud-home/egress-allow.json", import.meta.url), "utf8"));
  for (const host of hosts) expect(egress.engines.kimiAgent).toContain(host);
});

describe("server and launcher agree on the render contract (test 16)", () => {
  it("holds the same MCP proxy table on both sides", () => {
    const launcherTable = JSON.parse(rig.py(`print(json.dumps({k:{"script":v["script"],"arg":v["arg"],"env":list(v["env"])} for k,v in m.MCP_PROXIES.items()}))`));
    expect(launcherTable).toEqual(JSON.parse(JSON.stringify(CLOUD_MCP_PROXIES)));
  });
  it("converts the drivers' stdio specs into stanzas the launcher renders, dropping what a home cannot express", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const node = process.execPath, flag = { ELECTRON_RUN_AS_NODE: "1" };
    const mcp = cloudRenderMcp({
      muragebox: { command: node, args: [SPAWNED_PROXIES.permission, socket], env: flag },
      agents: { command: node, args: [SPAWNED_PROXIES.agents], env: { ...flag, MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_COMMS_TOKEN: "t", MURAGE_TURN_DEPTH: "0", MURAGE_CRED_FILE: "/tmp/x" } },
      composio: { command: node, args: [SPAWNED_PROXIES.connectors], env: { ...flag, MURAGE_CONNECTORS_TOKEN: "c", MURAGE_CONNECTOR_UPSTREAM_HEADERS: '{"authorization":"Bearer c"}' } },
      browser: { command: node, args: [SPAWNED_PROXIES.unifiedBrowser], env: { ...flag, MURAGE_CONTROL_TOKEN: "b" } },
      github: { command: node, args: [SPAWNED_PROXIES.remoteMcp, "--server", "github"], env: { MURAGE_MCP_TOKEN: "m" } },
      own: { command: "npx", args: ["-y", "fixture-server"], env: {} },
    }, name => name === "github");
    expect(Object.keys(mcp)).toEqual(["muragebox", "agents", "composio", "browser", "github"]);
    expect(mcp.agents.env).toEqual({ MURAGE_HARNESS_URL: "http://127.0.0.1:8787", MURAGE_COMMS_TOKEN: "t", MURAGE_TURN_DEPTH: "0" });
    expect(mcp.github).toEqual({ proxy: "remote", server: "github", env: { MURAGE_MCP_TOKEN: "m" }, ask: true });
    for (const engine of ["claudeAgent", "codex"]) expect(rig.plan(rig.request(engine, { render: { mcp } })).error, engine).toBeUndefined();
  });
  it("sends the drivers' routes in a shape the launcher accepts", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const providerRoute = { connectionId: "c1", preset: "openai" as const, protocol: "responses" as const, baseUrl: "http://localhost:4000/v1", apiKey: "route-key", model: "gpt-fixture", revision: "r1" };
    const codexEnv: NodeJS.ProcessEnv = {};
    applyProviderRoute("codex", codexEnv, providerRoute);
    const codexRender = JSON.parse(codexEnv[TURN_RENDER]!);
    expect(codexRender.route.baseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(rig.plan(rig.request("codex", { render: codexRender })).error).toBeUndefined();
    const fuigoEnv: NodeJS.ProcessEnv = {};
    applyProviderRoute("fuigoAgent", fuigoEnv, { ...providerRoute, protocol: "openai" }, { threadId: "t", memoryTools: true });
    expect(rig.plan(rig.request("fuigoAgent", { render: JSON.parse(fuigoEnv[TURN_RENDER]!), scratch: JSON.parse(fuigoEnv[TURN_SCRATCH]!) })).error).toBeUndefined();
    const opencodeEnv = cloudTurnEnvironment("opencodeGo", {});
    stripForeignProviderKeys(opencodeEnv);
    const opencode = rig.plan(rig.request("opencodeGo", { render: JSON.parse(opencodeEnv[TURN_RENDER]!) })).ok!;
    expect(JSON.parse(opencode.env.OPENCODE_AUTH_CONTENT).flux).toEqual({ type: "api", key: "fixture-cloud-flux-key" });
    expect(cloudRouteUrl("http://[::1]:8080/v1")).toBe("http://127.0.0.1:8080/v1");
  });
  it("never sends files, and Kimi passes no -m for a routed home turn (r3 M2)", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment("kimiAgent", {});
    const request = JSON.parse(cloudTurnLaunch("/opt/murage/bin/kimi", kimiSpawnArgs("ollama::fixture-model"), env)!.request);
    expect(request).not.toHaveProperty("files");
    expect(request.args).toEqual(["acp"]);
    expect(kimiSpawnArgs("kimi-code/kimi-for-coding")).toEqual(["-m", "kimi-code/kimi-for-coding", "acp"]);
    expect(rig.plan(rig.request("kimiAgent", { args: request.args })).error).toBeUndefined();
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(kimiSpawnArgs("ollama::fixture-model")).toEqual(["-m", "ollama::fixture-model", "acp"]);
  });
});
