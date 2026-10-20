// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fixture shared by the launcher suites (never imported by the server): drives the
// real launcher Python (deploy/cloud-home/murage-turn-launch.py) through validate_request
// and turn_mount_args, the path launch() takes, against throwaway engine homes, a fixture
// manifest and fixture MCP proxy scripts.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../testing/safe-wipe.mjs";

export const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
export const CLOUD_TURN_ENGINES = ["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo", "fuigoAgent"] as const;
export const PROXY_SCRIPTS = ["permission-proxy", "drivers/agents-proxy", "drivers/memory-proxy", "drivers/phone-proxy", "drivers/unified-browser-proxy", "computer-proxy",
  "drivers/host-computer-proxy", "drivers/dweb-proxy", "connector-proxy", "drivers/remote-mcp-proxy", "cloud-home/vps-relay-mcp"];

/** The argv each driver emits today on a Cloud home (claude.ts 1427-1871, codex.ts
 * 232-250/516-531, grok.ts 248-257, kimi.ts 573-579, opencode-go.ts spawnArgs, fuigo.ts
 * 573-603), smallest form. */
export const MINIMAL_ARGV: Record<(typeof CLOUD_TURN_ENGINES)[number], string[]> = {
  claudeAgent: ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--session-id", "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"],
  codex: ["app-server", "-c", "features.browser_use=false", "-c", "features.browser_use_external=false", "-c", "features.computer_use=false",
    "-c", 'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }'],
  grokAgent: ["--permission-mode", "default", "agent", "stdio"],
  kimiAgent: ["acp"],
  opencodeGo: ["acp"],
  fuigoAgent: ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio"],
};

const harness = `import importlib.util,json,os,sys,tempfile
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cfg=json.loads(open(sys.argv[2]).read())
for key,value in cfg.get("set",{}).items(): setattr(m,key,value)
def plan(request):
    engine,home,cwd,command,args,env,render,bot=m.validate_request(request,manifest_path=cfg["manifest"],manifest_uid=os.getuid(),engine_root=cfg["engineRoot"],cache_root=cfg["cache"],login=cfg.get("login",False))
    # r4: the turn home is staged (allowlisted state copied in) and bound at the home path; only cwd comes from disk.
    turn_home=tempfile.mkdtemp(prefix="turn-home-",dir=cfg["root"])
    hfd=os.open(home,os.O_RDONLY|os.O_DIRECTORY);tfd=os.open(turn_home,os.O_RDONLY|os.O_DIRECTORY)
    try: staged=m.stage_turn_home(hfd,engine,tfd,None,(os.getuid(),),m.turn_state_ids(engine,args,render),bot=bot,cwd=cwd,render=render)
    finally: os.close(hfd);os.close(tfd)
    # r5 R5.1: with "place", root's placeholder step runs first; the immutable ioctl is recorded, not made.
    placed=[]
    if cfg.get("place"):
        m.set_immutable=lambda fd: placed.append(os.readlink("/proc/self/fd/%d"%fd))
        m.ensure_placeholders(m.placeholder_dirs(engine,home,cwd,args))
    argv,blobs=m.turn_mount_args(engine,([("/fixture/anchor/cwd",cwd)] if cwd!=home else []),home,cwd,command,args,render,request.get("scratch",[]),turn_home=turn_home)
    files={argv[i+2]:blobs[argv[i+1][4:]] for i,a in enumerate(argv) if a=="--ro-bind-data" and argv[i+2]!="/etc/resolv.conf"}
    return {"args":args,"env":env,"files":files,"readOnly":[argv[i+1] for i,a in enumerate(argv) if a=="--remount-ro"],"tmpfs":[argv[i+1] for i,a in enumerate(argv) if a=="--tmpfs"],"roBind":[argv[i+1] for i,a in enumerate(argv) if a=="--ro-bind"],"argv":argv,
            "turnHome":turn_home,"staged":staged,"bot":bot,"placed":placed,"binds":[[argv[i+1],argv[i+2]] for i,a in enumerate(argv) if a=="--bind"]}
try:
    out={"ok":plan(cfg["request"])}
except ValueError as error:
    out={"error":str(error)}
print(json.dumps(out))`;

