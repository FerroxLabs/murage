// SPDX-License-Identifier: AGPL-3.0-or-later
// Fuigo under the Cloud turn's user namespace (FUIGO-ADMIN-POLICY-USERNS.md, round 2): the admin tier
// is not bound, the rendered user tiers carry fail_closed first, the sandbox root is read-only, the
// environment is scrubbed by the FUIGO_ prefix with the home and the policy gates pinned, and every
// .fuigo under the grant root is an empty read-only mount that keeps its immutable placeholder. These
// tests drive the real launcher Python through the rig, the way engine-render-launcher.test.ts does.
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_TURN_ENGINES, MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-fuigo-userns-"); });
afterEach(() => { rig.dispose(); });
const ok = (request: Record<string, unknown>, options: Parameters<Rig["plan"]>[1] = {}) => { const result = rig.plan(request, options); if (!result.ok) throw new Error(result.error); return result.ok; };
const refused = (request: Record<string, unknown>, options: Parameters<Rig["plan"]>[1] = {}) => rig.plan(request, options).error;
const json = <T>(source: string, ...args: string[]): T => JSON.parse(rig.py(source, ...args)) as T;

const PINS = ["[plugins]\nauto_discover = false\n", "[cli]\nuse_leader = false\n", "[claude_compat]\nimported = true\n"];
const route = { provider: "murage_0123456789ab", baseUrl: "https://fixture.example/v1", model: "fixture-model", apiKey: "fixture-route-key", protocol: "openai" };
const SCRATCH = "native/provider-turns/fuigoAgent-0123456789ab";

// The hostile proposal of the round 2 env probe (probe-env.py): every override the Fuigo team listed, three OTEL names,
// the launcher-pinned names, and the allowed names exactly as the server's driver sends them.
const OVERRIDES = [
  "FUIGO_CONFIG_PATH", "FUIGO_MANAGED_CONFIG", "FUIGO_MANAGED_CONFIG_URL", "FUIGO_POLICY_PATH", "FUIGO_POLICY_SHA256", "FUIGO_MANAGED_HOOKS_ONLY",
  "FUIGO_SANDBOX", "FUIGO_SANDBOX_PROFILE", "FUIGO_SANDBOX_MODE", "FUIGO_DEFAULT_PERMISSION_MODE", "FUIGO_AUTO_PERMISSION_MODE", "FUIGO_CLI_BASE_URL",
  "FUIGO_GATEWAY_URL", "FUIGO_EXTRA_CA_BUNDLE", "FUIGO_WEB_FETCH_ALLOW_LOCAL", "FUIGO_AUTH", "FUIGO_AUTH_PATH", "FUIGO_CODE_API_KEY",
  "FUIGO_REQUIRED_MINIMUM_VERSION", "FUIGO_MINIMUM_VERSION", "FUIGO_MAXIMUM_VERSION", "FUIGO_WORKSPACE_PROJECT_LSP_TRUSTED", "FUIGO_FOLDER_TRUST",
  "FUIGO_WORKSPACE_HOME", "FUIGO_SOMETHING_NEW_IN_1_0_99",
];
const OTEL = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_LOG_USER_PROMPTS", "OTEL_TRACES_EXPORTER"];
const hostile: Record<string, string> = {
  ...Object.fromEntries([...OVERRIDES, ...OTEL].map(name => [name, "evil"])),
  FUIGO_HOME: "/evil/home", FUIGO_MANAGED_CONFIG_FAIL_CLOSED: "0", FUIGO_ENVRC_TIMEOUT_SECS: "30",
  FUIGO_SUBAGENTS: "1", FUIGO_CLAUDE_MCPS_ENABLED: "1", FUIGO_DISABLE_MODEL_REFRESH: "0",
  HOME: "/evil", XDG_CONFIG_HOME: "/evil/.config", TMPDIR: "/evil/tmp", PATH: "/evil/bin",
  FUIGO_API_KEY: "sk-probe", MURAGE_PROVIDER_API_KEY: "sk-route", FUIGO_API_BASE_URL: "https://api.fluxrouter.ai/v1",
  FUIGO_MODELS_BASE_URL: "https://api.fluxrouter.ai/v1", FUIGO_ALLOW_UPSTREAM_HOSTS: "1", LANG: "C.UTF-8", TERM: "dumb",
};
const environment = (scratch: string[] = []) => json<{ env: Record<string, string>; dropped: string[] }>(
  `env,dropped=m.engine_environment("fuigoAgent",sys.argv[2],json.loads(sys.argv[3]),scratch=json.loads(sys.argv[4]));print(json.dumps({"env":env,"dropped":dropped}))`,
  rig.home("fuigoAgent"), JSON.stringify(hostile), JSON.stringify(scratch));

