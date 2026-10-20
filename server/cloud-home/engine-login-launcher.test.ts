// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
req=json.loads(sys.argv[2])
try:
    turn=m.validate_login_request(req)
    plan=m.scope_plan(req)
    print(json.dumps({"ok":True,"turn":turn,"plan":list(plan)}))
except ValueError as e:
    print(json.dumps({"ok":False,"error":str(e)}))`;
const run = (request: unknown) => JSON.parse(execFileSync("python3", ["-I", "-c", script, launcher, JSON.stringify(request)], { encoding: "utf8" }));

describe("launcher login mode (r9 launcher modes)", () => {
  // Every sign-in except Claude's names its bot (B, per bot); Claude's setup-token is C, for the whole home.
  it.each([
    ["codex", "/opt/murage/bin/codex", ["login", "--device-auth"], "bot-atlas"],
    ["claudeAgent", "/opt/murage/bin/claude", ["setup-token"], undefined],
    ["grokAgent", "/opt/murage/bin/grok", ["login", "--device-auth"], "bot-atlas"],
    ["kimiAgent", "/opt/murage/bin/kimi", ["login", "--region", "global"], "bot-atlas"],
    ["opencodeGo", "/opt/murage/bin/opencode", ["auth", "login"], "bot-atlas"],
  ])("%s login runs the fixed argv from the root table", (engine, command, args, bot) => {
    const result = run({ mode: "login", engine, action: "login", ...(bot ? { bot } : {}) });
    expect(result.ok).toBe(true);
    expect(result.turn).toMatchObject({ engine, command, args, cwd: `/data/engine-homes/${engine}`, ...(bot ? { bot } : {}) });
    if (!bot) expect(result.turn.bot).toBeUndefined();
    expect(result.turn.env.HOME).toBeUndefined();
    expect(Object.keys(result.turn.env).filter((key: string) => key.startsWith("LD_"))).toEqual([]);
  });
  it.each([
    ["codex", { CODEX_HOME: "/data/engine-homes/codex/.codex" }],
    ["claudeAgent", { CLAUDE_CONFIG_DIR: "/data/engine-homes/claudeAgent/.claude", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" }],
    ["grokAgent", { GROK_HOME: "/data/engine-homes/grokAgent/.grok", GROK_DISABLE_AUTOUPDATER: "1" }],
    ["kimiAgent", { KIMI_CODE_HOME: "/data/engine-homes/kimiAgent/.kimi-code", KIMI_CODE_NO_AUTO_UPDATE: "1" }],
  ])("%s signs in with its own config home, the one its turns read", (engine, expected) => {
    const env = run({ mode: "login", engine, action: "login", ...(engine === "claudeAgent" ? {} : { bot: "bot-atlas" }) }).turn.env;
    expect(env).toMatchObject(expected);
    const homes = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "KIMI_CODE_HOME"].filter(key => key in env);
    expect(homes).toEqual([Object.keys(expected)[0]]); // exactly its own home, never another engine's
  });
  it.each([
    [{ engine: "codex", action: "logout" }, { engine: "codex", publish: "logout" }],
    [{ engine: "claudeAgent", action: "logout" }, { engine: "claudeAgent", publish: "logout" }],
    [{ engine: "grokAgent", action: "logout", bot: "bot-atlas" }, { engine: "grokAgent", publish: "logout", bot: "bot-atlas" }],
    [{ engine: "kimiAgent", action: "logout", bot: "bot-atlas" }, { engine: "kimiAgent", publish: "logout", bot: "bot-atlas" }],
    [{ engine: "opencodeGo", action: "logout", bot: "bot-atlas" }, { engine: "opencodeGo", publish: "logout", bot: "bot-atlas" }],
    [{ engine: "codex", action: "enroll-key", secret: "fixture-key-0123456789abc" }, { engine: "codex", publish: "enroll-key", secret: "fixture-key-0123456789abc" }], // secret-scan: fixture
    [{ engine: "opencodeGo", action: "enroll-key", secret: "fixture-key-0123456789abc", provider: "openai" }, { engine: "opencodeGo", publish: "enroll-key", secret: "fixture-key-0123456789abc", provider: "openai" }], // secret-scan: fixture
  ])("%j runs no CLI: it is the launcher's own publish", (request, publish) => {
    const result = run({ mode: "login", ...request });
    expect(result.ok).toBe(true);
    expect(result.turn).toEqual(publish);
  });
  it("gets the turn scope under murage-turns.slice with an 20 minute runtime cap, a publish too", () => {
    for (const request of [{ mode: "login", engine: "codex", action: "login", bot: "bot-atlas" }, { mode: "login", engine: "kimiAgent", action: "logout", bot: "bot-atlas" }]) {
      const [unit, slice, props] = run(request).plan;
      expect(unit).toMatch(/^murage-turn-[0-9a-f]{16}\.scope$/);
      expect(slice).toBe("murage-turns.slice");
      expect(props).toEqual(expect.arrayContaining(["TasksMax=512", "MemoryMax=40%", "BindsTo=murage-home.service", "RuntimeMaxSec=1200"]));
      expect(props.filter((item: string) => item.startsWith("RuntimeMaxSec="))).toEqual(["RuntimeMaxSec=1200"]);
    }
  });
  it.each([
    { mode: "login", engine: "pi", action: "login" },
    { mode: "login", engine: "fuigoAgent", action: "login" },
    { mode: "login", engine: "codex", action: "status", bot: "bot-atlas" },
    { mode: "login", engine: "kimiAgent", action: "status", bot: "bot-atlas" },
    { mode: "login", engine: "codex", action: "login" },
    { mode: "login", engine: "opencodeGo", action: "login" },
    { mode: "login", engine: "claudeAgent", action: "login", bot: "bot-atlas" },
    { mode: "login", engine: "codex", action: "login", bot: "../x" },
    { mode: "login", engine: "codex", action: "login", bot: "bot-atlas", secret: "fixture-key-0123456789abc" }, // secret-scan: fixture
    { mode: "login", engine: "codex", action: "enroll-key" },
    { mode: "login", engine: "codex", action: "enroll-key", secret: "short" },
    { mode: "login", engine: "codex", action: "enroll-key", secret: "fixture-key-0123456789abc", bot: "bot-atlas" }, // secret-scan: fixture
    { mode: "login", engine: "codex", action: "enroll-key", secret: "fixture-key-0123456789abc", provider: "openai" }, // secret-scan: fixture
    { mode: "login", engine: "opencodeGo", action: "enroll-key", secret: "fixture-key-0123456789abc" }, // secret-scan: fixture
    { mode: "login", engine: "claudeAgent", action: "enroll-key", secret: "fixture-key-0123456789abc" }, // secret-scan: fixture
    { mode: "login", engine: "codex" },
    { mode: "login", engine: "codex", action: "login", bot: "bot-atlas", command: "/bin/sh" },
    { mode: "login", engine: "codex", action: "login", bot: "bot-atlas", args: ["--evil"] },
    { mode: "login", engine: "codex", action: "login", bot: "bot-atlas", env: { LD_PRELOAD: "/x" } },
    { mode: "login", engine: "codex", action: "login", bot: "bot-atlas", cwd: "/data/home" },
    { mode: "login", engine: ["codex"], action: "login" },
  ])("refuses %j", request => { expect(run(request).ok).toBe(false); });
  it("accepts a boolean pty flag only, and carries it into the turn", () => {
    expect(run({ mode: "login", engine: "codex", action: "login", bot: "bot-atlas", pty: true }).turn.pty).toBe(true);
    expect(run({ mode: "login", engine: "codex", action: "login", bot: "bot-atlas" }).turn.pty).toBeUndefined();
    for (const pty of ["yes", 1, null, ["x"]]) expect(run({ mode: "login", engine: "codex", action: "login", bot: "bot-atlas", pty }).ok).toBe(false);
  });
  // asserts the Linux line discipline's echo; a BSD (macOS) pty echoes the EOF it is sent as "^D\\b\\b"
  it.skipIf(process.platform !== "linux")("relays a pseudo-terminal: the command sees a tty, bytes pass both ways, the exit status survives", () => {
    const probe = `import importlib.util,sys,os
