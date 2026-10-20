// SPDX-License-Identifier: AGPL-3.0-or-later
// r8 R2/R3/R4 as corrected by r9 (CLOUD-ENGINES-DESIGN.md): versioned sign-in stores. Every writer (a
// sign-in turn's collect, a refresh, a logout, a key enrollment, Claude's captured setup-token) publishes
// one generation through publish_generation, durably and in a fixed order; C-mode sign-ins (Claude's
// token, Codex's key, OpenCode's api entries) are rendered from the engine's root store and never staged
// or collected; B-mode sign-ins live per bot under bots/<bot>/signin. The harness drives the real
// launcher Python in throwaway directories; fsync, rename and the turn's child are seams.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_BOT, MINIMAL_ARGV, launcher, launcherRig, signinStore, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-signin-store-"); });
afterEach(() => rig.dispose());

const A = FIXTURE_BOT;
const TOKEN = `sk-ant-oat01-${"Fx0_-".repeat(20)}`; // secret-scan: fixture (a made-up token shape, never a real one)
const TOKEN2 = `sk-ant-oat01-${"Zz9-".repeat(15)}`; // secret-scan: fixture (a made-up token shape, never a real one)
const KEY = "fixture-codex-key-0123456789"; // secret-scan: fixture
const OC_KEY = "fixture-opencode-key-0123456789"; // secret-scan: fixture
const REPLACEMENT = "[sign-in token enrolled by Murage]";
const MOVED = "Cloud engine sign-in changed during the turn; its refresh was not kept\n";
const SHADOWED = "Cloud OpenCode sign-in: key entries shadow the OAuth sign-in\n";

// The launcher's roots pointed at the rig; fsync recorded (paths relative to the engine root, temp
// tokens normalised), erase_tree's top-level calls recorded into the same trace.
const prelude = `
import io, contextlib, re, tempfile, time
root=sys.argv[2]; ER=root+"/engine-homes"
m.ENGINE_ROOT=ER; m.LIVE_DIR=root+"/live"; m.TOMBSTONE_DIR=root+"/deleted"
trace=[]; real_fsync=os.fsync; real_erase=m.erase_tree
def label(path):
    path=path[len(ER)+1:] if path.startswith(ER+"/") else path
    return re.sub(r"\\.(tmp|current)-[0-9a-f]{16}", r".\\1-T", path)
def fdpath(fd):
    # /proc/self/fd on Linux; macOS has no procfs and names an open file with fcntl F_GETPATH
    if os.path.isdir("/proc/self/fd"): return os.readlink("/proc/self/fd/%d"%fd)
    import fcntl; return fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\\0", 1)[0].decode()
def seam(fd): trace.append(label(fdpath(fd))); real_fsync(fd)
def erase(parent, name, clear=None, depth=0, budget=None):
    if depth==0: trace.append("erase "+label(name))
    return real_erase(parent, name, clear, depth, budget)
m.fsync=seam; m.erase_tree=erase
def store(engine, bot=None, create=True): return m.engine_signin_store(engine, bot, create=create, engine_root=ER)
def publish(engine, files, record, bot=None, unit=None):
    fd=store(engine, bot)
    try: return m.publish_generation(fd, {k: v.encode() for k, v in files.items()}, record, unit)
    finally: os.close(fd)
def current(engine, bot=None):
    fd=store(engine, bot, False)
    if fd is None: return None
    try:
        g, record, files=m.store_current(fd)
        return {"g": g, "record": record, "files": {k: v.decode() for k, v in files.items()}}
    finally: os.close(fd)
def listing(engine, bot=None):
    return sorted(re.sub(r"-[0-9a-f]{16}$", "-T", n) for n in os.listdir(ER+"/"+engine+("/bots/"+bot if bot else "")+"/signin"))
def stage(engine, bot, render=None):
    t=tempfile.mkdtemp(dir=root); hfd=os.open(ER+"/"+engine, os.O_RDONLY|os.O_DIRECTORY); tfd=os.open(t, os.O_RDONLY|os.O_DIRECTORY)
    snap=m.stage_turn_home(hfd, engine, tfd, None, (os.getuid(),), m.turn_state_ids(engine, [], render), bot=bot, render=render)
    return {"dir": t, "hfd": hfd, "tfd": tfd, "snap": snap, "engine": engine, "bot": bot, "render": render}
def put(t, rel, text):
    path=t["dir"]+"/"+rel
    if text is None: os.unlink(path); return
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "w").write(text)
def collect(t, login=False):
    err=io.StringIO()
    with contextlib.redirect_stderr(err):
        changed=m.collect_turn_home(t["hfd"], t["engine"], t["tfd"], t["snap"], None, (os.getuid(),), m.turn_state_ids(t["engine"], [], t["render"]), bot=t["bot"], unit="u",
                                    login=login, signin=not m.signin_rendered(t["engine"], t["render"]))
    return {"changed": changed, "err": err.getvalue()}
def staged(t):
    out={}
    for d, _, files in os.walk(t["dir"]):
        for f in files: out[os.path.relpath(os.path.join(d, f), t["dir"])]=open(os.path.join(d, f)).read()
    return out
def login_request(**kw):
    try: return m.validate_login_request(dict({"mode": "login"}, **kw))
    except ValueError as e: return str(e)
def logout(engine, bot=None):
    turn={"engine": engine, "publish": "logout"}
    if bot: turn["bot"]=bot
    out=io.StringIO(); m.publish_login(turn, engine_root=ER, out=out); return out.getvalue()
def enroll(engine, secret, provider=None):
    turn=m.validate_login_request(dict({"mode": "login", "engine": engine, "action": "enroll-key", "secret": secret}, **({"provider": provider} if provider else {})))
    out=io.StringIO(); m.publish_login(turn, engine_root=ER, out=out); return out.getvalue()
out=[]
`;
const run = (source: string) => rig.py(prelude + source + "\nprint(json.dumps(out))", rig.root, rig.manifest);
const result = (source: string) => JSON.parse(run(source)) as unknown[];
// validate_request with stderr captured (the rig's plan harness keeps only stdout).
const validated = (request: Record<string, unknown>) => JSON.parse(rig.py(`${prelude}
m.MCP_PROXY_ROOT=root+"/dist-server"; m.WORKSPACE_ROOT=root+"/workspaces"
req=json.loads(sys.argv[4]); err=io.StringIO()
with contextlib.redirect_stderr(err):
    engine,home,cwd,command,args,env,render,bot=m.validate_request(req,manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=ER,cache_root=root+"/digest-cache")
print(json.dumps({"env":env,"err":err.getvalue()}))`, rig.root, rig.manifest, JSON.stringify(request))) as { env: Record<string, string>; err: string };