describe("C1: fail_closed comes first in every requirements copy", () => {
  it("renders it as the first line of $FUIGO_HOME/requirements.toml with every pin, unrouted and routed", () => {
    const h = rig.home("fuigoAgent");
    for (const [label, request, state] of [
      ["unrouted", rig.request("fuigoAgent"), `${h}/.fuigo`],
      ["routed", rig.request("fuigoAgent", { scratch: [SCRATCH], render: { route } }), `${h}/${SCRATCH}`],
    ] as const) {
      const text = ok(request).files[`${state}/requirements.toml`];
      expect(text.startsWith("fail_closed = true\nallow_managed_hooks_only = true\n["), label).toBe(true);
      for (const pin of PINS) expect(text, label).toContain(pin);
    }
  });
  it("is byte-identical to the file the image installs", () => {
    const constant = json<string>("print(json.dumps(m.FUIGO_REQUIREMENTS))");
    expect(readFileSync(new URL("../../deploy/cloud-home/managed/fuigo-requirements.toml", import.meta.url), "utf8")).toBe(constant);
    expect(constant.startsWith("fail_closed = true\nallow_managed_hooks_only = true\n[")).toBe(true);
    // Top-level keys only before the first table: a key after a [table] would belong to that table.
    expect(constant.slice(0, constant.indexOf("["))).toBe("fail_closed = true\nallow_managed_hooks_only = true\n");
  });
});

describe("C2: the sandbox root is the last mount op and read-only", () => {
  it.each(CLOUD_TURN_ENGINES)("%s: ... --ro-bind-data @fd:resolv /etc/resolv.conf --remount-ro / --chdir <cwd> --", engine => {
    const { argv } = ok(rig.request(engine, { args: MINIMAL_ARGV[engine] }));
    const chdir = argv.indexOf("--chdir");
    expect(argv.slice(chdir - 5, chdir + 3)).toEqual(["--ro-bind-data", "@fd:resolv", "/etc/resolv.conf", "--remount-ro", "/", "--chdir", rig.home(engine), "--"]);
    expect(argv.lastIndexOf("--remount-ro")).toBe(chdir - 2);
    expect(argv.filter((arg, index) => arg === "--remount-ro" && argv[index + 1] === "/").length).toBe(1);
  });
  it("is not counted among the read-only shadows", () => {
    expect(ok(rig.request("fuigoAgent")).readOnly).not.toContain("/");
  });
});

