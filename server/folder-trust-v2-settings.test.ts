// What Settings says about folder trust, proved on the outcome and not the
// sentence: a Forget does what its row says (test 18, 13(e)), the engine's own
// file is read as written (test 19), and a file this build writes survives a
// downgrade (test 10). Own server: rule 3 needs a store with no reject in it,
// so these cannot share one with folder-trust-v2-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FolderTrustStore, readUpstreamTrustFile, readUpstreamTrustedFolders } from "./folder-trust.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let trustLog: string;

const K = (name: string) => join(home, `key-${name}`);
const homeOf = (name: string) => join(home, `home-${name}`);
const trustFile = (name: string) => join(homeOf(name), "trusted_folders.toml");

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const openCard = async (threadId: string) => (await messages(threadId)).filter((m) => m.card?.folderTrust && !m.card.answered).at(-1);
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const trustEvents = () => lines(trustLog).map((line) => JSON.parse(line)) as Array<{ event: string; pid: number; raw?: string; params?: any }>;
const requestsFor = (key: string) => trustEvents().filter((entry) => entry.event === "request" && entry.params.workspace === key).length;
const lastReply = () => trustEvents().filter((entry) => entry.event === "reply").at(-1)?.raw ?? "";
const stored = () => JSON.parse(readFileSync(join(home, ".murage", "folder-trust.json"), "utf8")).folders as Record<string, any>;

