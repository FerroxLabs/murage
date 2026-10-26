// SPDX-License-Identifier: AGPL-3.0-or-later
// r4, the state allowlist (CLOUD-ENGINES-DESIGN.md; Astra r2 H x3 closed as a class): a turn's $HOME is a
// launcher-owned tmpfs that starts empty. Root copies in exactly the allowlisted state files
// (PERSISTED_STATE: sign-in tokens and the one conversation the turn resumes), each checked against its
// shape, and copies them back after the turn the same way. The disk home is never mounted into a turn, so
// nothing else a turn writes (config, instructions, trust lists, hooks, plugins, managed files, sessions it
// was not asked to resume) exists for the next one. Workspace masks are unconditional, so the window between
// an existence check and bwrap's mount, in which another turn could plant <cwd>/.claude/settings.json, is gone.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_TURN_ENGINES, FIXTURE_BOT, MINIMAL_ARGV, launcherRig, signinStore, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-fresh-home-"); });
afterEach(() => rig.dispose());

const RESUME = "0f1e2d3c-4b5a-4968-8776-655443322110", SESSION = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", FOREIGN = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";
const ROLLOUT = (id: string) => `.codex/sessions/2026/10/16/rollout-2026-10-16T00-00-00-${id}.jsonl`;
// r9 "state scopes": a bot's conversation state lives in bots/<bot>/, its B-mode sign-in set in the
// versioned store bots/<bot>/signin/ (r8 R2: `current` names generation 1, relative to the engine home).
const SIGNIN = [".codex/auth.json", ".grok/auth.json", ".kimi-code/credentials/", ".local/share/opencode/auth.json"];
const isSignin = (relative: string) => SIGNIN.some(p => relative === p || (p.endsWith("/") && relative.startsWith(p)));
const STORE = (relative: string, bot = FIXTURE_BOT) => `bots/${bot}/${isSignin(relative) ? "signin/1/" : ""}${relative}`;
/** `before` entries for an engine's state: sign-in files as a B store generation, the rest in the bot store. */
const planted = (engine: string, files: Record<string, string>) => {
  const signin = Object.fromEntries(Object.entries(files).filter(([relative]) => isSignin(relative)));
  return { ...Object.fromEntries(Object.entries(files).filter(([relative]) => !isSignin(relative)).map(([relative, text]) => [STORE(relative), text])),
    ...(Object.keys(signin).length ? signinStore(engine, signin) : {}) };
};
const POLICY = { approval: "on-request", sandbox: "workspace-write" };

// Resolves, per path, what the sandbox shows there, the way bwrap stacks mounts (the last mount covering a
// path wins): "host" (present in the staged turn home or the cwd bind), "absent" (covered by a bind but not
// there), "fresh" (a tmpfs this turn started empty) or "rendered" (a launcher-rendered read-only file).
const view = (request: Record<string, unknown>, paths: string[], plant: Record<string, string> = {}) => JSON.parse(rig.py(`
import tempfile
cfg=json.loads(sys.argv[2])
m.MCP_PROXY_ROOT=cfg["proxyRoot"]; m.WORKSPACE_ROOT=cfg["workspaces"]
request=cfg["request"]
try:
    engine,home,cwd,command,args,env,render,bot=m.validate_request(request,manifest_path=cfg["manifest"],manifest_uid=os.getuid(),engine_root=cfg["engineRoot"],cache_root=cfg["cache"])
    turn_home=tempfile.mkdtemp(prefix="turn-home-",dir=cfg["root"])
    hfd=os.open(home,os.O_RDONLY|os.O_DIRECTORY); tfd=os.open(turn_home,os.O_RDONLY|os.O_DIRECTORY)
    staged=m.stage_turn_home(hfd,engine,tfd,None,(os.getuid(),),m.turn_state_ids(engine,args,render),bot=bot,cwd=cwd,render=render); os.close(hfd); os.close(tfd)
    mounts=[(cwd,cwd)] if cwd!=home else []
    argv,blobs=m.turn_mount_args(engine,mounts,home,cwd,command,args,render,request.get("scratch",[]),turn_home=turn_home)
except ValueError as error:
    print(json.dumps({"error":str(error)})); sys.exit(0)
# The race: whatever another turn plants after the plan is built and before bwrap runs.
for relative,text in cfg["plant"].items():
    os.makedirs(os.path.dirname(relative),exist_ok=True); open(relative,"w").write(text)
options=argv[:argv.index("--")]
ops=[]
for i,a in enumerate(options):
    if a in ("--bind","--ro-bind"): ops.append(("host",options[i+1],options[i+2]))
    elif a=="--tmpfs": ops.append(("fresh",None,options[i+1]))
    elif a=="--ro-bind-data": ops.append(("rendered",None,options[i+2]))
def resolve(path):
    kind,source,dest="none",None,None
    for k,s,d in ops:
        if path==d or path.startswith(d+"/"): kind,source,dest=k,s,d
    if kind=="host":
        return "host" if os.path.lexists(source+path[len(dest):]) else "absent"
    return kind
dests=[d for _,_,d in ops]+[options[i+1] for i,a in enumerate(options) if a=="--dir"]
print(json.dumps({"view":{p:resolve(p) for p in cfg["paths"]},"dests":dests,"turnHome":turn_home,"staged":staged,"tmpfs":[d for k,_,d in ops if k=="fresh"]}))`, JSON.stringify({ request, paths, plant, proxyRoot: rig.proxyRoot, workspaces: rig.workspaces,
  manifest: rig.manifest, engineRoot: rig.engineRoot, root: rig.root, cache: join(rig.root, "digest-cache") })));
