// SPDX-License-Identifier: AGPL-3.0-or-later
// B2 sign-in: the engine CLI must be able to create its credential file in its config directory,
// while the managed config files bound inside that directory stay unmodifiable by a turn.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const script = `import importlib.util,json,sys,os,stat,tempfile
spec=importlib.util.spec_from_file_location("cred_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
case,engine=sys.argv[2],sys.argv[3]
out={}
with tempfile.TemporaryDirectory() as home:
    fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY)
    me=os.getuid()
    mode=lambda p: oct(stat.S_IMODE(os.lstat(home+"/"+p).st_mode))
    try:
        if case=="create":
            m.prepare_credential_dirs(fd,engine,None,(me,))
            out={d:mode(d) for d in m.credential_dirs(engine)}
        elif case=="heal":
            for d in m.credential_dirs(engine):
                os.makedirs(home+"/"+d,mode=0o755); os.chmod(home+"/"+d,0o2755)
            m.prepare_credential_dirs(fd,engine,None,(me,))
            out={d:mode(d) for d in m.credential_dirs(engine)}
        elif case=="symlink":
            os.mkdir(home+"/elsewhere",0o755); os.symlink("elsewhere",home+"/"+m.credential_dirs(engine)[0].split("/")[0])
            try: m.prepare_credential_dirs(fd,engine,None,(me,)); out={"refused":False}
            except (OSError, ValueError) as e: out={"refused":True}
            out["target"]=mode("elsewhere")
        elif case=="owner":
            d=m.credential_dirs(engine)[0]; os.makedirs(home+"/"+d,mode=0o755)
            try: m.prepare_credential_dirs(fd,engine,None,(me+1,)); out={"refused":False}
            except ValueError as e: out={"refused":True,"mode":mode(d)}
        elif case=="mounts":
            h="/data/engine-homes/"+engine
            argv,_=m.turn_mount_args(engine,[],h,h,"/fixture/cli",[],None,turn_home="/turn-home")
            binds=[(argv[i+1],argv[i+2]) for i,a in enumerate(argv) if a=="--bind"]
            out={"home":binds[0],"state":[d for s,d in binds[1:] if s=="/turn-home"+d[len(h):]]}
        elif case=="state-cwd":
            h="/data/engine-homes/"+engine
            try: m.turn_mount_args(engine,[("/anchor",h+"/"+m.credential_dirs(engine)[0])],h,h+"/"+m.credential_dirs(engine)[0],"/fixture/cli",[],None); out={"refused":False}
            except ValueError as e: out={"refused":str(e)}
        elif case=="sets":
            out={"credential":m.credential_dirs(engine)}
    finally:
        os.close(fd)
print(json.dumps(out))`;
const run = (kase: string, engine: string) => JSON.parse(execFileSync("python3", ["-I", "-c", script, launcher, kase, engine], { encoding: "utf8" })) as Record<string, unknown>;

it.each(["claudeAgent", "codex"])("creates the %s credential directory group-writable (2770), never world-writable", (engine) => {
  const dirs = run("create", engine);
  expect(Object.keys(dirs).length).toBe(1);
  for (const mode of Object.values(dirs)) expect(mode).toBe("0o2770");
});
it.each(["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo"])("heals a root 2755 credential directory for %s (the bwrap --dir default)", (engine) => {
  for (const mode of Object.values(run("heal", engine))) expect(mode).toBe("0o2770");
});
it("creates the nested opencode credential directories group-writable", () => {
  const dirs = run("create", "opencodeGo");
  expect(Object.keys(dirs)).toEqual([".config/opencode", ".local/share/opencode"]);
});
it("gives Fuigo its writable state directory $HOME/.fuigo, 2770 and pinned (CLOUD-ENGINES-DESIGN.md r2 R2)", () => {
  expect(run("create", "fuigoAgent")).toEqual({ ".fuigo": "0o2770" });
  expect(run("sets", "fuigoAgent")).toEqual({ credential: [".fuigo"] });
});
it("refuses a credential directory that is a symlink and never changes its target", () => {
  expect(run("symlink", "codex")).toEqual({ refused: true, target: "0o755" });
});
it("refuses a credential directory owned by neither root nor the turn user", () => {
  expect(run("owner", "codex")).toEqual({ refused: true, mode: "0o755" });
});
it("names the state directories that hold credentials", () => {
  expect(run("sets", "codex")).toEqual({ credential: [".codex"] });
  expect(run("sets", "claudeAgent")).toEqual({ credential: [".claude"] });
  expect(run("sets", "kimiAgent")).toEqual({ credential: [".kimi-code"] });
});
it("binds the turn home at the engine home and pins each state directory inside it as its own mount (r4)", () => {
  expect(run("mounts", "codex")).toEqual({ home: ["/turn-home", "/data/engine-homes/codex"], state: ["/data/engine-homes/codex/.codex"] });
  expect(run("mounts", "claudeAgent")).toEqual({ home: ["/turn-home", "/data/engine-homes/claudeAgent"], state: ["/data/engine-homes/claudeAgent/.claude"] });
  expect(run("mounts", "opencodeGo").state).toEqual(["/data/engine-homes/opencodeGo/.config/opencode", "/data/engine-homes/opencodeGo/.local/share/opencode"]);
});
it("refuses a cwd bind inside a state directory: the disk home never reaches a turn", () => {
  expect(run("state-cwd", "codex")).toEqual({ refused: "Cloud turn binds an engine state directory" });
});
it("stages the turn home as root after the regroup walk, the anchors and the placeholders, before it drops to the turn user, and collects after the turn", () => {
  const source = readFileSync(launcher, "utf8");
  const launch = source.slice(source.indexOf("\ndef launch(request, login=False):"));
  const at = (needle: string) => { const i = launch.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
  expect(at("regroup_workspace(")).toBeLessThan(at("anchor_mounts(mounts)"));
  // r5 R5.1: placeholders are root's, after the anchors (through them) and before the drop.
  // The turn body (mount_turn_home onward) is a nested turn() that run_frozen() calls only after ensure_placeholders() ran.
  expect(at("anchor_mounts(mounts)")).toBeLessThan(at("run_frozen("));
  expect(source.slice(source.indexOf("\ndef run_frozen("))).toMatch(/held = ensure_placeholders\([\s\S]*return body\(\)/);
  expect(at("def turn():")).toBeLessThan(at("mount_turn_home("));
  expect(at("anchor_mounts(mounts)")).toBeLessThan(at("mount_turn_home("));
  expect(at("mount_turn_home(")).toBeLessThan(at("stage_turn_home("));
  expect(at("stage_turn_home(")).toBeLessThan(at("os.setuid(account.pw_uid)"));
  expect(at("os.setuid(account.pw_uid)")).toBeLessThan(at("collect_turn_home("));
  expect(launch).not.toContain("managed_dir_mounts(");
});
