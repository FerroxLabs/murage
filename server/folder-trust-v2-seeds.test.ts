// FUIGO-TRUST-V2 R4, R5, S5a: seeds on a home made for one routed turn. The real Fuigo
// support runs against the fake ACP CLI's 1.0.35 protocol, which reads the seeded
// store with Fuigo's coverage (F5), so "the engine declined with no request" is the
// fake honouring the bytes Murage wrote. Launcher half: cloud-home/fuigo-seed-launcher.test.ts.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fixture.failRename) throw Object.assign(new Error("fixture rename"), { code: "EIO" });
    return actual.renameSync(...args);
  } };
});

import { ensureDirs } from "./config.ts";
import type { FolderTrustTurnInput, ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import type { ProviderTurnRoute } from "./provider-routing.ts";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { FolderTrustStore, folderTrustRecordRows, readUpstreamTrustFile } from "./folder-trust.ts";
import { folderPolicySeedAllowed, fuigoSeedPathValid, fuigoSeedText, planFuigoSeeds, writeFuigoSeed, CLOUD_SEED_MAX_PATHS } from "./folder-trust-seed.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { folderTrustDisplayName, folderTrustNotice, folderTrustPassedLine } from "../shared/folder-trust.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const REJECT_REPLY = '{"jsonrpc":"2.0","id":9006,"result":{"outcome":"reject"}}';
const TRUST_REPLY = '{"jsonrpc":"2.0","id":9006,"result":{"outcome":"trust","scope":"configAndCommands"}}';
const route = { connectionId: "seed-route", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "fixture-provider-key", model: "fixture-model", revision: "r1" } as ProviderTurnRoute;
const routed = { providerRoute: route, model: route.model } satisfies Partial<SendTurnInput>;
const table = (path: string, trusted: boolean) => `[folders.${JSON.stringify(path)}]\ntrusted = ${trusted}\nconsent = 2\n`;
const U2 = (key: string) => `You chose not to trust ${key}, and Murage passed that answer to Fuigo for this folder. To change it, forget ${key} in this conversation's folder settings.`;

let scratch: string;
beforeEach(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-trust-seeds-"))); fixture.failRename = false; });
afterEach(async () => { fixture.failRename = false; await removeTempDir(scratch); });
const folder = (...parts: string[]) => { const path = join(scratch, ...parts); mkdirSync(path, { recursive: true }); return path; };

describe("the seed plan (R4)", () => {
  it("seeds every reject at its key and its folder, and every consent-2 trust", () => {
    const [K, F, T, cwd] = [join(scratch, "K"), join(scratch, "F"), join(scratch, "T"), join(scratch, "cwd")];
    expect(planFuigoSeeds({ trustKeys: [T], rejects: [{ key: K, folder: F }], realCwd: cwd }, null)).toEqual({ trusts: [T], declines: [K, F], declineSkipped: false, policySeeded: false });
  });
  it("writes one table for a string that is both, as a decline", () => {
    const K = join(scratch, "K");
    const plan = planFuigoSeeds({ trustKeys: [K], rejects: [{ key: K, folder: K }], realCwd: join(scratch, "cwd") }, null);
    expect(plan).toMatchObject({ trusts: [], declines: [K] });
    expect(fuigoSeedText(plan).match(/\[folders\./g)).toHaveLength(1);
  });
  it("path-of-cwd: a trust a reject answers for under rule 2 stays out, so the engine asks", () => {
    const K = join(scratch, "K"), worktree = join(scratch, "linked"), cwd = join(worktree, "sub");
    // a declined worktree folder on the cwd's path, K outside it
    expect(planFuigoSeeds({ trustKeys: [K], rejects: [{ key: join(scratch, "elsewhere"), folder: worktree }], realCwd: cwd }, null).trusts).toEqual([]);
    // a strict ancestor of K never answers for K
    const parent = join(scratch, "P"), nested = join(parent, "K");
    expect(planFuigoSeeds({ trustKeys: [nested], rejects: [{ key: parent, folder: parent }], realCwd: nested }, null).trusts).toEqual([nested]);
  });
  it("a skipped decline drops every trust and the policy seed; the valid declines stay", () => {
    const good = join(scratch, "good"), T = join(scratch, "T"), cwd = join(scratch, "cwd");
    const plan = planFuigoSeeds({ trustKeys: [T], rejects: [{ key: good, folder: good }, { key: "relative/path", folder: good }], realCwd: cwd }, cwd);
    expect(plan).toEqual({ trusts: [], declines: [good], declineSkipped: true, policySeeded: false });
  });
  it("a skipped trust costs only itself: the engine asks and R3 answers", () => {
    const T = join(scratch, "T"), bad = join(scratch, "bad\nkey");
    expect(planFuigoSeeds({ trustKeys: [bad, T], rejects: [], realCwd: join(scratch, "cwd") }, null)).toMatchObject({ trusts: [T], declineSkipped: false });
  });
  it.each([
    ["relative", "some/folder"], ["root", "/"], ["a control character", "/tmp/a\tb"], ["DEL", "/tmp/a\u007fb"], ["a lone surrogate", "/tmp/a\ud800b"], ["not canonical", "/tmp/a/../b"], ["empty", ""],
  ])("validation refuses %s", (_name, path) => { expect(fuigoSeedPathValid(path)).toBe(false); });
  it("validation refuses the owner's home and accepts a plain path with quotes and any letters", () => {
    expect(fuigoSeedPathValid(process.env.HOME ?? "/root")).toBe(false);
    expect(fuigoSeedPathValid('/tmp/a"b\\c \u{1f600} é')).toBe(true);
  });
  it("a Cloud plan keeps the launcher's limits, and an overflowing decline is a skipped decline", () => {
    const home = "/data/engine-homes/fuigoAgent";
    expect(fuigoSeedPathValid(home, home)).toBe(false);
    expect(fuigoSeedPathValid(`/w/${"x".repeat(5000)}`, home)).toBe(false);
    const many = Array.from({ length: CLOUD_SEED_MAX_PATHS + 1 }, (_v, index) => join(scratch, `d${index}`));
    const plan = planFuigoSeeds({ trustKeys: [join(scratch, "T")], rejects: many.map((path) => ({ key: path, folder: path })), realCwd: join(scratch, "cwd") }, null, home);
    expect(plan).toMatchObject({ declineSkipped: true, trusts: [] });
    expect(plan.declines).toHaveLength(CLOUD_SEED_MAX_PATHS);
    const heavy = Array.from({ length: 200 }, (_v, index) => join(scratch, `${index}${"y".repeat(3000)}`));
    expect(planFuigoSeeds({ trustKeys: [], rejects: heavy.map((path) => ({ key: path, folder: path })), realCwd: join(scratch, "cwd") }, null, home).declineSkipped).toBe(true);
  });
  it("the text is Fuigo's table shape, and Murage's own strict reader takes it back", () => {
    const hard = join(scratch, 'q"uo\\te \u{1f600}'), T = join(scratch, "T");
    const text = fuigoSeedText({ trusts: [T], declines: [hard] });
    expect(text).toBe(`${table(hard, false)}\n${table(T, true)}`);
    const home = folder("home");
    expect(writeFuigoSeed(home, text)).toBe(true);
    expect(readUpstreamTrustFile(home)).toMatchObject({ declines: [hard], unreadable: false });
  });
});

describe("the atomic write (R4)", () => {
  const entries = (home: string) => readdirSync(home).sort();
  it("leaves only the file, mode 0600", () => {
    const home = folder("home");
    expect(writeFuigoSeed(home, table("/x", true))).toBe(true);
    expect(entries(home)).toEqual(["trusted_folders.toml"]);
    if (process.platform !== "win32") expect(statSync(join(home, "trusted_folders.toml")).mode & 0o777).toBe(0o600);
  });
  it("a file already there is left alone", () => {
    const home = folder("home");
    writeFileSync(join(home, "trusted_folders.toml"), "kept");
    expect(writeFuigoSeed(home, table("/x", true))).toBe(false);
    expect(readFileSync(join(home, "trusted_folders.toml"), "utf8")).toBe("kept");
    expect(entries(home)).toEqual(["trusted_folders.toml"]);
  });
  it("a failed rename leaves neither the temp file nor the store", () => {
    const home = folder("home");
    fixture.failRename = true;
    expect(writeFuigoSeed(home, table("/x", true))).toBe(false);
    expect(entries(home)).toEqual([]);
  });
  it("a home that cannot be written is an answer, not a throw", () => {
    expect(writeFuigoSeed(join(scratch, "missing"), table("/x", true))).toBe(false);
  });
});

describe("R5 on the policy folder", () => {
  it("a plain folder with no repository near it qualifies", async () => {
    expect(await folderPolicySeedAllowed(folder("desk", "inner"), [])).toBe(true);
  });
  it("a reject for the folder, an ancestor, by key or by folder, stops it", async () => {
    const cwd = folder("desk", "inner"), parent = dirname(cwd);
    for (const rejects of [[{ key: cwd, folder: join(scratch, "x") }], [{ key: join(scratch, "x"), folder: cwd }], [{ key: parent, folder: parent }], [{ key: join(scratch, "x"), folder: parent }]]) {
      expect(await folderPolicySeedAllowed(cwd, rejects)).toBe(false);
    }
    expect(await folderPolicySeedAllowed(cwd, [{ key: join(cwd, "below"), folder: join(cwd, "below") }])).toBe(true);
  });
  it.each(["a directory", "a file", "a symlink"])(".git as %s at, above or below stops it", async (kind) => {
    const make = (parent: string) => {
      const path = join(parent, ".git");
      if (kind === "a directory") mkdirSync(path);
      else if (kind === "a file") writeFileSync(path, "gitdir: elsewhere\n");
      else symlinkSync(join(scratch, "nowhere"), path);
    };
    const at = folder("at"); make(at);
    expect(await folderPolicySeedAllowed(at, [])).toBe(false);
    const above = folder("above"); make(above);
    expect(await folderPolicySeedAllowed(folder("above", "inner"), [])).toBe(false);
    const below = folder("below"); make(folder("below", "a", "b"));
    expect(await folderPolicySeedAllowed(below, [])).toBe(false);
  });
  it("a symlink to a repository is never followed", async () => {
    const repo = folder("repo"); mkdirSync(join(repo, ".git"));
    const desk = folder("desk");
    symlinkSync(repo, join(desk, "link"));
    expect(await folderPolicySeedAllowed(desk, [])).toBe(true);
  });
  it("a walk that stops at its bound counts as found", async () => {
    const big = folder("big");
    for (let index = 0; index <= 10_000; index += 1) writeFileSync(join(big, `f${index}`), "");
    expect(await folderPolicySeedAllowed(big, [])).toBe(false);
  }, 60_000);
});

// The opt-in pool is off on Windows; routed turns are never pooled, but the fake's coverage is POSIX paths.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("a routed turn on the real Fuigo driver", () => {
  let home: string;
  let cwd: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let trustLog: string;
  let dump: string;
  let store: FolderTrustStore;
  let storeFile: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    home = folder("home");
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    cwd = folder("work");
    trustLog = join(scratch, "trust.log");
    dump = join(scratch, "dump.json");
    storeFile = join(scratch, "folder-trust.json");
    store = new FolderTrustStore(storeFile);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
  });

  const create = async (environment: Record<string, string> = {}, config: { fullAuto?: boolean; cli?: string } = {}) => {
    recorder?.stop();
    await instance?.dispose();
    instance = await FuigoAgentDriver.create({
      instanceId: `fuigo-seed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "Fuigo",
      environment: { HOME: home, FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_MCP_READY: "1", FAKE_ACP_TRUST_LOG: trustLog, FAKE_ACP_DUMP: dump, ...environment },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, ...config },
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };
  const log = () => (existsSync(trustLog) ? readFileSync(trustLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) as Array<{ event: string; raw?: string; key?: string; verdict?: string; store?: string | null; home?: string }>;
  const starts = () => log().filter((entry) => entry.event === "start");
  const lastStart = () => starts().at(-1)!;
  const requests = () => log().filter((entry) => entry.event === "request");
  const replies = () => log().filter((entry) => entry.event === "reply").map((entry) => entry.raw);
  const spawnArgv = () => JSON.parse(readFileSync(dump, "utf8")).argv as string[];
  const gate = (over: Partial<FolderTrustTurnInput> = {}): FolderTrustTurnInput => ({ key: cwd, folder: cwd, sources: [], ...store.turnRecords(), ...over });
  const chips = () => recorder.events.filter((e) => e.type === "item.started").map((e) => (e as { title?: string }).title ?? "").filter((title) => folderTrustNotice(title));
  const passed = () => chips().filter((title) => folderTrustNotice(title)?.kind === "passed").map((title) => folderTrustNotice(title)!.key);
  const done = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  const opened = (turnId: string) => recorder.until((e) => e.type === "request.opened" && e.turnId === turnId) as Promise<Extract<RuntimeEvent, { type: "request.opened" }> & { requestId: string }>;
  const send = async (threadId: string, input: Partial<SendTurnInput> = {}) =>
    (await instance!.adapter.sendTurn({ threadId, text: "go", cwd, folderTrust: gate(), ...routed, ...input })).turnId;
  const skip = (threadId: string, requestId: string) => instance!.adapter.respondToRequest(threadId, requestId, { behavior: "deny" });
  const decline = (key: string, decidedIn: string) => store.remember(decidedIn, "reject", "card", { key, consent: 2 });
  const grant = (key: string, decidedIn = key) => store.remember(decidedIn, "trust", "card", { key, consent: 2 });
  /** A turn whose engine is expected to raise a card: it is skipped so the turn can end. */
  const sendThroughCard = async (threadId: string, input: Partial<SendTurnInput> = {}) => {
    const turnId = await send(threadId, input);
    const card = await opened(turnId);
    await skip(threadId, card.requestId);
    await done(turnId);
    return card;
  };

  describe("(3) routed fresh home, both shapes", () => {
    it("K = cwd: the seed holds it, the engine declines unasked, the chip names it; Forget brings the card back", async () => {
      await create();
      decline(cwd, cwd);
      await done(await send("t3a"));
      expect(lastStart()).toMatchObject({ verdict: "declined", asks: false, key: cwd });
      expect(lastStart().store).toBe(table(cwd, false));
      expect(requests()).toEqual([]);
      expect(passed()).toEqual([cwd]);
      expect(folderTrustRecordRows(store.list(), cwd)).toMatchObject([{ key: cwd, decision: "reject", onPath: true }]);
      expect(store.forgetKey(cwd)).toBe(true);
      const card = await sendThroughCard("t3a-next");
      expect(lastStart().store).toBeNull();
      expect(card.folderTrust).toMatchObject({ key: cwd, v2: true });
      expect(requests()).toHaveLength(1);
    });

    it("K = the main checkout, cwd a submodule in an outside worktree: seeded at key and folder, no chip when neither is the cwd", async () => {
      const K = folder("main"), decidedIn = folder("main", "src"), outside = folder("linked", "sub");
      cwd = outside;
      await create({ FAKE_ACP_TRUST_WORKSPACE: K });
      decline(K, decidedIn);
      await done(await send("t3b"));
      expect(lastStart().store).toBe(`${table(K, false)}\n${table(decidedIn, false)}`);
      expect(lastStart()).toMatchObject({ verdict: "declined", asks: false });
      expect(requests()).toEqual([]);
      expect(passed()).toEqual([]);
      expect(folderTrustRecordRows(store.list(), cwd)).toMatchObject([{ key: K, onPath: false }]);
      expect(store.forgetKey(K)).toBe(true);
      await sendThroughCard("t3b-next");
      expect(lastStart().store).toBeNull();
      expect(requests()).toHaveLength(1);
    });

    it("(note 5) a hidden key still qualifies when its stored folder equals the cwd", async () => {
      const K = folder("main"), outside = folder("linked", "sub");
      cwd = outside;
      await create({ FAKE_ACP_TRUST_WORKSPACE: K });
      decline(K, outside);
      await done(await send("t3c"));
      expect(passed()).toEqual([K]);
    });

    it("control: with no seed the same record is answered by rule 2 after a request", async () => {
      await create();
      decline(cwd, cwd);
      await done(await send("t3d", { providerRoute: undefined, model: undefined }));
      expect(requests()).toHaveLength(1);
      expect(replies()).toEqual([REJECT_REPLY]);
      expect(existsSync(join(home, ".fuigo", "trusted_folders.toml"))).toBe(false);
    });

    it("the seed never reaches the owner's own home", async () => {
      await create();
      decline(cwd, cwd);
      grant(folder("T"));
      await done(await send("t3e"));
      expect(lastStart().home).not.toBe(join(home, ".fuigo"));
      expect(existsSync(join(home, ".fuigo", "trusted_folders.toml"))).toBe(false);
    });
  });

  it("(4) Grok's split submodule: Forget K leaves S, the chip names S, Forget S brings the card", async () => {
    const K = folder("main"), S = folder("main", "sub");
    cwd = S;
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    decline(K, K);
    decline(S, S);
    await done(await send("t4a"));
    expect(lastStart().store).toContain(table(K, false));
    expect(lastStart().store).toContain(table(S, false));
    expect(passed()).toEqual([S]);
    expect(store.forgetKey(K)).toBe(true);
    await done(await send("t4b"));
    expect(lastStart().store).toBe(table(S, false));
    expect(lastStart().verdict).toBe("declined");
    expect(passed()).toEqual([S, S]);
    // on a home with no seed the engine asks for K, and rule 2 answers with S
    await done(await send("t4c", { providerRoute: undefined, model: undefined }));
    expect(replies()).toEqual([REJECT_REPLY]);
    expect(folderTrustNotice(chips().at(-1))).toMatchObject({ kind: "withheld", key: S });
    expect(store.forgetKey(S)).toBe(true);
    const card = await sendThroughCard("t4d");
    expect(card.folderTrust).toMatchObject({ key: K });
  });

  describe("(11) the chip", () => {
    it("shows once per thread", async () => {
      await create();
      decline(cwd, cwd);
      await done(await send("t11"));
      await done(await send("t11"));
      expect(passed()).toEqual([cwd]);
    });
    it("shares its once with the rule 2 chip for the same record", async () => {
      await create();
      decline(cwd, cwd);
      await done(await send("t11b", { providerRoute: undefined, model: undefined }));
      await done(await send("t11b"));
      expect(chips()).toHaveLength(1);
      expect(folderTrustNotice(chips()[0])).toMatchObject({ kind: "withheld", key: cwd });
    });
    it("is absent when no seeded decline is on the cwd's path", async () => {
      await create();
      const other = folder("other");
      decline(other, other);
      await sendThroughCard("t11c");
      expect(passed()).toEqual([]);
    });
    it.each<[string, { fullAuto?: boolean }, Partial<SendTurnInput>]>([["Ask", {}, {}], ["Full access", { fullAuto: true }, {}], ["No limits stop line", {}, { stopLine: true }]])("is present at %s", async (_mode, config, input) => {
      await create({}, config);
      decline(cwd, cwd);
      await done(await send("t11d", input));
      expect(passed()).toEqual([cwd]);
    });
  });

  describe("(S5a, note 5) each equality arm, with a distinct stored key and folder", () => {
    it("the stored key is the cwd, the folder elsewhere", async () => {
      await create();
      const other = folder("other");
      decline(cwd, other);
      await done(await send("t-a1"));
      expect(lastStart().store).toBe(`${table(cwd, false)}\n${table(other, false)}`);
      expect(passed()).toEqual([cwd]);
    });
    it("the stored folder is the cwd, the key elsewhere: the chip names the key, never the folder", async () => {
      const other = folder("other");
      await create({ FAKE_ACP_TRUST_WORKSPACE: other });
      decline(other, cwd);
      await done(await send("t-a2"));
      expect(passed()).toEqual([other]);
      expect(chips()[0]).not.toContain(cwd);
    });
    it("no ancestor matching: a decline above the cwd shows no chip", async () => {
      const parent = dirname(cwd);
      await create({ FAKE_ACP_TRUST_WORKSPACE: cwd });
      decline(parent, parent);
      await sendThroughCard("t-a3");
      expect(passed()).toEqual([]);
    });
    it("no successful seed, no chip: the engine asks and rule 2 answers", async () => {
      await create();
      decline(cwd, cwd);
      fixture.failRename = true;
      await done(await send("t-a4"));
      expect(lastStart().store).toBeNull();
      expect(passed()).toEqual([]);
      expect(requests()).toHaveLength(1);
      expect(folderTrustNotice(chips()[0])).toMatchObject({ kind: "withheld", key: cwd });
    });
    it("a failed write leaves declinesSeeded false, so a stored trust goes to the card", async () => {
      const unrelated = folder("unrelated");
      await create();
      grant(cwd);
      decline(unrelated, unrelated);
      fixture.failRename = true;
      const card = await sendThroughCard("t-a5");
      expect(card.folderTrust).toMatchObject({ key: cwd, declines: [unrelated] });
    });
    it("a skipped decline drops the trusts, keeps the valid declines and leaves declinesSeeded false", async () => {
      const unrelated = folder("unrelated");
      await create();
      await sendThroughCard("t-a6", { folderTrust: gate({ trustKeys: [cwd], rejects: [{ key: unrelated, folder: "not/absolute" }] }) });
      expect(lastStart().store).toBe(table(unrelated, false));
      expect(requests()).toHaveLength(1);
    });
    it("every decline written: rule 3 answers a trust the seed could not hold, with no card", async () => {
      const unrelated = folder("unrelated"), K = join(scratch, "line\nbreak");
      await create({ FAKE_ACP_TRUST_WORKSPACE: K });
      await done(await send("t-a7", { folderTrust: gate({ trustKeys: [K], rejects: [{ key: unrelated, folder: unrelated }] }) }));
      expect(lastStart().store).toBe(table(unrelated, false));
      expect(replies()).toEqual([TRUST_REPLY]);
    });
    it("no rejects and a fresh home: rule 3 stands and no file appears for nothing", async () => {
      await create();
      await sendThroughCard("t-a8");
      expect(lastStart().store).toBeNull();
    });
  });

  describe("(13) predicate and copy", () => {
    it("(a) a decline at the cwd exactly: U2's text byte for byte", async () => {
      await create();
      decline(cwd, cwd);
      await done(await send("t13a"));
      expect(requests()).toEqual([]);
      expect(passed()).toEqual([cwd]);
      expect(folderTrustDisplayName(chips()[0])).toBe(U2(cwd));
      expect(folderTrustPassedLine(cwd)).toBe(U2(cwd));
      expect(U2(cwd)).not.toMatch(/—|safe/iu);
    });
    it("(b) a decline at a strict ancestor, a trust at nested K = cwd: both seeded, trusted, no chip, listed on the path", async () => {
      const P = folder("P"), K = folder("P", "K");
      cwd = K;
      await create();
      decline(P, P);
      grant(K);
      await done(await send("t13b"));
      expect(lastStart().store).toBe(`${table(P, false)}\n${table(K, true)}`);
      expect(lastStart()).toMatchObject({ verdict: "trusted", asks: false });
      expect(chips()).toEqual([]);
      expect(folderTrustRecordRows(store.list(), cwd).find((row) => row.key === P)).toMatchObject({ decision: "reject", onPath: true });
    });
    it("(c) a decline at the cwd and a trust nested below it: the chip names the decline", async () => {
      const K = folder("work", "K");
      await create();
      decline(cwd, cwd);
      grant(K);
      await done(await send("t13c"));
      expect(lastStart().store).toBe(`${table(cwd, false)}\n${table(K, true)}`);
      expect(lastStart().verdict).toBe("declined");
      expect(passed()).toEqual([cwd]);
    });
    it("(d) the trust switch off: the engine runs trusted and the chip still reads true, claiming no verdict", async () => {
      await create({ FAKE_ACP_TRUST_DISABLED: "1" });
      decline(cwd, cwd);
      await done(await send("t13d"));
      expect(lastStart()).toMatchObject({ verdict: "trusted", asks: false });
      expect(folderTrustDisplayName(chips()[0])).toBe(U2(cwd));
    });
    describe.each([
      ["linked worktree", (s: string) => join(s, "worktrees-elsewhere", "wt")],
      ["`fuigo -w` worktree", (s: string) => join(s, "home", ".fuigo", "worktrees", "repo", "w1")],
      ["submodule", (s: string) => join(s, "main", "vendor", "lib")],
    ])("(note 5) cwd in a %s, the engine naming the main checkout", (_name, place) => {
      it("the record decided there qualifies by its folder and the chip names the key", async () => {
        const K = folder("main");
        cwd = place(scratch);
        mkdirSync(cwd, { recursive: true });
        await create({ FAKE_ACP_TRUST_WORKSPACE: K });
        decline(K, cwd);
        await done(await send("t13n"));
        expect(requests()).toEqual([]);
        expect(passed()).toEqual([K]);
      });
      it("the record decided at the main checkout is seeded and shows no chip", async () => {
        const K = folder("main");
        cwd = place(scratch);
        mkdirSync(cwd, { recursive: true });
        await create({ FAKE_ACP_TRUST_WORKSPACE: K });
        decline(K, K);
        await done(await send("t13o"));
        expect(lastStart()).toMatchObject({ verdict: "declined", asks: false });
        expect(passed()).toEqual([]);
      });
    });
  });

  describe("(7, R5) policy seeds", () => {
    const policyTurn = async (threadId: string, input: Partial<SendTurnInput> = {}) => {
      const applied = vi.fn();
      const turnId = await send(threadId, { folderTrust: gate({ decision: "trust", sources: ["AGENTS.md"] }), onFolderPolicyApplied: applied, ...input });
      return { applied, turnId };
    };
    it("a plain desk on a fresh home is seeded, trusted unasked, and the line is due once", async () => {
      await create();
      const { applied, turnId } = await policyTurn("t7a");
      await done(turnId);
      expect(lastStart().store).toBe(table(cwd, true));
      expect(lastStart()).toMatchObject({ verdict: "trusted", asks: false });
      expect(requests()).toEqual([]);
      expect(applied).toHaveBeenCalledTimes(1);
      expect(spawnArgv()).not.toContain("--trust");
    });
    it("a turn-only grant: the next turn's fresh home holds nothing of it, and no record is written", async () => {
      await create();
      await done((await policyTurn("t7b")).turnId);
      await sendThroughCard("t7b");
      expect(lastStart().store).toBeNull();
      expect(existsSync(storeFile)).toBe(false);
    });
    it("a reject above the folder stops it: nothing seeded for it, no line, the engine asks", async () => {
      await create();
      const parent = dirname(cwd);
      decline(parent, parent);
      const { applied, turnId } = await policyTurn("t7c");
      const card = await opened(turnId);
      await skip("t7c", card.requestId);
      await done(turnId);
      expect(lastStart().store).toBe(table(parent, false));
      expect(applied).not.toHaveBeenCalled();
    });
    it("a repository at the desk stops it on generation 2", async () => {
      await create();
      mkdirSync(join(cwd, ".git"));
      const { applied, turnId } = await policyTurn("t7d");
      const card = await opened(turnId);
      await skip("t7d", card.requestId);
      await done(turnId);
      expect(lastStart().store).toBeNull();
      expect(applied).not.toHaveBeenCalled();
    });
    it("a failed write takes the line with it", async () => {
      await create();
      fixture.failRename = true;
      const { applied, turnId } = await policyTurn("t7e");
      const card = await opened(turnId);
      await skip("t7e", card.requestId);
      await done(turnId);
      expect(applied).not.toHaveBeenCalled();
    });
    it("the owner's own home: no policy grant, the card shows, never --trust", async () => {
      await create();
      const { applied, turnId } = await policyTurn("t7f", { providerRoute: undefined, model: undefined });
      const card = await opened(turnId);
      await skip("t7f", card.requestId);
      await done(turnId);
      expect(applied).not.toHaveBeenCalled();
      expect(existsSync(join(home, ".fuigo", "trusted_folders.toml"))).toBe(false);
      expect(spawnArgv()).not.toContain("--trust");
    });
    it("a decision from a stored record is not a policy grant", async () => {
      await create();
      const applied = vi.fn();
      await sendThroughCard("t7g", { folderTrust: gate({ decision: "trust", fromRecord: true }), onFolderPolicyApplied: applied });
      expect(lastStart().store).toBeNull();
      expect(applied).not.toHaveBeenCalled();
    });
    it("generation 1: --trust as today, the line is due once, and nothing is seeded", async () => {
      const link = join(scratch, "own-fake-cli.ts");
      symlinkSync(FAKE_CLI, link);
      await create({ FAKE_ACP_TRUST_V: "" }, { cli: link });
      const { applied, turnId } = await policyTurn("t7h");
      await done(turnId);
      expect(applied).toHaveBeenCalledTimes(1);
      expect(spawnArgv()).toContain("--trust");
      expect(starts()).toEqual([]);
    });
  });
});