describe("environment: the FUIGO_ prefix scrub, pinned home and policy gates (N1, N3)", () => {
  it("drops every override and OTEL name, keeps nothing the proposal set outside the allowlist", () => {
    const { env, dropped } = environment();
    for (const name of [...OVERRIDES, ...OTEL]) { expect(dropped, name).toContain(name); expect(env, name).not.toHaveProperty(name); }
    expect(Object.keys(env).filter(name => name.startsWith("OTEL_"))).toEqual([]);
    const allowed = json<string[]>(`print(json.dumps(sorted(m.ENGINE_ENV_ALLOW["fuigoAgent"])))`);
    // FUIGO_KEYED_PIN is pinned per turn, only on a keyed turn (this proposal carries FUIGO_API_KEY).
    const pinned = json<string[]>(`print(json.dumps(sorted(list(m.pinned_environment("fuigoAgent",sys.argv[2]))+list(m.FUIGO_KEYED_PIN))))`, rig.home("fuigoAgent"));
    for (const name of Object.keys(env).filter(name => name.startsWith("FUIGO_"))) expect(allowed.includes(name) || pinned.includes(name), name).toBe(true);
  });
  it("N3: FUIGO_MANAGED_CONFIG_FAIL_CLOSED survives as 1, pinned, and is not among the dropped names", () => {
    const { env, dropped } = environment();
    expect(env.FUIGO_MANAGED_CONFIG_FAIL_CLOSED).toBe("1");
    expect(dropped).not.toContain("FUIGO_MANAGED_CONFIG_FAIL_CLOSED");
    expect(json<Record<string, string>>(`print(json.dumps(m.ENGINE_ENV_PIN["fuigoAgent"]))`).FUIGO_MANAGED_CONFIG_FAIL_CLOSED).toBe("1");
  });
  it("N1: FUIGO_ENVRC_TIMEOUT_SECS is 0 for the child whatever the request says, and is not dropped", () => {
    const { env, dropped } = environment();
    expect(env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
    expect(dropped).not.toContain("FUIGO_ENVRC_TIMEOUT_SECS");
    expect(ok(rig.request("fuigoAgent", { env: { FUIGO_ENVRC_TIMEOUT_SECS: "30" } })).env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
  });
  it("N3: a routed turn's FUIGO_HOME is its scratch dir, an unrouted turn's is $HOME/.fuigo; HOME is the engine home for both", () => {
    const h = rig.home("fuigoAgent");
    const unrouted = environment().env, routed = environment([`${h}/${SCRATCH}`]).env;
    expect(unrouted.FUIGO_HOME).toBe(`${h}/.fuigo`);
    expect(routed.FUIGO_HOME).toBe(`${h}/${SCRATCH}`);
    expect(routed.FUIGO_HOME).not.toBe(`${h}/.fuigo`);
    for (const env of [unrouted, routed]) { expect(env.HOME).toBe(h); expect(env.TMPDIR).toBe(`${h}/tmp`); expect(env.PATH).not.toContain("evil"); }
    // The same through validate_request, the path launch() takes, with the hostile names in the request.
    const request = { env: Object.fromEntries(Object.entries(hostile).filter(([name]) => name !== "FUIGO_CONFIG")) };
    expect(ok(rig.request("fuigoAgent", request)).env.FUIGO_HOME).toBe(`${h}/.fuigo`);
    // A routed turn's base names are the route's own base (check_fuigo_base_env).
    const routedEnv = { ...request.env, FUIGO_API_BASE_URL: route.baseUrl, FUIGO_MODELS_BASE_URL: route.baseUrl };
    expect(ok(rig.request("fuigoAgent", { ...request, env: routedEnv, scratch: [SCRATCH], render: { route } })).env.FUIGO_HOME).toBe(`${h}/${SCRATCH}`);
  });
  it("keeps the allowed route names and the launcher's gate values", () => {
    const { env } = environment();
    expect(env).toMatchObject({ FUIGO_API_KEY: "sk-probe", MURAGE_PROVIDER_API_KEY: "sk-route", FUIGO_API_BASE_URL: "https://api.fluxrouter.ai/v1", FUIGO_MODELS_BASE_URL: "https://api.fluxrouter.ai/v1",
      FUIGO_SUBAGENTS: "0", FUIGO_DISABLE_MODEL_REFRESH: "1", FUIGO_CLAUDE_MCPS_ENABLED: "0" });
  });
  it("scrubs any FUIGO_ name by prefix, even one an allowlist edit let through", () => {
    const out = json<{ env: Record<string, string>; dropped: string[] }>(
      `m.COMMON_ENV=m.COMMON_ENV|{"FUIGO_LEAK"}\nenv,dropped=m.engine_environment("fuigoAgent",sys.argv[2],{"FUIGO_LEAK":"1","LANG":"C"});print(json.dumps({"env":env,"dropped":dropped}))`, rig.home("fuigoAgent"));
    expect(out.env).not.toHaveProperty("FUIGO_LEAK");
    expect(out.dropped).toContain("FUIGO_LEAK");
    expect(out.env.LANG).toBe("C");
  });
  it("refuses a malformed FUIGO_CONFIG, and an allowlist that names an override or path variable", () => {
    expect(refused(rig.request("fuigoAgent", { env: { FUIGO_CONFIG: JSON.stringify({ cli: { use_leader: true } }) } }))).toBe("Cloud engine environment FUIGO_CONFIG is malformed");
    const check = (name: string) => json<string>(`try:\n    m.check_env_allowlist({"fuigoAgent":frozenset({sys.argv[2]})});print(json.dumps("accepted"))\nexcept ValueError as e:\n    print(json.dumps(str(e)))`, name);
    expect(check("FUIGO_CONFIG_PATH")).toMatch(/names a path variable/u);
    expect(check("FUIGO_HOME")).toMatch(/names a path variable/u);
    expect(check("FUIGO_SANDBOX_MODE")).toMatch(/names an override variable/u);
    expect(check("FUIGO_AUTH")).toMatch(/names an override variable/u);
    expect(check("FUIGO_ALLOW_UPSTREAM_HOSTS")).toBe("accepted");
    expect(check("FUIGO_CONFIG")).toBe("accepted");
  });
});

describe("--trust (design 3.6)", () => {
  const args = ["--permission-mode", "default", "--trust", "--no-memory", "agent", "--no-leader", "stdio"];
  it("is accepted, writes nothing outside $FUIGO_HOME, and no trust list is rendered or collected", () => {
    const h = rig.home("fuigoAgent"), cwd = `${rig.workspaces}/ws/proj/sub`;
    const plan = ok(rig.request("fuigoAgent", { cwd, args }));
    expect(plan.args).toEqual(args);
    expect(plan.env.FUIGO_HOME).toBe(`${h}/.fuigo`);
    expect(Object.keys(plan.files).filter(path => path.endsWith("trusted_folders.toml"))).toEqual([]);
    expect(plan.binds).toContainEqual([`${plan.turnHome}/.fuigo`, `${h}/.fuigo`]);
    expect(json<unknown[]>(`print(json.dumps(list(m.PERSISTED_STATE["fuigoAgent"])))`)).toEqual([]);
  });
  it("on a routed turn the grant lives in the scratch tmpfs", () => {
    const h = rig.home("fuigoAgent"), cwd = `${rig.workspaces}/ws/proj/sub`;
    const plan = ok(rig.request("fuigoAgent", { cwd, args, scratch: [SCRATCH], render: { route } }));
    expect(plan.env.FUIGO_HOME).toBe(`${h}/${SCRATCH}`);
    expect(plan.tmpfs).toContain(`${h}/${SCRATCH}`);
  });
});

describe("masks: every .fuigo under the grant root (design 3.5, N2)", () => {
  const ws = () => `${rig.workspaces}/ws`, cwd = () => `${ws()}/proj/sub`;
  const plant = (...dirs: string[]) => { for (const dir of dirs) mkdirSync(`${dir}/.fuigo`, { recursive: true }); };
  it("masks .fuigo above, at, below and beside cwd as read-only tmpfs mounts", () => {
    mkdirSync(`${cwd()}/deeper`); mkdirSync(`${ws()}/other`);
    plant(ws(), `${ws()}/proj`, cwd(), `${cwd()}/deeper`, `${ws()}/other`);
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }));
    for (const dir of [ws(), `${ws()}/proj`, cwd(), `${cwd()}/deeper`, `${ws()}/other`]) {
      expect(plan.readOnly, dir).toContain(`${dir}/.fuigo`);
      expect(plan.tmpfs, dir).toContain(`${dir}/.fuigo`);
    }
  });
  it("walks only for Fuigo, and not at all when cwd is the engine home", () => {
    mkdirSync(`${ws()}/other`); plant(`${ws()}/other`);
    expect(ok(rig.request("fuigoAgent")).readOnly.some(path => path.startsWith(rig.workspaces))).toBe(false);
    expect(ok(rig.request("codex", { cwd: cwd() })).readOnly).not.toContain(`${ws()}/other/.fuigo`);
    expect(ok(rig.request("fuigoAgent", { cwd: cwd() })).readOnly).toContain(`${ws()}/other/.fuigo`);
  });
  it("does not follow symlinks", () => {
    mkdirSync(`${rig.root}/elsewhere/.fuigo`, { recursive: true }); symlinkSync(`${rig.root}/elsewhere`, `${ws()}/link`);
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }));
    expect(plan.readOnly).not.toContain(`${ws()}/link/.fuigo`);
  });
  it("H1: enters a .claude, .codex or any masked name that is not itself shadowed, and masks the .fuigo inside it", () => {
    // Fuigo can be pointed at any directory as its git root (core.worktree, a .git file), so a repository
    // can hide .fuigo/hooks under a name the walk used to skip.
    const inside = [`${cwd()}/sub/.claude/payload`, `${ws()}/other/.codex/inner`, `${ws()}/other/.grok/a/.opencode/b`, `${ws()}/proj/.kimi-code/x`];
    mkdirSync(`${cwd()}/sub`); mkdirSync(`${ws()}/other`);
    plant(...inside);
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }));
    for (const dir of inside) { expect(plan.readOnly, dir).toContain(`${dir}/.fuigo`); expect(plan.tmpfs, dir).toContain(`${dir}/.fuigo`); }
  });
  it("H1: does not enter a directory the plan already shadows whole (cwd's masked names, .claude along the chain)", () => {
    const hidden = [`${cwd()}/.claude/inner`, `${cwd()}/.codex/inner`, `${ws()}/proj/.claude/inner`, `${ws()}/.claude/inner`];
    plant(...hidden);
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }));
    for (const dir of hidden) expect(plan.readOnly, dir).not.toContain(`${dir}/.fuigo`);
  });
  it("H1: a mask inside a non-shadowed .claude below the bound cwd gets the immutable placeholder", () => {
    const payload = `${cwd()}/sub/.claude/payload`;
    mkdirSync(`${cwd()}/sub`); plant(payload);
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }), { place: true });
    expect(plan.placed).toContain(`${realpathSync(cwd())}/sub/.claude/payload/.fuigo`);
    expect(plan.readOnly).toContain(`${payload}/.fuigo`);
  });
  it("H1: a traversal error refuses the turn instead of skipping the directory", () => {
    mkdirSync(`${ws()}/other`);
    const out = json<{ error: string }>(`
real=os.walk
def failing(top, topdown=True, onerror=None, followlinks=False):
    if onerror:
        onerror(OSError(13, "Permission denied", top + "/other"))
    return iter(())
os.walk=failing
try:
    m.fuigo_walk_masks("/nonexistent-home", sys.argv[2]);error=""
except m.Refusal as e:
    error=str(e)
os.walk=real
print(json.dumps({"error":error}))`, cwd());
    expect(out.error).toBe("Cloud turn workspace cannot be walked");
  });
  it("refuses a .fuigo that is a symlink or a regular file, anywhere under the grant root", () => {
    mkdirSync(`${ws()}/other`); mkdirSync(`${cwd()}/deeper`);
    symlinkSync("/tmp", `${ws()}/other/.fuigo`);
    expect(refused(rig.request("fuigoAgent", { cwd: cwd() }))).toBe("Cloud turn mask path is contested: .fuigo");
    rmSync(`${ws()}/other/.fuigo`); writeFileSync(`${cwd()}/deeper/.fuigo`, "x");
    expect(refused(rig.request("fuigoAgent", { cwd: cwd() }))).toBe("Cloud turn mask path is contested: .fuigo");
  });
  it("refuses MASK_MAX + 1 planted directories and a walk past WALK_DIRS_MAX", () => {
    for (const name of ["a", "b", "c", "d"]) { mkdirSync(`${ws()}/${name}`); plant(`${ws()}/${name}`); }
    expect(refused(rig.request("fuigoAgent", { cwd: cwd() }), { set: { MASK_MAX: 3 } })).toBe("Cloud turn workspace is too large to mask");
    expect(rig.plan(rig.request("fuigoAgent", { cwd: cwd() }), { set: { MASK_MAX: 4 } }).ok).toBeDefined();
    expect(refused(rig.request("fuigoAgent", { cwd: cwd() }), { set: { WALK_DIRS_MAX: 3 } })).toBe("Cloud turn workspace is too large to mask");
  });
  it("N2: a mask below the bound cwd gets the immutable placeholder; masks outside the bound directory and the cwd's own are left to the existing path", () => {
    mkdirSync(`${cwd()}/deeper/deepest`, { recursive: true }); mkdirSync(`${ws()}/other`);
    plant(cwd(), `${cwd()}/deeper`, `${cwd()}/deeper/deepest`, `${ws()}/other`, ws());
    const plan = ok(rig.request("fuigoAgent", { cwd: cwd() }), { place: true });
    const real = realpathSync(cwd());
    // The rig records the immutable ioctl instead of making it (no CAP_LINUX_IMMUTABLE here).
    expect(plan.placed).toContain(`${real}/deeper/.fuigo`);
    expect(plan.placed).toContain(`${real}/deeper/deepest/.fuigo`);
    expect(plan.placed.filter(path => path === `${real}/.fuigo`).length).toBe(1);
    expect(plan.placed.some(path => path.includes("/other/") || path === `${realpathSync(ws())}/.fuigo`)).toBe(false);
    for (const dir of [`${cwd()}/deeper`, `${cwd()}/deeper/deepest`]) expect(plan.readOnly).toContain(`${dir}/.fuigo`);
  });
  it("N2: the freeze is fd-relative from the bound directory, so a path swapped for a symlink since the walk refuses the turn", () => {
    mkdirSync(`${cwd()}/deeper`); plant(`${cwd()}/deeper`);
    const out = json<{ before: string[]; error: string }>(`
frozen=[]
m.set_immutable=lambda fd: frozen.append(os.readlink("/proc/self/fd/%d"%fd))
cwd=sys.argv[2]
masks=m.fuigo_walk_masks("/nonexistent-home",cwd)
m.walk_placeholders(masks,[(cwd,cwd)])
before=list(frozen)
os.rename(cwd+"/deeper",cwd+"/moved")
os.symlink(cwd+"/moved",cwd+"/deeper")
try:
    m.walk_placeholders(masks,[(cwd,cwd)]);error=""
except m.Refusal as e:
    error=str(e)
print(json.dumps({"before":before,"error":error}))`, cwd());
    expect(out.before).toEqual([`${realpathSync(cwd())}/deeper/.fuigo`]);
    expect(out.error).toBe("Cloud turn mask path is contested: .fuigo");
  });
  it("N2: a mask removed between the walk and the freeze is put back as a placeholder, never left absent", () => {
    mkdirSync(`${cwd()}/deeper`); plant(`${cwd()}/deeper`);
    const out = json<{ exists: boolean; frozen: string[] }>(`
frozen=[]
m.set_immutable=lambda fd: frozen.append(os.readlink("/proc/self/fd/%d"%fd))
cwd=sys.argv[2]
masks=m.fuigo_walk_masks("/nonexistent-home",cwd)
os.rmdir(cwd+"/deeper/.fuigo")
m.walk_placeholders(masks,[(cwd,cwd)])
print(json.dumps({"exists":os.path.isdir(cwd+"/deeper/.fuigo"),"frozen":frozen}))`, cwd());
    expect(out.exists).toBe(true);
    expect(out.frozen).toEqual([`${realpathSync(cwd())}/deeper/.fuigo`]);
  });
  it("N2: launch() walks once, freezes that list and hands the same list to the mount plan", () => {
    const source = readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8");
    const launch = source.slice(source.indexOf("\ndef launch(request"));
    expect(launch).toContain("walk_masks = fuigo_walk_masks(home, cwd) if engine == \"fuigoAgent\" else []");
    expect(launch).toContain("walk_masks=walk_masks)");
    expect(launch).toContain("turn, walk_masks)");
    expect(launch.indexOf("anchor_mounts(mounts)")).toBeLessThan(launch.indexOf("fuigo_walk_masks(home, cwd)"));
    expect(source.slice(source.indexOf("\ndef run_frozen(")).indexOf("walk_placeholders(walk_masks, anchors)")).toBeGreaterThan(0);
  });
});