spec=importlib.util.spec_from_file_location("l",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r,w=os.pipe(); o_r,o_w=os.pipe()
os.write(w,b"hello\\n"); os.close(w)
code=m.run_in_pty(["/bin/sh","-c","test -t 0 && test -t 1 && read x && echo got:$x && exit 7"],dict(os.environ),stdin_fd=r,stdout_fd=o_w)
os.close(o_w); print(code, os.read(o_r,4096).decode().replace("\\r","").strip().splitlines()[-1])`;
    const out = execFileSync("python3", ["-I", "-c", probe, launcher], { encoding: "utf8" }).trim();
    expect(out).toBe("7 got:hello");
  });
  it("keeps the argv table and the scope wiring in the launcher source", () => {
    const source = readFileSync(launcher, "utf8");
    expect(source).toContain('"login": ["login", "--device-auth"]');
    expect(source).toContain('"claudeAgent": ("/opt/murage/bin/claude", {"login": ["setup-token"]})');
    expect(source).toContain("turn = validate_login_request(request)");
    expect(source).toContain("sys.exit(publish_login(turn))");
    expect(source).toContain("launch(turn, login=True)");
    expect(source).toContain("LOGIN_RUNTIME_MAX_SEC = 20 * 60");
    // r9 "logout": no logout subcommand and no launcher-side file removal remain.
    expect(source).not.toMatch(/"logout": \[/);
    expect(source).not.toContain("LOCAL_LOGOUT");
    expect(source).not.toContain("def local_logout");
  });
});
