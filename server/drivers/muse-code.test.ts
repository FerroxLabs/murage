import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Muse Code driver (GAP-MUSE, BRIEF-1016-MUSE-BUILD.md). Ported in part from OpenMausBot (Apache-2.0),
// upstream eea36bdb1cd76f5fda659e68f564f106d177cbc1 server/drivers/muse-code.test.ts, with one test per Murage level.
// The process tests drive server/testing/fake-muse-cli.ts, a shebang .ts file spawnCli resolves to `node <script>`
// on Windows, so they run on every OS. The one exception is the POSIX pipe case below, which says why.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Connection } from "@muse-code/sdk";
import { withCliMemoryLearning } from "./cli-memory-learning.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { droppedUnsent } from "../memory/learning-send.ts";
import { MemorySendFenced, isMemorySendFenced } from "../memory/learning-send-fence.ts";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BotFolderUnavailableError } from "../bot-folder.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import * as procs from "../procs.ts";
import * as jobs from "../memory/pip-job.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ASK_STOP_NOTE, ASK_STOP_PROMPT, ASK_STOP_REASON, askStopUnavailableLine } from "./ask-stop.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import {
  checkMuseWrite, stdioTransport, musePromptCommand, MUSE_PROMPT_METHODS, type MuseAdmission,
  MUSE_APPROVAL_MODE, MUSE_DEFAULT_MODEL, MUSE_MODELS_LOADING_NOTE, MUSE_MOUNTS_REFUSED_LINE, MUSE_NO_REGULAR_MODEL_LINE, MuseCodeDriver,
  museAllowOnce, museAnswers, museAskRead, museCatalog, museChangeItem, museChildEnv, museContributorIds, museContributorModel, museDeny, museInitialCatalog,
  museMcpServers, museModelLabel, musePosture, museQuestions, museServeArgs, museSessionModel, museSignedIn, museToolOutput, museToolStart,
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
    expect(museServeArgs("ask")).toEqual(["serve", "--disable-shell", "--disable-write", "--contributor-mode", "off"]);
    // Muse never asks before a file write (probe 2): writes are open only at Full access (MUSE-WRITE-GATE, 1.0.18).
    expect(museServeArgs("auto")).toEqual(["serve", "--disable-write", "--contributor-mode", "off"]);
    expect(museServeArgs("full")).toEqual(["serve", "--contributor-mode", "off"]);
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
    expect(plain).toMatchObject({ MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0", MUSE_DISABLE_APPROVAL_JUDGE: "1", HOME: "/h" });
    const own = museChildEnv(base, { META_API_KEY: "mine", MUSE_CONTRIBUTOR_MODE: "1", MUSE_NO_AUTO_UPDATE: "0", MUSE_DISABLE_APPROVAL_JUDGE: "0" }, "linux");
    expect(own).toMatchObject({ META_API_KEY: "mine", MUSE_CONTRIBUTOR_MODE: "0", MUSE_NO_AUTO_UPDATE: "1", MUSE_DISABLE_APPROVAL_JUDGE: "1" });
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
    // Never the Contributor default, never the first row, never Muse Wonder: Muse Spark 1.3.
    expect(listed).toEqual({ default: MUSE_DEFAULT_MODEL, source: "live", options: [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 500_000 },
    ] });
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next")?.default).toBe("muse-next");
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next-contributor")?.default).toBe("muse-spark-1.3");
    expect(museCatalog({ models: [{ modelId: "a-contributor" }] })).toBeNull();
    // The 1.4.14 shape (probe 3): Contributor marked default, Wonder first among the regular rows.
    const served = museCatalog({ models: [
      { modelId: "muse-spark-1.3-contributor", displayLabel: "Muse Spark 1.3 Contributor", isDefault: true },
      { modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder 1.0" }, { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3" },
    ] })!;
    expect(served.default).toBe("muse-spark-1.3");
    expect(served.options.map((option) => option.id)).toEqual(["muse-wonder-1.0", "muse-spark-1.3"]);
    expect(museCatalog({ models: [{ modelId: "muse-wonder-1.0" }, { modelId: "muse-spark-1.4" }, { modelId: "muse-spark-1.4-contributor", isDefault: true }] })?.default).toBe(MUSE_DEFAULT_MODEL);
    // A model whose label says Contributor is never brought back as the configured pick, whatever its id.
    const labelled = { models: [{ modelId: "muse-spark-1.3" }, { modelId: "muse-spark-1.2", displayLabel: "Spark (Contributor)" }] };
    expect(museCatalog(labelled, "muse-spark-1.2")).toMatchObject({ default: "muse-spark-1.3", options: [{ id: "muse-spark-1.3" }] });
    expect([...museContributorIds(labelled)]).toEqual(["muse-spark-1.2"]);
    expect(museSessionModel(museContributorIds(labelled), "muse-spark-1.2")).toBe("muse-spark-1.3");
    expect(museCatalog({ models: [{ modelId: "muse-wonder-1.0", isDefault: true }] })?.default).toBe(MUSE_DEFAULT_MODEL);
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }, { modelId: "muse-x", displayLabel: "Spark Contributor" }] })?.options.map((option) => option.id)).toEqual(["muse-spark-1.3"]);
    expect(museSessionModel(new Set(), undefined, "")).toBe("muse-spark-1.3");
    expect(museSessionModel(new Set(), "muse-spark-1.3-contributor", "muse-wonder-1.0")).toBe("muse-wonder-1.0");
    expect(museSessionModel(new Set(), " ", "muse-spark-1.2-contributor")).toBe("muse-spark-1.3");
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
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // Container PID 1 may leave reparented children as zombies. They have exited and hold no pipes;
    // kill(pid, 0) alone would mistake their unreaped process-table entries for running descendants.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
};