describe("publication durability (r8 fixture 18, r9 H2 ancestors)", () => {
  it("creates missing ancestors 0700 with each parent fsynced, then fsyncs files, directories and signin/ in order, pruning last", () => {
    const [first, second, third, modes] = result(`
publish("kimiAgent", {".kimi-code/credentials/a.json": '{"t":1}'}, {"mode": "oauth", "kind": "signin", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
out.append(trace[:]); del trace[:]
publish("kimiAgent", {".kimi-code/credentials/a.json": '{"t":2}'}, {"mode": "oauth", "kind": "refresh", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
out.append(trace[:]); del trace[:]
publish("kimiAgent", {}, {"mode": None, "kind": "signout", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
out.append(trace[:])
out.append([oct(os.stat(ER+"/kimiAgent/"+p).st_mode & 0o777) for p in ("bots", "bots/alpha", "bots/alpha/signin", "bots/alpha/signin/3")] + [oct(os.stat(ER+"/kimiAgent/bots/alpha/signin/2/.kimi-code/credentials/a.json").st_mode & 0o777)])
`);
    const S = "kimiAgent/bots/alpha/signin";
    const body = [S, `${S}/.tmp-T/.kimi-code/credentials/a.json`, `${S}/.tmp-T/record.json`, `${S}/.tmp-T/.kimi-code/credentials`, `${S}/.tmp-T/.kimi-code`, `${S}/.tmp-T`, S, `${S}/.current-T`, S];
    expect(first).toEqual(["kimiAgent", "kimiAgent/bots", "kimiAgent/bots/alpha", ...body]);
    expect(second).toEqual(body);
    expect(third).toEqual([S, `${S}/.tmp-T/record.json`, `${S}/.tmp-T`, S, `${S}/.current-T`, S, "erase 1"]);
    expect(modes).toEqual(["0o700", "0o700", "0o700", "0o700", "0o600"]);
  });
  it("keeps the last two generations; a current naming a missing directory reads as signed out", () => {
    const [names, record, query, missing, status] = result(`
for n in range(4): publish("codex", {"key": "${KEY}"}, {"mode": "apikey", "kind": "enroll", "enrolledAt": n, "expiresAt": None})
out.append(listing("codex")); out.append(current("codex")["record"])
out.append(m.bot_state_query({"mode": "bot-state-query"}, engine_root=ER)["engines"]["codex"])
open(ER+"/codex/signin/current", "w").write("9\\n")
out.append(current("codex")); out.append(m.signin_status(ER+"/codex"))
`);
    expect(names).toEqual(["3", "4", "current"]);
    expect(record).toEqual({ mode: "apikey", kind: "enroll", enrolledAt: 3, expiresAt: null, unit: null, files: { key: { keys: [] } } });
    expect(query).toEqual({ mode: "apikey", signedIn: true, expiresAt: null });
    expect(missing).toEqual({ g: 9, record: null, files: {} });
    expect(status).toEqual([null, false, null]);
    expect(rig.plan(rig.request("codex")).ok!.files[`${rig.home("codex")}/.codex/auth.json`]).toBeUndefined();
  });
});

