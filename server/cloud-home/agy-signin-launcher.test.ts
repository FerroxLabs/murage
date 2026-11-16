// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD 4 items 5 and 6, design test 11 (launcher half): the refusal record and turn admission for Antigravity.
// Drives the real launcher Python in a throwaway rig (the same one the commit gate tests use).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-agy-signin-"); });
afterEach(() => rig.dispose());

const prelude = `
root=sys.argv[2]; ER=root+"/engine-homes"
m.ENGINE_ROOT=ER; m.LIVE_DIR=root+"/live"; m.TOMBSTONE_DIR=root+"/deleted"
TOKEN=".gemini/antigravity-cli/antigravity-oauth-token"
def store(bot, create=True): return m.engine_signin_store("antigravity", bot, create=create, engine_root=ER)
def publish(files, kind="signin", bot="alpha"):
    fd=store(bot)
    try:
        record={"mode": "oauth" if files and kind != "signout" else None, "kind": kind, "enrolledAt": 1, "expiresAt": None}
        return m.publish_generation(fd, {k: v.encode() for k, v in files.items()}, record, "u")
    finally: os.close(fd)
def refuse(epoch, bot="alpha"):
    try: return m.mark_signin_refused({"mode": "signin-refused", "engine": "antigravity", "bot": bot, "epoch": epoch}, ER)
    except ValueError as e: return str(e)
def admit(bot="alpha", expected=None):
    hfd=os.open(ER+"/antigravity", os.O_RDONLY|os.O_DIRECTORY)
    try: m.admit_signin(hfd, "antigravity", bot, expected); return "admitted"
    except m.Refusal as e: return str(e)
def query(bot="alpha"): return m.bot_state_query({"mode": "bot-state-query", "bot": bot}, ER)["engines"].get("antigravity")
def publish_through(kind, files, bot="alpha"):
    """The real publish seam, as collect_signin calls it."""
    hfd=os.open(ER+"/antigravity", os.O_RDONLY|os.O_DIRECTORY)
    return m.publish_signin(hfd, "antigravity", bot, {k: v.encode() for k, v in files.items()}, "u", kind, 1)
out=[]
`;
const result = (source: string) => JSON.parse(rig.py(prelude + source + "\nprint(json.dumps(out))", rig.root, rig.manifest)) as unknown[];