const plant = (path: string, text = "planted by a previous turn") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

// What a previous turn can leave in its home that the engine would read at start: none of it is in
// PERSISTED_STATE, so none of it may exist in the turn's home (Astra r1 H, r2 H: Grok's managed and
// requirements tiers, CLAUDE.md, Fuigo's trusted_folders.toml, every hook, plugin, skill, cache and rc file).
const COMMON = [".bashrc", ".profile", ".gitconfig", ".npmrc", ".cache/planted", ".local/state/planted", "tmp/planted", ".config/git/config"];
const HIDDEN: Record<string, string[]> = {
  claudeAgent: [".claude.json", ".claude/CLAUDE.md", ".claude/hooks/stop.sh", ".claude/plugins/installed_plugins.json", ".claude/skills/x/SKILL.md", ".claude/shell-snapshots/s.sh",
    ".claude/projects/p/" + FOREIGN + ".jsonl", ".claude/projects/p/" + FOREIGN + "/subagents/a.jsonl", ".claude/.credentials.json.bak", ".claude/statsig/x"],
  codex: [".codex/config.toml.bak", ".codex/hooks/x.sh", ".codex/skills/x/SKILL.md", ".codex/rules/x.toml", ".codex/history.jsonl", ".codex/state_5.sqlite", ROLLOUT(FOREIGN), ".codex/archived_sessions/" + ROLLOUT(FOREIGN).slice(".codex/sessions/".length), ".agents/skills/x/SKILL.md"],
  grokAgent: [".grok/managed_config.toml", ".grok/requirements.toml", ".grok/hooks/x.sh", ".grok/plugins/x/plugin.toml", ".grok/sessions/s.json", ".claude/skills/x/SKILL.md", ".cursor/hooks.json"],
  kimiAgent: [".kimi-code/hooks/x.sh", ".kimi-code/credentials/planted.toml", ".kimi-code/credentials/nested/x.json", ".kimi-code/sessions/s.json", ".claude/skills/x/SKILL.md", ".codex/skills/x/SKILL.md"],
  opencodeGo: [".local/share/opencode/snapshot/git/config", ".local/share/opencode/storage/session/s.json", ".cache/opencode/models.json", ".cache/opencode/bin/rg", ".local/state/opencode/model.json", ".config/opencode/plugin/x.js"],
  fuigoAgent: [".fuigo/trusted_folders.toml", ".fuigo/hooks/x.sh", ".fuigo/plugins/x/plugin.toml", ".fuigo/sessions/s.json", ".fuigo/auth.json", ".claude/settings.json", ".claude.json"],
};
// Each engine's allowlisted state: copied in from the bot's stores (STORE), within its shape. Claude's
// .credentials.json and OpenCode's api entries are C-mode sign-ins: rendered, never staged.
const KEPT: Record<string, Record<string, string>> = {
  claudeAgent: { ".claude/.claude.json": '{"hasCompletedOnboarding":true,"oauthAccount":{"emailAddress":"o@x"},"mcpServers":{"evil":{"command":"/bin/true"}},"projects":{"/x":{"allowedTools":["Bash"]}}}' },
  codex: { ".codex/auth.json": '{"tokens":{"access_token":"t"}}' },
  grokAgent: { ".grok/auth.json": '{"token":"t"}' },
  kimiAgent: { ".kimi-code/credentials/kimi-code.json": '{"accessToken":"t"}', ".kimi-code/credentials/kimi-code-env-0e4f99c69cc27850.json": "{}" },
  opencodeGo: { ".local/share/opencode/auth.json": '{"anthropic":{"type":"oauth","refresh":"r","access":"a","expires":1}}' },
  fuigoAgent: {},
};