async function bootServer(port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, ".fuigo"), { recursive: true });
  writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
  const engine = (name: string, workspace?: string) => {
    mkdirSync(homeOf(name), { recursive: true });
    writeFileSync(join(homeOf(name), "auth.json"), "{}");
    return {
      driver: "fuigoAgent",
      environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_MCP_READY: "1", FAKE_ACP_TRUST_LOG: trustLog, FUIGO_HOME: homeOf(name), ...(workspace ? { FAKE_ACP_TRUST_WORKSPACE: workspace } : {}) },
      config: { cli: FAKE_ACP, fullAuto: false },
    };
  };
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
    defaultModel: { instanceId: "own", model: "fake-acp-model" },
    instances: {
      // test 18: one key, the home that said yes and two homes that never did
      own: engine("own", K("forgotten")),
      "fresh-control": engine("fresh-control", K("forgotten")),
      "fresh-after": engine("fresh-after", K("forgotten")),
      // 13(e): a trust, a reject, and a home that has decided neither
      "trust-p": engine("trust-p", K("parent")),
      "reject-d": engine("reject-d", K("declined")),
      "ask-p": engine("ask-p", K("parent")),
      "reject-only": engine("reject-only", K("only")),
      // test 19
      "store-no": engine("store-no"),
      "store-broken": engine("store-broken"),
      "store-dir": engine("store-dir"),
      "store-empty": engine("store-empty"),
      "store-none": engine("store-none"),
    },
  }));
  writeFileSync(trustFile("store-no"), [
    '[folders."/stored/plain"]', "trusted = false", "",
    '[folders."/stored/slash/"]', "trusted = false", "",
    '[folders."relative/key"]', "trusted = false", "",
    '[folders."/stored/yes"]', "trusted = true", "consent = 2", "",
  ].join("\n"));
  writeFileSync(trustFile("store-broken"), "this is not toml at all [[[\n");
  mkdirSync(trustFile("store-dir"));
  writeFileSync(trustFile("store-empty"), "  \n");
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stderr!.on("data", (c) => (output += c));
  proc.stdout!.on("data", (c) => (output += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

async function makeBot(name: string, instanceId: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-acp-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
type Bot = { id: string; threadId: string };
const workspaceOf = (bot: Bot) => join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
async function send(bot: Bot, text = "go") {
  const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  expect(sent, sent.text).toMatchObject({ status: 202 });
}
async function settled(bot: Bot) {
  await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(false);
}
async function turn(bot: Bot, text = "go") {
  await send(bot, text);
  await settled(bot);
}
async function card(bot: Bot) {
  await expect.poll(async () => Boolean(await openCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
  return (await openCard(bot.threadId))!.card;
}
const answer = (bot: Bot, requestId: string, label: string) =>
  request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "answer", answers: [{ id: "folderTrust", selected: [label] }] });
const skip = (bot: Bot, requestId: string) => request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "skip" });
async function decide(bot: Bot, label: "Trust this folder" | "Don't trust") {
  await send(bot);
  const open = await card(bot);
  expect((await answer(bot, open.requestId, label)).status).toBe(200);
  await settled(bot);
}
async function skipCard(bot: Bot, text: string) {
  await send(bot, text);
  const open = await card(bot);
  expect((await skip(bot, open.requestId)).status).toBe(200);
  await settled(bot);
}
const noteFor = async (bot: Bot) => {
  mkdirSync(workspaceOf(bot), { recursive: true });
  return (await request("GET", `/api/folder-trust?thread=${bot.threadId}&bot=${bot.id}`));
};
const forget = (key: string) => request("DELETE", `/api/folder-trust?key=${encodeURIComponent(key)}`);

posixOnly("what Settings promises, through the harness", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = realpathSync(mkdtempSync(join(tmpdir(), "murage-folder-trust-settings-")));
    trustLog = join(home, "trust.log");
    ({ child, desktop: desktopHeaders } = await bootServer(port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("(18) Forget of a trust: the owner's own Fuigo keeps it and does not ask; a home that never trusted it does", async () => {
    const owner = await makeBot("Owner", "own");
    await decide(owner, "Trust this folder");
    expect(stored()[K("forgotten")]).toMatchObject({ decision: "trust", consent: 2 });
    expect(readFileSync(trustFile("own"), "utf8")).toContain(K("forgotten"));
    // the row's copy reads these: consent 2, own home, the real file
    const note = (await noteFor(owner)).body;
    expect(note).toMatchObject({ upstreamStore: "own", upstreamTrustFile: trustFile("own"), trustGeneration: 2 });
    expect(note.records.find((row: any) => row.key === K("forgotten"))).toMatchObject({ decision: "trust", consent: 2 });

    // control: while the record stands, a home with no grant is answered with no card
    const control = await makeBot("Control", "fresh-control");
    const before = requestsFor(K("forgotten"));
    await turn(control);
    expect(requestsFor(K("forgotten"))).toBe(before + 1);
    expect(lastReply()).toContain('"outcome":"trust"');
    expect(await openCard(control.threadId)).toBeUndefined();

    expect((await forget(K("forgotten"))).status).toBe(200);
    expect(stored()[K("forgotten")]).toBeUndefined();

    // own home: the engine's grant stands, so it does not ask
    const asked = requestsFor(K("forgotten"));
    await turn(owner, "two");
    expect(requestsFor(K("forgotten"))).toBe(asked);
    expect(await openCard(owner.threadId)).toBeUndefined();

    // a home with no grant: the engine asks and the owner decides
    const fresh = await makeBot("Fresh", "fresh-after");
    await skipCard(fresh, "go");
    expect(requestsFor(K("forgotten"))).toBe(asked + 1);
  }, 60_000);

  it("(13e) the reject row's sentence holds both ways: with a trust still standing Fuigo continues without asking, with none it asks", async () => {
    // no other trust decision covers it: the card returns
    const alone = await makeBot("Alone", "reject-only");
    await decide(alone, "Don't trust");
    expect((await forget(K("only"))).status).toBe(200);
    await skipCard(alone, "two");

    // another trust decision stands
    await decide(await makeBot("Trusts", "trust-p"), "Trust this folder");
    await decide(await makeBot("Declines", "reject-d"), "Don't trust");
    const bot = await makeBot("Asks", "ask-p");
    // control: while the reject stands it may sit inside the trust, so the card shows
    await skipCard(bot, "one");
    const asked = requestsFor(K("parent"));
    expect((await forget(K("declined"))).status).toBe(200);
    await turn(bot, "two");
    expect(requestsFor(K("parent"))).toBe(asked + 1);
    expect(lastReply()).toContain('"outcome":"trust"');
    expect(await openCard(bot.threadId)).toBeUndefined();
    expect(stored()[K("declined")]).toBeUndefined();
    expect((await forget(K("parent"))).status).toBe(200);
  }, 90_000);

  it("(19) stored engine no rows are the file's own keys with the real path; a broken file is named and says no more than that", async () => {
    const yes = (await noteFor(await makeBot("Stored", "store-no"))).body;
    expect(yes).toMatchObject({ upstreamStore: "own", upstreamTrustFile: trustFile("store-no"), upstreamUnreadable: false });
    expect(yes.upstreamDeclines).toEqual(["/stored/plain", "/stored/slash/", "relative/key"]);

    for (const [instance, name] of [["store-broken", "Broken"], ["store-dir", "Directory"]]) {
      const res = await noteFor(await makeBot(name!, instance!));
      expect(res.body).toMatchObject({ upstreamTrustFile: trustFile(instance!), upstreamDeclines: [], upstreamUnreadable: true });
      expect(res.text).not.toMatch(/EISDIR|EACCES|\[\[\[/);
    }
    for (const [instance, name] of [["store-empty", "Empty"], ["store-none", "None"]]) {
      expect((await noteFor(await makeBot(name!, instance!))).body).toMatchObject({ upstreamDeclines: [], upstreamUnreadable: false });
    }
  }, 40_000);
});

describe("the engine's file as Settings reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-upstream-file-"));
  const write = (text: string) => writeFileSync(join(dir, "trusted_folders.toml"), text);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("tells a broken file from an absent or empty one, and leaves the engine's own reader as it was", () => {
    expect(readUpstreamTrustFile(dir)).toEqual({ file: join(dir, "trusted_folders.toml"), declines: [], unreadable: false });
    write("\n  \n");
    expect(readUpstreamTrustFile(dir).unreadable).toBe(false);
    write("not toml [[[\n");
    expect(readUpstreamTrustFile(dir)).toMatchObject({ declines: [], unreadable: true });
    expect(readUpstreamTrustedFolders(dir).size).toBe(0);
    write('[folders."/a/"]\ntrusted = false\n[folders."/b"]\ntrusted = true\n');
    expect(readUpstreamTrustFile(dir)).toMatchObject({ declines: ["/a/"], unreadable: false });
    expect([...readUpstreamTrustedFolders(dir)]).toEqual([["/a/", false], ["/b", true]]);
  });
});

// The check ed8af4fd5's FolderTrustStore constructor runs on every record, as shipped.
const oldReaderKeeps = (value: any) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (value.decision === "trust" || value.decision === "reject")
  && typeof value.decidedAt === "number"
  && typeof value.folder === "string";

describe("(10) downgrade", () => {
  it("a file this build wrote keeps every record through the ed8af4fd5 reader, consent stamp included", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-folder-trust-downgrade-"));
    try {
      const file = join(dir, "folder-trust.json");
      const store = new FolderTrustStore(file);
      const [one, two, three] = [resolve("/work/one"), resolve("/work/two"), resolve("/work/three")];
      store.remember(one, "trust", "card", { key: one, consent: 2 });
      store.remember(join(two, "sub"), "reject", "card", { key: two, consent: 2 });
      store.remember(three, "trust", "picker", { key: three });
      const written = JSON.parse(readFileSync(file, "utf8"));
      expect(written.version).toBe(1);
      const entries = Object.entries(written.folders) as Array<[string, any]>;
      expect(entries.map(([key]) => key).sort()).toEqual([one, three, two]);
      expect(entries.filter(([, record]) => oldReaderKeeps(record))).toHaveLength(entries.length);
      expect(written.folders[one].consent).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