const turnHarness = `import importlib.util,io,contextlib,json,os,sys,tempfile
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cfg=json.loads(open(sys.argv[2]).read());home=cfg["home"];engine=cfg["engine"];m.LIVE_DIR=cfg["live"]
def walk(top):
    out={}
    for d,_,files in os.walk(top):
        for f in files:
            p=os.path.join(d,f);out[os.path.relpath(p,top)]="@symlink" if os.path.islink(p) else open(p,encoding="utf-8",errors="replace").read()
    return out
for rel,text in cfg["before"].items():
    os.makedirs(os.path.dirname(home+"/"+rel),exist_ok=True);open(home+"/"+rel,"w").write(text)
published=[];publish=m.publish_signin
def spy(h,e,b,files,unit,kind,*rest):
    published.append({"engine":e,"bot":b,"files":{k:v.decode() for k,v in files.items()},"kind":kind});return publish(h,e,b,files,unit,kind,*rest)
m.publish_signin=spy
try:
    render=m.validate_render(engine,cfg["render"],cfg["unit"])
    args=m.check_argv(engine,cfg["args"],render)
except ValueError as error:
    print(json.dumps({"error":str(error)}));sys.exit(0)
ids=m.turn_state_ids(engine,args,render)
turn=tempfile.mkdtemp(prefix="turn-home-",dir=cfg["root"])
hfd=os.open(home,os.O_RDONLY|os.O_DIRECTORY);tfd=os.open(turn,os.O_RDONLY|os.O_DIRECTORY)
stage_err=io.StringIO()
with contextlib.redirect_stderr(stage_err): snapshot=m.stage_turn_home(hfd,engine,tfd,None,(os.getuid(),),ids,bot=cfg["bot"],cwd=cfg["cwd"],render=render)
turn_files=walk(turn)
for rel,text in cfg["during"].items():
    path=turn+"/"+rel
    if text is None:
        os.unlink(path);continue
    os.makedirs(os.path.dirname(path),exist_ok=True)
    if os.path.lexists(path): os.unlink(path)
    if text.startswith("@symlink:"): os.symlink(text[len("@symlink:"):],path)
    else: open(path,"w").write(text)
err=io.StringIO()
with contextlib.redirect_stderr(err): changed=m.collect_turn_home(hfd,engine,tfd,snapshot,None,(os.getuid(),),ids,bot=cfg["bot"],unit=cfg["unit"],login=cfg["login"])
os.close(hfd);os.close(tfd)
print(json.dumps({"snapshot":snapshot,"turnFiles":turn_files,"changed":sorted(changed),"stageErr":stage_err.getvalue(),"err":err.getvalue(),"disk":walk(home),"published":published}))`;

export interface Plan { args: string[]; env: Record<string, string>; files: Record<string, string>; readOnly: string[]; tmpfs: string[]; roBind: string[]; argv: string[]; turnHome: string; staged: Record<string, string>; bot: string | null; binds: [string, string][]; placed: string[] }
/** The bot every rig request runs for unless the test says otherwise (r5 R5.2: a non-probe turn names one). */
export const FIXTURE_BOT = "fixture-bot";
/** One staged-and-collected turn (stage_turn_home, the turn's writes, collect_turn_home). Paths in
 * `before` are relative to the engine home (so "bots/<bot>/..." plants a bot store); `during` is what
 * the turn leaves in its home (null removes, "@symlink:<target>" plants a symlink). */
export interface TurnSpec { engine: string; args: string[]; render?: Record<string, unknown> | null; bot?: string | null; cwd?: string; before?: Record<string, string>; during?: Record<string, string | null>; unit?: string; login?: boolean }
/** `before` entries that plant a bot's B sign-in store as generation 1 (r8 R2: `current` names `1/`,
 * whose record.json lists each file and its top-level key set). */
export function signinStore(engine: string, files: Record<string, string>, bot = FIXTURE_BOT, kind = "signin"): Record<string, string> {
  const modes: Record<string, string> = { codex: "chatgpt", grokAgent: "oauth", kimiAgent: "oauth", opencodeGo: "oauth" };
  const keys = (text: string) => { try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : []; } catch { return []; } };
  const base = `bots/${bot}/signin`;
  return { [`${base}/current`]: "1\n", [`${base}/1/record.json`]: JSON.stringify({ mode: modes[engine] ?? null, kind, enrolledAt: 1, expiresAt: null, unit: null, files: Object.fromEntries(Object.entries(files).map(([relative, text]) => [relative, { keys: keys(text) }])) }),
    ...Object.fromEntries(Object.entries(files).map(([relative, text]) => [`${base}/1/${relative}`, text])) };
}
export interface TurnResult { snapshot: Record<string, string>; turnFiles: Record<string, string>; changed: string[]; stageErr: string; err: string; disk: Record<string, string>; published: { engine: string; bot: string; files: Record<string, string>; kind: string }[]; error?: string }
export interface Rig {
  root: string; engineRoot: string; workspaces: string; proxyRoot: string; command: string; manifest: string;
  home(engine: string): string;
  request(engine: string, extra?: Record<string, unknown>): Record<string, unknown>;
  plan(request: Record<string, unknown>, options?: { login?: boolean; set?: Record<string, unknown>; place?: boolean }): { ok?: Plan; error?: string };
  turn(spec: TurnSpec): TurnResult;
  py(source: string, ...args: string[]): string;
  dispose(): void;
}