describe("generation rules (r7 R2, fixture 12)", () => {
  it("sign-out resurrection: a refresh staged before a sign-out is discarded; a crash before the current rename leaves G0+1 current and its garbage goes with the next publish", () => {
    const [aOut, bOut, after, crashed, listed, next, finalListing] = result(`
publish("codex", {".codex/auth.json": '{"tokens":{"access_token":"g1"}}'}, {"mode": "chatgpt", "kind": "signin", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
a=stage("codex", "alpha"); b=stage("codex", "alpha")
put(a, ".codex/auth.json", None); out.append(collect(a))
put(b, ".codex/auth.json", '{"tokens":{"access_token":"refreshed"}}'); out.append(collect(b))
out.append(current("codex", "alpha"))
real_rename=os.rename
def crash(src, dst, **kw):
    if dst == "current": raise OSError("crash")
    return real_rename(src, dst, **kw)
os.rename=crash
try: publish("codex", {".codex/auth.json": '{"tokens":{"access_token":"g3"}}'}, {"mode": "chatgpt", "kind": "signin", "enrolledAt": 3, "expiresAt": None}, bot="alpha"); out.append("published")
except OSError as e: out.append(str(e))
os.rename=real_rename
out.append(listing("codex", "alpha"))
publish("codex", {".codex/auth.json": '{"tokens":{"access_token":"g3b"}}'}, {"mode": "chatgpt", "kind": "signin", "enrolledAt": 4, "expiresAt": None}, bot="alpha")
out.append(current("codex", "alpha")); out.append(listing("codex", "alpha"))
`);
    expect(aOut).toEqual({ changed: [".codex/auth.json"], err: "" });
    expect(bOut).toEqual({ changed: [], err: MOVED });
    expect(after).toMatchObject({ g: 2, record: { mode: null, kind: "signout", unit: "u" }, files: {} });
    expect(crashed).toBe("crash");
    expect(listed).toEqual([".current-T", "1", "2", "3", "current"]);
    expect(next).toMatchObject({ g: 3, record: { kind: "signin", enrolledAt: 4 }, files: { ".codex/auth.json": '{"tokens":{"access_token":"g3b"}}' } });
    expect(finalListing).toEqual(["2", "3", "current"]);
  });
  it("a non-login turn keeps the record's mode and key set: a changed key set is taken from G0 and named; an unchanged-shape refresh is published", () => {
    const [refresh, refreshed, reshaped, kept, fresh, freshStore] = result(`
publish("grokAgent", {".grok/auth.json": '{"access":"a","refresh":"r"}'}, {"mode": "oauth", "kind": "signin", "enrolledAt": 5, "expiresAt": None}, bot="alpha")
t=stage("grokAgent", "alpha"); put(t, ".grok/auth.json", '{"access":"a2","refresh":"r"}'); out.append(collect(t))
out.append(current("grokAgent", "alpha"))
t=stage("grokAgent", "alpha"); put(t, ".grok/auth.json", '{"access":"a3","refresh":"r","evil":"x"}'); out.append(collect(t))
out.append(current("grokAgent", "alpha"))
t=stage("grokAgent", "beta"); put(t, ".grok/auth.json", '{"access":"planted"}'); out.append(collect(t))
out.append(current("grokAgent", "beta"))
`);
    expect(refresh).toEqual({ changed: [".grok/auth.json"], err: "" });
    expect(refreshed).toMatchObject({ g: 2, record: { mode: "oauth", kind: "refresh", enrolledAt: 5, files: { ".grok/auth.json": { keys: ["access", "refresh"] } } }, files: { ".grok/auth.json": '{"access":"a2","refresh":"r"}' } });
    expect(reshaped).toEqual({ changed: [], err: "Cloud engine sign-in file was not kept: .grok/auth.json\n" });
    expect(kept).toMatchObject({ g: 2 });
    // A turn cannot sign a bot in: only a login turn starts a set.
    expect(fresh).toEqual({ changed: [], err: "Cloud engine sign-in file was not kept: .grok/auth.json\n" });
    expect(freshStore).toBeNull();
  });
  it("a non-login turn keeps every recorded claim: a Codex refresh under another account is taken from G0 and named; the same account refreshes", () => {
    const [record, same, sameStore, swapped, swappedStore, dropped] = result(`
auth=lambda access, account: json.dumps({"tokens": {"access_token": access, "account_id": account}} if account else {"tokens": {"access_token": access}}, separators=(",", ":"))
t=stage("codex", "alpha"); put(t, ".codex/auth.json", auth("a1", "acct-1")); collect(t, login=True)
out.append(current("codex", "alpha")["record"])
t=stage("codex", "alpha"); put(t, ".codex/auth.json", auth("a2", "acct-1")); out.append(collect(t)); out.append(current("codex", "alpha"))
t=stage("codex", "alpha"); put(t, ".codex/auth.json", auth("a3", "acct-2")); out.append(collect(t)); out.append(current("codex", "alpha"))
t=stage("codex", "alpha"); put(t, ".codex/auth.json", auth("a4", None)); out.append(collect(t))
`);
    expect(record).toMatchObject({ mode: "chatgpt", kind: "signin", files: { ".codex/auth.json": { keys: ["tokens"], claims: { "tokens.account_id": "acct-1" } } } });
    expect(same).toEqual({ changed: [".codex/auth.json"], err: "" });
    expect(sameStore).toMatchObject({ g: 2, files: { ".codex/auth.json": JSON.stringify({ tokens: { access_token: "a2", account_id: "acct-1" } }) } });
    expect(swapped).toEqual({ changed: [], err: "Cloud engine sign-in file was not kept: .codex/auth.json\n" });
    expect(swappedStore).toMatchObject({ g: 2 });
    // A missing claim refuses too (r6 R2).
    expect(dropped).toEqual({ changed: [], err: "Cloud engine sign-in file was not kept: .codex/auth.json\n" });
  });
});

