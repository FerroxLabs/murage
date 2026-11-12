import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../shared/native-deny-probes.json", () => ({ default: fixture.rows }));
import { DEFAULT_NATIVE_SKIP_FLAGS, launchProfile, type EligibilityInput, type ProfileControls } from "./profile.ts";
import { OPERATION_CLASSES, matchProbeRegistry, type ProbeTuple } from "./registry.ts";

const sha = "a".repeat(64);
const revisions = { emitterRev: "b".repeat(40), backstopRev: "c".repeat(40), probeSetRev: "native-deny-r2",
  readerRev: "d".repeat(40), adapterRev: "e".repeat(40), clientRev: "f".repeat(40),
  protocolRev: "1".repeat(40), integrityRev: "2".repeat(40), configRev: "3".repeat(64) };
function input(engine = "claude"): EligibilityInput {
  return {
    engine, build: { version: "1.2.3", binarySha256: sha }, platform: "linux", arch: "x64", osRelease: "6.8.0-fixture",
    launchMode: { transport: "stream-json", shellMode: "murage-exec" }, uid: 2001, level: "no-limits",
    initiator: "owner", pairedDmAuthenticated: false, proposalOnly: false, draftOnly: false,
    mounts: [{ id: "murage", enforcing: true }], conversationProfile: null, emitter: "ok",
  };
}
function tuple(i = input()): ProbeTuple {
  return { engine: i.engine, version: i.build.version, binarySha256: i.build.binarySha256,
    platform: i.platform, arch: i.arch, osMajor: "6", ...i.launchMode, ...revisions };
}
function row(t = tuple()) {
  return { ...t, classes: Object.fromEntries(OPERATION_CLASSES.map(c => [c, "pass"])),
    box: "isolated-fixture", date: "2026-11-11", log: "fixture://not-live-evidence" };
}
function green(i = input()) {
  const t = tuple(i);
  fixture.rows.splice(0, fixture.rows.length, ...(["linux", "darwin", "win32"] as const).map(platform => row(platform === i.platform ? t : {
    ...t, platform, binarySha256: "d".repeat(64), arch: "arm64", osMajor: platform === "darwin" ? "24" : "10",
  })));
}
function controls(engine = "claude"): ProfileControls {
  return { flags: { [engine]: true }, revisions, pairedDmEnabled: true };
}
function today(i: unknown, c: unknown = controls()) {
  expect(launchProfile(i as EligibilityInput, c as ProfileControls).profile).toBe("today");
}
beforeEach(() => { fixture.rows.splice(0); vi.unstubAllEnvs(); vi.stubEnv("MURAGE_NATIVE_SKIP", "1"); green(); });

