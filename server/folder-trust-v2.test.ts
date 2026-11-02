// FUIGO-TRUST-V2: Fuigo 1.0.35 folder trust, the store and the driver. The real
// Fuigo support runs against the fake ACP CLI's 1.0.35 protocol
// (FAKE_ACP_TRUST_V=2), so these drive the real reply handler, the real spawn
// and the real pool. Routes are in folder-trust-v2-api.test.ts.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "./config.ts";
import type { FolderTrustTurnInput, ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import { FuigoAgentDriver, fuigoFolderTrustGeneration } from "./drivers/acp/fuigo.ts";
import { FOLDER_LINE_ENGINE_DECIDES, FOLDER_LINE_TRUSTED, FOLDER_LINE_UNTRUSTED, fillFolderLineForEngine } from "./capabilities-primer.ts";
import { FolderTrustStore, folderTrustDeclinesFor, folderTrustRecordRows, folderTrustRejectFor } from "./folder-trust.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import {
  describeFolderTrustDeclines,
  folderTrustChosenName,
  folderTrustDecision,
  folderTrustDeclinedName,
  folderTrustDisplayName,
  folderTrustNotice,
  folderTrustQuestion,
  folderTrustQuestionV2,
  folderTrustWithheld,
  folderTrustWithheldKey,
  folderTrustWithheldName,
} from "../shared/folder-trust.ts";
import { QUESTION_LIMITS } from "../shared/questions.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const TRUST_REPLY = '{"jsonrpc":"2.0","id":9006,"result":{"outcome":"trust","scope":"configAndCommands"}}';
const REJECT_REPLY = '{"jsonrpc":"2.0","id":9006,"result":{"outcome":"reject"}}';

describe("generation", () => {
  it("is 1 only for a parsed version below 1.0.35; unknown and unparseable are 2", () => {
    expect(fuigoFolderTrustGeneration("fuigo 1.0.34")).toBe(1);
    expect(fuigoFolderTrustGeneration("1.0.32")).toBe(1);
    expect(fuigoFolderTrustGeneration("0.9.99")).toBe(1);
    expect(fuigoFolderTrustGeneration("1.0.35")).toBe(2);
    expect(fuigoFolderTrustGeneration("fuigo 1.0.36")).toBe(2);
    expect(fuigoFolderTrustGeneration("1.1.0")).toBe(2);
    expect(fuigoFolderTrustGeneration("")).toBe(2);
    expect(fuigoFolderTrustGeneration(undefined)).toBe(2);
    expect(fuigoFolderTrustGeneration("nightly")).toBe(2);
  });
});