/** Bytes for a fixture engine binary. The launcher admits only native Linux (ELF) engines and only
 * reads the header; it never runs the file. /usr/bin/true is ELF on Linux; on macOS it is Mach-O, so a
 * minimal ELF header stands in there and the launcher's own checks run unchanged on every POSIX host. */
export function fixtureEngineBytes(): Buffer {
  const hostTrue = readFileSync("/usr/bin/true");
  return hostTrue.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ? hostTrue : Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(57)]);
}

/** A throwaway engine root, workspace root, manifest (every engine plus every proxy
 * script) and proxy tree under the test's working directory. */
export function launcherRig(prefix: string): Rig {
  const cwd = process.cwd();
  const root = mkdtempSync(join(cwd, prefix));
  const engineRoot = join(root, "engine-homes"), workspaces = join(root, "workspaces"), proxyRoot = join(root, "dist-server");
  for (const engine of CLOUD_TURN_ENGINES) mkdirSync(join(engineRoot, engine), { recursive: true });
  mkdirSync(join(workspaces, "ws", "proj", "sub"), { recursive: true });
  mkdirSync(join(root, "bin"));
  // The section and admission locks (LIVE_DIR) of this rig's turns.
  const live = join(root, "live"); mkdirSync(live, { mode: 0o700 });
  const command = join(root, "bin", "fixture-engine"), bytes = fixtureEngineBytes();
  writeFileSync(command, bytes, { mode: 0o755 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const proxies = PROXY_SCRIPTS.map(relative => {
    const path = join(proxyRoot, `${relative}.js`); mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const text = `// fixture ${relative}\n`; writeFileSync(path, text, { mode: 0o644 });
    return { path, sha256: createHash("sha256").update(text).digest("hex") };
  });
  const manifest = join(root, "engine-manifest.json");
  writeFileSync(manifest, JSON.stringify({ ...Object.fromEntries(CLOUD_TURN_ENGINES.map(engine => [engine, [{ path: command, sha256 }]])), mcpProxies: proxies }), { mode: 0o644 });
  const cfgPath = join(root, "cfg.json");
  const home = (engine: string) => join(engineRoot, engine);
  return {
    root, engineRoot, workspaces, proxyRoot, command, manifest, home,
    request: (engine, extra = {}) => ({ engine, command, args: MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV] ?? [], cwd: home(engine), env: {}, bot: FIXTURE_BOT, ...extra }),
    plan(request, options = {}) {
      writeFileSync(cfgPath, JSON.stringify({ request, manifest, engineRoot, root, cache: join(root, "digest-cache"), login: options.login ?? false, place: options.place ?? false,
        set: { MCP_PROXY_ROOT: proxyRoot, WORKSPACE_ROOT: workspaces, LIVE_DIR: live, ...options.set } }));
      const child = spawnSync("python3", ["-I", "-c", harness, launcher, cfgPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (child.status !== 0) throw new Error(child.stderr);
      return JSON.parse(child.stdout);
    },
    turn(spec) {
      writeFileSync(cfgPath, JSON.stringify({ engine: spec.engine, args: spec.args, render: spec.render ?? null, bot: spec.bot === undefined ? FIXTURE_BOT : spec.bot, cwd: spec.cwd ?? home(spec.engine),
        before: spec.before ?? {}, during: spec.during ?? {}, unit: spec.unit ?? "0123456789abcdef", home: home(spec.engine), root, live, login: spec.login ?? false }));
      const child = spawnSync("python3", ["-I", "-c", turnHarness, launcher, cfgPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (child.status !== 0) throw new Error(child.stderr);
      return JSON.parse(child.stdout);
    },
    py: (source, ...args) => execFileSync("python3", ["-I", "-c", `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${source}`, launcher, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    // The rig lives under the working directory (the launcher refuses a /tmp workspace), so it is admitted as a path inside it.
    dispose: () => { safeWipeSync(root, { within: cwd }); },
  };
}