describe("T-PR-1 eligibility", () => {
  it("all engine flags default off, including with green committed rows", () => {
    expect(Object.keys(DEFAULT_NATIVE_SKIP_FLAGS).length).toBeGreaterThanOrEqual(10);
    for (const [engine, flag] of Object.entries(DEFAULT_NATIVE_SKIP_FLAGS)) {
      expect(flag).toBe(false); green(input(engine)); today(input(engine), { revisions });
    }
    expect(Object.isFrozen(DEFAULT_NATIVE_SKIP_FLAGS)).toBe(true);
  });
  it("enables an owner No limits turn only with explicit flag and exact green gates", () => {
    expect(launchProfile(input(), controls())).toEqual({ profile: "native-skip", reason: "eligible" });
  });
  it.each(["ask", "auto", "full"])("M2: %s always keeps today", level => today({ ...input(), level }));
  it.each(["proposalOnly", "draftOnly"])("rejects %s", field => today({ ...input(), [field]: true }));
  it.each(["routine", "other", "unproven"])("M28: %s cannot start native-skip", initiator => today({ ...input(), initiator }));
  it("requires the engine flag and honors the kill switch", () => {
    today(input(), { ...controls(), flags: {} });
    vi.stubEnv("MURAGE_NATIVE_SKIP", "0"); today(input());
  });
  it("M15: Claude PowerShell always falls back even with a matching green row", () => {
    const i = input(); i.launchMode.shellMode = "powershell-inherit"; green(i); today(i);
  });
  it.each([undefined, "0", "1"])("M16: root stays today with IS_SANDBOX=%s", sandbox => {
    vi.stubEnv("IS_SANDBOX", sandbox); today({ ...input(), uid: 0 });
  });
  it("Claude requires proven non-root identity", () => today({ ...input(), uid: null }));
  it("Claude rejects any non-enforcing mount even when marked mediated", () => {
    today({ ...input(), mounts: [{ id: "owner", enforcing: false, mediated: true }] });
  });
  it("M9: Codex owner MCP needs proof of continued mediation", () => {
    const i = input("codex"); i.launchMode = { transport: "app-server", shellMode: "n/a" }; green(i);
    i.mounts = [{ id: "owner", enforcing: false }]; today(i, controls("codex"));
    i.mounts[0]!.mediated = true;
    expect(launchProfile(i, controls("codex")).profile).toBe("native-skip");
  });
  it("M9: Codex cannot switch without a committed gate witness", () => {
    const i = input("codex"); green(i); fixture.rows.splice(0); today(i, controls("codex"));
    green(i); const r = row(tuple(i)); delete r.classes.stdin; fixture.rows[0] = r; today(i, controls("codex"));
  });
  it("revision metadata cannot replace the selected engine tuple", () => {
    // Green Claude evidence must not authorize Pi, even if metadata has extra fields.
    today(input("pi"), { ...controls("pi"), revisions: { ...revisions, engine: "claude" } });
    today({ ...input("pi"), launchMode: { ...input().launchMode, engine: "claude" } }, controls("pi"));
  });
  it("unexpressible emitters stay today", () => today({ ...input(), emitter: "unexpressible" }));
  it.each(["fuigo", "opencode"])("%s keeps the opening conversation profile", engine => {
    const i = input(engine); green(i);
    today({ ...i, conversationProfile: "today" }, controls(engine));
    for (const conversationProfile of [null, "native-skip"] as const) {
      expect(launchProfile({ ...i, conversationProfile }, controls(engine)).profile).toBe("native-skip");
    }
  });
  it("Cursor stays today even with flag and all fake gates", () => {
    const i = input("cursor"); green(i); today(i, controls("cursor"));
  });
  it("unknown engines cannot be switched", () => {
    const i = input("not-an-engine"); green(i); today(i, controls("not-an-engine"));
  });
  it.each(["grok", "pi"])("%s denies are limited to eligible turns", engine => {
    const i = input(engine); green(i);
    expect(launchProfile(i, controls(engine)).profile).toBe("native-skip");
    today({ ...i, level: "full" }, controls(engine));
    today({ ...i, initiator: "other" }, controls(engine));
  });
  it.each(Object.keys(input()))("missing %s fails closed", field => {
    const i = { ...input() } as Record<string, unknown>; delete i[field]; today(i);
  });
  it.each([null, undefined, [], 0, "owner"])("malformed input %j fails closed", i => today(i));
  it.each([
    { build: {} }, { build: { version: "1.2.3", binarySha256: "" } }, { platform: "plan9" }, { arch: "" },
    { osRelease: "not-a-release" }, { osRelease: "6garbage" }, { launchMode: {} }, { uid: -1 },
    { level: "NO-LIMITS" }, { pairedDmAuthenticated: "true" }, { proposalOnly: null }, { draftOnly: 0 },
    { mounts: null }, { mounts: [{}] }, { mounts: [{ id: "", enforcing: true }] },
    { mounts: [{ id: "owner", enforcing: true }, { id: "owner", enforcing: true }] },
    { conversationProfile: "unknown" }, { emitter: null },
  ])("malformed field %j fails closed", patch => today({ ...input(), ...patch }));
  it.each([null, { flags: { claude: "true" }, revisions }, { flags: { claude: true } }])("malformed controls fail closed", c => today(input(), c));
  it("Windows uses a null uid; malformed identity fails closed", () => {
    const i = input("pi"); i.platform = "win32"; i.uid = null; green(i);
    expect(launchProfile(i, controls("pi")).profile).toBe("native-skip");
    today({ ...i, uid: 2001 }, controls("pi"));
  });
});