describe.each(CLOUD_TURN_ENGINES)("%s", engine => {
  it("starts a turn with its sign-in and nothing else a previous turn left: no cache, registry, hook, rc file, catalog, managed tier, trust list or foreign session", () => {
    const h = rig.home(engine);
    const hidden = [...COMMON, ...HIDDEN[engine]].map(relative => `${h}/${relative}`);
    for (const path of hidden) plant(path);
    // The OpenCode case Astra built: a cached catalog naming a local module as a provider SDK.
    if (engine === "opencodeGo") plant(`${h}/.cache/opencode/models.json`, JSON.stringify({ opencode: { npm: `file://${h}/persisted-sdk.mjs`, models: {} } }));
    for (const [relative, text] of Object.entries(planted(engine, KEPT[engine]))) plant(`${h}/${relative}`, text);
    const kept = Object.keys(KEPT[engine]).map(relative => `${h}/${relative}`);
    const result = view(rig.request(engine), [...hidden, ...kept]);
    expect(result.error).toBeUndefined();
    for (const path of hidden) expect([path, result.view[path]]).not.toEqual([path, "host"]);
    for (const path of kept) expect([path, result.view[path]]).toEqual([path, "host"]);
    expect(Object.keys(result.staged).sort()).toEqual(Object.keys(KEPT[engine]).sort());
    // The staged copy is the shape-checked bytes; nothing of the disk home is bound.
    for (const [relative, text] of Object.entries(KEPT[engine])) {
      const staged = readFileSync(`${result.turnHome}/${relative}`, "utf8");
      if (relative.endsWith(".claude.json")) { expect(JSON.parse(staged)).toEqual({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "o@x" } }); } else expect(staged).toBe(text);
    }
    expect(result.dests.filter((d: string) => d === h || d.startsWith(`${h}/`)).length).toBeGreaterThan(0);
    for (const entry of readdirSync(result.turnHome)) expect([".claude", ".codex", ".grok", ".kimi-code", ".config", ".local", ".fuigo"]).toContain(entry);
  });
  it("refuses an allowlisted file with a bad shape and leaves it on disk", () => {
    const h = rig.home(engine);
    if (engine === "fuigoAgent") { expect(JSON.parse(rig.py(`print(json.dumps(m.PERSISTED_STATE["fuigoAgent"]))`))).toEqual([]); return; }
    const [relative] = Object.keys(KEPT[engine]);
    for (const bad of ["not json", "[]", '"str"', "{", "\u0000"]) {
      for (const [path, text] of Object.entries(planted(engine, { [relative]: bad }))) plant(`${h}/${path}`, text);
      const out = rig.py(`
import io,contextlib,tempfile
home=sys.argv[2];engine=sys.argv[3];turn=tempfile.mkdtemp()
err=io.StringIO()
hfd=os.open(home,os.O_RDONLY|os.O_DIRECTORY);tfd=os.open(turn,os.O_RDONLY|os.O_DIRECTORY)
with contextlib.redirect_stderr(err): staged=m.stage_turn_home(hfd,engine,tfd,None,(os.getuid(),),(frozenset(),frozenset()),bot=sys.argv[5])
print(json.dumps({"staged":staged,"err":err.getvalue(),"exists":os.path.exists(turn+"/"+sys.argv[4])}))`, h, engine, relative, FIXTURE_BOT);
      const r = JSON.parse(out);
      expect([bad, r]).toEqual([bad, { staged: {}, err: `Cloud engine state file refused: ${relative}\n`, exists: false }]);
      expect(readFileSync(`${h}/${STORE(relative)}`, "utf8")).toBe(bad);
    }
  });
});