describe("agy refusal record and turn admission", () => {
  it("turn admission refuses a bot with no published generation, a sign-out and a refusal mark; admits a signed-in bot", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
out.append(admit())
publish({TOKEN: '{"access_token":"a"}'}); out.append(admit())
refuse(1); out.append(admit())
publish({}, "signout"); out.append(admit())`);
    expect(r).toEqual(["Cloud engine is not signed in", "admitted", "Cloud engine is not signed in", "Cloud engine is not signed in"]);
  });
  it("a refusal marks only the login epoch the turn ran with, and the status says needs sign-in", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
publish({TOKEN: '{"access_token":"a"}'}); publish({TOKEN: '{"access_token":"b"}'}, "refresh")
out.append(refuse(2)); out.append(query())
out.append(refuse(1)); q=query(); out.append(q)`);
    expect(r[0]).toBe(false);
    expect(r[1]).toMatchObject({ signedIn: true, generation: 2, epoch: 1 });
    expect(r[2]).toBe(true);
    expect(r[3]).toMatchObject({ signedIn: false, needsSignin: true, generation: 2, epoch: 1 });
  });
  it("a login clears the mark and an in-place refresh does not; a refusal for the old epoch never marks the new one", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
publish({TOKEN: '{"access_token":"a"}'}); refuse(1)
publish_through("refresh", {TOKEN: '{"access_token":"a2"}'}); out.append(query())
out.append(refuse(1)); out.append(query())
publish_through("signin", {TOKEN: '{"access_token":"c"}'}); out.append(query()); out.append(admit())
out.append(refuse(1)); out.append(query()["signedIn"])`);
    expect(r[0]).toMatchObject({ signedIn: false, needsSignin: true, generation: 2, epoch: 1 });
    expect(r[1]).toBe(true);
    expect(r[2]).toMatchObject({ signedIn: false, needsSignin: true, generation: 2, epoch: 1 });
    expect(r[3]).toMatchObject({ signedIn: true, generation: 3, epoch: 2 });
    expect((r[3] as Record<string, unknown>).needsSignin).toBeUndefined();
    expect(r[4]).toBe("admitted");
    expect(r[5]).toBe(false);
    expect(r[6]).toBe(true);
  });
  it("Astra r2 #1: a turn staged G1, another turn refreshed to G2, then G1's refusal arrives: the epoch is still refused and G2 does not run", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
publish({TOKEN: '{"access_token":"a"}'})
epoch=query()["epoch"]; out.append(admit(expected=epoch))
publish_through("refresh", {TOKEN: '{"access_token":"a2"}'}); out.append(query()["generation"])
out.append(refuse(epoch)); q=query(); out.append([q["signedIn"], q.get("needsSignin")]); out.append(admit(expected=epoch)); out.append(admit())`);
    expect(r).toEqual(["admitted", 2, true, [false, true], "Cloud engine is not signed in", "Cloud engine is not signed in"]);
  });
  it("admission binds the turn to the login epoch the server read: a refresh keeps it admitted, a login in between refuses", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
publish({TOKEN: '{"access_token":"a"}'}); out.append(admit(expected=1))
publish_through("refresh", {TOKEN: '{"access_token":"a2"}'}); out.append(admit(expected=1)); out.append(admit())
publish_through("signin", {TOKEN: '{"access_token":"b"}'}); out.append(admit(expected=1)); out.append(admit(expected=2))`);
    expect(r).toEqual(["admitted", "admitted", "admitted", "Cloud engine sign-in changed; try again", "admitted"]);
  });
  it("a crash at any point of an in-place refresh keeps the refusal (a refresh never touches the mark)", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
real=m.publish_generation
class Crash(Exception): pass
def crashing(where):
    def f(*a, **k):
        if where == "before": raise Crash()
        n=real(*a, **k)
        raise Crash()
    return f
for where in ("before", "after"):
    bot="b-"+where
    publish({TOKEN: '{"access_token":"a"}'}, bot=bot); refuse(1, bot=bot)
    m.publish_generation=crashing(where)
    try: publish_through("refresh", {TOKEN: '{"access_token":"a2"}'}, bot=bot)
    except Crash: pass
    m.publish_generation=real
    q=query(bot); out.append([q["generation"], q.get("needsSignin"), q["signedIn"], admit(bot)])
publish({TOKEN: '{"access_token":"a"}'}, bot="ok"); refuse(1, bot="ok")
publish_through("refresh", {TOKEN: '{"access_token":"a2"}'}, bot="ok"); q=query("ok"); out.append([q["generation"], q.get("needsSignin")])
publish_through("signin", {TOKEN: '{"access_token":"c"}'}, bot="ok"); q=query("ok"); out.append([q["generation"], q.get("needsSignin"), admit("ok")])`);
    expect(r).toEqual([[1, true, false, "Cloud engine is not signed in"], [2, true, false, "Cloud engine is not signed in"], [2, true], [3, null, "admitted"]]);
  });
  it("refuses a malformed refusal request and marks nothing for a signed-out store or a tombstoned bot", () => {
    const r = result(`
os.makedirs(ER+"/antigravity", exist_ok=True)
out.append(refuse(0)); out.append(refuse(True)); out.append(refuse(1))
publish({}, "signout"); out.append(refuse(1))
try: m.mark_signin_refused({"mode": "signin-refused", "engine": "codex", "bot": "alpha", "epoch": 1}, ER); out.append("accepted")
except ValueError as e: out.append(str(e))`);
    expect(r).toEqual(["Invalid cloud sign-in refusal request", "Invalid cloud sign-in refusal request", false, false, "Invalid cloud sign-in refusal request"]);
  });
  it("login mode starts with empty staged auth, publishes nothing when the vendor wrote no token, and publishes the new token as the next generation", () => {
    const r = result(`
import tempfile
os.makedirs(ER+"/antigravity", exist_ok=True)
publish({TOKEN: '{"access_token":"a"}'})
def login_turn(write):
    t=tempfile.mkdtemp(dir=root); hfd=os.open(ER+"/antigravity", os.O_RDONLY|os.O_DIRECTORY); tfd=os.open(t, os.O_RDONLY|os.O_DIRECTORY)
    snap=m.stage_turn_home(hfd, "antigravity", tfd, None, (os.getuid(),), m.turn_state_ids("antigravity", [], None), bot="alpha", render=None, login=True)
    staged=os.path.exists(t+"/"+TOKEN)
    if write:
        os.makedirs(os.path.dirname(t+"/"+TOKEN), exist_ok=True); open(t+"/"+TOKEN, "w").write('{"access_token":"new"}')
    changed=m.collect_turn_home(hfd, "antigravity", tfd, snap, None, (os.getuid(),), m.turn_state_ids("antigravity", [], None), bot="alpha", unit="u", login=True, signin=True, commit=False)
    return [staged, changed, snap.generation]
out.append(login_turn(False)); out.append(query()["generation"]); out.append(login_turn(True)); out.append(query()["generation"])`);
    expect(r).toEqual([[false, [], 1], 1, [false, [TOKEN_REL], 1], 2]);
  });
});
const TOKEN_REL = ".gemini/antigravity-cli/antigravity-oauth-token";