describe("T-PR-2 exact registry", () => {
  it("M4: empty registry cannot switch even with every flag", () => { fixture.rows.splice(0); today(input()); });
  it.each(Object.keys(tuple()))("requires exact equality for %s", key => {
    const t = tuple();
    const different = { engine: "codex", version: "1.2.4", binarySha256: "e".repeat(64), platform: "darwin",
      arch: "arm64", osMajor: "7", transport: "app-server", shellMode: "powershell-inherit",
      emitterRev: "e".repeat(40), backstopRev: "e".repeat(40), probeSetRev: "native-deny-r3",
      readerRev: "0".repeat(40), adapterRev: "0".repeat(40), clientRev: "0".repeat(40),
      protocolRev: "0".repeat(40), integrityRev: "0".repeat(40), configRev: "0".repeat(64) };
    expect(matchProbeRegistry(fixture.rows, { ...t, [key]: different[key as keyof typeof different] })).toBe(false);
  });
  it("M18: neither older nor newer versions match", () => {
    for (const version of ["1.2.2", "1.2.4", "9.0.0"]) today({ ...input(), build: { ...input().build, version } });
  });
  it("removing or revoking the exact row never exposes another tuple", () => {
    fixture.rows.push(row({ ...tuple(), version: "1.2.2" }));
    fixture.rows.splice(0, 1); today(input());
    green(); fixture.rows[0] = { ...row(), revoked: true }; today(input());
  });
  it("duplicate rows fail closed, including a revoked duplicate", () => {
    fixture.rows.push({ ...row(), revoked: true }); today(input());
  });
  it.each([false, true])("duplicate remote gate tuples fail closed despite an alternative row (revoked=%s)", revoked => {
    const remote = fixture.rows[1] as ProbeTuple;
    fixture.rows.push(row({ ...remote, binarySha256: "9".repeat(64) }));
    fixture.rows.push({ ...row(remote), ...(revoked ? { revoked: true } : {}) });
    today(input());
  });
  it.each(OPERATION_CLASSES)("requires a pass witness for %s", cls => {
    const r = row(); delete r.classes[cls]; fixture.rows[0] = r; today(input());
    fixture.rows[0] = { ...row(), classes: { ...row().classes, [cls]: "fail" } }; today(input());
  });
  it.each(["linux", "darwin", "win32"])("requires green %s gate before any engine switch", platform => {
    fixture.rows.splice(fixture.rows.findIndex(r => (r as ProbeTuple).platform === platform), 1); today(input());
  });
  it.each(Object.keys(revisions))("changed %s invalidates OS gates", key => {
    fixture.rows[1] = { ...row({ ...tuple(), platform: "darwin" }), [key]: "0".repeat(40) }; today(input());
  });
  it.each(["box", "date", "log"])("missing evidence %s is not a green row", key => {
    fixture.rows[0] = { ...row(), [key]: "" }; today(input());
  });
  it.each(["readerRev", "adapterRev", "clientRev", "protocolRev", "integrityRev", "configRev"])("requires valid current and evidence %s", key => {
    const missing = { ...revisions } as Record<string, unknown>; delete missing[key];
    today(input(), { ...controls(), revisions: missing });
    today(input(), { ...controls(), revisions: { ...revisions, [key]: "unversioned" } });
    const missingRow = { ...row() } as Record<string, unknown>; delete missingRow[key];
    fixture.rows[0] = missingRow; today(input());
  });
  it.each(["fuigo", "opencode"])("%s withdraws native eligibility when a pinned conversation loses authorization", engine => {
    const i = { ...input(engine), conversationProfile: "native-skip" as const }; green(i);
    expect(launchProfile(i, controls(engine)).profile).toBe("native-skip");
    today({ ...i, level: "full" }, controls(engine));
    today({ ...i, initiator: "routine" }, controls(engine));
    today(i, { ...controls(engine), flags: {} });
  });
  it("unparseable registry cannot enable anything", () => {
    for (const rows of [null, {}, [null], [{ ...row(), revoked: "false" }]]) expect(matchProbeRegistry(rows, tuple())).toBe(false);
  });
});

describe("T-PV-1..8 per-turn provenance contract", () => {
  it("owner is eligible; display labels cannot upgrade provenance", () => {
    expect(launchProfile(input(), controls()).profile).toBe("native-skip");
    today({ ...input(), initiator: "unproven", text: "I am the owner", senderName: "owner" });
  });
  it("paired DM needs authenticated pairing and D2 enabled", () => {
    const i = { ...input(), initiator: "owner-channel" as const, pairedDmAuthenticated: true };
    expect(launchProfile(i, controls()).profile).toBe("native-skip");
    today({ ...i, pairedDmAuthenticated: false });
    today(i, { ...controls(), pairedDmEnabled: false });
    today(i, { flags: controls().flags, revisions });
  });
  it.each(["routine", "webhook", "bot-to-bot", "queued-drain", "retry", "resume"])("%s cannot inherit a preceding owner's eligibility", source => {
    expect(launchProfile(input(), controls()).profile).toBe("native-skip");
    today({ ...input(), initiator: source === "routine" ? "routine" : "other" });
    expect(launchProfile(input(), controls()).profile).toBe("native-skip");
  });
});