describe("what comes back from a turn (collect_turn_home)", () => {
  // Stage, let "the turn" write into the turn home, collect; returns what the disk home holds afterwards
  // (paths relative to the engine home, so a bot store's files read "bots/<bot>/...").
  const roundTrip = (engine: string, args: string[], render: Record<string, unknown> | null, before: Record<string, string>, during: Record<string, string | null>) =>
    rig.turn({ engine, args, render, before, during });
  const store = (relative: string) => STORE(relative);
  const inStore = (files: Record<string, string>, engine = "claudeAgent") => planted(engine, files);
  const outsideStore = (disk: Record<string, string>) => Object.keys(disk).filter(path => !path.startsWith(`bots/${FIXTURE_BOT}/`));

  it("writes back a changed credential, removes one the CLI signed out of, and drops everything else the turn wrote", () => {
    const r = roundTrip("codex", MINIMAL_ARGV.codex, null, inStore({ ".codex/auth.json": '{"tokens":{"access_token":"old"}}' }, "codex"),
      { ".codex/auth.json": '{"tokens":{"access_token":"refreshed"}}', ".codex/config.toml": "[mcp_servers.evil]\ncommand = '/bin/true'\n", ".codex/hooks/x.sh": "#!/bin/sh", ".codex/history.jsonl": "{}\n", ".bashrc": "evil", ".codex/sessions/2026/10/16/notes.txt": "x" });
    expect(r.changed).toEqual([".codex/auth.json"]);
    // The refresh is the store's next generation; nothing else the turn wrote reaches the disk.
    expect(r.published).toEqual([{ engine: "codex", bot: FIXTURE_BOT, files: { ".codex/auth.json": '{"tokens":{"access_token":"refreshed"}}' }, kind: "refresh" }]);
    expect(r.disk[`bots/${FIXTURE_BOT}/signin/current`]).toBe("2\n");
    expect(r.disk[`bots/${FIXTURE_BOT}/signin/2/.codex/auth.json`]).toBe('{"tokens":{"access_token":"refreshed"}}');
    expect(Object.keys(r.disk).filter(path => !path.startsWith(`bots/${FIXTURE_BOT}/signin/`))).toEqual([]);
    const gone = roundTrip("codex", MINIMAL_ARGV.codex, null, inStore({ ".codex/auth.json": '{"tokens":{"access_token":"old"}}' }, "codex"), { ".codex/auth.json": null });
    expect(gone.changed).toEqual([".codex/auth.json"]);
    expect(gone.published).toEqual([{ engine: "codex", bot: FIXTURE_BOT, files: {}, kind: "signout" }]);
    expect(Object.keys(gone.disk).filter(path => path.startsWith(`bots/${FIXTURE_BOT}/signin/2/`))).toEqual([`bots/${FIXTURE_BOT}/signin/2/record.json`]);
  });
  it("keeps the disk copy when the turn left a bad shape or a symlink at an allowlisted path, and names the file", () => {
    for (const during of ["not json", "[1]", "@symlink:/etc/passwd"]) {
      const before = { ...inStore({ ".grok/auth.json": '{"token":"good"}' }, "grokAgent"), ".grok/managed_config.toml": "planted" };
      const r = roundTrip("grokAgent", MINIMAL_ARGV.grokAgent, null, before, { ".grok/auth.json": during, ".grok/requirements.toml": "[hooks]\n" });
      expect([during, r.changed, r.disk, r.err, r.published]).toEqual([during, [], before, `Cloud engine state file refused: .grok/auth.json\n`, []]);
    }
  });
  it("persists only the session a Claude turn resumed or started, in the bot's store: --resume comes in, --resume and --session-id go out, a foreign id neither way", () => {
    const base = MINIMAL_ARGV.claudeAgent.filter(a => a !== "--session-id" && a !== SESSION);
    const r = roundTrip("claudeAgent", [...base, "--resume", RESUME, "--session-id", SESSION], null,
      inStore({ [`.claude/projects/p/${RESUME}.jsonl`]: '{"type":"user"}\n', [`.claude/projects/p/${RESUME}/subagents/a.jsonl`]: '{"type":"user"}\n', [`.claude/projects/p/${RESUME}/tool-results/r.txt`]: "big output",
        [`.claude/projects/p/${FOREIGN}.jsonl`]: '{"type":"user"}\n', [`.claude/projects/p/${SESSION}.jsonl`]: '{"type":"user"}\n', ".claude/CLAUDE.md": "instructions" }),
      { [`.claude/projects/p/${RESUME}.jsonl`]: '{"type":"user"}\n{"type":"assistant"}\n', [`.claude/projects/p/${SESSION}.jsonl`]: '{"type":"user"}\n', [`.claude/projects/p/${FOREIGN}.jsonl`]: '{"type":"user"}\n{"type":"x"}\n',
        [`.claude/projects/p/${SESSION}/subagents/b.jsonl`]: '{"type":"assistant"}\n', [`.claude/projects/p/${SESSION}/tool-results/x.txt`]: "out", ".claude/CLAUDE.md": "turn-written", ".claude/settings.json": '{"hooks":{}}' });
    expect(Object.keys(r.snapshot).sort()).toEqual([`.claude/projects/p/${RESUME}.jsonl`, `.claude/projects/p/${RESUME}/subagents/a.jsonl`]);
    expect(r.changed).toEqual([`.claude/projects/p/${RESUME}.jsonl`, `.claude/projects/p/${SESSION}.jsonl`, `.claude/projects/p/${SESSION}/subagents/b.jsonl`].sort());
    expect(r.disk[store(`.claude/projects/p/${RESUME}.jsonl`)]).toBe('{"type":"user"}\n{"type":"assistant"}\n');
    expect(r.disk[store(`.claude/projects/p/${FOREIGN}.jsonl`)]).toBe('{"type":"user"}\n');
    expect(r.disk[store(".claude/CLAUDE.md")]).toBe("instructions");
    expect(r.disk[store(".claude/settings.json")]).toBeUndefined();
    expect(r.disk[store(`.claude/projects/p/${SESSION}/tool-results/x.txt`)]).toBeUndefined();
    expect(outsideStore(r.disk)).toEqual([]);
  });
  it("persists only the Codex rollout named by render.resume on the way in and the one new rollout the turn wrote on the way out, in the bot's store", () => {
    const meta = (id: string) => JSON.stringify({ timestamp: "2026-10-16T00:00:00Z", type: "session_meta", payload: { id, timestamp: "2026-10-16T00:00:00Z", cwd: "/x", originator: "codex", cli_version: "0.162.1" } });
    const r = roundTrip("codex", MINIMAL_ARGV.codex, { resume: RESUME, codexPolicy: POLICY },
      inStore({ [ROLLOUT(RESUME)]: `${meta(RESUME)}\n`, [ROLLOUT(FOREIGN)]: "{}\n", ".codex/sessions/2026/10/16/notes.jsonl": "{}\n" }, "codex"),
      { [ROLLOUT(SESSION)]: `${meta(SESSION)}\n{"type":"response_item"}\n`, [ROLLOUT(FOREIGN)]: '{"bad":"line"\n', ".codex/sessions/2026/10/16/rollout-bad-name.jsonl": "{}\n" });
    expect(Object.keys(r.snapshot)).toEqual([ROLLOUT(RESUME)]);
    expect(r.changed).toEqual([ROLLOUT(SESSION)]);
    expect(r.disk[store(ROLLOUT(SESSION))]).toBe(`${meta(SESSION)}\n{"type":"response_item"}\n`);
    expect(r.disk[store(ROLLOUT(FOREIGN))]).toBe("{}\n");
    expect(r.err).toBe(`Cloud engine state file refused: ${ROLLOUT(FOREIGN)}\n`);
    expect(r.disk[store(".codex/sessions/2026/10/16/rollout-bad-name.jsonl")]).toBeUndefined();
  });
  it("filters Claude's CLI state to account and onboarding facts in both directions", () => {
    const r = roundTrip("claudeAgent", MINIMAL_ARGV.claudeAgent, null, inStore({ ".claude/.claude.json": '{"numStartups":1,"projects":{"/x":{"hasTrustDialogAccepted":true}}}' }),
      { ".claude/.claude.json": '{"numStartups":2,"oauthAccount":{"emailAddress":"o@x"},"mcpServers":{"evil":{"command":"/bin/true"}},"enabledPlugins":{"p":true},"customApiKeyResponses":{"approved":["k"]}}' });
    expect(r.changed).toEqual([".claude/.claude.json"]);
    expect(JSON.parse(r.disk[store(".claude/.claude.json")])).toEqual({ numStartups: 2, oauthAccount: { emailAddress: "o@x" } });
  });
  it("refuses a turn whose allowlisted state is over the cap, and never copies a file over the per-file cap", () => {
    const out = JSON.parse(rig.py(`
import tempfile
home=sys.argv[2]
store=home+"/bots/"+sys.argv[3]+"/signin"
os.makedirs(store+"/1/.grok",exist_ok=True);open(store+"/1/.grok/auth.json","w").write('{"t":"'+"x"*100+'"}')
open(store+"/1/record.json","w").write(json.dumps({"mode":"oauth","kind":"signin","enrolledAt":1,"expiresAt":None,"unit":None,"files":{".grok/auth.json":{"keys":["t"]}}}))
open(store+"/current","w").write("1\\n")
m.STATE_FILE_MAX=50
turn=tempfile.mkdtemp();hfd=os.open(home,os.O_RDONLY|os.O_DIRECTORY);tfd=os.open(turn,os.O_RDONLY|os.O_DIRECTORY)
import io,contextlib;err=io.StringIO()
with contextlib.redirect_stderr(err): staged=m.stage_turn_home(hfd,"grokAgent",tfd,None,(os.getuid(),),(frozenset(),frozenset()),bot=sys.argv[3])
m.STATE_FILE_MAX=64*1024*1024;m.STATE_TOTAL_MAX=50
try: m.stage_turn_home(hfd,"grokAgent",tfd,None,(os.getuid(),),(frozenset(),frozenset()),bot=sys.argv[3]);total="ok"
except ValueError as e: total=str(e)
print(json.dumps({"staged":staged,"err":err.getvalue(),"total":total}))`, rig.home("grokAgent"), FIXTURE_BOT));
    expect(out).toEqual({ staged: {}, err: "Cloud engine state file refused: .grok/auth.json\n", total: "Cloud engine state exceeds its limit" });
  });
  it("every allowlisted path is data inside a state directory, never a config or code file; a table edit outside that fails at load", () => {
    const out = JSON.parse(rig.py(`
out=[]
for table in [{"codex":(("x/y.json","json","signin"),)},{"codex":((".codex/config.toml","json","signin"),)},{"codex":((".codex/hooks/x.sh","json","signin"),)}]:
    m.PERSISTED_STATE=table
    try: m.check_state_tables();out.append("ok")
    except ValueError as e: out.append(str(e))
print(json.dumps(out))`));
    expect(out).toEqual(["Cloud state pattern is outside the engine's state directories: x/y.json", "Cloud state pattern names a config or code file: .codex/config.toml", "Cloud state pattern names a config or code file: .codex/hooks/x.sh"]);
  });
});