describe("Muse physical write admission", () => {
  const fixture = () => {
    const writes: string[] = [];
    const stdout = new PassThrough();
    const child = { stdout, stderr: new PassThrough(), stdin: new Writable({
      write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); },
    }) } as unknown as ReturnType<typeof procs.spawnCli>;
    const admissions = new Map<string, MuseAdmission>();
    const active = { turnId: "owner", nativeTurnId: "native" };
    const authority = { closed: false, generation: 1, observationRevision: 0, role: "session", phase: "ready", requestMcp: false,
      sessionId: "s-1", requested: MUSE_DEFAULT_MODEL, owner: "owner", receipts: new Set(), observations: new Map(), unsafeObserved: new Set(),
      selection: { model: MUSE_DEFAULT_MODEL, classification: "regular" }, state: { active } } as unknown as Parameters<typeof checkMuseWrite>[1];
    authority.state!.host = authority;
    const transport = stdioTransport(child, Promise.resolve(), admissions, (frame, submitting) => checkMuseWrite(frame, authority, true, id => id === MUSE_DEFAULT_MODEL ? "regular" : "unclassified", submitting));
    const params = { sessionId: "s-1", input: [{ type: "text", text: "private prompt" }], commandId: "c-1" };
    const frame = (method = "turn/start", body: Record<string, unknown> = params) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: body }) + "\n";
    const admit = (extra: Partial<MuseAdmission> = {}) => admissions.set("c-1", {
      method: "turn/start", params: JSON.stringify(params), stopped: () => false, ...extra,
    });
    return { child, writes, stdout, admissions, transport, params, frame, admit, authority };
  };

  it("withdraws admission on asynchronous zero-byte stdin failure", async () => {
    const f = fixture();
    const notWritten = vi.fn();
    f.child.stdin.destroy();
    f.admit({ notWritten });
    await expect(f.transport.write(f.frame())).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" });
    expect(notWritten).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  });

  it("keeps delivery uncertain for a possibly partial stdin failure", async () => {
    const f = fixture();
    const notWritten = vi.fn();
    vi.spyOn(f.child.stdin, "write").mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => (args[2] as (error: Error) => void)(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
      return true;
    });
    f.admit({ notWritten });
    await expect(f.transport.write(f.frame())).rejects.toMatchObject({ code: "EPIPE" });
    expect(notWritten).not.toHaveBeenCalled();
  });

  it.each(["approval/decide", "userInput/answer"])("revokes queued %s at the physical write after Stop", async (method) => {
    const f = fixture();
    let stopped = false;
    f.admit({ method, stopped: () => stopped });
    const command = Promise.resolve().then(() => f.transport.write(f.frame(method)));
    stopped = true;
    await expect(command).rejects.toThrow("MUSE_STOPPED_BEFORE_WRITE");
    expect(f.writes).toEqual([]);
  });

  it("admits exactly once immediately before stdin, including steering", async () => {
    for (const method of MUSE_PROMPT_METHODS) {
      const f = fixture();
      const beforeSubmit = vi.fn(() => expect(f.writes).toEqual([]));
      const params = method === "turn/steer" ? { ...f.params, expectedTurnId: "native" } : f.params;
      f.admit({ method, beforeSubmit, params: JSON.stringify(params) });
      await f.transport.write(f.frame(method, params));
      expect(beforeSubmit).toHaveBeenCalledTimes(1);
      expect(f.writes).toEqual([f.frame(method, params)]);
      await expect(f.transport.write(f.frame(method, params))).rejects.toThrow("MUSE_UNADMITTED_WRITE");
      expect(f.writes).toHaveLength(1);
    }
  });

  it("refuses unowned, changed, malformed, partial and batched frames before writing", async () => {
    for (const change of ["unowned", "payload", "method", "malformed", "partial", "batch"]) {
      const f = fixture();
      if (change !== "unowned") f.admit();
      const chunk = change === "payload" ? f.frame("turn/start", { ...f.params, sessionId: "another" })
        : change === "method" ? f.frame("turn/steer")
        : change === "malformed" ? "garbage\n"
        : change === "partial" ? f.frame().trimEnd()
        : change === "batch" ? f.frame() + f.frame() : f.frame();
      await expect(f.transport.write(chunk)).rejects.toThrow("MUSE_UNADMITTED_WRITE");
      expect(f.writes).toEqual([]);
    }
  });

  it("preserves the exact fence error and checks Stop on both sides of admission", async () => {
    const f = fixture(), error = new MemorySendFenced();
    f.admit({ beforeSubmit: () => { throw error; } });
    await expect(f.transport.write(f.frame())).rejects.toBe(error);
    expect(isMemorySendFenced(error)).toBe(true);
    expect(f.writes).toEqual([]);
    const notWritten = vi.fn();
    let stopped = false;
    f.admit({ beforeSubmit: () => { stopped = true; }, stopped: () => stopped, notWritten });
    await expect(f.transport.write(f.frame())).rejects.toThrow("MUSE_STOPPED_BEFORE_WRITE");
    expect(notWritten).toHaveBeenCalledTimes(1);
    const hook = vi.fn();
    f.admit({ beforeSubmit: hook, stopped: () => true });
    await expect(f.transport.write(f.frame())).rejects.toThrow("MUSE_STOPPED_BEFORE_WRITE");
    expect(hook).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("T13 requires exact bootstrap forms and owned regular lifecycle authority", async () => {
    for (const requestMcp of [false, true]) {
      const f = fixture(); f.authority.phase = "initialize"; f.authority.requestMcp = requestMcp;
      const frame = { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "murage", title: "Murage", version: "1" }, capabilities: { requestedCapabilities: requestMcp ? ["sessionMcp"] : [] } } };
      await expect(f.transport.write(JSON.stringify({ ...frame, params: { ...frame.params, private: "sentinel" } }) + "\n")).rejects.toThrow("MUSE_UNADMITTED_WRITE");
      for (const nested of ["clientInfo", "capabilities"] as const) {
        await expect(f.transport.write(JSON.stringify({ ...frame, params: { ...frame.params, [nested]: { ...frame.params[nested], private: "PRIVATE" } } }) + "\n")).rejects.toThrow("MUSE_UNADMITTED_WRITE");
      }
      await f.transport.write(JSON.stringify(frame) + "\n");
      await f.transport.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const params = { sessionId: "s-1", turnId: "native", commandId: "c-1" };
      f.admit({ method: "turn/interrupt", params: JSON.stringify(params) });
      await f.transport.write(f.frame("turn/interrupt", params));
      expect(f.writes).toHaveLength(3);
      await expect(f.transport.write(f.frame("session/start"))).rejects.toThrow("MUSE_UNADMITTED_WRITE");
      await expect(f.transport.write(f.frame("unknown"))).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    }
  });

  it.each(["turn/start", "turn/steer"])("T01 ack then unsafe notification blocks held SDK %s", async method => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let queued = false;
    const connection = new Connection({ incoming: f.transport.incoming, write: async chunk => {
      const frame = JSON.parse(chunk);
      if (frame.method === method) { queued = true; await held; }
      await f.transport.write(chunk);
      f.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { commandId: frame.params.commandId } }) + "\n");
    } });
    connection.onNotification(() => { f.authority.selection!.classification = "Contributor"; });
    await musePromptCommand(connection, f.admissions, "session/setModel", { sessionId: "s-1", model: { modelId: MUSE_DEFAULT_MODEL, providerId: "meta" } }, { stopped: () => false });
    const sent = musePromptCommand(connection, f.admissions, method, { sessionId: "s-1", input: [], ...(method === "turn/steer" ? { expectedTurnId: "native" } : {}) }, { stopped: () => false });
    const refused = expect(sent).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    await vi.waitFor(() => expect(queued).toBe(true));
    f.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/modelChanged", params: { sessionId: "s-1", modelId: "contributor" } }) + "\n");
    await vi.waitFor(() => expect(f.authority.selection!.classification).toBe("Contributor"));
    release(); await refused;
    expect(f.writes.map(line => JSON.parse(line).method)).toEqual(["session/setModel"]);
    await connection.close(); f.stdout.end();
  });

  it("T01 rechecks classification after a synchronous owner callback", async () => {
    const f = fixture(); const notWritten = vi.fn();
    f.admit({ beforeSubmit: () => { f.authority.selection!.classification = "Contributor"; }, notWritten });
    await expect(f.transport.write(f.frame())).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    expect(f.writes).toEqual([]); expect(notWritten).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["turn/start", { input: [{ type: "text", text: "PRIVATE" }] }],
    ["turn/steer", { expectedTurnId: "native", input: [{ type: "text", text: "PRIVATE" }] }],
    ["approval/decide", { approvalId: "ap", requirementId: {}, choiceId: "once" }],
    ["userInput/answer", { userInputId: "q", answers: [{ questionId: "q", freeText: "PRIVATE" }] }],
    ["userInput/cancel", { userInputId: "q", reason: "closed" }],
    ["session/setModel", { model: { modelId: MUSE_DEFAULT_MODEL, providerId: "meta" } }],
    ["session/setApprovalMode", { mode: MUSE_APPROVAL_MODE }],
    ["turn/interrupt", { turnId: "native" }],
  ] as const)("T13 %s has a valid baseline and refuses unsafe queued writes", async (method, fields) => {
    const f = fixture(); const params = { sessionId: "s-1", commandId: "c-1", ...fields };
    f.admit({ method, params: JSON.stringify(params) });
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n";
    await f.transport.write(line); expect(f.writes).toEqual([line]);
    for (const classification of ["Contributor", "unclassified"] as const) {
      f.authority.selection!.classification = "regular";
      f.admit({ method, params: JSON.stringify(params) });
      const queued = Promise.resolve().then(() => f.transport.write(line));
      f.authority.selection!.classification = classification;
      await expect(queued).rejects.toThrow("MUSE_UNADMITTED_WRITE"); expect(f.writes).toEqual([line]);
    }
  });

  it.each(["session/start", "session/resume"])("T13 %s needs live regular setup authority", async method => {
    const f = fixture();
    const params = method === "session/start"
      ? { commandId: "c-1", workspaceRoot: "/PRIVATE", providerId: "meta", approvalMode: MUSE_APPROVAL_MODE, modelId: MUSE_DEFAULT_MODEL }
      : { commandId: "c-1", sessionId: "s-1", excludeItems: true, modelId: MUSE_DEFAULT_MODEL };
    f.admit({ method, params: JSON.stringify(params) });
    await f.transport.write(f.frame(method, params));
    expect(f.writes).toHaveLength(1);
    f.authority.requested = "unknown";
    f.admit({ method, params: JSON.stringify(params) });
    await expect(f.transport.write(f.frame(method, params))).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    expect(f.writes).toHaveLength(1);
  });

  it("T13 SDK receipts require a received ID and current regular session", async () => {
    const f = fixture(); const line = JSON.stringify({ jsonrpc: "2.0", id: 77, result: {} }) + "\n";
    await expect(f.transport.write(line)).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    f.authority.receipts.add(77); await f.transport.write(line);
    await expect(f.transport.write(line)).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    f.authority.receipts.add(78); f.authority.selection!.classification = "unclassified";
    await expect(f.transport.write(JSON.stringify({ jsonrpc: "2.0", id: 78, result: {} }) + "\n")).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    expect(f.writes).toEqual([line]);
  });

  it("the pinned SDK queues writes: retraction before its queued write still prevents bytes", async () => {
    const f = fixture();
    const connection = new Connection({ incoming: f.transport.incoming, write: f.transport.write });
    let stopped = false;
    const beforeSubmit = vi.fn();
    const sent = musePromptCommand(connection, f.admissions, "turn/start", { sessionId: "s-1", input: [] }, {
      beforeSubmit, stopped: () => stopped,
    });
    expect(f.writes).toEqual([]); // SDK 1.4.14 uses #writeTail.then, never same-stack submission
    stopped = true;
    await expect(sent).rejects.toThrow("MUSE_STOPPED_BEFORE_WRITE");
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.admissions.size).toBe(0);
    await connection.close();
    f.stdout.end();
  });

  it("preserves fence identity through the real SDK's queued command", async () => {
    const f = fixture(), error = new MemorySendFenced();
    const connection = new Connection({ incoming: f.transport.incoming, write: f.transport.write });
    await expect(musePromptCommand(connection, f.admissions, "turn/start", { sessionId: "s-1", input: [] }, {
      beforeSubmit: () => { throw error; }, stopped: () => false,
    })).rejects.toBe(error);
    expect(f.writes).toEqual([]);
    await connection.close();
    f.stdout.end();
  });

  it("a command that resolves without writing loses its token; a later write is refused", async () => {
    const f = fixture();
    let method = "", params: Record<string, unknown> = {};
    const connection = { mintCommandId: () => "c-1", command: vi.fn(async (m: string, p: Record<string, unknown>, options: { commandId: string }) => {
      method = m; params = { ...p, commandId: options.commandId }; return {};
    }) } as unknown as Connection;
    await expect(musePromptCommand(connection, f.admissions, "turn/start", { sessionId: "s-1", input: [] }, {
      stopped: () => false,
    })).rejects.toThrow("MUSE_SDK_UNWRITTEN_COMMAND");
    await expect(f.transport.write(JSON.stringify({ method, params }) + "\n")).rejects.toThrow("MUSE_UNADMITTED_WRITE");
    expect(f.writes).toEqual([]);
  });

  it("L12 item 7 synchronous onWrite throw settles command completion", async () => {
    const f = fixture();
    const connection = new Connection({ incoming: f.transport.incoming, write: f.transport.write });
    let settled = false;
    const outcome = musePromptCommand(connection, f.admissions, "turn/start", { sessionId: "s-1", input: [] }, {
      stopped: () => false, onWrite: () => { throw new Error("confirmation listener failed"); },
    }).then(() => "resolved", error => error.message).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.writes).toHaveLength(1));
      const frame = JSON.parse(f.writes[0]!);
      f.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { commandId: frame.params.commandId } }) + "\n");
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(await outcome).toBe("confirmation listener failed");
    } finally { await connection.close(); f.stdout.end(); }
  });

  it("all driver prompt methods use the admitted command helper", () => {
    const source = readFileSync(new URL("./muse-code.ts", import.meta.url), "utf8");
    const methods = [...source.matchAll(/musePromptCommand\(host.connection, host.admissions, "([^"]+)"/g)].map(m => m[1]);
    expect(methods.sort()).toEqual([...MUSE_PROMPT_METHODS].sort());
    expect(source).not.toMatch(/connection\.(?:command|request)\("turn\/(?:start|steer)"/);
  });
});

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

  it("MARKS D3: a turn without a bot folder fails closed and never launches in process.cwd; the --version probe gets a folder", async () => {
    const { instance, spawned, events } = await start({});
    await vi.waitFor(() => expect(instance.models.source).toBe("live"));
    await instance.snapshot();
    const probes = spawned.mock.calls.filter((call) => call[1].includes("--version"));
    expect(probes.length).toBeGreaterThan(0);
    for (const call of probes) { const cwd = call[2]?.cwd; expect(typeof cwd === "string" && isAbsolute(cwd)).toBe(true); }
    spawned.mockClear();
    const outcome = await instance.adapter.sendTurn(turn({ cwd: undefined })).then(() => "sent" as const, (error: unknown) => error);
    if (outcome === "sent") expect(await completedOf(events)).toMatchObject({ ok: false });
    else expect(outcome).toBeInstanceOf(BotFolderUnavailableError);
    expect(spawned.mock.calls.filter((call) => call[1][0] === "serve")).toEqual([]);
    expect(spawned.mock.calls.some((call) => call[2]?.cwd === process.cwd())).toBe(false);
    await instance.dispose();
  });

  it.each(["FAKE_MUSE_VERSION_HANG", "FAKE_MUSE_VERSION_EXIT_WITH_PIPES"])("T12 real %s probe descendants remain owned through disposal", async mode => {
    const { instance, spawned } = await start({ [mode]: "1" });
    await vi.waitFor(() => expect(instance.models.source).toBe("live"));
    const original = procs.awaitCliTreeStopped;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation(async (child, ...args) => {
      if (child.spawnargs.includes("--version")) { entered = true; await barrier; }
      return original(child, ...args);
    });
    const snapshot = instance.snapshot();
    try {
      await vi.waitFor(() => expect(entries().some(entry => typeof entry.descendant === "number")).toBe(true), { timeout: 10_000 });
      const pid = entries().find(entry => typeof entry.descendant === "number")!.descendant!;
      // Windows: the root's `exit` closes the job (KILL_ON_JOB_CLOSE, procs.ts:560-567), so a descendant that held the pipes is already
      // gone when the root has exited; only the hanging root keeps its descendant alive until disposal.
      expect(alive(pid)).toBe(!(process.platform === "win32" && mode === "FAKE_MUSE_VERSION_EXIT_WITH_PIPES"));
      let disposed = false;
      const dispose = instance.dispose().then(() => { disposed = true; });
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(disposed).toBe(false);
      expect(spawned.mock.calls.filter(call => call[1][0] === "--version")).toHaveLength(1);
      release(); await Promise.all([snapshot, dispose]);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
    } finally { release(); await instance.dispose(); await snapshot; }
  }, 30_000);

  it("T08 real root exit begins confirmation before descendant-held pipes close", async () => {
    const { instance, events } = await start({ FAKE_MUSE_DESCENDANT: "1", FAKE_MUSE_ROOT_EXIT: "1" });
    await vi.waitFor(() => expect(instance.models.source).toBe("live"), { timeout: 10_000 });
    const original = procs.awaitCliTreeStopped;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
    const closeJob = jobs.closePipJob;
    const heldJobs = new Set<Parameters<typeof closeJob>[0]>();
    let released = false;
    const release = () => {
      released = true;
      for (const job of heldJobs) closeJob(job);
      heldJobs.clear(); releaseBarrier();
    };
    // Keep the real Windows job handle alive across root exit so its descendants hold the pipes.
    // Releasing the barrier closes that handle normally and still requires real tree confirmation.
    if (process.platform === "win32") vi.spyOn(jobs, "closePipJob").mockImplementation(job => {
      if (released) closeJob(job); else heldJobs.add(job);
    });
    let rootObserved = false, pipesOpen = false, entered = false;
    vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation(async (child, ...args) => {
      if (!child.spawnargs.includes("--no-session-log")) {
        // Windows must exercise the real job route, including its root launcher.
        if (process.platform === "win32") expect(procs.cliContainment(child)).toBe("job");
        rootObserved = child.exitCode === 17; pipesOpen = !child.stdout!.readableEnded; entered = true;
        await barrier;
      }
      return original(child, ...args);
    });
    try {
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      const descendants = entries().filter(entry => typeof entry.descendant === "number").map(entry => entry.descendant!);
      expect(descendants.length).toBeGreaterThan(0);
      if (process.platform === "win32") {
        // The root's `exit` closes the job (KILL_ON_JOB_CLOSE, procs.ts:560-567), so no descendant outlives the root to hold the pipes:
        // the pipes have ended and the descendants are gone by the time confirmation is entered. (CI diagnostic run 42345667514: the closePipJob spy
        // above held no job, held=0, and the real job had already ended the descendants.) The turn must still not complete on the root's exit alone.
        expect(descendants.every(pid => !alive(pid))).toBe(true);
      } else {
        expect(rootObserved).toBe(true); expect(pipesOpen).toBe(true);
        expect(descendants.some(pid => alive(pid))).toBe(true);
      }
      expect(events.filter(event => event.type === "turn.completed")).toHaveLength(0);
      await expect(instance.adapter.sendTurn(turn())).rejects.toThrow();
      release(); await instance.adapter.interruptTurn("t-1");
      await vi.waitFor(() => expect(descendants.every(pid => !alive(pid))).toBe(true), { timeout: 5_000 });
      expect(events.filter(event => event.type === "turn.completed")).toMatchObject([{ ok: false }]);
    } finally { release(); await instance.dispose(); }
  }, 20_000);

  it.each([false, true])("rejects catalog-labelled Contributor session aliases, including Contributor-only catalogs (%s)", async (onlyContributor) => {
    const models = [{ modelId: "muse-x", displayLabel: "Contributor" }, ...(onlyContributor ? [] : [{ modelId: MUSE_DEFAULT_MODEL }])];
    const { instance, events } = await start({ FAKE_MUSE_MODELS: JSON.stringify(models), FAKE_MUSE_SERVED_MODEL: "muse-x", FAKE_MUSE_MODEL_DELAY_MS: "200" });
    await instance.adapter.sendTurn(turn());
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(requests("turn/start")).toHaveLength(0);
    if (onlyContributor) expect(instance.models.options).toEqual([]);
  });

  it("T15 retires an actual unsafe model change before later usage or steering", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "hang", FAKE_MUSE_CHANGED_MODEL: "muse-x", FAKE_MUSE_MODELS: JSON.stringify([{ modelId: MUSE_DEFAULT_MODEL }, { modelId: "muse-x", displayLabel: "Contributor" }]) });
    await instance.adapter.sendTurn(turn());
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(events.some(event => event.type === "thread.token-usage.updated")).toBe(false);
    expect(events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    expect(await instance.adapter.steer!("t-1", "private followup")).toBe("rejected");
    expect(requests("turn/steer")).toHaveLength(0);
  });

  it("waits for catalog classification before accepting a configured alias", async () => {
    const { instance, events } = await start({ FAKE_MUSE_MODEL_DELAY_MS: "300", FAKE_MUSE_MODELS: JSON.stringify([{ modelId: "muse-x", displayLabel: "Contributor" }, { modelId: MUSE_DEFAULT_MODEL }]) }, { model: "muse-x" });
    await instance.adapter.sendTurn(turn());
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(requests("session/start")[0]!.params!.modelId).not.toBe("muse-x");
  });

  it("retains the turn and rejects replacement, reset and disposal when tree shutdown is unconfirmed", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "hang", FAKE_MUSE_INTERRUPT: "refuse" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    const original = procs.awaitCliTreeStopped;
    vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation(async (child, ...args) => {
      await original(child, ...args); // fixture really dies; simulate missing confirmation only
      return false;
    });
    await expect(instance.adapter.interruptTurn("t-1")).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    await expect(instance.adapter.sendTurn(turn())).rejects.toThrow(/still working|MUSE_SHUTDOWN_UNCONFIRMED/);
    await expect(instance.adapter.resetSession!("t-1")).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(instance.dispose()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
  });

  it("does not reuse a host with a pending steer or let its late rejection kill the next turn", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "hang", FAKE_MUSE_LATE_STEER: "1" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    const steer = instance.adapter.steer!("t-1", "finish A");
    await completedOf(events);
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(2));
    await steer;
    expect(turnLaunches()).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    await instance.adapter.stopAll();
  });

  it("runs an Auto turn through the shared launcher at promptUnmatched, with Contributor off, no self-update and no inherited key", async () => {
    vi.stubEnv("META_API_KEY", "planted");
    vi.stubEnv("OPENAI_API_KEY", "planted-openai");
    const { instance, events, spawned } = await start();
    await instance.adapter.sendTurn(turn({ routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({ text: "hello", origin: "engine" });
    expect(spawned.mock.calls.some((call) => call[0] === FAKE && call[1][0] === "serve")).toBe(true);
    const [launch] = turnLaunches();
    expect(launch!.launch).toEqual(["serve", "--disable-write", "--contributor-mode", "off"]);
    expect(launch!.env).toMatchObject({ META_API_KEY: null, OPENAI_API_KEY: null, MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0", MUSE_DISABLE_APPROVAL_JUDGE: "1" });
    expect(requests("session/start")[0]!.params).toMatchObject({ approvalMode: "promptUnmatched", providerId: "meta", workspaceRoot: root });
    await instance.snapshot();
    const version = entries().find((entry) => entry.launch?.[0] === "--version");
    expect(version!.env).toMatchObject({ META_API_KEY: null, MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0" });
    for (const entry of entries().filter((e) => e.launch)) {
      expect(entry.launch).not.toContain("--trust-workspace");
      if (entry.launch![0] === "serve") expect(entry.launch!.join(" ")).toContain("--contributor-mode off");
      expect(entry.env).toMatchObject({ MUSE_NO_AUTO_UPDATE: "1", MUSE_CONTRIBUTOR_MODE: "0", MUSE_DISABLE_APPROVAL_JUDGE: "1" });
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
    expect(turnLaunches()[0]!.launch).toEqual(["serve", "--contributor-mode", "off"]);
    const modes = [...requests("session/start").map((e) => e.params!.approvalMode), ...requests("session/setApprovalMode").map((e) => e.params!.mode)];
    expect(modes).toEqual(["promptUnmatched"]);
    expect(JSON.stringify(entries())).not.toContain("allowAll");
    expect(requests("approval/decide").map((entry) => entry.params!.choiceId)).toEqual(["c-once"]);
  }, 20_000);

  it("runs Ask read-only and refuses a shell ask with no card", async () => {
    const { instance, events } = await start({ FAKE_MUSE_TURN: "approval" });
    await instance.adapter.sendTurn(turn({ askLevel: true, routeAsks: true }));
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(turnLaunches()[0]!.launch).toEqual(["serve", "--disable-shell", "--disable-write", "--contributor-mode", "off"]);
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
    const { instance, events } = await start({ FAKE_MUSE_REFUSE_FLAG: "--disable-write", FAKE_MUSE_REFUSE_SERVE_ONLY: "1" });
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
    expect(slow.instance.models.options.map((option) => option.id)).toEqual(["muse-wonder-1.0", "muse-spark-1.3"]);
    expect(slow.instance.models.default).toBe("muse-spark-1.3");
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

  it("admits the complete prompt once before the fake receives any prompt bytes", async () => {
    const { instance, events } = await start();
    const beforeSubmit = vi.fn(() => expect(requests("turn/start")).toHaveLength(0));
    await instance.adapter.sendTurn(turn({ text: "private body", system: "private system", beforeSubmit }));
    expect(await completedOf(events)).toMatchObject({ ok: true });
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
    expect(requests("turn/start")[0]!.params).toMatchObject({ input: [{ type: "text", text: "private system\n\nprivate body" }] });
  }, 20_000);

  it("a fenced hidden learning turn retains its typed unsent outcome", async () => {
    const { instance } = await start();
    const gate = openLearningGate();
    const error = new MemorySendFenced();
    gate.admit = () => { throw error; };
    const learning = withCliMemoryLearning(instance);
    await expect(learning.extractMemory!("private learning text", 100, new AbortController().signal, { policyRevision: "fixture", messages: [{ role: "user", content: "private learning text" }], fence: gate, cwd: fixtureBotFolder() })).rejects.toBe(error);
    expect(droppedUnsent(error, gate)).toBe(true);
    expect(gate.released).toBe(0);
    expect(requests("turn/start")).toHaveLength(0);
  }, 20_000);

  it("sends no prompt when the submission fence refuses", async () => {
    const { instance, events, spawned } = await start();
    await instance.adapter.sendTurn(turn({ beforeSubmit: () => { throw new MemorySendFenced(); } }));
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(requests("turn/start")).toHaveLength(0);
    expect(events.find(event => event.type === "runtime.error")).toMatchObject({ message: "MEMORY_SEND_FENCED" });
    const at = spawned.mock.calls.findIndex(call => call[1][0] === "serve" && !call[1].includes("--no-session-log"));
    const child = spawned.mock.results[at]!.value as ReturnType<typeof procs.spawnCli>;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 10_000 });
  }, 20_000);

  it("retires a host when the SDK acknowledges a prompt without submitting it", async () => {
    const original = Connection.prototype.command;
    vi.spyOn(Connection.prototype, "command").mockImplementation(function (this: Connection, method, params, options) {
      return method === "turn/start" ? Promise.resolve({}) : original.call(this, method, params, options);
    });
    const { instance, events, spawned } = await start();
    const beforeSubmit = vi.fn();
    await instance.adapter.sendTurn(turn({ beforeSubmit }));
    expect(await completedOf(events)).toMatchObject({ ok: false });
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(requests("turn/start")).toHaveLength(0);
    expect(events.find(event => event.type === "runtime.error")).toMatchObject({ message: "MUSE_SDK_UNWRITTEN_COMMAND" });
    const at = spawned.mock.calls.findIndex(call => call[1][0] === "serve" && !call[1].includes("--no-session-log"));
    const child = spawned.mock.results[at]!.value as ReturnType<typeof procs.spawnCli>;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 10_000 });
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

  // STOP-NONACP: Stop All and a reset before the prompt end as the stopped pair too, as Stop does.
  it.each(["Stop All", "reset"] as const)("%s while the session is still being set up ends as the stopped pair with no prompt written", async (kind) => {
    const { instance, events } = await start({ FAKE_MUSE_HANG_SESSION_START: "1" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("session/start")).toHaveLength(1), { timeout: 10_000 });
    await (kind === "Stop All" ? instance.adapter.stopAll!() : instance.adapter.resetSession!("t-1"));
    expect(await completedOf(events)).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(events.filter((event) => event.type === "turn.started" || event.type === "turn.completed").map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(requests("turn/start")).toHaveLength(0);
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("ends the host and its tree when Stop comes while the session is still being set up", async () => {
    const { instance, events, spawned } = await start({ FAKE_MUSE_HANG_SESSION_START: "1" });
    await instance.adapter.sendTurn(turn());
    await vi.waitFor(() => expect(requests("session/start")).toHaveLength(1), { timeout: 10_000 });
    const bot = spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"));
    const engine = spawned.mock.results[bot]!.value as ReturnType<typeof procs.spawnCli>;
    await instance.adapter.interruptTurn("t-1");
    // NAMED expectation change (MurageMain ruling, STOP-FENCE goal line): a Stop before the prompt ends as the stopped pair, not ok:false "interrupted"
    expect(await completedOf(events)).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(events.filter((event) => event.type === "turn.started" || event.type === "turn.completed").map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    await vi.waitFor(() => expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true), { timeout: 5_000 });
    expect(requests("turn/start")).toHaveLength(0);
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
  }, 20_000);

  describe("Contributor (probe 3: Muse's served default is a Contributor model)", () => {
    it("starts every session on a regular model, never Muse's own default, even when a Contributor model is asked for", async () => {
      const { instance, events } = await start();
      await instance.adapter.sendTurn(turn());
      expect(await completedOf(events)).toMatchObject({ ok: true });
      await instance.adapter.sendTurn(turn({ threadId: "t-2", model: "muse-spark-1.3-contributor" }));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2), { timeout: 10_000 });
      expect(requests("session/start").map((entry) => entry.params!.modelId)).toEqual(["muse-spark-1.3"]);
      expect(requests("turn/start")).toHaveLength(1);
      expect(events.find(event => event.type === "turn.completed" && event.threadId === "t-2")).toMatchObject({ ok: false });
      expect(events.find(event => event.type === "runtime.error" && event.threadId === "t-2")).toMatchObject({ message: MUSE_NO_REGULAR_MODEL_LINE });
      expect(events.find((event) => event.type === "session.started")).toMatchObject({ model: "muse-spark-1.3" });
    }, 20_000);

    it("names the regular model on resume too, and sets it again on the resumed session", async () => {
      const { instance, events } = await start();
      await instance.adapter.sendTurn(turn({ resumeCursor: "s-7" }));
      expect(await completedOf(events)).toMatchObject({ ok: true });
      expect(requests("session/resume")[0]!.params).toMatchObject({ sessionId: "s-7", modelId: "muse-spark-1.3" });
      expect(requests("session/setModel")[0]!.params).toMatchObject({ sessionId: "s-7", model: { modelId: "muse-spark-1.3", providerId: "meta" } });
      expect(requests("turn/start")[0]!.params).toMatchObject({ sessionId: "s-7" });
    }, 20_000);

    it("refuses the turn, before the message goes, when Muse runs the session on a Contributor model anyway", async () => {
      const { instance, events } = await start({ FAKE_MUSE_SERVED_MODEL: "muse-spark-1.3-contributor" });
      await instance.adapter.sendTurn(turn());
      expect(await completedOf(events)).toMatchObject({ ok: false });
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: MUSE_NO_REGULAR_MODEL_LINE });
      expect(requests("turn/start")).toHaveLength(0);
      expect(instance.adapter.hasSession("t-1")).toBe(false);
    }, 20_000);

    it("never starts a configured model the live list labels Contributor", async () => {
      const models = JSON.stringify([{ modelId: "muse-spark-1.3" }, { modelId: "muse-spark-1.2", displayLabel: "Spark (Contributor)" }]);
      const { instance, events } = await start({ FAKE_MUSE_MODELS: models }, { model: "muse-spark-1.2" });
      await vi.waitFor(() => expect(instance.models.source).toBe("live"), { timeout: 10_000 });
      await instance.adapter.sendTurn(turn({ model: "muse-spark-1.2" }));
      expect(await completedOf(events)).toMatchObject({ ok: false });
      expect(requests("session/start").map((entry) => entry.params!.modelId)).toEqual([]);
      expect(requests("session/setModel")).toHaveLength(0);
      expect(requests("turn/start")).toHaveLength(0);
      expect(events.find(event => event.type === "runtime.error")).toMatchObject({ message: MUSE_NO_REGULAR_MODEL_LINE });
    }, 20_000);

    it("refuses the turn when the owner's model switch on a running session is refused", async () => {
      const { instance, events } = await start({ FAKE_MUSE_FAIL_SET_MODEL: "1" });
      await instance.adapter.sendTurn(turn());
      expect(await completedOf(events)).toMatchObject({ ok: true });
      await instance.adapter.sendTurn(turn({ model: "muse-wonder-1.0" }));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2), { timeout: 10_000 });
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: MUSE_NO_REGULAR_MODEL_LINE });
      expect(requests("turn/start")).toHaveLength(1);
    }, 20_000);

    it("refuses a resumed turn whose regular model cannot be set", async () => {
      const { instance, events } = await start({ FAKE_MUSE_FAIL_SET_MODEL: "1" });
      await instance.adapter.sendTurn(turn({ resumeCursor: "s-7" }));
      expect(await completedOf(events)).toMatchObject({ ok: false });
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: MUSE_NO_REGULAR_MODEL_LINE });
      expect(requests("turn/start")).toHaveLength(0);
    }, 20_000);
  });

  describe("a stopped turn's late answers (Builder 6 Mediums)", () => {
    const done = (events: RuntimeEvent[]) => events.filter((event) => event.type === "turn.completed");
    // Turn 1 is stopped while session/start is still out; turn 2 resumes s-9 on its own host and finishes; only then does
    // turn 1's session/start answer (its host is still shutting down); turn 3 follows on the same thread.
    const lateAnswer = async () => {
      const { instance, events, spawned } = await start({ FAKE_MUSE_SESSION_START_DELAY_MS: "1500", FAKE_MUSE_EXIT_DELAY_MS: "2500" });
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(requests("session/start")).toHaveLength(1), { timeout: 10_000 });
      const first = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))]!.value as ReturnType<typeof procs.spawnCli>;
      void instance.adapter.interruptTurn("t-1");
      await vi.waitFor(() => expect(done(events)).toHaveLength(1));
      await instance.adapter.sendTurn(turn({ resumeCursor: "s-9" }));
      await vi.waitFor(() => expect(done(events)).toHaveLength(2), { timeout: 10_000 });
      expect(done(events)[1]).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(first.exitCode !== null || first.signalCode !== null).toBe(true), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(done(events)).toHaveLength(3), { timeout: 10_000 });
      return { events };
    };

    it("never lets a stopped turn's late session/start answer overwrite a newer turn's session", async () => {
      const { events } = await lateAnswer();
      expect(done(events)[2]).toMatchObject({ ok: true });
      expect(requests("turn/start").map((entry) => entry.params!.sessionId)).toEqual(["s-9", "s-9"]);
    }, 30_000);

    it("never closes a newer turn's idle host when a stopped turn's setup finishes late", async () => {
      await lateAnswer();
      expect(turnLaunches()).toHaveLength(2);
    }, 30_000);

    it("sends no prompt when Stop lands in the submission fence, after the last check", async () => {
      const { instance, events } = await start();
      const notWritten = vi.fn();
      await instance.adapter.sendTurn(turn({ beforeSubmit: () => { void instance.adapter.interruptTurn("t-1"); }, notWritten }));
      // NAMED expectation change (MurageMain ruling, STOP-FENCE goal line): a Stop in the submission fence is the stopped pair, not "interrupted"
      expect(await completedOf(events)).toMatchObject({ ok: true, stopReason: "cancelled" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(requests("turn/start")).toHaveLength(0);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(notWritten).toHaveBeenCalledTimes(1);
    }, 20_000);

    it("never lets a stopped reset turn clear or close a newer turn's session while the old host shuts down", async () => {
      const { instance, events } = await start({ FAKE_MUSE_EXIT_DELAY_MS: "1500" });
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(done(events)).toHaveLength(1), { timeout: 10_000 });
      await instance.adapter.sendTurn(turn({ sessionReset: true }));
      void instance.adapter.interruptTurn("t-1");
      await vi.waitFor(() => expect(done(events)).toHaveLength(2));
      await instance.adapter.sendTurn(turn({ resumeCursor: "s-9" }));
      await vi.waitFor(() => expect(done(events)).toHaveLength(3), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(instance.adapter.hasSession("t-1")).toBe(true);
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(done(events)).toHaveLength(4), { timeout: 10_000 });
      expect(requests("turn/start").map((entry) => entry.params!.sessionId)).toEqual(["s-1", "s-9", "s-9"]);
      expect(turnLaunches()).toHaveLength(2);
    }, 30_000);

    it("disposes only once a host still initializing when Stop came has ended", async () => {
      const { instance, spawned } = await start({ FAKE_MUSE_INIT_DELAY_MS: "3000" });
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(spawned.mock.calls.some((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))).toBe(true), { timeout: 10_000 });
      const engine = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))]!.value as ReturnType<typeof procs.spawnCli>;
      void instance.adapter.interruptTurn("t-1");
      await instance.dispose();
      expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true);
    }, 20_000);

    it("disposes only once the host a Stop during setup let go has ended", async () => {
      const { instance, spawned } = await start({ FAKE_MUSE_HANG_SESSION_START: "1", FAKE_MUSE_EXIT_DELAY_MS: "1500" });
      await instance.adapter.sendTurn(turn());
      await vi.waitFor(() => expect(requests("session/start")).toHaveLength(1), { timeout: 10_000 });
      const engine = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))]!.value as ReturnType<typeof procs.spawnCli>;
      void instance.adapter.interruptTurn("t-1");
      await instance.dispose();
      expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true);
    }, 20_000);
  });

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
      await vi.waitFor(() => expect(spawned.mock.calls.some((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))).toBe(true), { timeout: 10_000 });
      const engine = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[1][0] === "serve" && !call[1].includes("--no-session-log"))]!.value as ReturnType<typeof procs.spawnCli>;
      await instance.adapter.interruptTurn("t-early");
      // NAMED expectation change (MurageMain ruling, STOP-FENCE goal line; same pre-prompt path as :882, flagged for confirmation)
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true);
      expect(requests("turn/start")).toHaveLength(0);
    }, 20_000);
  });
});