describe("the store", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-trust-v2-store-")));
    file = join(dir, "folder-trust.json");
  });
  afterEach(() => removeTempDir(dir));
  const folder = (name: string) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };

  it("a v2 card records consent 2 under the engine's key verbatim, and it survives a reload", () => {
    const store = new FolderTrustStore(file);
    const cwd = folder("repo/sub");
    const key = folder("repo");
    expect(store.remember(cwd, "trust", "card", { key, consent: 2 })).toBe(key);
    expect(new FolderTrustStore(file).list()).toEqual([expect.objectContaining({ key, folder: cwd, decision: "trust", consent: 2, source: "card" })]);
  });

  it("turnRecords is every reject and every consent-2 trust, and never an unstamped trust", () => {
    const store = new FolderTrustStore(file);
    const [a, b, c, d] = [folder("a"), folder("b"), folder("c"), folder("d")];
    store.remember(a, "trust", "card", { key: a, consent: 2 });
    store.remember(b, "trust", "picker");
    store.remember(c, "reject", "card", { key: c, consent: 2 });
    store.remember(d, "reject", "card");
    expect(store.turnRecords()).toEqual({ trustKeys: [a], rejects: [{ key: c, folder: c }, { key: d, folder: d }] });
  });

  it("choosing a folder again keeps a consent-2 trust: no rewrite, and the seed still names the key", () => {
    const store = new FolderTrustStore(file);
    const repo = folder("repo");
    store.remember(repo, "trust", "card", { key: repo, consent: 2 });
    const before = readFileSync(file, "utf8");
    expect(store.remember(repo, "trust", "picker")).toBe(repo);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(new FolderTrustStore(file).record(repo)).toMatchObject({ decision: "trust", source: "card", consent: 2 });
    expect(new FolderTrustStore(file).turnRecords().trustKeys).toEqual([repo]);
  });

  it("choosing a folder again keeps a stored no, generation 1 or 2: only Forget or a card changes it", () => {
    const store = new FolderTrustStore(file);
    const [one, two] = [folder("one"), folder("two")];
    store.remember(one, "reject", "card");
    store.remember(two, "reject", "card", { key: two, consent: 2 });
    const before = readFileSync(file, "utf8");
    expect(store.remember(one, "trust", "picker")).toBe(one);
    expect(store.remember(two, "trust", "picker")).toBe(two);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(new FolderTrustStore(file).decision(one)).toBe("reject");
    expect(new FolderTrustStore(file).decision(two)).toBe("reject");
  });

  it("a pick still records a new folder and refreshes a plain picker trust, and a card can still change a stored no", () => {
    const store = new FolderTrustStore(file);
    const repo = folder("repo");
    store.remember(repo, "trust", "picker");
    expect(store.record(repo)).toMatchObject({ decision: "trust", source: "picker" });
    store.remember(repo, "trust", "picker");
    expect(store.record(repo)).toMatchObject({ decision: "trust", source: "picker" });
    store.remember(repo, "reject", "card", { key: repo, consent: 2 });
    store.remember(repo, "trust", "card", { key: repo, consent: 2 });
    expect(store.record(repo)).toMatchObject({ decision: "trust", source: "card", consent: 2 });
  });

  it("forgetKey removes exactly the one key, persists, and reports a miss without touching the file", () => {
    const store = new FolderTrustStore(file);
    const [a, b] = [folder("a"), folder("b")];
    store.remember(a, "reject", "card");
    store.remember(b, "reject", "card");
    const before = readFileSync(file, "utf8");
    expect(store.forgetKey(join(dir, "nope"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(store.forgetKey(a)).toBe(true);
    expect(new FolderTrustStore(file).list().map((row) => row.key)).toEqual([b]);
  });

  it("(10) a file this build writes is kept whole by the 1.0.10 reader", () => {
    const store = new FolderTrustStore(file);
    const [a, b] = [folder("a"), folder("b")];
    store.remember(a, "trust", "card", { key: a, consent: 2 });
    store.remember(b, "reject", "card", { key: b, consent: 2 });
    // ed8af4fd5 `isRecord`, copied: an older reader checks only these three
    const isRecord = (value: any) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && (value.decision === "trust" || value.decision === "reject") && typeof value.decidedAt === "number" && typeof value.folder === "string";
    const old = JSON.parse(readFileSync(file, "utf8")) as { version: number; folders: Record<string, unknown> };
    expect(old.version).toBe(1);
    expect(Object.keys(old.folders).filter((key) => isRecord(old.folders[key])).sort()).toEqual([a, b].sort());
    expect(Object.keys(old)).not.toContain("named");
  });

  it("records rows: rejects first, then on the path, then newest; onPath never filters", () => {
    const rows = folderTrustRecordRows([
      { key: "/a/other", folder: "/a/other", decision: "trust", source: "card", decidedAt: 5 },
      { key: "/repo", folder: "/repo/x", decision: "trust", consent: 2, source: "card", decidedAt: 4 },
      { key: "/elsewhere", folder: "/repo/sub", decision: "reject", source: "card", decidedAt: 3 },
      { key: "/old", folder: "/old", decision: "reject", source: "card", decidedAt: 9 },
    ], "/repo/sub/deep");
    expect(rows.map((row) => [row.key, row.onPath])).toEqual([["/elsewhere", true], ["/old", false], ["/repo", true], ["/a/other", false]]);
    expect(rows[2]).toMatchObject({ consent: 2 });
  });
});

describe("(N7.3) rule 2 is pathStartsWith on canonical paths, exactly d4.2", () => {
  // a real root that is neither home nor /
  const root = realpathSync(tmpdir());
  const p = (rel: string) => join(root, "r2", rel);
  it("key equality, folder equality, the cwd itself, and an ancestor of it", () => {
    expect(folderTrustRejectFor([{ key: p("K"), folder: p("other") }], p("K"), p("cwd"))?.key).toBe(p("K"));
    expect(folderTrustRejectFor([{ key: p("stored"), folder: p("K") }], p("K"), p("cwd"))?.key).toBe(p("stored"));
    expect(folderTrustRejectFor([{ key: p("stored"), folder: p("cwd") }], p("K"), p("cwd"))?.key).toBe(p("stored"));
    expect(folderTrustRejectFor([{ key: p("x"), folder: p("up") }], p("K"), p("up/cwd"))?.key).toBe(p("x"));
    // the record's key on the cwd's path, with an unrelated folder
    expect(folderTrustRejectFor([{ key: p("up"), folder: p("gone") }], p("K"), p("up/cwd"))?.key).toBe(p("up"));
  });
  it("a strict ancestor of K is not an answer, even on the cwd's path", () => {
    expect(folderTrustRejectFor([{ key: p("top"), folder: p("top") }], p("top/K"), p("top/K/sub"))).toBeNull();
    // but a reject inside K on the cwd's path is
    expect(folderTrustRejectFor([{ key: p("top/K/sub"), folder: p("top/K/sub") }], p("top/K"), p("top/K/sub/deep"))?.key).toBe(p("top/K/sub"));
  });
  it("a declined linked worktree outside K answers by its folder; an unrelated one does not", () => {
    expect(folderTrustRejectFor([{ key: p("main"), folder: p("wt") }], p("K"), p("wt/sub"))?.key).toBe(p("main"));
    expect(folderTrustRejectFor([{ key: p("main"), folder: p("wt") }], p("K"), p("elsewhere"))).toBeNull();
  });
  it("root never answers", () => {
    expect(folderTrustRejectFor([{ key: "/", folder: "/" }], p("K"), p("cwd"))).toBeNull();
  });
  it("the card's declines leave K out and put those strictly inside K first", () => {
    expect(folderTrustDeclinesFor([{ key: p("z"), folder: p("z") }, { key: p("K"), folder: p("K") }, { key: p("K/in"), folder: p("K/in") }], p("K"))).toEqual([p("K/in"), p("z")]);
  });
});

describe("copy", () => {
  const card = { key: "/repo", cwd: "/repo", sources: [] as string[], repository: false, fullAccess: false, declines: [] as string[] };
  it("the question at each shape (F2, R6, T1)", () => {
    expect(folderTrustQuestionV2(card).question).toBe("Trust /repo? Trusting it lets its own settings guide the bot here. Commands still follow your approval settings.");
    expect(folderTrustQuestionV2({ ...card, sources: ["AGENTS.md"] }).question).toContain("lets AGENTS.md guide the bot here");
    expect(folderTrustQuestionV2({ ...card, cwd: "/repo/sub" }).question).toContain(" The bot is working in /repo/sub, which is part of /repo.");
    expect(folderTrustQuestionV2({ ...card, repository: true }).question).toContain(" This includes its worktrees, wherever they are.");
    expect(folderTrustQuestionV2({ ...card, declines: ["/d"] }).question).toContain(' Your earlier "Don\'t trust" for /d may not carry over here: trusting /repo can include it.');
  });
  it("the Don't trust line, mode by mode, ends with the way back; Trust names the key", () => {
    const options = (fullAccess: boolean) => folderTrustQuestionV2({ ...card, fullAccess }).options;
    expect(options(false)[0]).toEqual({ label: "Trust this folder", description: "Trust /repo and remember it" });
    expect(options(false)[1]).toEqual({ label: "Don't trust", description: "The bot keeps working here, leaves the folder's own settings out and checks commands with you as your approval settings say. To be asked again, forget /repo in this conversation's folder settings." });
    expect(options(true)[1]!.description).toBe("The bot keeps working here and leaves the folder's own settings out. Commands keep running as Full access allows. To be asked again, forget /repo in this conversation's folder settings.");
  });
  describe("a card over the limit", () => {
    const key = `/start-of-key/${"k".repeat(2970)}/end-of-key`;
    const cwd = `${key}/sub/end-of-cwd`;
    const decline = `${key}/declined/end-of-decline`;
    const SENTENCES = [
      "? Trusting it lets ", " guide the bot here. Commands still follow your approval settings.",
      "The bot is working in ", ", which is part of ", "This includes its worktrees, wherever they are.",
      'Your earlier "Don\'t trust" for ', " may not carry over here: trusting ", " can include it.",
    ];
    it("a 3000-character key with one decline keeps the warning and every sentence, within the limit", () => {
      expect(key.length).toBeGreaterThan(2_990);
      const { question } = folderTrustQuestionV2({ key, cwd, sources: ["AGENTS.md"], repository: true, fullAccess: false, declines: [decline] });
      expect(question.length).toBeLessThanOrEqual(QUESTION_LIMITS.questionChars);
      expect(question.length).toBeGreaterThan(QUESTION_LIMITS.questionChars - 10);
      expect(question.startsWith("Trust /start-of-key/k")).toBe(true);
      for (const sentence of SENTENCES) expect(question, sentence).toContain(sentence);
      expect(question).toContain("lets AGENTS.md guide");
      for (const end of ["/end-of-key?", "/end-of-cwd,", "/end-of-decline may not", "/end-of-key can include it."]) expect(question, end).toContain(end);
      expect(question).toContain("...");
    });
    it("every sentence stays in the worst shape: long key, folder, sources and five declines", () => {
      const declines = [1, 2, 3, 4, 5].map((n) => `${decline}-${n}`);
      const sources = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${"s".repeat(800)}-${n}`);
      const { question } = folderTrustQuestionV2({ key, cwd, sources, repository: true, fullAccess: true, declines });
      expect(question.length).toBeLessThanOrEqual(QUESTION_LIMITS.questionChars);
      for (const sentence of SENTENCES) expect(question, sentence).toContain(sentence);
      expect(question).toContain("and 2 more folders");
    });
    it("a question at the limit is byte-identical to the plain text, and one character more is shortened", () => {
      const text = (k: string) => `Trust ${k}? Trusting it lets AGENTS.md guide the bot here. Commands still follow your approval settings. Your earlier "Don't trust" for /d may not carry over here: trusting ${k} can include it.`;
      const room = (QUESTION_LIMITS.questionChars - text("").length) / 2;
      const atLimit = "/" + "k".repeat(Math.floor(room) - 1);
      const shape = (k: string) => ({ ...card, key: k, cwd: k, sources: ["AGENTS.md"], declines: ["/d"] });
      expect(folderTrustQuestionV2(shape(atLimit)).question).toBe(text(atLimit));
      const over = `${atLimit}kk`;
      expect(text(over).length).toBeGreaterThan(QUESTION_LIMITS.questionChars);
      const shortened = folderTrustQuestionV2(shape(over)).question;
      expect(shortened).not.toBe(text(over));
      expect(shortened).toContain("can include it.");
    });
    it("the options say the whole sentence around a shortened key, and the answer is still the label", () => {
      const spec = folderTrustQuestionV2({ ...card, key, cwd: key });
      const [trust, reject] = spec.options;
      for (const option of spec.options) expect(option.description!.length).toBeLessThanOrEqual(QUESTION_LIMITS.descriptionChars);
      expect(trust!.description).toMatch(/^Trust \/start-of-key\/k+\.\.\.k+\/end-of-key and remember it$/);
      expect(reject!.description).toMatch(/approval settings say\. To be asked again, forget \/start-of-key\/k+\.\.\.k+\/end-of-key in this conversation's folder settings\.$/);
      expect(spec.options.map((option) => option.label)).toEqual(["Trust this folder", "Don't trust"]);
      expect(folderTrustDecision([{ id: spec.id, selected: [trust!.label] }])).toBe("trust");
      expect(folderTrustDecision([{ id: spec.id, selected: [trust!.description!] }])).toBeNull();
    });
    it("generation 1 keeps its own text and its plain cut", () => {
      const folder = `/${"f".repeat(3000)}`;
      const spec = folderTrustQuestion({ key: folder, folder, sources: [] });
      expect(spec.question).toBe(`Trust the files in ${folder}? Instructions, tools and skills from this folder would apply to every turn that runs here.`.slice(0, QUESTION_LIMITS.questionChars));
    });
  });
  it("past three declines the card counts the rest", () => {
    expect(describeFolderTrustDeclines(["/a", "/b", "/c"])).toBe("/a, /b, /c");
    expect(describeFolderTrustDeclines(["/a", "/b", "/c", "/d"])).toBe("/a, /b, /c and 1 more folder");
    expect(describeFolderTrustDeclines(["/a", "/b", "/c", "/d", "/e"])).toBe("/a, /b, /c and 2 more folders");
  });
  it("no sentence claims commands stop asking, and none uses an em dash", () => {
    const all = [folderTrustQuestionV2({ ...card, declines: ["/d"], repository: true, cwd: "/repo/x" }), folderTrustQuestionV2({ ...card, fullAccess: true })];
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/—|without stopping to ask|\bsafe\b/);
  });
  it("chips: a recorded no carries its key, the sources read as before, a skip stays the plain chip", () => {
    const name = folderTrustDeclinedName(["AGENTS.md"], "/repo");
    expect(folderTrustWithheld(name)).toBe("AGENTS.md");
    expect(folderTrustWithheldKey(name)).toBe("/repo");
    expect(folderTrustNotice(name)).toEqual({ kind: "withheld", sources: "AGENTS.md", key: "/repo" });
    expect(folderTrustDisplayName(name)).toBe("Folder not trusted: AGENTS.md left out. To be asked again, forget /repo in this conversation's folder settings.");
    expect(folderTrustWithheldKey(folderTrustWithheldName(["AGENTS.md"]))).toBeUndefined();
    expect(folderTrustDisplayName(folderTrustWithheldName(["AGENTS.md"]))).toBe("Folder not trusted: AGENTS.md left out");
    expect(folderTrustNotice(folderTrustDeclinedName([], "/repo"))?.sources).toBe("the folder's own settings");
  });
  it("the chosen chip names the owner's choice", () => {
    expect(folderTrustNotice(folderTrustChosenName(["AGENTS.md"]))).toEqual({ kind: "chosen", sources: "AGENTS.md" });
    expect(folderTrustDisplayName(folderTrustChosenName(["AGENTS.md"]))).toBe("You chose to trust this folder: Fuigo brings in AGENTS.md as it applies that. Instructions apply in a new conversation in this folder");
  });
  it("(R8) the primer's folder line, on generation 2, claims neither way; generation 1's is untouched", () => {
    const stack = (line: string) => `before\n${line}\nafter`;
    expect(fillFolderLineForEngine(stack(FOLDER_LINE_TRUSTED))).toBe(stack(FOLDER_LINE_ENGINE_DECIDES));
    expect(fillFolderLineForEngine(stack(FOLDER_LINE_UNTRUSTED))).toBe(stack(FOLDER_LINE_ENGINE_DECIDES));
    expect(fillFolderLineForEngine("no line here")).toBe("no line here");
    expect(FOLDER_LINE_ENGINE_DECIDES).not.toMatch(/working folder is trusted,/);
  });
});

describe("(6) type level: a turn carries stored records only", () => {
  it("has no association field, no seed flag and no list view", () => {
    expectTypeOf<FolderTrustTurnInput>().not.toHaveProperty("named");
    expectTypeOf<FolderTrustTurnInput>().not.toHaveProperty("seed");
    expectTypeOf<FolderTrustTurnInput>().not.toHaveProperty("records");
    expectTypeOf<FolderTrustTurnInput>().not.toHaveProperty("onPath");
    expectTypeOf<NonNullable<FolderTrustTurnInput["rejects"]>[number]>().toEqualTypeOf<{ key: string; folder: string }>();
    expectTypeOf<NonNullable<SendTurnInput["folderTrust"]>>().toEqualTypeOf<FolderTrustTurnInput>();
  });
});

// The opt-in pool is off on Windows.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("the reply handler, on the real Fuigo driver", () => {
  let scratch: string;
  let home: string;
  let cwd: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let dump: string;
  let trustLog: string;
  let spawnLog: string;
  let infoLines: string[];
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-trust-v2-core-")));
    home = join(scratch, "home");
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    cwd = join(scratch, "work");
    mkdirSync(cwd, { recursive: true });
    dump = join(scratch, "dump.json");
    trustLog = join(scratch, "trust.log");
    spawnLog = join(scratch, "spawns.log");
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    infoSpy.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    delete process.env.MURAGE_ACP_POOL;
    delete process.env.MURAGE_ACP_CROSS_THREAD_SPARE;
    await removeTempDir(scratch);
  });

  /** The version cache is per file, so a test of the probe runs its own path to the fake. */
  const ownCli = () => {
    const link = join(scratch, "own-fake-cli.ts");
    symlinkSync(FAKE_CLI, link);
    return link;
  };
  const create = async (environment: Record<string, string> = {}, config: { fullAuto?: boolean; cli?: string } = {}) => {
    recorder?.stop();
    await instance?.dispose();
    instance = await FuigoAgentDriver.create({
      instanceId: `fuigo-trust-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "Fuigo",
      environment: {
        HOME: home,
        FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_MCP_READY: "1",
        FAKE_ACP_DUMP: dump, FAKE_ACP_TRUST_LOG: trustLog, FAKE_ACP_SPAWN_LOG: spawnLog,
        ...environment,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, ...config },
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };
  const readDump = () => JSON.parse(readFileSync(dump, "utf8"));
  const log = () => (existsSync(trustLog) ? readFileSync(trustLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) as Array<{ pid: number; event: string; raw?: string; params?: any }>;
  const requests = () => log().filter((entry) => entry.event === "request");
  const replies = () => log().filter((entry) => entry.event === "reply").map((entry) => entry.raw);
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean) : []);
  const closed = (reason: string) => infoLines.some((line) => line.includes(`reason=${reason}`));
  const gate = (over: Partial<FolderTrustTurnInput> = {}): FolderTrustTurnInput => ({ key: cwd, folder: cwd, sources: [], trustKeys: [], rejects: [], ...over });
  const chips = () => recorder.events.filter((e) => e.type === "item.started").map((e) => (e as any).title as string).filter((title) => /^(untrusted folder|trusted folder|trust chosen):/.test(title));
  const done = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  const opened = (turnId: string) => recorder.until((e) => e.type === "request.opened" && e.turnId === turnId) as Promise<Extract<RuntimeEvent, { type: "request.opened" }> & { requestId: string }>;
  const send = async (threadId: string, input: Partial<SendTurnInput> = {}) =>
    (await instance!.adapter.sendTurn({ threadId, text: "go", cwd, folderTrust: gate(), ...input })).turnId;
  const answer = (threadId: string, requestId: string, label: string) =>
    instance!.adapter.respondToRequest(threadId, requestId, { behavior: "answer", answers: [{ id: "folderTrust", selected: [label] }] });
  const skip = (threadId: string, requestId: string) => instance!.adapter.respondToRequest(threadId, requestId, { behavior: "deny" });
  /** A pooled turn on a thread, its session resumed the way the harness does. */
  const nativeOrder = (threadId: string) => readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");

  it("(R1, R9) generation 2 never passes --trust, raises no card before the spawn, and advertises v2", async () => {
    await create();
    const turnId = await send("t-g2", { folderTrust: gate({ decision: "trust", fromRecord: true, sources: ["AGENTS.md"], trustKeys: [cwd] }) });
    await done(turnId);
    const wire = readDump();
    expect(wire.argv).not.toContain("--trust");
    expect(wire.initialize.clientCapabilities._meta["fuigo/folderTrust"]).toEqual({ interactive: true, v2: true });
    expect(replies()).toEqual([TRUST_REPLY]);
  });

  it("generation 1 is unchanged: --trust on the spawn, the card before it, no v2 in the advert", async () => {
    await create({ FAKE_ACP_TRUST_V: "", FAKE_ACP_VERSION: "fuigo 1.0.34" }, { cli: ownCli() });
    const turnId = await send("t-g1", { folderTrust: gate({ decision: "trust", fromRecord: true, sources: ["AGENTS.md"] }) });
    await done(turnId);
    const wire = readDump();
    expect(wire.argv).toContain("--trust");
    expect(wire.initialize.clientCapabilities._meta["fuigo/folderTrust"]).toEqual({ interactive: true });
  });

  // Fuigo 1.0.38 runs a trusted folder's .envrc at session start, before any tool call; FUIGO_ENVRC_TIMEOUT_SECS=0
  // keeps it from being evaluated (fuigo.ts FUIGO_ENVRC_OFF). Every way a folder reaches the engine trusted carries it.
  describe("FUIGO_ENVRC_TIMEOUT_SECS=0 on every trusted-folder spawn, over the instance's non-zero value", () => {
    const envrcIn = (folder: string) => writeFileSync(join(folder, ".envrc"), "touch envrc-ran\n");
    it("generation 1, a remembered or picker trust: --trust on the spawn, .envrc not evaluated", async () => {
      envrcIn(cwd);
      await create({ FAKE_ACP_TRUST_V: "", FAKE_ACP_VERSION: "fuigo 1.0.34", FUIGO_ENVRC_TIMEOUT_SECS: "5" }, { cli: ownCli() });
      await done(await send("t-envrc-g1", { folderTrust: gate({ decision: "trust", fromRecord: true, sources: [".envrc"] }) }));
      const wire = readDump();
      expect(wire.argv).toContain("--trust");
      expect(wire.env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
    });
    it("generation 2, a consent-2 record: the engine's question answered trust, .envrc not evaluated", async () => {
      envrcIn(cwd);
      await create({ FUIGO_ENVRC_TIMEOUT_SECS: "5" });
      await done(await send("t-envrc-g2", { folderTrust: gate({ trustKeys: [cwd], sources: [".envrc"] }) }));
      expect(replies()).toEqual([TRUST_REPLY]);
      expect(readDump().env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
    });
    it("generation 2, the owner answers the card Trust: .envrc not evaluated", async () => {
      envrcIn(cwd);
      await create({ FUIGO_ENVRC_TIMEOUT_SECS: "5" });
      const turnId = await send("t-envrc-card", { folderTrust: gate({ sources: [".envrc"] }) });
      const card = await opened(turnId);
      await answer("t-envrc-card", card.requestId, "Trust this folder");
      await done(turnId);
      expect(replies()).toEqual([TRUST_REPLY]);
      expect(readDump().env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
    });
    it("Full access with a one-turn setup trust: .envrc not evaluated", async () => {
      envrcIn(cwd);
      await create({ FUIGO_ENVRC_TIMEOUT_SECS: "5" }, { fullAuto: true });
      await done(await send("t-envrc-full", { folderTrust: gate({ decision: "trust", sources: [".envrc"], trustKeys: [cwd] }) }));
      expect(readDump().env.FUIGO_ENVRC_TIMEOUT_SECS).toBe("0");
    });
  });

  it("an unknown version is generation 2", async () => {
    await create({ FAKE_ACP_VERSION_FAIL: "1" }, { cli: ownCli() });
    await done(await send("t-unknown", { folderTrust: gate({ decision: "trust", fromRecord: true, sources: ["AGENTS.md"], trustKeys: [cwd] }) }));
    expect(readDump().argv).not.toContain("--trust");
    expect(readDump().initialize.clientCapabilities._meta["fuigo/folderTrust"].v2).toBe(true);
  });

  it("(R8) the turn's system text carries the engine-decides line on generation 2", async () => {
    await create();
    await done(await send("t-primer", { system: `persona\n${FOLDER_LINE_TRUSTED}\nrest`, folderTrust: gate({ trustKeys: [cwd] }) }));
    const prompt = JSON.stringify(readDump());
    expect(prompt).not.toContain(FOLDER_LINE_TRUSTED);
  });

  it("(10) reply bytes: exact JSON for trust and reject", async () => {
    await create();
    await done(await send("t-bytes-1", { folderTrust: gate({ trustKeys: [cwd] }) }));
    expect(replies()).toEqual([TRUST_REPLY]);
    // the fake kept that grant, so the reject is asked about another key
    const other = join(scratch, "other");
    await create({ FAKE_ACP_TRUST_WORKSPACE: other });
    await done(await send("t-bytes-2", { folderTrust: gate({ rejects: [{ key: other, folder: other }] }) }));
    expect(replies()).toEqual([TRUST_REPLY, REJECT_REPLY]);
  });

  it("(10) a request without scope keeps today's {outcome} reply, on a generation 2 turn too", async () => {
    await create({ FAKE_ACP_TRUST_SCOPE: "none" });
    await done(await send("t-v1", { folderTrust: gate({ decision: "trust", fromRecord: true }) }));
    expect(replies()).toEqual(['{"jsonrpc":"2.0","id":9006,"result":{"outcome":"trust"}}']);
  });

  it("(rule 1) a scope this client does not know, or a home or root key: reject, and the process is marked", async () => {
    await create({ FAKE_ACP_TRUST_SCOPE: "configOnly" });
    await done(await send("t-r1a"));
    expect(replies()).toEqual([REJECT_REPLY]);
    expect(closed("folder-trust-undecided")).toBe(true);
    await create({ FAKE_ACP_TRUST_WORKSPACE: "/" });
    await done(await send("t-r1b"));
    expect(replies().at(-1)).toBe(REJECT_REPLY);
    expect(chips()).toEqual([]);
  });

  it("(8) the real rule 2 handler across all four arms, each record with a distinct key and folder", async () => {
    const stored = join(scratch, "stored-key");
    const upper = join(scratch, "up");
    const nested = join(upper, "down");
    mkdirSync(nested, { recursive: true });
    const K = join(scratch, "K");
    const arms: Array<[string, { key: string; folder: string }, string]> = [
      ["key equality", { key: K, folder: join(scratch, "elsewhere") }, cwd],
      ["folder equality", { key: stored, folder: K }, cwd],
      ["realpath(cwd) equality", { key: stored, folder: nested }, nested],
      ["ancestor of the cwd", { key: stored, folder: upper }, nested],
    ];
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    for (const [index, [, record, armCwd]] of arms.entries()) {
      const threadId = `t-arm-${index}`;
      const turnId = await send(threadId, { cwd: armCwd, folderTrust: { ...gate({ rejects: [record], sources: ["AGENTS.md"] }), key: armCwd, folder: armCwd } });
      await done(turnId);
      expect(replies().at(-1)).toBe(REJECT_REPLY);
      expect(recorder.events.find((e) => e.type === "request.opened" && e.turnId === turnId)).toBeUndefined();
      const chip = chips().at(-1)!;
      expect(folderTrustWithheldKey(chip)).toBe(record.key);
      expect(chip).not.toContain(` forget ${record.folder}`);
    }
  });

  it("(T2) a rule 2 chip shows once per key per thread, and a different key on the thread shows its own", async () => {
    const K = join(scratch, "K");
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    const S = join(scratch, "S");
    await done(await send("t-once", { folderTrust: gate({ rejects: [{ key: K, folder: K }] }) }));
    await done(await send("t-once", { folderTrust: gate({ rejects: [{ key: K, folder: K }] }) }));
    expect(chips()).toHaveLength(1);
    // (4) Forget K leaves S on the cwd's path: S answers, and the chip names S
    await done(await send("t-once", { folderTrust: gate({ rejects: [{ key: S, folder: cwd }] }) }));
    expect(chips().map((chip) => folderTrustWithheldKey(chip))).toEqual([K, S]);
  });

  it("(rule 3) a consent-2 trust for exactly K answers trust with the chosen chip; another spelling never does", async () => {
    const K = join(scratch, "K");
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    await done(await send("t-r3", { folderTrust: gate({ trustKeys: [K], sources: ["AGENTS.md"] }) }));
    expect(replies()).toEqual([TRUST_REPLY]);
    expect(chips()).toEqual([folderTrustChosenName(["AGENTS.md"])]);
    const spelled = join(scratch, "K2");
    await create({ FAKE_ACP_TRUST_WORKSPACE: spelled });
    const turnId = await send("t-r3b", { folderTrust: gate({ trustKeys: [`${spelled}/`] }) });
    const card = await opened(turnId);
    await answer("t-r3b", card.requestId, "Don't trust");
    await done(turnId);
  });

  it("(rule 3, d4.2) any reject and no written decline: the card shows, names it, and never auto-replies trust", async () => {
    const K = join(scratch, "K");
    const unrelated = join(scratch, "unrelated");
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    const turnId = await send("t-r3c", { folderTrust: gate({ trustKeys: [K], rejects: [{ key: unrelated, folder: unrelated }] }) });
    const card = await opened(turnId);
    expect(card.folderTrust).toMatchObject({ key: K, v2: true, declines: [unrelated] });
    expect(card.questions![0]!.question).toContain(`Your earlier "Don't trust" for ${unrelated} may not carry over here: trusting ${K} can include it.`);
    expect(replies()).toEqual([]);
    await answer("t-r3c", card.requestId, "Trust this folder");
    await done(turnId);
    expect(replies()).toEqual([TRUST_REPLY]);
  });

  it("(rule 3 at Full access) a stored trust held back by a reject goes to the card, past rule 4", async () => {
    const K = join(scratch, "K");
    await create({ FAKE_ACP_TRUST_WORKSPACE: K, FAKE_ACP_TRUST_KINDS: "" });
    const turnId = await send("t-r3d", { stopLine: true, folderTrust: gate({ trustKeys: [K], rejects: [{ key: join(scratch, "other"), folder: join(scratch, "other") }] }) });
    const card = await opened(turnId);
    await skip("t-r3d", card.requestId);
    await done(turnId);
  });

  it("(T1) at Ask and Auto a plain folder gets the card, never a silent reject", async () => {
    await create({ FAKE_ACP_TRUST_KINDS: "" });
    for (const [threadId, level] of [["t-ask", { routeAsks: true, askLevel: true }], ["t-auto", { routeAsks: true }]] as const) {
      const turnId = await send(threadId, level);
      const card = await opened(turnId);
      expect(card.tool).toBe("folder_trust");
      expect(card.questions![0]!.question).toContain("its own settings");
      await skip(threadId, card.requestId);
      await done(turnId);
    }
  });

  it("(rule 4) Full access and No limits with nothing to bring in: reject, nothing recorded, no chip", async () => {
    await create({ FAKE_ACP_TRUST_KINDS: "" });
    const turnId = await send("t-r4", { stopLine: true });
    await done(turnId);
    expect(replies()).toEqual([REJECT_REPLY]);
    expect(chips()).toEqual([]);
    expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
    await create({ FAKE_ACP_TRUST_KINDS: "" }, { fullAuto: true });
    await done(await send("t-r4b"));
    expect(replies()).toEqual([REJECT_REPLY, REJECT_REPLY]);
  });

  it("(rule 4) with something to bring in, Full access still asks", async () => {
    await create();
    const turnId = await send("t-r4c", { stopLine: true });
    const card = await opened(turnId);
    expect(card.questions![0]!.options[1]!.description).toContain("Commands keep running as Full access allows.");
    await skip("t-r4c", card.requestId);
    await done(turnId);
  });

  it("(rule 5) Trust and Don't trust reply exactly, and the chips follow", async () => {
    await create();
    const trustTurn = await send("t-r5a", { folderTrust: gate({ sources: ["AGENTS.md"] }) });
    const card = await opened(trustTurn);
    expect(card.folderTrust).toEqual({ key: cwd, folder: cwd, sources: ["AGENTS.md"], v2: true });
    await answer("t-r5a", card.requestId, "Trust this folder");
    await done(trustTurn);
    expect(replies()).toEqual([TRUST_REPLY]);
    expect(chips()).toEqual([folderTrustChosenName(["AGENTS.md"])]);
    // the engine persisted the grant for exactly the key it named
    expect(readFileSync(join(home, ".fuigo", "trusted_folders.toml"), "utf8")).toContain(`[folders.${JSON.stringify(cwd)}]\ntrusted = true\nconsent = 2`);

    await create({ HOME: join(scratch, "home2"), FUIGO_HOME: join(scratch, "fuigo2") });
    mkdirSync(join(scratch, "fuigo2"), { recursive: true });
    writeFileSync(join(scratch, "fuigo2", "auth.json"), "{}");
    const rejectTurn = await send("t-r5b", { folderTrust: gate({ sources: ["AGENTS.md"] }) });
    const second = await opened(rejectTurn);
    await answer("t-r5b", second.requestId, "Don't trust");
    await done(rejectTurn);
    expect(replies().at(-1)).toBe(REJECT_REPLY);
    expect(chips().at(-1)).toBe(folderTrustDeclinedName(["AGENTS.md"], cwd));
  });

  it("a card names K and the folder the bot works in, when they differ", async () => {
    const K = join(scratch, "K");
    mkdirSync(join(K, ".git"), { recursive: true });
    await create({ FAKE_ACP_TRUST_WORKSPACE: K });
    const turnId = await send("t-names");
    const card = await opened(turnId);
    expect(card.questions![0]!.question).toContain(`The bot is working in ${cwd}, which is part of ${K}.`);
    expect(card.questions![0]!.question).toContain("This includes its worktrees, wherever they are.");
    await skip("t-names", card.requestId);
    await done(turnId);
  });

  it("(12) allowOnceOnly: no allow_always is ever picked for a Fuigo instance", async () => {
    // Fuigo's own option order offers the session-wide allow first
    await create({ FAKE_ACP_MODE: "permission-session-first" }, { fullAuto: true });
    await done(await send("t-once-only", { folderTrust: gate() }));
    expect(readDump().decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  describe("(T3, U1) a process that learned something is never kept", () => {
    beforeEach(() => { process.env.MURAGE_ACP_POOL = "1"; });

    const cursor = "fake-acp-session";

    it("(12a) a card answered Don't trust marks before the reply, is not parked, and the next turn asks", async () => {
      await create();
      const threadId = "t-pool-card";
      const turnId = await send(threadId);
      const card = await opened(turnId);
      await answer(threadId, card.requestId, "Don't trust");
      await done(turnId);
      expect(closed("folder-trust-card")).toBe(true);
      const native = nativeOrder(threadId);
      expect(native.indexOf('"reason":"folder-trust-card"')).toBeGreaterThan(-1);
      expect(native.indexOf('"reason":"folder-trust-card"')).toBeLessThan(native.indexOf('"outcome":"reject"'));
      // Forget restored the digest to D0: the process is gone, so a request arrives
      const next = await send(threadId, { resumeCursor: cursor });
      const again = await opened(next);
      expect(spawns()).toHaveLength(2);
      await skip(threadId, again.requestId);
      await done(next);
    });

    it("(12c) a card answered Trust is marked and closed too: the next process reads the engine's own grant", async () => {
      await create();
      const threadId = "t-pool-trust";
      const turnId = await send(threadId);
      await answer(threadId, (await opened(turnId)).requestId, "Trust this folder");
      await done(turnId);
      expect(closed("folder-trust-card")).toBe(true);
      await done(await send(threadId, { resumeCursor: cursor, folderTrust: gate({ trustKeys: [cwd] }) }));
      expect(spawns()).toHaveLength(2);
      expect(requests()).toHaveLength(1);
    });

    it("(12d) control: a rule 2 reply parks, and the same digest adopts that process with no request (its dedup)", async () => {
      await create();
      const threadId = "t-pool-rule2";
      const rejects = [{ key: cwd, folder: cwd }];
      await done(await send(threadId, { folderTrust: gate({ rejects }) }));
      expect(closed("folder-trust")).toBe(false);
      await done(await send(threadId, { resumeCursor: cursor, folderTrust: gate({ rejects }) }));
      expect(spawns()).toHaveLength(1);
      expect(requests()).toHaveLength(1);
      // a Forget changes a digest input: that process is not adopted, and the engine asks
      const forgotten = await send(threadId, { resumeCursor: cursor, folderTrust: gate() });
      const card = await opened(forgotten);
      expect(spawns()).toHaveLength(2);
      await skip(threadId, card.requestId);
      await done(forgotten);
    });

    it("(rule 3 reuse) a rule 3 reply parks and is adopted", async () => {
      await create();
      const threadId = "t-pool-rule3";
      const inputs = gate({ trustKeys: [cwd] });
      await done(await send(threadId, { folderTrust: inputs }));
      await done(await send(threadId, { resumeCursor: cursor, folderTrust: inputs }));
      expect(spawns()).toHaveLength(1);
    });

    it("(12e) rule 4 at Full access marks undecided, is not parked, and the next turn asks again", async () => {
      await create({ FAKE_ACP_TRUST_KINDS: "" });
      const threadId = "t-pool-rule4";
      await done(await send(threadId, { stopLine: true }));
      expect(closed("folder-trust-undecided")).toBe(true);
      await done(await send(threadId, { stopLine: true, resumeCursor: cursor }));
      expect(spawns()).toHaveLength(2);
      expect(requests()).toHaveLength(2);
    });

    it("(12f) a skipped card: mark before the reject reply, settle does not park, turn 2 spawns and the request arrives", async () => {
      await create();
      const threadId = "t-pool-skip";
      const turnId = await send(threadId);
      await skip(threadId, (await opened(turnId)).requestId);
      await done(turnId);
      expect(closed("folder-trust-undecided")).toBe(true);
      const native = nativeOrder(threadId);
      expect(native.indexOf('"reason":"folder-trust-undecided"')).toBeLessThan(native.indexOf('"outcome":"reject"'));
      const next = await send(threadId, { resumeCursor: cursor });
      const card = await opened(next);
      expect(spawns()).toHaveLength(2);
      expect(requests()).toHaveLength(2);
      await skip(threadId, card.requestId);
      await done(next);
    });

    it("(N7.11) a card the turn outran is unanswered: marked, not parked", async () => {
      await create({ FAKE_ACP_TRUST_PROMPT_FIRST: "1" });
      const threadId = "t-pool-late";
      const turnId = await send(threadId, { folderTrust: gate({ sources: ["AGENTS.md"] }) });
      await done(turnId);
      expect(closed("folder-trust-undecided")).toBe(true);
      expect(chips()).toEqual([folderTrustWithheldName(["AGENTS.md"])]);
      await done(await instance!.adapter.sendTurn({ threadId, text: "again", cwd, resumeCursor: cursor, folderTrust: gate({ decision: "reject", fromRecord: true, rejects: [{ key: cwd, folder: cwd }] }) }).then((r) => r.turnId));
      expect(spawns()).toHaveLength(2);
    });

    it("(policy origin) on the pre-set path only a stored record stays reusable", async () => {
      // a v1 request, answered from `decision`
      await create({ FAKE_ACP_TRUST_SCOPE: "none" });
      await done(await send("t-origin-record", { folderTrust: gate({ decision: "reject", fromRecord: true }) }));
      expect(closed("folder-trust")).toBe(false);
      expect(spawns()).toHaveLength(1);
      // the same answer with no provenance: a managed desk or Full access auto-trust
      await done(await send("t-origin-policy", { folderTrust: gate({ decision: "trust" }) }));
      expect(closed("folder-trust-undecided")).toBe(true);
      expect(replies().at(-1)).toBe('{"jsonrpc":"2.0","id":9006,"result":{"outcome":"trust"}}');
    });

    it("(spare) a marked process is never handed to another thread; an unmarked donor is", async () => {
      process.env.MURAGE_ACP_CROSS_THREAD_SPARE = "1";
      await create();
      const inputs = gate({ trustKeys: [cwd] });
      const donorTurn = await send("t-spare-marked");
      await answer("t-spare-marked", (await opened(donorTurn)).requestId, "Don't trust");
      await done(donorTurn);
      expect(spawns()).toHaveLength(1);
      // nothing parked: the other thread's turn spawns
      const taker = await send("t-spare-taker", { resumeCursor: cursor, folderTrust: inputs });
      await done(taker);
      expect(spawns()).toHaveLength(2);
      // control: that turn's rule 3 reply left it unmarked and parked, so a third thread adopts it
      await done(await send("t-spare-third", { resumeCursor: cursor, folderTrust: inputs }));
      expect(spawns()).toHaveLength(2);
    });
  });

  const warmNeverGrants = async (folderTrust = gate()) => {
    await instance!.adapter.sendTurn({ threadId: "t-warm", text: "", cwd, folderTrust, prewarm: true } as SendTurnInput).catch(() => undefined);
    await vi.waitFor(() => expect(requests()).toHaveLength(1), { timeout: 10_000 });
    // Answered inside the warm, or refused once it has parked. The refused process
    // closes at once, so the fake may die before it logs the refusal: the close is the proof.
    await vi.waitFor(() => expect(closed("folder-trust-undecided") || closed("post-turn-activity")).toBe(true), { timeout: 10_000 });
    expect(replies().filter((raw) => raw?.includes('"outcome":"trust"'))).toEqual([]);
    expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
  };
  it("a warm on intent never raises a card: the request is answered and the process not kept", async () => {
    process.env.MURAGE_ACP_POOL = "1";
    await create();
    await warmNeverGrants();
  });
  it("rule 3b: a warm in a picked folder rejects, with no chip, because nobody asked for this turn yet", async () => {
    process.env.MURAGE_ACP_POOL = "1";
    await create({ FAKE_ACP_VERSION: "1.0.38" });
    await warmNeverGrants(gate({ sources: ["AGENTS.md"], noCardPickKeys: [cwd] }));
    expect(recorder.events.filter((e) => e.type === "item.started" && folderTrustNotice((e as { title?: string }).title))).toEqual([]);
  });
  it("a warm that parked before the engine asked never raises a card: refused and closed", async () => {
    process.env.MURAGE_ACP_POOL = "1";
    await create({ FAKE_ACP_TRUST_DELAY_MS: "500" });
    await warmNeverGrants();
    expect(closed("post-turn-activity")).toBe(true);
  });
});