it("never binds the engine home whole, nor a state directory from disk", () => {
  expect(() => rig.py(`m.turn_mount_args("codex",[("/fixture/anchor","/fixture/home")],"/fixture/home","/fixture/home","/fixture/cli",[],None)`)).toThrow(/Cloud turn binds the whole engine home/u);
  expect(() => rig.py(`m.turn_mount_args("codex",[("/fixture/anchor","/fixture/home/.codex/sub")],"/fixture/home","/fixture/home/.codex/sub","/fixture/cli",[],None)`)).toThrow(/Cloud turn binds an engine state directory/u);
});

it("pins OpenCode's model catalog to the binary's own snapshot: no catalog fetch", () => {
  expect(rig.plan(rig.request("opencodeGo")).ok!.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
});

it("pins Fuigo's startup model refresh off, whatever the request says (Fuigo 1.0.32)", () => {
  expect(rig.plan(rig.request("fuigoAgent")).ok!.env.FUIGO_DISABLE_MODEL_REFRESH).toBe("1");
});

it("pins Fuigo's own subagents off: a request FUIGO_SUBAGENTS=1 is ignored", () => {
  expect(rig.plan(rig.request("fuigoAgent", { env: { FUIGO_SUBAGENTS: "1" } })).ok!.env.FUIGO_SUBAGENTS).toBe("0");
});

// The owner's workspace: every mask is mounted whether or not the path exists (no check-then-mount), only
// over directories, and no rendered file lands in the workspace, so bwrap can create at most an empty
// dot-directory as a mount point.
const tree = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name);
  return [path, ...(entry.isDirectory() ? tree(path) : [])];
}).sort();
const CHAIN_ARGS: Record<string, string[]> = {
  claudeAgent: [...MINIMAL_ARGV.claudeAgent, "--add-dir", "@extra"], codex: MINIMAL_ARGV.codex, grokAgent: MINIMAL_ARGV.grokAgent,
  kimiAgent: MINIMAL_ARGV.kimiAgent, opencodeGo: MINIMAL_ARGV.opencodeGo, fuigoAgent: MINIMAL_ARGV.fuigoAgent,
};
// r5 R5.1: every engine masks the union of every engine's project config names, not only its own.
const MASK_NAMES = [".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode"];