/** L12: real SDK queue over isolated physical streams. Every barrier is explicitly released. */
describe("L12 retirement and delivery", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  type Frame = { id: number; method: string; params: Record<string, any> };
  const fixture = async (config: Record<string, unknown> = {},
    initialIntercept?: (child: any, frame: Frame, callback: (error?: Error | null) => void) => boolean,
    waitCatalog = true) => {
    const children: Array<any> = [];
    const events: RuntimeEvent[] = [];
    let intercept = initialIntercept;
    let confirmation: ReturnType<typeof deferred<boolean>> | undefined;
    let versionMode = "normal";
    const stopped: any[] = [];
    const notificationHandlers: Array<Parameters<Connection["onNotification"]>[0]> = [];
    const deliveredNotifications: string[] = [];
    const originalNotification = Connection.prototype.onNotification;
    vi.spyOn(Connection.prototype, "onNotification").mockImplementation(function (this: Connection, handler) {
      notificationHandlers.push(handler);
      return originalNotification.call(this, notification => {
        handler(notification); deliveredNotifications.push(notification.method);
      });
    });
    const spawn = vi.spyOn(procs, "spawnCli").mockImplementation((_cli, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as any,
        pid: 10000 + children.length, exitCode: null as number | null, signalCode: null,
        frames: [] as Frame[], args, rootExited: false,
        send(...frames: unknown[]) { this.stdout.write(frames.map(f => JSON.stringify({ jsonrpc: "2.0", ...(f as object) }) + "\n").join("")); },
        ack(frame: Frame, result = {}) { this.send({ id: frame.id, result: { commandId: frame.params?.commandId, ...result } }); },
        exit(this: any) { this.rootExited = true; this.exitCode = 0; this.emit("exit", 0, null); },
        end(this: any) { if (!this.rootExited) this.exit(); this.stdout.end(); this.stderr.end(); this.emit("close", 0, null); },
      });
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const frame: Frame = JSON.parse(String(chunk)); child.frames.push(frame);
        if (intercept?.(child, frame, callback)) return;
        callback();
        if (frame.id === undefined) return;
        if (frame.method === "initialize") child.ack(frame, { grantedCapabilities: ["sessionMcp"] });
        else if (frame.method === "model/list") child.ack(frame, { models: [{ modelId: MUSE_DEFAULT_MODEL }, { modelId: "muse-wonder-1.0" }] });
        else if (frame.method === "session/start") child.ack(frame, { session: { sessionId: "s-1", modelId: frame.params.modelId } });
        else child.ack(frame);
      } });
      children.push(child);
      if (args[0] === "--version" && versionMode !== "hang") queueMicrotask(() => { if (versionMode !== "empty") child.stdout.write("muse 1.4.14\n"); if (versionMode === "exit") child.exit(); else child.end(); });
      return child as unknown as ReturnType<typeof procs.spawnCli>;
    });
    vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation(async child => {
      stopped.push(child);
      if (confirmation && !await confirmation.promise) return false;
      (child as any).end(); return true;
    });
    const instance = await MuseCodeDriver.create({ instanceId: "l12", displayName: "L12", enabled: true,
      environment: {}, config: MuseCodeDriver.decodeConfig({ cli: "isolated-stream-fixture", ...config }) });
    instance.adapter.onEvent(event => events.push(event));
    if (waitCatalog) await vi.waitFor(() => expect(instance.models.source).toBe("live"));
    const send = (extra = {}) => instance.adapter.sendTurn({ threadId: "l12", text: "PRIVATE-L12", stopLine: true, cwd: fixtureBotFolder(), ...extra });
    const host = () => children.find(c => c.args[0] === "serve" && !c.args.includes("--no-session-log"));
    const started = async () => { await send(); await vi.waitFor(() => expect(host()?.frames.some((f: Frame) => f.method === "turn/start")).toBe(true)); return host(); };
    return { instance, children, events, stopped, spawn, send, host, started, deliveredNotifications,
      intercept(fn: typeof intercept) { intercept = fn; },
      version(mode: string) { versionMode = mode; },
      holdDeath() { confirmation = deferred<boolean>(); return confirmation; },
      notification(child: any, params: Record<string, unknown>) {
        const index = children.filter(c => c.args[0] === "serve").indexOf(child);
        notificationHandlers[index]!({ jsonrpc: "2.0", method: "session/modelChanged", params });
      },
      changedNow(child: any, modelId: unknown = "unknown") {
        const index = children.filter(c => c.args[0] === "serve").indexOf(child);
        notificationHandlers[index]!({ jsonrpc: "2.0", method: "session/modelChanged", params: { sessionId: "s-1", modelId } });
      },
      changed(child: any, modelId: unknown = "unknown") { child.send({ method: "session/modelChanged", params: { sessionId: "s-1", modelId } }); },
    };
  };
  afterEach(() => vi.restoreAllMocks());

  it("T08 root exit enters cleanup while descendant pipes remain open", async () => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath();
    child.exit();
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(child.stdout.readableEnded).toBe(false);
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow();
    let settled = false; const stop = f.instance.adapter.interruptTurn("l12").then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    death.resolve(true); await stop;
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    await f.instance.dispose();
  });

  it("T11 command rejection precedes protocol handler and retains owner", async () => {
    const f = await fixture(); const death = f.holdDeath();
    const handlerRelease = deferred<void>();
    let handlerEntered = false, handlerReturned = false;
    const register = Connection.prototype.onProtocolError;
    vi.spyOn(Connection.prototype, "onProtocolError").mockImplementation(function (this: Connection, handler) {
      return register.call(this, async error => {
        handlerEntered = true;
        await handlerRelease.promise;
        handler(error); handlerReturned = true;
      });
    });
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/start") return false;
      // This matched, invalid response independently rejects the caller and invokes the handler.
      callback(); child.send({ id: frame.id, result: {}, error: { code: -32600, message: "invalid" } }); return true;
    });
    await f.send();
    await vi.waitFor(() => expect(handlerEntered).toBe(true));
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    expect(handlerReturned).toBe(false);
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow();
    handlerRelease.resolve();
    await vi.waitFor(() => expect(handlerReturned).toBe(true));
    f.host().stdout.write("malformed\n");
    const start = f.host().frames.find((frame: Frame) => frame.method === "turn/start");
    f.host().send({ method: "turn/completed", params: { sessionId: "s-1", turnId: start.params.commandId, terminal: "completed" } });
    const stop = f.instance.adapter.interruptTurn("l12"); death.resolve(true); await stop;
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(f.stopped.filter(c => c === f.host())).toHaveLength(1);
    await f.instance.dispose();
  });

  it("T15 passive unsafe notification suppresses later events in the same chunk", async () => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath();
    const frame = child.frames.find((frame: Frame) => frame.method === "turn/start");
    child.send(
      { method: "session/modelChanged", params: { sessionId: "s-1", modelId: "unknown" } },
      { method: "session/tokenUsage", params: { sessionId: "s-1", usage: { inputTokens: 987 } } },
      { method: "item/completed", params: { sessionId: "s-1", item: { itemId: "late", turnId: frame.params.commandId, kind: "toolCall", status: "completed", tool: "write_file" } } },
      { method: "turn/completed", params: { sessionId: "s-1", turnId: frame.params.commandId, terminal: "completed" } },
    );
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(f.events.some(e => e.type === "thread.token-usage.updated" || e.type === "item.completed" || e.type === "turn.completed")).toBe(false);
    death.resolve(true); await f.instance.adapter.interruptTurn("l12");
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    await f.instance.dispose();
  });

  it.each(["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"])("L12 item 1 error receipt retains uncertainty after %s", async code => {
    const f = await fixture(); await f.started(); const death = f.holdDeath();
    let release!: (error?: Error | null) => void;
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/steer") return false;
      release = callback;
      child.send({ id: frame.id, error: { code: -32000, message: "refused", data: { kind: "commandRejected" } } });
      return true;
    });
    const outcome = f.instance.adapter.steer!("l12", "PRIVATE-STEER");
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    release(Object.assign(new Error("late callback"), { code }));
    death.resolve(true);
    expect(await outcome).toBe("uncertain");
    await f.instance.dispose();
  });

  it("L12 item 7 early terminal replay listener throw settles and cleans the host", async () => {
    const f = await fixture(); let release!: (error?: Error | null) => void;
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/start") return false;
      release = callback; child.ack(frame);
      child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: frame.params.commandId, terminal: "completed" } });
      question(child); return true;
    });
    const finished = vi.fn();
    f.instance.adapter.onEvent(event => {
      if (event.type === "turn.completed") { finished(); throw new Error("early terminal listener failed"); }
    });
    await f.send();
    // The question follows the terminal in the same chunk, proving the terminal is held.
    await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    expect(finished).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    expect(finished).toHaveBeenCalledTimes(1);
    await f.instance.dispose();
  });

  it("T16 EPIPE after possible steer delivery stays uncertain", async () => {
    const f = await fixture(); const child = await f.started();
    f.intercept((_child, frame, callback) => {
      if (frame.method !== "turn/steer") return false;
      callback(Object.assign(new Error("pipe failed"), { code: "EPIPE" })); return true;
    });
    expect(await f.instance.adapter.steer!("l12", "PRIVATE-STEER")).toBe("uncertain");
    expect(child.frames.filter((f: Frame) => f.method === "turn/steer")).toHaveLength(1);
    await f.instance.dispose();
  });

  it.each(["unknown", "muse-spark-1.3-contributor"].flatMap(modelId => [true, false].map(before => ({ modelId, before }))))("T02/T03 switch ack and $modelId change (before=$before) never restore requested truth", async ({ modelId, before }) => {
    for (const resume of [false, true]) {
      const f = await fixture();
      if (!resume) {
        const child = await f.started();
        const turn = child.frames.find((frame: Frame) => frame.method === "turn/start");
        child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: turn.params.commandId, terminal: "completed" } });
        await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1));
      }
      f.intercept((child, frame, callback) => {
        if (frame.method !== "session/setModel") return false;
        callback();
        const ack = { id: frame.id, result: { commandId: frame.params.commandId } };
        const change = { method: "session/modelChanged", params: { sessionId: "s-1", modelId } };
        child.send(...(before ? [change, ack] : [ack, change]));
        return true;
      });
      await f.send(resume ? { resumeCursor: "s-1" } : { model: "muse-wonder-1.0" });
      await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(resume ? 1 : 2));
      expect(f.host().frames.filter((frame: Frame) => frame.method === "turn/start")).toHaveLength(resume ? 0 : 1);
      expect(f.events.filter(e => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
      await f.instance.dispose(); vi.restoreAllMocks();
    }
  });

  it.each([null, "unknown", "muse-spark-1.3-contributor"])("T14 session response and unsafe setup observation %s share a chunk", async modelId => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback(); child.send({ id: frame.id, result: { session: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } } },
        { method: "session/modelChanged", params: { sessionId: "s-1", modelId } }); return true;
    });
    await f.send();
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host().frames.some((frame: Frame) => frame.method === "turn/start")).toBe(false);
    await f.instance.dispose();
  });

  it.each(["unknown", "muse-spark-1.3-contributor"])("L12 item 3 unsafe then regular setup observation refuses resume (%s)", async modelId => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "initialize") return false;
      callback();
      child.send(
        { method: "session/modelChanged", params: { sessionId: "s-1", modelId } },
        { method: "session/modelChanged", params: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } },
      );
      child.ack(frame, { grantedCapabilities: ["sessionMcp"] }); return true;
    });
    await f.send({ resumeCursor: "s-1", integrations: { memory: { command: "PRIVATE-MCP", args: [], env: {} } } });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host().frames.some((frame: Frame) => ["session/resume", "session/start", "turn/start"].includes(frame.method))).toBe(false);
    expect(JSON.stringify(f.host().frames)).not.toContain("modelId");
    expect(JSON.stringify(f.host().frames)).not.toContain("PRIVATE-MCP");
    expect(JSON.stringify(f.host().frames)).not.toContain("mcpServers");
    await f.instance.dispose();
  });

  it("L12 item 8 T04 setup and answer await catalog authority for a picker alias", async () => {
    let release!: () => void;
    const f = await fixture({ model: "private-picker-alias" }, (child, frame, callback) => {
      if (frame.method !== "model/list") return false;
      callback(); release = () => child.ack(frame, { models: [{ modelId: MUSE_DEFAULT_MODEL }] }); return true;
    }, false);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.send({ model: "private-picker-alias" });
    expect(await f.instance.adapter.respondToRequest("l12", "pending", { behavior: "answer", message: "PRIVATE-PENDING-ANSWER" })).toBe("unavailable");
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    expect(f.host()).toBeUndefined();
    expect(JSON.stringify(f.children.flatMap(child => child.frames))).not.toContain("PRIVATE-PENDING-ANSWER");
    release();
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host()).toBeUndefined();
    await f.instance.dispose();
  });

  it("T04 explicit unknown selection never sends session content", async () => {
    const f = await fixture(); await f.send({ model: "private-alias" });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host()).toBeUndefined(); await f.instance.dispose();
  });

  const question = (child: any) => {
    const turn = child.frames.find((frame: Frame) => frame.method === "turn/start");
    child.send({ method: "userInput/requested", params: { sessionId: "s-1", turnId: turn.params.commandId,
      userInputId: "q-l12", questions: [{ id: "q", question: "Private?", options: [{ label: "yes" }] }] } });
  };

  it.each([
    [{ modelId: MUSE_DEFAULT_MODEL, isContributor: true }], [], [{ modelId: "unknown" }], null,
  ].map(models => ({ models })))("T05 refresh rows %j revoke questions and never revive their answers", async ({ models }) => {
    const f = await fixture(); const child = await f.started(); question(child);
    await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    let release!: () => void;
    f.intercept((catalog, frame, callback) => {
      if (frame.method !== "model/list") return false;
      callback(); release = () => catalog.ack(frame, { models }); return true;
    });
    const queuedAnswer = f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-QUEUED-ANSWER" });
    const queuedSteer = f.instance.adapter.steer!("l12", "PRIVATE-QUEUED-STEER");
    const refresh = f.instance.refreshModels!();
    expect(await f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-ANSWER" })).toBe("unavailable");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await queuedAnswer).toBe("unavailable");
    expect(await queuedSteer).toBe("rejected");
    expect(await f.instance.adapter.steer!("l12", "PRIVATE-DURING-REFRESH")).toBe("rejected");
    expect(child.frames.some((frame: Frame) => ["turn/steer", "userInput/answer"].includes(frame.method))).toBe(false);
    release(); await refresh;
    expect(await f.instance.adapter.steer!("l12", "PRIVATE-AFTER-REFRESH")).toBe("rejected");
    expect(child.frames.some((frame: Frame) => frame.method === "turn/steer")).toBe(false);
    expect(await f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-ANSWER" })).toBe("unavailable");
    expect(child.frames.some((frame: Frame) => frame.method === "userInput/answer")).toBe(false);
    expect(f.events.filter(e => e.type === "request.resolved")).toHaveLength(1);
    await f.instance.dispose();
  });

  it("L12 item 2 throwing resolution listener cannot skip captured host cleanup", async () => {
    const f = await fixture(); const child = await f.started(); question(child);
    await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    f.instance.adapter.onEvent(event => { if (event.type === "request.resolved") throw new Error("listener failed"); });
    const death = f.holdDeath(); f.changedNow(child);
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow();
    const stop = f.instance.adapter.interruptTurn("l12");
    death.resolve(true); await stop; await f.instance.dispose();
    expect(f.stopped.filter(c => c === child)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
  });

  it.each(["unknown", "muse-spark-1.3-contributor", "protocol"])("L12 item 8 listener failure retains ownership on unconfirmed %s retirement", async cause => {
    const f = await fixture(); const child = await f.started(); question(child);
    await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    f.instance.adapter.onEvent(event => { if (event.type === "request.resolved") throw new Error("resolution listener failed"); });
    const death = f.holdDeath();
    if (cause === "protocol") child.stdout.write("malformed\n"); else f.changedNow(child, cause);
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(await f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-ANSWER" })).toBe("unavailable");
    await expect(f.send()).rejects.toThrow();
    const outcomes = Promise.allSettled([
      f.instance.adapter.interruptTurn("l12"), f.instance.adapter.resetSession!("l12"), f.instance.dispose(),
    ]);
    death.resolve(false);
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason.message).toBe("MUSE_SHUTDOWN_UNCONFIRMED");
    }
    expect(f.stopped.filter(c => c === child)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    expect(f.events.filter(e => e.type === "request.resolved")).toHaveLength(1);
    expect(child.frames.some((frame: Frame) => ["userInput/answer", "userInput/cancel", "turn/interrupt"].includes(frame.method))).toBe(false);
  });

  it("T09 a fatal thread retains its owner while another thread works", async () => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath(); f.changed(child);
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    await expect(f.send()).rejects.toThrow();
    await f.send({ threadId: "independent" });
    await vi.waitFor(() => expect(f.children.filter(c => c.frames.some((frame: Frame) => frame.method === "turn/start"))).toHaveLength(2));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    death.resolve(true); await f.instance.dispose();
  });

  it.each(["unknown", "muse-spark-1.3-contributor"])("L12 item 9 T10 question arriving after %s cannot open", async modelId => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath();
    f.changedNow(child, modelId);
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    question(child);
    await vi.waitFor(() => expect(f.deliveredNotifications).toContain("userInput/requested"));
    expect(f.events.some(e => e.type === "request.opened")).toBe(false);
    expect(await f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-LATE-ANSWER" })).toBe("unavailable");
    expect(child.frames.some((frame: Frame) => ["userInput/answer", "userInput/cancel"].includes(frame.method))).toBe(false);
    death.resolve(true); await f.instance.adapter.interruptTurn("l12"); await f.instance.dispose();
  });

  it.each(["answer", "deny"])("T07/T10 queued %s is revoked by unsafe change and Stop", async behavior => {
    const f = await fixture(); const child = await f.started(); question(child);
    await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    // The SDK queues this command; feed the registered notification handler before its write microtask.
    const answer = f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: behavior as "answer" | "deny", message: "PRIVATE-ANSWER" });
    f.changedNow(child); const stop = f.instance.adapter.interruptTurn("l12");
    expect(await answer).toBe("unavailable"); await stop;
    expect(f.events.filter(e => e.type === "request.resolved")).toHaveLength(1);
    expect(child.frames.some((frame: Frame) => ["userInput/answer", "userInput/cancel", "turn/interrupt"].includes(frame.method))).toBe(false);
    await f.instance.dispose();
  });

  it("T06 delayed old switch continuation cannot authorize a new host", async () => {
    const f = await fixture(); const releaseAck = deferred<void>(); let ackHeld = false;
    const command = Connection.prototype.command;
    vi.spyOn(Connection.prototype, "command").mockImplementation(async function (this: Connection, method, params, options) {
      const result = await command.call(this, method, params, options);
      if (method === "session/setModel") { ackHeld = true; await releaseAck.promise; }
      return result;
    });
    await f.send({ resumeCursor: "s-1" }); await vi.waitFor(() => expect(ackHeld).toBe(true));
    f.changedNow(f.host());
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1));
    f.intercept((child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback(); child.send({ method: "session/modelChanged", params: { sessionId: "s-1", modelId: "unknown" } },
        { id: frame.id, result: { session: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } } }); return true;
    });
    await f.send(); await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(2));
    releaseAck.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.children.flatMap(c => c.frames).some((frame: Frame) => frame.method === "turn/start")).toBe(false);
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(2); await f.instance.dispose();
  });

  it("T12 concurrent snapshots share a registered version child", async () => {
    const f = await fixture(); const death = f.holdDeath();
    const one = f.instance.snapshot(), two = f.instance.snapshot();
    await vi.waitFor(() => expect(f.children.filter(c => c.args[0] === "--version")).toHaveLength(1));
    let published = false; void one.then(() => { published = true; });
    await Promise.resolve(); expect(published).toBe(false);
    const dispose = f.instance.dispose(); death.resolve(true);
    await Promise.all([one, two, dispose]);
    expect(f.stopped.filter(c => c.args[0] === "--version")).toHaveLength(1);
  });

  it("T17 false-confirmed catalog cleanup blocks new turn hosts", async () => {
    const f = await fixture(); const death = f.holdDeath();
    const refresh = f.instance.refreshModels!();
    const failure = expect(refresh).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED"); death.resolve(false); await failure;
    await expect(f.send()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED"); expect(f.host()).toBeUndefined();
    await expect(f.instance.dispose()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    for (const child of f.children) child.end();
  });

  it("T16 successful steer write with a failed acknowledgment stays uncertain", async () => {
    const f = await fixture(); await f.started();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/steer") return false;
      callback(); child.send({ id: frame.id, error: { code: -32000, message: "failed", data: { kind: "invalidState" } } }); return true;
    });
    expect(await f.instance.adapter.steer!("l12", "PRIVATE-STEER")).toBe("uncertain");
    await f.instance.dispose();
  });

  it("T16 early completion waits for held start callback", async () => {
    const f = await fixture(); let release!: (error?: Error | null) => void;
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/start") return false;
      release = callback; child.ack(frame);
      child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: frame.params.commandId, terminal: "completed" } }); return true;
    });
    await f.send(); await vi.waitFor(() => expect(release).toBeDefined());
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow(); release();
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: true }]));
    await f.instance.dispose();
  });

  it.each([undefined, "EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"])("T16 held callback after Stop (%s) cannot authorize interrupt", async code => {
    const f = await fixture(); let release!: (error?: Error | null) => void; const notWritten = vi.fn();
    f.intercept((_child, frame, callback) => { if (frame.method !== "turn/start") return false; release = callback; return true; });
    await f.send({ notWritten }); await vi.waitFor(() => expect(release).toBeDefined());
    const child = f.host(); const death = f.holdDeath(); const stop = f.instance.adapter.interruptTurn("l12");
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    release(code ? Object.assign(new Error(code), { code }) : undefined);
    death.resolve(true); await stop;
    expect(child.frames.some((frame: Frame) => frame.method === "turn/interrupt")).toBe(false);
    expect(notWritten).toHaveBeenCalledTimes(code?.startsWith("ERR_STREAM") ? 1 : 0);
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1);
    await f.instance.dispose();
  });


  it.each(["exit", "protocol"])("T08/T11 false confirmation after %s keeps all shutdown callers failed", async mode => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath();
    if (mode === "exit") child.exit(); else child.stdout.write("not-json\n");
    await vi.waitFor(() => expect(f.stopped).toContain(child)); death.resolve(false);
    await expect(f.instance.adapter.interruptTurn("l12")).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(f.instance.adapter.resetSession!("l12")).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(f.instance.adapter.stopAll()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(f.instance.dispose()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(f.send()).rejects.toThrow();
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0); child.end();
  });

  it.each(["json", "unknown-id", "handler"])("T11 active protocol failure %s enters shared retirement", async mode => {
    const f = await fixture(); const child = await f.started(); const death = f.holdDeath();
    if (mode === "json") child.stdout.write("bad-json\n");
    else if (mode === "unknown-id") child.send({ id: 987654, result: {} });
    else {
      f.instance.adapter.onEvent(event => { if (event.type === "thread.token-usage.updated") throw new Error("PRIVATE-NOTIFICATION"); });
      child.send({ method: "session/tokenUsage", params: { sessionId: "s-1", usage: { inputTokens: 3 } } });
    }
    await vi.waitFor(() => expect(f.stopped).toContain(child));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow();
    const stop = f.instance.adapter.interruptTurn("l12"); death.resolve(true); await stop;
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE-NOTIFICATION"); await f.instance.dispose();
  });

  it.each(["hang", "exit"])("T12 dispose owns a %s version child and waits for descendant confirmation", async mode => {
    const f = await fixture(); f.version(mode); const death = f.holdDeath();
    const snapshot = f.instance.snapshot();
    await vi.waitFor(() => expect(f.children.some(c => c.args[0] === "--version")).toBe(true));
    let finished = false; const dispose = f.instance.dispose().then(() => { finished = true; });
    await vi.waitFor(() => expect(f.stopped.some(c => c.args[0] === "--version")).toBe(true));
    expect(finished).toBe(false); death.resolve(true); await Promise.all([dispose, snapshot]);
    expect(f.stopped.filter(c => c.args[0] === "--version")).toHaveLength(1);
  });

  it("T12/T17 failed version cleanup is not cached or cleared by another snapshot", async () => {
    const f = await fixture(); const death = f.holdDeath();
    const snapshot = f.instance.snapshot(); const result = expect(snapshot).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    death.resolve(false); await result;
    await expect(f.send()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    await expect(f.instance.snapshot()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    expect(f.children.filter(c => c.args[0] === "--version")).toHaveLength(1);
    await expect(f.instance.dispose()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    for (const child of f.children) child.end();
  });

  it.each(["missing-session", "overflow"])("T14 unsafe unbound setup %s cannot authorize a prompt", async mode => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback();
      const frames = mode === "missing-session" ? [{ method: "session/modelChanged", params: { modelId: MUSE_DEFAULT_MODEL } }]
        : Array.from({ length: 129 }, (_, i) => ({ method: "session/modelChanged", params: { sessionId: `s-${i}`, modelId: MUSE_DEFAULT_MODEL } }));
      child.send(...frames, { id: frame.id, result: { session: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } } }); return true;
    });
    await f.send(); await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host().frames.some((frame: Frame) => frame.method === "turn/start")).toBe(false); await f.instance.dispose();
  });


  it("T04 configured picker alias absent from live rows is never membership", async () => {
    const f = await fixture({ model: "custom-picker-alias" });
    expect(f.instance.models.options.some(row => row.id === "custom-picker-alias")).toBe(true);
    await f.send({ model: "custom-picker-alias" });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host()).toBeUndefined(); await f.instance.dispose();
  });

  it("T02/T14 repeated regular observation before ack defeats a requested overwrite", async () => {
    const f = await fixture(); const child = await f.started();
    const complete = () => {
      const turns = child.frames.filter((frame: Frame) => frame.method === "turn/start");
      child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: turns.at(-1).params.commandId, terminal: "completed" } });
    };
    complete(); await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1));
    f.intercept((host, frame, callback) => {
      if (frame.method !== "session/setModel") return false;
      callback(); host.send(
        { method: "session/modelChanged", params: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } },
        { method: "session/modelChanged", params: { sessionId: "s-1", modelId: MUSE_DEFAULT_MODEL } },
        { method: "session/modelChanged", params: { sessionId: "other-session", modelId: "unknown" } },
        { id: frame.id, result: { commandId: frame.params.commandId } },
      ); return true;
    });
    await f.send({ model: "muse-wonder-1.0" });
    await vi.waitFor(() => expect(child.frames.filter((frame: Frame) => frame.method === "turn/start")).toHaveLength(2));
    complete(); await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(2));
    await f.send({ model: MUSE_DEFAULT_MODEL });
    await vi.waitFor(() => expect(child.frames.filter((frame: Frame) => frame.method === "turn/start")).toHaveLength(3));
    expect(child.frames.filter((frame: Frame) => frame.method === "session/setModel")).toHaveLength(1);
    await f.instance.dispose();
  });

  it("T16 early items and questions correlate while callback is held; failure revokes queued answer", async () => {
    const f = await fixture(); let release!: (error?: Error | null) => void;
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/start") return false;
      release = callback; child.ack(frame);
      child.send({ method: "item/started", params: { sessionId: "s-1", item: { itemId: "early", turnId: frame.params.commandId, kind: "toolCall", status: "inProgress", tool: "read_file" } } });
      question(child); return true;
    });
    await f.send(); await vi.waitFor(() => expect(f.events.some(e => e.type === "request.opened")).toBe(true));
    expect(f.events.some(e => e.type === "item.started")).toBe(true);
    const answer = f.instance.adapter.respondToRequest("l12", "q-l12", { behavior: "answer", message: "PRIVATE-QUEUED" });
    const death = f.holdDeath(); release(Object.assign(new Error("pipe"), { code: "EPIPE" }));
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    death.resolve(true); await f.instance.adapter.interruptTurn("l12"); await answer;
    expect(f.host().frames.some((frame: Frame) => frame.method === "userInput/answer")).toBe(false);
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    await f.instance.dispose();
  });


  it("T12 timeout publishes unavailable only after registered probe cleanup", async () => {
    const f = await fixture(); f.version("hang"); const death = f.holdDeath();
    vi.useFakeTimers();
    try {
      let published = false;
      const snapshot = f.instance.snapshot().then(result => { published = true; return result; });
      await Promise.resolve(); await Promise.resolve();
      expect(f.children.filter(c => c.args[0] === "--version")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(f.stopped.some(c => c.args[0] === "--version")).toBe(true); expect(published).toBe(false);
      death.resolve(true); expect(await snapshot).toMatchObject({ state: "unavailable" });
      await f.instance.dispose();
    } finally { vi.useRealTimers(); }
  });

  it.each(["spawn", "empty", "hang"])("L12 item 4 retries a confirmed null probe after %s", async mode => {
    const f = await fixture(); const spawn = f.spawn.getMockImplementation()!;
    if (mode === "spawn") f.spawn.mockImplementation(() => { throw new Error("no child"); });
    else f.version(mode);
    vi.useFakeTimers();
    try {
      const before = f.spawn.mock.calls.length;
      const first = Promise.all([f.instance.snapshot(), f.instance.snapshot()]);
      await vi.advanceTimersByTimeAsync(mode === "hang" ? 15_001 : 0);
      expect((await first).map(s => s.state)).toEqual(["unavailable", "unavailable"]);
      expect(f.spawn.mock.calls).toHaveLength(before + 1);
      f.spawn.mockImplementation(spawn); f.version("normal");
      const next = Promise.all([f.instance.snapshot(), f.instance.snapshot()]);
      await vi.advanceTimersByTimeAsync(0);
      expect((await next).map(s => s.version)).toEqual(["1.4.14", "1.4.14"]);
      expect(f.spawn.mock.calls).toHaveLength(before + 2);
      await f.instance.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("T12 concurrent no-child spawn errors share one attempt", async () => {
    const f = await fixture(); const before = f.spawn.mock.calls.length;
    f.spawn.mockImplementation(() => { throw new Error("no child created"); });
    const results = await Promise.all([f.instance.snapshot(), f.instance.snapshot()]);
    expect(results.map(result => result.state)).toEqual(["unavailable", "unavailable"]);
    expect(f.spawn.mock.calls).toHaveLength(before + 1); await f.instance.dispose();
  });

  it("T11 idle protocol failure retains a tombstone until cleanup", async () => {
    const f = await fixture(); const child = await f.started();
    const turn = child.frames.find((frame: Frame) => frame.method === "turn/start");
    child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: turn.params.commandId, terminal: "completed" } });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1));
    const death = f.holdDeath(); child.send({ id: 987654, result: {} });
    await vi.waitFor(() => expect(f.stopped).toContain(child)); await expect(f.send()).rejects.toThrow();
    death.resolve(true); await f.instance.dispose();
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1);
  });

  it.each(["json", "unknown-id", "handler"])("T11 setup protocol failure %s retires before completion", async mode => {
    const f = await fixture(); const death = f.holdDeath();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback();
      if (mode === "json") child.stdout.write("bad-json\n");
      else if (mode === "unknown-id") child.send({ id: 987654, result: {} });
      else {
        const params = { get sessionId() { throw new Error("PRIVATE-HANDLER"); } };
        // Invoke the installed handler with a throwing notification payload during setup.
        f.notification(child, params);
      }
      return true;
    });
    await f.send(); await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    await expect(f.send()).rejects.toThrow();
    const stop = f.instance.adapter.interruptTurn("l12"); death.resolve(true); await stop;
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE-HANDLER"); await f.instance.dispose();
  });

  it("T17 auxiliary failure after turn entry blocks replacement spawn", async () => {
    const f = await fixture(); const old = await f.started();
    const start = old.frames.find((frame: Frame) => frame.method === "turn/start");
    old.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: start.params.commandId, terminal: "completed" } });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(1));
    const replacementBarrier = deferred<boolean>();
    vi.mocked(procs.awaitCliTreeStopped).mockImplementation(async child => {
      if (child === old) { await replacementBarrier.promise; old.end(); return true; }
      return false;
    });
    await f.send({ sessionReset: true });
    await vi.waitFor(() => expect(vi.mocked(procs.awaitCliTreeStopped).mock.calls.some(([child]) => child === old)).toBe(true));
    await expect(f.instance.snapshot()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    replacementBarrier.resolve(true);
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(2));
    expect(f.children.filter(c => c.args[0] === "serve" && !c.args.includes("--no-session-log"))).toHaveLength(1);
    await expect(f.instance.dispose()).rejects.toThrow("MUSE_SHUTDOWN_UNCONFIRMED");
    for (const child of f.children) child.end();
  });

  it("T05 malformed refresh rows cannot authorize a new session", async () => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "model/list") return false;
      callback(); child.ack(frame, { models: [{ modelId: MUSE_DEFAULT_MODEL }, { modelId: 17 }] }); return true;
    });
    await f.instance.refreshModels!(); await f.send();
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]));
    expect(f.host()).toBeUndefined(); await f.instance.dispose();
  });

  it("T12/T17 disposal waits for every cleanup even when another host fails", async () => {
    const f = await fixture(); const first = await f.started();
    await f.send({ threadId: "second" });
    await vi.waitFor(() => expect(f.children.filter(c => c.frames.some((frame: Frame) => frame.method === "turn/start"))).toHaveLength(2));
    const barrier = deferred<boolean>(); const failure = deferred<void>();
    vi.mocked(procs.awaitCliTreeStopped).mockImplementation(async child => {
      if (child === first) { await barrier.promise; first.end(); return true; }
      failure.resolve(); return false;
    });
    let settled = false;
    const dispose = f.instance.dispose().then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await failure.promise;
      // Drain the finite promise chain from false confirmation through disposal.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled).toBe(false);
    } finally { barrier.resolve(true); }
    expect(await dispose).toMatchObject({ message: "MUSE_SHUTDOWN_UNCONFIRMED" });
    for (const child of f.children) child.end();
  });

  it.each(["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"])("T16 early receipt contradicts %s zero-byte accounting", async code => {
    const f = await fixture(); let release!: (error?: Error | null) => void; const notWritten = vi.fn();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/start") return false;
      release = callback;
      child.send({ method: "item/started", params: { sessionId: "s-1", item: { itemId: "received", turnId: frame.params.commandId, kind: "toolCall", status: "inProgress", tool: "read_file" } } });
      return true;
    });
    await f.send({ notWritten });
    await vi.waitFor(() => expect(f.events.some(e => e.type === "item.started")).toBe(true));
    const death = f.holdDeath(); release(Object.assign(new Error(code), { code }));
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    try {
      expect(notWritten).not.toHaveBeenCalled();
      expect(f.events.filter(e => e.type === "turn.completed")).toHaveLength(0);
    } finally { death.resolve(true); await f.instance.adapter.interruptTurn("l12"); }
    expect(f.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    await f.instance.dispose();
  });

});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