describe("Claude C mode (r8 R3.1, r9 H Claude C, fixture 19)", () => {
  it("TokenFilter: a split token, two tokens, 1 MiB without one, a token at end of file, and none", () => {
    const [split, two, big, atEof, none] = result(`
def filtered(chunks):
    f=m.TokenFilter(); shown=b"".join(f.feed(c.encode()) for c in chunks)+f.flush()
    return {"shown": shown.decode(), "token": f.token.decode() if f.token else None, "peak": f.peak}
T="${TOKEN}"; T2="${TOKEN2}"
out.append(filtered(["hello ", T[:30], T[30:] + " done\\r\\n"]))
out.append(filtered(["a " + T + " b " + T2 + " c\\n"]))
text="".join("line %06d sk-ant-oat01-${"short"} ok\\r\\n" % i for i in range(1 << 15))[:1 << 20]
chunks=[text[i:i + 4096] for i in range(0, len(text), 4096)]
r=filtered(chunks); out.append({"same": r["shown"] == text, "size": len(r["shown"]), "peak": r["peak"], "token": r["token"]})
out.append(filtered(["x ", T]))
out.append(filtered(["nothing to see\\n"]))
`);
    expect(split).toMatchObject({ shown: `hello ${REPLACEMENT} done\r\n`, token: TOKEN });
    expect(two).toMatchObject({ shown: `a ${REPLACEMENT} b ${REPLACEMENT} c\n`, token: TOKEN });
    expect(big).toEqual({ same: true, size: 1 << 20, peak: 160, token: null });
    expect(atEof).toMatchObject({ shown: `x ${REPLACEMENT}`, token: TOKEN });
    expect(none).toEqual({ shown: "nothing to see\n", token: null, peak: 15 });
  });
  it("a token longer than the carry, split at the boundary, is redacted whole and enrolled whole", () => {
    const long = `sk-ant-oat01-${"L".repeat(400)}`; // secret-scan: fixture
    const [r] = result(`
f=m.TokenFilter(); T="${long}"
shown=f.feed(("p " + T[:300]).encode())+f.feed((T[300:] + " q").encode())+f.flush()
out.append({"shown": shown.decode(), "token": f.token.decode(), "peak": f.peak})`);
    expect(r).toEqual({ shown: `p ${REPLACEMENT} q`, token: long, peak: expect.any(Number) });
    expect((r as { peak: number }).peak).toBeLessThanOrEqual(160);
  });
  it("run_turn: the root parent filters the child's pipe to stdout and publishes the token before collect; no token reports not signed in", () => {
    const [shown, order, record, token, query, noneShown, noneStore] = result(`
def drive(chunks):
    sink=tempfile.mktemp(dir=root); saved=os.dup(1); sys.stdout.flush()
    fd=os.open(sink, os.O_WRONLY | os.O_CREAT, 0o600); os.dup2(fd, 1); os.close(fd)
    events=[]
    def child(stdout_fd):
        for c in chunks: os.write(stdout_fd, c.encode()); time.sleep(0.01)
        os._exit(0)
    def collect(): events.append(("collect", current("claudeAgent") is not None))
    publisher=m.claude_token_publisher("murage-turn-0123456789abcdef.scope", engine_root=ER)
    def capture(t): events.append(("capture", t is not None)); return publisher(t)
    status=m.run_turn(child, collect, signals=(), capture=capture)
    os.dup2(saved, 1); os.close(saved)
    return open(sink, newline="").read(), events, status
T="${TOKEN}"
shown, events, status=drive(["Paste the code\\r\\n", "Your token: " + T[:20], T[20:] + "\\r\\nStore it safely\\r\\n"])
out.append(shown); out.append([events, status])
c=current("claudeAgent"); out.append(c["record"]); out.append(c["files"]["token"] == T)
out.append(m.bot_state_query({"mode": "bot-state-query"}, engine_root=ER)["engines"]["claudeAgent"])
publish_count=len(listing("claudeAgent"))
shown, events, status=drive(["Error: login cancelled\\r\\n"])
out.append([shown, events]); out.append(len(listing("claudeAgent")) == publish_count)
`);
    expect(shown).toBe(`Paste the code\r\nYour token: ${REPLACEMENT}\r\nStore it safely\r\nSigned in to Claude on this Cloud home.\r\n`);
    expect(shown).not.toContain("sk-ant-oat01-");
    expect(order).toEqual([[["capture", true], ["collect", true]], 0]);
    const r = record as { mode: string; kind: string; enrolledAt: number; expiresAt: number; unit: string; files: unknown };
    expect(r).toMatchObject({ mode: "oauth-token", kind: "signin", unit: "murage-turn-0123456789abcdef.scope", files: { token: { keys: [] } } });
    expect(r.expiresAt - r.enrolledAt).toBe(365 * 24 * 60 * 60);
    expect(token).toBe(true);
    expect(query).toEqual({ mode: "oauth-token", signedIn: true, expiresAt: r.expiresAt * 1000 });
    expect(noneShown).toEqual(["Error: login cancelled\r\nClaude is not signed in on this Cloud home: no sign-in token was received.\r\n", [["capture", false], ["collect", true]]]);
    expect(noneStore).toBe(true);
  });
  it("turns carry CLAUDE_CODE_OAUTH_TOKEN from the store only; .credentials.json is never staged or collected; logout publishes a tokenless generation", () => {
    const request = rig.request("claudeAgent", { env: { CLAUDE_CODE_OAUTH_TOKEN: "request-token-value" } });
    expect(rig.plan(request).ok!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    result(`publish("claudeAgent", {"token": "${TOKEN}"}, {"mode": "oauth-token", "kind": "signin", "enrolledAt": 1, "expiresAt": 2})`);
    const plan = rig.plan(request).ok!;
    expect(plan.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(plan.files)).not.toContain(TOKEN);
    // A login renders none: the setup-token turn runs on the base configuration.
    const login = rig.plan({ engine: "claudeAgent", command: rig.command, args: ["setup-token"], cwd: rig.home("claudeAgent"), env: {} }, { login: true }).ok!;
    expect(login.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const planted = rig.turn({ engine: "claudeAgent", args: MINIMAL_ARGV.claudeAgent, before: { ".claude/.credentials.json": '{"claudeAiOauth":{"accessToken":"legacy"}}', ...signinStore("claudeAgent", { ".claude/.credentials.json": "{}" }) },
      during: { ".claude/.credentials.json": '{"claudeAiOauth":{"accessToken":"t"}}' } });
    expect([planted.snapshot, planted.changed, planted.published]).toEqual([{}, [], []]);
    const [message, after] = result(`out.append(logout("claudeAgent")); out.append(current("claudeAgent"))`);
    expect(message).toBe("Signed out of Claude on this Cloud home.\r\n");
    expect(after).toMatchObject({ g: 2, record: { mode: null, kind: "signout" }, files: {} });
    expect(rig.plan(request).ok!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("Codex key mode (r9 H Codex C, fixture 20)", () => {
  it("enroll-key publishes the key; turns render a read-only auth.json with exactly the key, no key variable, nothing staged or collected", () => {
    const B = signinStore("codex", { ".codex/auth.json": '{"tokens":{"access_token":"chatgpt"}}' });
    const before = rig.plan(rig.request("codex"));
    expect(before.ok!.files[`${rig.home("codex")}/.codex/auth.json`]).toBeUndefined();
    rig.turn({ engine: "codex", args: MINIMAL_ARGV.codex, bot: null, before: B });
    expect(rig.plan(rig.request("codex")).ok!.staged).toEqual({ ".codex/auth.json": expect.any(String) });
    const [message, record] = result(`out.append(enroll("codex", "${KEY}")); out.append(current("codex")["record"])`);
    expect(message).toBe("Codex key enrolled on this Cloud home.\r\n");
    expect(record).toMatchObject({ mode: "apikey", kind: "enroll", files: { key: { keys: [] } } });
    const plan = rig.plan(rig.request("codex", { env: { OPENAI_API_KEY: "request-openai", CODEX_API_KEY: "request-codex" } })).ok!;
    expect(JSON.parse(plan.files[`${rig.home("codex")}/.codex/auth.json`])).toEqual({ OPENAI_API_KEY: KEY });
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.env.CODEX_API_KEY).toBeUndefined();
    expect(plan.staged).toEqual({});
    const i = plan.argv.indexOf(`${rig.home("codex")}/.codex/auth.json`);
    expect(plan.argv[i - 2]).toBe("--ro-bind-data");
    const [collected, still] = result(`
t=stage("codex", "${A}", render={"credentials": {"key": "${KEY}"}})
pre=staged(t); put(t, ".codex/auth.json", '{"OPENAI_API_KEY":"swapped"}'); out.append([pre, collect(t)])
out.append(current("codex", "${A}")["g"])`);
    expect(collected).toEqual([{}, { changed: [], err: "" }]);
    expect(still).toBe(1);
    expect(readFileSync(launcher, "utf8")).toContain("signin=not signin_rendered(engine, render)");
  });
});

describe("B mode per bot (r8 R4, fixture 21)", () => {
  it("login requests: B logins name their bot, Claude's and key enrollments never do, shapes are checked, a tombstoned bot refuses", () => {
    const out = result(`
out.append(login_request(engine="codex", action="login", bot="alpha", pty=True, unit="murage-turn-0123456789abcdef.scope"))
out.append(login_request(engine="opencodeGo", action="login", bot="alpha")["args"])
out.append(login_request(engine="claudeAgent", action="login")["args"])
for kw in [dict(engine="codex", action="login"), dict(engine="grokAgent", action="login"), dict(engine="claudeAgent", action="login", bot="alpha"),
           dict(engine="codex", action="enroll-key", secret="${KEY}", bot="alpha"), dict(engine="codex", action="enroll-key"), dict(engine="codex", action="enroll-key", secret="short"),
           dict(engine="codex", action="enroll-key", secret="${KEY}", provider="openai"), dict(engine="opencodeGo", action="enroll-key", secret="${OC_KEY}"),
           dict(engine="opencodeGo", action="enroll-key", secret="${OC_KEY}", provider="Bad/Provider"), dict(engine="grokAgent", action="enroll-key", secret="${KEY}"),
           dict(engine="codex", action="login", bot="../x"), dict(engine="codex", action="logout", secret="${KEY}"), dict(engine="codex", action="status")]:
    out.append(login_request(**kw))
out.append(login_request(engine="kimiAgent", action="logout")); out.append(login_request(engine="kimiAgent", action="logout", bot="alpha"))
m.write_tombstone("gone")
out.append(login_request(engine="codex", action="login", bot="gone")); out.append(login_request(engine="codex", action="logout", bot="gone"))
out.append(hasattr(m, "LOCAL_LOGOUT") or hasattr(m, "local_logout") or any("logout" in actions for _c, actions in m.LOGIN_COMMANDS.values()))
`);
    expect(out[0]).toEqual({ engine: "codex", command: "/opt/murage/bin/codex", args: ["login", "--device-auth"], cwd: "/data/engine-homes/codex", env: expect.any(Object), bot: "alpha", unit: "murage-turn-0123456789abcdef.scope", pty: true });
    expect(out.slice(1, 3)).toEqual([["auth", "login"], ["setup-token"]]);
    expect(out.slice(3, 16)).toEqual(["Cloud sign-in names no bot", "Cloud sign-in names no bot", "Cloud sign-in takes no bot", "Cloud sign-in takes no bot", "Cloud sign-in key is not allowed",
      "Cloud sign-in key is not allowed", "Cloud sign-in provider is not allowed", "Cloud sign-in provider is not allowed", "Cloud sign-in provider is not allowed", "Invalid cloud login action",
      "Cloud turn bot is not allowed", "Cloud sign-in key is not allowed", "Invalid cloud login action"]);
    expect(out.slice(16, 18)).toEqual([{ engine: "kimiAgent", publish: "logout" }, { engine: "kimiAgent", publish: "logout", bot: "alpha" }]);
    expect(out.slice(18)).toEqual(["Cloud bot was deleted", "Cloud bot was deleted", false]);
  });
  it("a Codex ChatGPT login publishes under bots/<bot>/signin; another bot never stages it; a planted legacy file never reaches a turn", () => {
    const [login, published, other, legacy, again, loggedOut, query] = result(`
os.makedirs(ER+"/codex/.codex", exist_ok=True); open(ER+"/codex/.codex/auth.json", "w").write('{"tokens":{"access_token":"legacy"}}')
t=stage("codex", "alpha"); put(t, ".codex/auth.json", '{"tokens":{"access_token":"new","account_id":"acct"}}'); out.append(collect(t, login=True))
out.append(current("codex", "alpha"))
out.append(staged(stage("codex", "beta")))
out.append(staged(stage("codex", "alpha")))
t=stage("codex", "alpha"); out.append(collect(t, login=True))
out.append(logout("codex", "alpha"))
out.append(m.bot_state_query({"mode": "bot-state-query", "bot": "alpha"}, engine_root=ER)["engines"]["codex"])
`);
    expect(login).toEqual({ changed: [".codex/auth.json"], err: "" });
    expect(published).toMatchObject({ g: 1, record: { mode: "chatgpt", kind: "signin", unit: "u", expiresAt: null, files: { ".codex/auth.json": { keys: ["tokens"] } } } });
    expect(other).toEqual({});
    expect(legacy).toEqual({ ".codex/auth.json": '{"tokens":{"access_token":"new","account_id":"acct"}}' });
    expect(again).toEqual({ changed: [], err: "" });
    expect(loggedOut).toBe("Signed out of Codex for this bot on this Cloud home.\r\n");
    expect(query).toEqual({ mode: null, signedIn: false, expiresAt: null });
    expect(existsSync(join(rig.home("codex"), "bots", "beta", "signin"))).toBe(false);
  });
  it("a sign-in turn's set is taken whole; a non-login turn that deletes a file publishes a sign-out", () => {
    const [kimiLogin, out1, refreshed, signout] = result(`
t=stage("kimiAgent", "alpha"); put(t, ".kimi-code/credentials/kimi-code.json", '{"a":"1"}'); put(t, ".kimi-code/credentials/kimi-code-env-1.json", "{}")
out.append(collect(t, login=True)["changed"])
t=stage("kimiAgent", "alpha"); put(t, ".kimi-code/credentials/kimi-code-env-1.json", None); out.append(collect(t))
out.append(current("kimiAgent", "alpha")["record"])
t=stage("kimiAgent", "alpha"); put(t, ".kimi-code/credentials/kimi-code.json", None); out.append(current("kimiAgent", "alpha")["g"] if not collect(t)["changed"] else current("kimiAgent", "alpha"))
`);
    expect(kimiLogin).toEqual([".kimi-code/credentials/kimi-code-env-1.json", ".kimi-code/credentials/kimi-code.json"]);
    expect(out1).toEqual({ changed: [".kimi-code/credentials/kimi-code-env-1.json"], err: "" });
    expect(refreshed).toMatchObject({ mode: null, kind: "signout", files: { ".kimi-code/credentials/kimi-code.json": { keys: ["a"] } } });
    expect(signout).toMatchObject({ g: 3, record: { kind: "signout" }, files: {} });
  });
  it("engine-signin-cleanup erases every signin/ store and every bots/*/signin/ with the legacy files", () => {
    const [cleaned, left] = result(`
publish("codex", {"key": "${KEY}"}, {"mode": "apikey", "kind": "enroll", "enrolledAt": 1, "expiresAt": None})
publish("codex", {".codex/auth.json": "{}"}, {"mode": "chatgpt", "kind": "signin", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
publish("kimiAgent", {}, {"mode": None, "kind": "signout", "enrolledAt": 1, "expiresAt": None}, bot="beta")
os.makedirs(ER+"/codex/bots/alpha/.codex/sessions", exist_ok=True)
out.append(m.cleanup_engine_signins({"mode": "engine-signin-cleanup"}, root=ER, owners={os.getuid()}, root_owner=os.getuid()))
rels=[os.path.relpath(os.path.join(d, n), ER) for d, dirs, files in os.walk(ER) for n in dirs + files]
out.append(sorted(r for r in rels if "signin" in r or "/bots/" in r))
`);
    expect(cleaned).toEqual({ claudeAgent: "ok", codex: "ok", grokAgent: "ok", opencodeGo: "ok", kimiAgent: "ok" });
    expect(left).toEqual(["codex/bots/alpha", "codex/bots/alpha/.codex", "codex/bots/alpha/.codex/sessions", "kimiAgent/bots/beta"]);
  });
});

describe("OpenCode modes (r9 OpenCode, fixture 22)", () => {
  const oauth = '{"anthropic":{"type":"oauth","refresh":"r","access":"a","expires":1}}';
  it("an api entry enrolled to the C store reaches OPENCODE_AUTH_CONTENT; a second merges; a route joins them", () => {
    const [m1, m2] = result(`out.append(enroll("opencodeGo", "${OC_KEY}", "openai")); out.append(enroll("opencodeGo", "${OC_KEY}x", "groq"))`);
    expect([m1, m2]).toEqual(["OpenCode key enrolled on this Cloud home.\r\n", "OpenCode key enrolled on this Cloud home.\r\n"]);
    expect(JSON.parse(rig.plan(rig.request("opencodeGo")).ok!.env.OPENCODE_AUTH_CONTENT)).toEqual({ groq: { type: "api", key: `${OC_KEY}x` }, openai: { type: "api", key: OC_KEY } });
    const route = { provider: "flux", baseUrl: "https://fixture.example/v1", model: "m", apiKey: "fixture-route-key" };
    expect(Object.keys(JSON.parse(rig.plan(rig.request("opencodeGo", { render: { route } })).ok!.env.OPENCODE_AUTH_CONTENT)).sort()).toEqual(["flux", "groq", "openai"]);
    expect(result(`out.append(logout("opencodeGo"))`)).toEqual(["Signed out of OpenCode on this Cloud home.\r\n"]);
    expect(rig.plan(rig.request("opencodeGo")).ok!.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });
  it("oauth only: the variable is unset and the bot's staged auth.json is read; a planted disk-home auth.json is never read", () => {
    rig.turn({ engine: "opencodeGo", args: MINIMAL_ARGV.opencodeGo, bot: null, before: { ...signinStore("opencodeGo", { ".local/share/opencode/auth.json": oauth }), ".local/share/opencode/auth.json": '{"x":{"type":"api","key":"legacy-disk-key"}}' } });
    const plan = rig.plan(rig.request("opencodeGo")).ok!;
    expect(plan.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(Object.keys(plan.staged)).toEqual([".local/share/opencode/auth.json"]);
    expect(JSON.stringify(plan)).not.toContain("legacy-disk-key");
    expect(validated(rig.request("opencodeGo")).err).toBe("");
    expect(result(`out.append(hasattr(m, "opencode_saved_auth")); out.append([e for e in m.PERSISTED_STATE["opencodeGo"]])`)).toEqual([false, [[".local/share/opencode/auth.json", "opencode-auth", "signin"]]]);
  });
  it("mixed: the C entries win and the turn says so once; collect keeps only the oauth entries a login wrote", () => {
    rig.turn({ engine: "opencodeGo", args: MINIMAL_ARGV.opencodeGo, bot: null, before: signinStore("opencodeGo", { ".local/share/opencode/auth.json": oauth }) });
    result(`enroll("opencodeGo", "${OC_KEY}", "openai")`);
    const mixed = validated(rig.request("opencodeGo"));
    expect(JSON.parse(mixed.env.OPENCODE_AUTH_CONTENT)).toEqual({ openai: { type: "api", key: OC_KEY } });
    expect(mixed.err).toBe(SHADOWED);
    const [login, store] = result(`
t=stage("opencodeGo", "alpha"); put(t, ".local/share/opencode/auth.json", '{"google":{"type":"oauth","refresh":"g","access":"h","expires":2},"typed":{"type":"api","key":"typed-in-login-key"},"wk":{"type":"wellknown","key":"k"}}')
out.append(collect(t, login=True)); out.append(current("opencodeGo", "alpha"))`);
    expect(login).toEqual({ changed: [".local/share/opencode/auth.json"], err: "" });
    expect(JSON.parse((store as { files: Record<string, string> }).files[".local/share/opencode/auth.json"])).toEqual({ google: { type: "oauth", refresh: "g", access: "h", expires: 2 } });
  });
});