describe.each(CLOUD_TURN_ENGINES)("%s in a workspace", engine => {
  it("masks every project config directory unconditionally and places no file in the workspace", () => {
    const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`, extra = `${rig.workspaces}/other`;
    mkdirSync(extra);
    writeFileSync(`${ws}/README.md`, "owner file");
    const before = tree(rig.workspaces);
    const args = CHAIN_ARGS[engine].map(arg => arg === "@extra" ? extra : arg);
    const result = view(rig.request(engine, { cwd, args }), MASK_NAMES.map(name => `${cwd}/${name}/settings.json`));
    expect(result.error).toBeUndefined();
    expect(tree(rig.workspaces)).toEqual(before);
    // Nothing exists at cwd/<mask> yet; the plan masks every name anyway.
    for (const name of MASK_NAMES) expect(result.view[`${cwd}/${name}/settings.json`]).toBe("fresh");
    // Every destination inside the workspace is cwd, an --add-dir, a mask tmpfs or a path inside one (bwrap creates those in the tmpfs).
    const masked = (dest: string) => (result.tmpfs as string[]).some(mask => dest === mask || dest.startsWith(`${mask}/`));
    for (const dest of result.dests as string[]) if (dest.startsWith(`${rig.workspaces}/`)) expect([dest, dest === cwd || dest === extra || masked(dest)]).toEqual([dest, true]);
  });
});

it("the mask race cannot expose a settings file: a .claude planted after the plan is built and before bwrap runs is under the mask", () => {
  const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`, extra = `${rig.workspaces}/other`;
  mkdirSync(extra);
  expect(existsSync(`${cwd}/.claude`)).toBe(false);
  const settings = `${cwd}/.claude/settings.json`, extraSettings = `${extra}/.claude/settings.json`;
  const result = view(rig.request("claudeAgent", { cwd, args: [...MINIMAL_ARGV.claudeAgent, "--add-dir", extra] }), [settings, extraSettings, `${cwd}/.mcp.json`],
    { [settings]: '{"apiKeyHelper":"/bin/true","hooks":{"Stop":[{"command":"/bin/true"}]}}', [extraSettings]: "{}", [`${cwd}/.mcp.json`]: '{"mcpServers":{"x":{"command":"/bin/true"}}}' });
  expect(result.error).toBeUndefined();
  expect(existsSync(settings)).toBe(true);
  expect(result.view[settings]).toBe("fresh");
  expect(result.view[extraSettings]).toBe("fresh");
  // .mcp.json is not masked by a file in the owner's folder; the required --strict-mcp-config closes it.
  expect(result.view[`${cwd}/.mcp.json`]).toBe("host");
  expect(JSON.parse(rig.py(`print(json.dumps(list(m.ARGV_RULES["claudeAgent"].required)))`))).toContain("--strict-mcp-config");
});

it("masks the project config that does exist and refuses a mask path that is a symlink", () => {
  const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`;
  mkdirSync(`${ws}/proj/.claude`); writeFileSync(`${ws}/proj/.claude/settings.json`, '{"hooks":{"Stop":[]}}');
  const plan = rig.plan(rig.request("claudeAgent", { cwd })).ok!;
  expect(plan.readOnly).toEqual([`${cwd}/.claude`, `${ws}/proj/.claude`, `${ws}/.claude`, ...MASK_NAMES.filter(name => name !== ".claude").map(name => `${cwd}/${name}`)]);
  for (const path of Object.keys(plan.files)) expect(path.startsWith(`${ws}/`)).toBe(false);
  symlinkSync(`${ws}/proj/.claude`, `${cwd}/.claude`);
  expect(lstatSync(`${cwd}/.claude`).isSymbolicLink()).toBe(true);
  expect(rig.plan(rig.request("claudeAgent", { cwd })).error).toBe("Cloud turn mask path is not a plain directory: .claude");
});
