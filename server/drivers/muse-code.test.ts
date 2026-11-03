// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Muse Code driver (GAP-MUSE, handoffs/BRIEF-1016-MUSE-BUILD.md). Ported in part from OpenMausBot (Apache-2.0),
// upstream eea36bdb1cd76f5fda659e68f564f106d177cbc1 server/drivers/muse-code.test.ts, with one test per Murage level.
// The process tests drive server/testing/fake-muse-cli.ts, a shebang .ts file spawnCli resolves to `node <script>`
// on Windows, so none of them is skipped on any OS.
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import * as procs from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ASK_STOP_NOTE, ASK_STOP_PROMPT, ASK_STOP_REASON, askStopUnavailableLine } from "./ask-stop.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import {
  MUSE_APPROVAL_MODE, MUSE_MODELS_LOADING_NOTE, MUSE_MOUNTS_REFUSED_LINE, MuseCodeDriver, museAllowOnce, museAnswers, museAskRead,
  museCatalog, museChangeItem, museChildEnv, museContributorModel, museDeny, museInitialCatalog, museMcpServers, museModelLabel,
  musePosture, museQuestions, museServeArgs, museSignedIn, museToolOutput, museToolStart,
} from "./muse-code.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-muse-cli.ts");

const CHOICES = [
  { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session" },
  { choiceId: "c-rule", label: "Always allow", decision: "approvedPolicyAmendment", scope: "localPersistent" },
  { choiceId: "c-abort", label: "Reject", decision: "abort", scope: "once" },
];

describe("Muse Code driver: launch and level mapping", () => {
  it("is registered right after Cline, with Fuigo still first", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds[0]).toBe("fuigoAgent");
    expect(kinds.indexOf("museCode")).toBe(kinds.indexOf("clineAgent") + 1);
  });

  it("installs with Meta's installer on every OS and signs in with `muse login`", () => {
    expect(MuseCodeDriver.install?.command?.darwin).toBe("curl -fsSL https://dev.meta.ai/install.sh | bash");
    expect(MuseCodeDriver.install?.command?.linux).toBe("curl -fsSL https://dev.meta.ai/install.sh | bash");
    expect(MuseCodeDriver.install?.command?.win32).toBe("irm https://dev.meta.ai/install.ps1 | iex");
    expect(MuseCodeDriver.install?.signInCommand).toBe("muse login");
    expect(MuseCodeDriver.defaultConfig()).toEqual({ cli: "muse" });
  });

  it("maps Ask, Auto, Full access and No limits to one asking mode, read-only at Ask, never trusting the folder or dropping the sandbox", () => {
    expect(MUSE_APPROVAL_MODE).toBe("promptUnmatched");
    expect(musePosture({ askLevel: true, routeAsks: true })).toBe("ask");
    expect(musePosture({ routeAsks: true })).toBe("auto");
    expect(musePosture({})).toBe("auto");
    expect(musePosture({ stopLine: true })).toBe("full");
    expect(museServeArgs("ask")).toEqual(["serve", "--disable-shell", "--disable-write"]);
    expect(museServeArgs("auto")).toEqual(["serve"]);
    expect(museServeArgs("full")).toEqual(["serve"]);
    for (const posture of ["ask", "auto", "full"] as const) {
      expect(museServeArgs(posture)).not.toContain("--trust-workspace");
      expect(museServeArgs(posture)).not.toContain("--disable-sandbox");
    }
  });

  it("answers an allow with Muse's once choice only, and a deny with its deny or Reject", () => {
    expect(museAllowOnce(CHOICES)?.choiceId).toBe("c-once");
    expect(museAllowOnce(CHOICES.slice(1))).toBeUndefined();
    expect(museDeny(CHOICES)?.choiceId).toBe("c-abort");
    expect(museDeny([...CHOICES, { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once" }])?.choiceId).toBe("c-deny");
    expect(museDeny(CHOICES.slice(0, 3))).toBeUndefined();
  });

  it("lets only a file read reach a card at Ask, and stops on a completed shell or write", () => {
    expect(museAskRead({ kind: "fileAccess", access: "read", path: "a.txt" })).toBe(true);
    expect(museAskRead({ kind: "fileAccess", access: "write", path: "a.txt" })).toBe(false);
    expect(museAskRead({ kind: "shell", command: "ls" })).toBe(false);
    expect(museAskRead({ kind: "network", host: "example.com" })).toBe(false);
    expect(museAskRead(undefined)).toBe(false);
    expect(museChangeItem({ itemId: "1", kind: "userShell", status: "completed", commandText: "touch c" })).toBe(true);
    expect(museChangeItem({ itemId: "1", kind: "toolCall", status: "completed", tool: "write_file" })).toBe(true);
    expect(museChangeItem({ itemId: "1", kind: "toolCall", status: "completed", tool: "bash" })).toBe(true);
    expect(museChangeItem({ itemId: "1", kind: "toolCall", status: "completed", tool: "read_file", patchSummary: {} })).toBe(true);
    expect(museChangeItem({ itemId: "1", kind: "toolCall", status: "completed", tool: "read_file" })).toBe(false);
    expect(museChangeItem({ itemId: "1", kind: "toolCall", status: "failed", tool: "write_file" })).toBe(false);
  });

  it("strips every inherited key, META_API_KEY included, takes the key only from the instance and forces Contributor off and no self-update", () => {
    const base = { PATH: "/bin", META_API_KEY: "planted", OPENAI_API_KEY: "o", CLINE_API_KEY: "c", OPENAI_BASE_URL: "http://x", HOME: "/h" };
    const plain = museChildEnv(base, {}, "linux");
    expect(plain.META_API_KEY).toBeUndefined();
    expect(plain.OPENAI_API_KEY).toBeUndefined();
    expect(plain.CLINE_API_KEY).toBeUndefined();
    expect(plain.OPENAI_BASE_URL).toBeUndefined();
    expect(plain).toMatchObject({ MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0", HOME: "/h" });
    const own = museChildEnv(base, { META_API_KEY: "mine", MUSE_CONTRIBUTOR_MODE: "1", MUSE_NO_AUTO_UPDATE: "0" }, "linux");
    expect(own).toMatchObject({ META_API_KEY: "mine", MUSE_CONTRIBUTOR_MODE: "0", MUSE_NO_AUTO_UPDATE: "1" });
    const windows = museChildEnv({ Meta_Api_Key: "planted", muse_contributor_mode: "1" }, {}, "win32");
    expect(Object.keys(windows).map((key) => key.toUpperCase())).not.toContain("META_API_KEY");
    expect(windows.muse_contributor_mode).toBeUndefined();
    expect(windows.MUSE_CONTRIBUTOR_MODE).toBe("0");
  });

  it("checks sign-in by the key or the saved file's existence only", () => {
    const seen: string[] = [];
    const exists = (path: string) => { seen.push(path); return false; };
    expect(museSignedIn({ META_API_KEY: "k" }, {}, "linux", exists)).toBe(true);
    expect(seen).toEqual([]);
    expect(museSignedIn({}, { HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux", exists)).toBe(false);
    expect(seen).toEqual([join("/x", "muse", "auth.json"), join("/h", ".config", "muse", "auth.json")]);
    seen.length = 0;
    museSignedIn({}, { USERPROFILE: "C:/u", APPDATA: "C:/u/AppData/Roaming" }, "win32", exists);
    expect(seen).toContain(join("C:/u/AppData/Roaming", "muse", "auth.json"));
    expect(museSignedIn({}, { HOME: "/h" }, "linux", (path) => path === join("/h", ".config", "muse", "auth.json"))).toBe(true);
  });

  it("builds the picker from the live list only, with every Contributor model dropped and nothing invented", () => {
    expect(MuseCodeDriver.models).toEqual({ default: "", options: [] });
    expect(museInitialCatalog(undefined)).toEqual({ default: "", options: [] });
    expect(museInitialCatalog("muse-spark-1.3").options.map((option) => option.id)).toEqual(["muse-spark-1.3"]);
    expect(museInitialCatalog("muse-spark-1.3-contributor").options).toEqual([]);
    const listed = museCatalog({ models: [
      { modelId: "muse-spark-1.3-contributor", displayLabel: "Muse Spark 1.3 Contributor", isDefault: true },
      { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isDefault: true, contextLimit: null },
      { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", contextLimit: 500_000 },
      { modelId: "muse-spark-1.2", displayLabel: "Spark (Contributor)" },
      { modelId: "muse-x", isContributor: true },
      { modelId: "muse-spark-1.3" }, { modelId: 7 }, null,
    ] });
    expect(listed).toEqual({ default: "muse-wonder-1.0", source: "live", options: [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 500_000 },
    ] });
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next")?.default).toBe("muse-next");
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next-contributor")?.default).toBe("muse-spark-1.3");
    expect(museCatalog({ models: [{ modelId: "a-contributor" }] })).toBeNull();
    expect(museCatalog({ models: [] })).toBeNull();
    expect(museCatalog(null)).toBeNull();
    expect(museContributorModel("Muse-Spark-CONTRIBUTOR")).toBe(true);
    expect(museModelLabel("muse-spark-1.3")).toBe("Muse Spark 1.3");
  });

  it("mounts Murage's tools as required stdio session servers", () => {
    const turn: SendTurnInput = { threadId: "t", text: "hi", integrations: { memory: { command: "node", args: ["m"], env: { A: "1" } } } };
    expect(museMcpServers(turn)).toEqual({ "murage-memory": { transport: "stdio", command: "node", args: ["m"], env: { A: "1" }, mode: "required" } });
    expect(museMcpServers({ threadId: "t", text: "hi" })).toBeNull();
  });

  it("shows a shell call as its command and reports its exit", () => {
    const item = { itemId: "i1", kind: "toolCall", status: "completed", tool: "bash", args: JSON.stringify({ command: "echo hi\nls" }), visibleOutput: "hi", exitCode: 0 };
    expect(museToolStart(item)).toMatchObject({ title: "bash", summary: "echo hi ls" });
    expect(museToolOutput(item)).toEqual({ ok: true, result: "hi" });
    expect(museToolOutput({ ...item, exitCode: 1 })).toMatchObject({ ok: false });
    expect(museToolOutput({ ...item, status: "failed", failureReason: "denied by policy", visibleOutput: undefined })).toEqual({ ok: false, detail: "denied by policy" });
  });

  it("turns Muse's questions into card questions and answers them by Muse's ids", () => {
    const questions = museQuestions([
      { id: "q1", header: "City", question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }], selection: { mode: "single" } },
      { id: "q2", header: "Days", question: "Which days?", options: [{ label: "Mon" }, { label: "Tue" }], selection: { mode: "multiple" } },
    ])!;
    expect(questions.map((q) => [q.id, q.question, q.multiSelect])).toEqual([["q1", "Which city?", false], ["q2", "Which days?", true]]);
    expect(museAnswers(questions, [{ id: "q1", selected: ["Pune"] }, { id: "q2", selected: ["Mon", "Tue"] }])).toEqual([
      { questionId: "q1", selectedLabel: "Pune" }, { questionId: "q2", selectedLabels: ["Mon", "Tue"] },
    ]);
    expect(museAnswers(questions, [{ id: "q1", selected: [], other: "Goa" }])).toEqual([{ questionId: "q1", freeText: "Goa" }]);
    expect(museQuestions("nope")).toBeNull();
  });
});

type Entry = { launch?: string[]; env?: Record<string, string | null>; method?: string; params?: Record<string, unknown>; descendant?: number };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("Muse Code's process", () => {
  let root = "";
  let logPath = "";
  const instances: ProviderInstance[] = [];

  beforeAll(() => {
    if (process.platform !== "win32") chmodSync(FAKE, 0o755);
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.dispose().catch(() => {});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await removeTempDir(root);
    root = "";
  });

  const start = async (environment: Record<string, string> = {}, config: Record<string, unknown> = {}) => {
    root = mkdtempSync(join(tmpdir(), "murage-muse-"));
    logPath = join(root, "log.jsonl");
    const spawned = vi.spyOn(procs, "spawnCli");
    const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
      environment: { FAKE_MUSE_LOG: logPath, ...environment }, config: MuseCodeDriver.decodeConfig({ cli: FAKE, ...config }) });
    instances.push(instance);
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    return { instance, events, spawned };
  };
  const entries = (): Entry[] => existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
  const turnLaunches = () => entries().filter((entry) => entry.launch?.[0] === "serve" && !entry.launch.includes("--no-session-log"));
  const requests = (method: string) => entries().filter((entry) => entry.method === method);
  const completedOf = async (events: RuntimeEvent[]) => vi.waitFor(() => {
    const done = events.find((event) => event.type === "turn.completed");
    expect(done).toBeDefined();
    return done as Extract<RuntimeEvent, { type: "turn.completed" }>;
  }, { timeout: 10_000 });
  const opened = (events: RuntimeEvent[]) => events.filter((event): event is Extract<RuntimeEvent, { type: "request.opened" }> => event.type === "request.opened");
  const turn = (extra: Partial<SendTurnInput> = {}): SendTurnInput => ({ threadId: "t-1", text: "hi", cwd: root, ...extra });

  it("runs an Auto turn through the shared launcher at promptUnmatched, with Contributor off, no self-update and no inherited key", async () => {
    vi.stubEnv("META_API_KEY", "planted");
    vi.stubEnv("OPENAI_API_KEY", "planted-openai");
    const { instance, events, spawned } = await start();
    await instance.adapter.sendTurn(turn({ routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({ text: "hello", origin: "engine" });
    expect(spawned.mock.calls.some((call) => call[0] === FAKE && call[1][0] === "serve")).toBe(true);
    const [launch] = turnLaunches();
    expect(launch!.launch).toEqual(["serve"]);
    expect(launch!.env).toMatchObject({ META_API_KEY: null, OPENAI_API_KEY: null, MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0" });
    expect(requests("session/start")[0]!.params).toMatchObject({ approvalMode: "promptUnmatched", providerId: "meta", workspaceRoot: root });
    await instance.snapshot();
    const version = entries().find((entry) => entry.launch?.[0] === "--version");
    expect(version!.env).toMatchObject({ META_API_KEY: null, MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0" });
    for (const entry of entries().filter((e) => e.launch)) {
      expect(entry.launch).not.toContain("--trust-workspace");
      expect(entry.env).toMatchObject({ MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0" });
    }
  }, 20_000);

  it("hands Muse the instance's own key and no other", async () => {
    vi.stubEnv("META_API_KEY", "planted");
    const { instance, events } = await start({ META_API_KEY: "instance-key", MUSE_CONTRIBUTOR_MODE: "1" });
    await instance.adapter.sendTurn(turn());
    await completedOf(events);
    expect(turnLaunches()[0]!.env).toMatchObject({ META_API_KEY: "instance-key", MUSE_CONTRIBUTOR_MODE: "0" });
    expect(await instance.snapshot()).toMatchObject({ state: "available", billing: "metered" });
  }, 20_000);

  it("opens one card per ask on Auto and answers an allow with Muse's once choice, once", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval" });
    await instance.adapter.sendTurn(turn({ routeAsks: true }));
    await vi.waitFor(() => expect(opened(events)).toHaveLength(1));
    expect(opened(events)[0]).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf build", toolCall: { name: "shell", input: { command: "rm -rf build" } } });
    expect(await instance.adapter.respondToRequest("t-1", "ap-1", { behavior: "allow" })).toBe("allowed-once");
    expect(await instance.adapter.respondToRequest("t-1", "ap-1", { behavior: "allow" })).toBe("unavailable");
    await completedOf(events);
    expect(requests("approval/decide").map((entry) => entry.params!.choiceId)).toEqual(["c-once"]);
  }, 20_000);

  it("never picks a session grant or a policy rule when no once choice is offered", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval", FAKE_MUSE_CHOICES: JSON.stringify(CHOICES.slice(1)) });
    await instance.adapter.sendTurn(turn({ routeAsks: true }));
    await vi.waitFor(() => expect(opened(events)).toHaveLength(1));
    expect(await instance.adapter.respondToRequest("t-1", "ap-1", { behavior: "allow" })).toBe("unavailable");
    await completedOf(events);
    expect(requests("approval/decide").map((entry) => entry.params!.choiceId)).toEqual(["c-abort"]);
  }, 20_000);

  it("keeps the sandbox and the asks on Full access and No limits, so Murage answers every ask", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval" });
    await instance.adapter.sendTurn(turn({ stopLine: true }));
    await vi.waitFor(() => expect(opened(events)).toHaveLength(1));
    expect(requests("approval/decide")).toHaveLength(0);
    expect(await instance.adapter.respondToRequest("t-1", "ap-1", { behavior: "allow" })).toBe("allowed-once");
    await completedOf(events);
    expect(turnLaunches()[0]!.launch).toEqual(["serve"]);
    const modes = [...requests("session/start").map((e) => e.params!.approvalMode), ...requests("session/setApprovalMode").map((e) => e.params!.mode)];
    expect(modes).toEqual(["promptUnmatched"]);
    expect(JSON.stringify(entries())).not.toContain("allowAll");
    expect(requests("approval/decide").map((entry) => entry.params!.choiceId)).toEqual(["c-once"]);
  }, 20_000);

  it("runs Ask read-only and refuses a shell ask with no card", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval" });
    await instance.adapter.sendTurn(turn({ askLevel: true, routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(turnLaunches()[0]!.launch).toEqual(["serve", "--disable-shell", "--disable-write"]);
    expect(opened(events)).toHaveLength(0);
    expect(requests("approval/decide").map((entry) => entry.params!.choiceId)).toEqual(["c-deny"]);
    const text = (requests("turn/start")[0]!.params!.input as Array<{ text?: string }>)[0]!.text!;
    expect(text.startsWith(ASK_STOP_PROMPT)).toBe(true);
    expect(events.some((event) => event.type === "item.started" && event.itemType === "tool" && event.title === ASK_STOP_NOTE)).toBe(true);
  }, 20_000);

  it("still asks the owner about a file read at Ask", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval", FAKE_MUSE_SUBJECT: JSON.stringify({ kind: "fileAccess", access: "read", path: "a.txt", toolName: "read_file" }) });
    await instance.adapter.sendTurn(turn({ askLevel: true, routeAsks: true }));
    await vi.waitFor(() => expect(opened(events)).toHaveLength(1));
    expect(opened(events)[0]).toMatchObject({ toolKind: "read", filePaths: [join(root, "a.txt")] });
    expect(await instance.adapter.respondToRequest("t-1", "ap-1", { behavior: "deny" })).toBe("rejected");
    await completedOf(events);
  }, 20_000);

  it("stops an Ask turn at once when a write completes anyway", async () => {
    const { instance, events, spawned } = await start({ FAKE_MUSE_TURN: "change" });
    await instance.adapter.sendTurn(turn({ askLevel: true, routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: true, stopReason: ASK_STOP_REASON });
    const bot = spawned.mock.calls.findIndex((call) => call[1].includes("--disable-write") && !call[1].includes("--no-session-log"));
    const engine = spawned.mock.results[bot]!.value as ReturnType<typeof procs.spawnCli>;
    await vi.waitFor(() => expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true), { timeout: 8_000 });
  }, 20_000);

  it("does not run an Ask turn whose read-only launch fails", async () => {
    const { instance, events } = await start({ FAKE_MUSE_REFUSE_FLAG: "--disable-write" });
    await instance.adapter.sendTurn(turn({ askLevel: true, routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: askStopUnavailableLine("Muse Code") });
    expect(requests("turn/start")).toHaveLength(0);
  }, 20_000);

  it("lists the live models with the Contributor rows dropped, and says they are loading until then", async () => {
    const slow = await start({ META_API_KEY: "k", FAKE_MUSE_INIT_DELAY_MS: "2500" });
    expect(slow.instance.models.options).toEqual([]);
    expect(await slow.instance.snapshot()).toMatchObject({ state: "available", versionNote: MUSE_MODELS_LOADING_NOTE });
    await vi.waitFor(() => expect(slow.instance.models.source).toBe("live"), { timeout: 10_000 });
    expect(slow.instance.models.options.map((option) => option.id)).toEqual(["muse-wonder-1.0"]);
    expect((await slow.instance.snapshot()).versionNote).toBeUndefined();
  }, 20_000);

  it("fails the turn when a required mount was not granted, and passes mounts as required when it was", async () => {
    const memory = { command: process.execPath, args: ["-e", ""], env: {} };
    const refused = await start();
    await refused.instance.adapter.sendTurn(turn({ integrations: { memory } }));
    expect(await completedOf(refused.events)).toMatchObject({ ok: false });
    expect(refused.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: MUSE_MOUNTS_REFUSED_LINE });
    expect(requests("session/start")).toHaveLength(0);
    await refused.instance.dispose();
    instances.splice(0);
    await removeTempDir(root);

    const granted = await start({ FAKE_MUSE_GRANT: "sessionMcp" });
    await granted.instance.adapter.sendTurn(turn({ integrations: { memory } }));
    expect(await completedOf(granted.events)).toMatchObject({ ok: true });
    expect(requests("initialize").some((entry) => JSON.stringify(entry.params).includes("sessionMcp"))).toBe(true);
    expect(requests("session/start")[0]!.params).toMatchObject({ config: { mcpServers: { "murage-memory": { transport: "stdio", mode: "required" } } } });
  }, 30_000);

  it("answers a question once, by Muse's ids", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "question" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(opened(events)).toHaveLength(1));
    expect(await instance.adapter.respondToRequest("t-1", "q-1", { behavior: "answer", answers: [{ id: "city", selected: ["Pune"] }] })).toBe("answered");
    expect(await instance.adapter.respondToRequest("t-1", "q-1", { behavior: "answer", answers: [{ id: "city", selected: ["Mumbai"] }] })).toBe("unavailable");
    await completedOf(events);
    expect(requests("userInput/answer").map((entry) => entry.params!.answers)).toEqual([[{ questionId: "city", selectedLabel: "Pune" }]]);
  }, 20_000);

  it("steers the running turn behind the fence, and writes nothing when the fence refuses", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "hang" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.started")).toBe(true));
    expect(await instance.adapter.steer!("t-1", "also this")).toBe("delivered");
    expect(await instance.adapter.steer!("t-1", "not this", () => { throw new Error("fenced"); })).toBe("rejected");
    const steers = requests("turn/steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.params).toMatchObject({ expectedTurnId: requests("turn/start")[0]!.params!.commandId });
  }, 20_000);

  it("sends no prompt when the submission fence refuses", async () => {
    const { instance, events } = await start();
    await instance.adapter.sendTurn(turn({ beforeSubmit: () => { throw new Error("refused"); } }));
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(requests("turn/start")).toHaveLength(0);
  }, 20_000);

  it("closes a host whose approval mode could not be set, so the next turn launches again and sets it again", async () => {
    const { instance, events } = await start({ FAKE_MUSE_FAIL_APPROVAL_MODE: "1" });
    const done = () => events.filter((event) => event.type === "turn.completed");
    await instance.adapter.sendTurn(turn({ resumeCursor: "s-7" }));
    await vi.waitFor(() => expect(done()).toHaveLength(1), { timeout: 10_000 });
    expect(done()[0]).toMatchObject({ ok: false });
    await instance.adapter.sendTurn(turn({ resumeCursor: "s-7" }));
    await vi.waitFor(() => expect(done()).toHaveLength(2), { timeout: 10_000 });
    expect(done()[1]).toMatchObject({ ok: false });
    expect(turnLaunches()).toHaveLength(2);
    expect(requests("session/setApprovalMode")).toHaveLength(2);
    expect(requests("turn/start")).toHaveLength(0);
  }, 20_000);

  // POSIX pipes: a descendant holding stdout/stderr keeps the root's close from ever landing. (On Windows the job route
  // confirms the tree on the job count, not on the pipes.)
  it.skipIf(process.platform === "win32")("stops the whole tree on shutdown even when the root has already exited", async () => {
    const { instance, events } = await start({ FAKE_MUSE_DESCENDANT: "1" });
    const held = () => entries().map((entry) => entry.descendant).filter((pid): pid is number => typeof pid === "number");
    try {
      await instance.adapter.sendTurn(turn());
      expect(await completedOf(events)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(held().length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
      await instance.dispose();
      await vi.waitFor(() => expect(held().filter(alive)).toEqual([]), { timeout: 5_000 });
    } finally {
      for (const pid of held().filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  }, 30_000);

  describe("Stop", () => {
    const runningTurn = async (interrupt: "ack" | "refuse" | "silent" | "confirm", extra: Record<string, string> = {}) => {
      const started = await start({ FAKE_MUSE_TURN: "hang", FAKE_MUSE_INTERRUPT: interrupt, ...extra });
      const { instance, spawned } = started;
      const exited = () => {
        const bot = spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"));
        const engine = spawned.mock.results[bot]!.value as ReturnType<typeof procs.spawnCli>;
        return engine.exitCode !== null || engine.signalCode !== null;
      };
      const settled: { started?: boolean; completed?: RuntimeEvent; hostExited?: boolean } = {};
      instance.adapter.onEvent((event) => {
        if (event.type === "turn.started") settled.started = true;
        if (event.type !== "turn.completed") return;
        settled.completed = event;
        settled.hostExited = exited();
      });
      await instance.adapter.sendTurn(turn({ threadId: "t-stop", stopLine: true }));
      await vi.waitFor(() => expect(settled.started).toBe(true));
      await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
      return { instance, settled, exited };
    };

    it("ends a turn Muse confirms cancelled", async () => {
      const { instance, settled } = await runningTurn("confirm");
      await instance.adapter.interruptTurn("t-stop");
      await vi.waitFor(() => expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" }));
    }, 20_000);

    it("ends the host before it reports a turn stopped whose interrupt Muse refused", async () => {
      const { instance, settled } = await runningTurn("refuse");
      await instance.adapter.interruptTurn("t-stop");
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("waits for the same host shutdown when Stop is pressed again", async () => {
      const { instance, settled, exited } = await runningTurn("refuse", { FAKE_MUSE_EXIT_DELAY_MS: "500" });
      const first = instance.adapter.interruptTurn("t-stop");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.adapter.interruptTurn("t-stop");
      expect(exited()).toBe(true);
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      await first;
    }, 20_000);

    it("ends the host when an acknowledged interrupt is never confirmed", async () => {
      const { instance, settled } = await runningTurn("ack");
      await instance.adapter.interruptTurn("t-stop");
      expect(settled.completed).toBeUndefined();
      await vi.waitFor(() => expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" }), { timeout: 10_000 });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("disposes only once the host of an acknowledged interrupt has ended", async () => {
      const { instance, settled } = await runningTurn("ack");
      await instance.adapter.interruptTurn("t-stop");
      await instance.dispose();
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("ends the host when Muse never answers the interrupt", async () => {
      const { instance, settled } = await runningTurn("silent");
      await instance.adapter.interruptTurn("t-stop");
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("ends a host that finishes starting after Stop", async () => {
      const { instance, spawned, events } = await start({ FAKE_MUSE_INIT_DELAY_MS: "800" });
      await instance.adapter.sendTurn(turn({ threadId: "t-early" }));
      await vi.waitFor(() => expect(spawned.mock.calls.some((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))).toBe(true));
      const engine = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))]!.value as ReturnType<typeof procs.spawnCli>;
      await instance.adapter.interruptTurn("t-early");
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "interrupted" });
      await vi.waitFor(() => expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true), { timeout: 8_000 });
      expect(requests("turn/start")).toHaveLength(0);
    }, 20_000);
  });
});
