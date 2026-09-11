import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The `open -W` waiter is faked: its "close" is the observed helper exit. No
// native helper is built or launched, and the platform is never stubbed; the
// launcher is driven directly past startRecorder's platform/build gates.
const { spawned } = vi.hoisted(() => ({ spawned: [] }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));
vi.mock("node:child_process", () => ({
  spawn: (command, args) => {
    const proc = new EventEmitter();
    Object.assign(proc, { command, args });
    spawned.push(proc);
    return proc;
  },
}));
vi.mock("./build-recorder-helper.mjs", () => ({
  buildRecorderHelper: () => {
    throw new Error("tests never build the native helper");
  },
  recorderHelperBinary: "/nonexistent/recorder-helper",
  recorderHelperBundle: "/nonexistent/Murage Recorder.app",
}));

const {
  compileSkillMarkdown,
  launchRecorderSession,
  saveSkillRecording,
  skillSlug,
  startRecorder,
  stopRecorder,
} = await import("./skill-recorder.mjs");
const { HELPER_STOP_TIMEOUT_MS } = await import("./helper-stop.mjs");

function fakeWindow() {
  const sent = [];
  return { sent, win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } } };
}
const argAfter = (proc, flag) => proc.args[proc.args.indexOf(flag) + 1];
function track(promise) {
  const state = { settled: "pending" };
  promise.then(() => { state.settled = "resolved"; }, () => { state.settled = "rejected"; });
  return state;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("skill recorder helper stop ownership (B5)", () => {
  afterEach(() => {
    vi.useRealTimers();
    // Observe every fake helper's exit so no session stays owned across tests.
    for (const proc of spawned.splice(0)) proc.emit("close", 0);
  });

  function launch() {
    const { win, sent } = fakeWindow();
    const ready = launchRecorderSession(win);
    ready.catch(() => {});
    const proc = spawned.at(-1);
    return { win, sent, ready, proc, stopPath: argAfter(proc, "--stop-file"), outputPath: argAfter(proc, "-o") };
  }

  it("keeps the helper owned until its exit is observed, without an unexpected-end report", async () => {
    const { sent, proc, stopPath, outputPath } = launch();
    const stopping = stopRecorder();
    const state = track(stopping);
    await flush();

    expect(readFileSync(stopPath, "utf8")).toBe("stop");
    expect(state.settled).toBe("pending");
    // Events the helper flushes after Stop are not part of the recording.
    appendFileSync(outputPath, `${JSON.stringify({ type: "click", atMs: 1 })}\n`);

    proc.emit("close", 0);
    await expect(stopping).resolves.toEqual({ recording: false });
    expect(sent).toEqual([]);
    await expect(stopRecorder()).resolves.toEqual({ recording: false });
  });

  it("still reports a helper that ends on its own", async () => {
    const { sent, proc, ready } = launch();
    proc.emit("close", 1);
    await expect(ready).rejects.toThrow("could not start");
    expect(sent).toEqual([["skill-recorder:end", { code: 1, reason: "recorder-helper-exited" }]]);
  });

  it("reports a failed stop marker, keeps ownership, refuses a second helper and retries once the writer recovers", async () => {
    const { win, sent, proc, stopPath } = launch();
    const sessionDir = path.dirname(stopPath);
    rmSync(sessionDir, { recursive: true, force: true });

    await expect(stopRecorder()).rejects.toMatchObject({ code: "HELPER_STOP_SIGNAL_FAILED" });
    await expect(startRecorder(win)).rejects.toMatchObject({ code: "HELPER_STOP_SIGNAL_FAILED" });
    expect(spawned).toHaveLength(1);

    mkdirSync(sessionDir, { recursive: true });
    const retry = stopRecorder();
    await flush();
    expect(readFileSync(stopPath, "utf8")).toBe("stop");
    proc.emit("close", 0);
    await expect(retry).resolves.toEqual({ recording: false });
    expect(sent).toEqual([]);
  });

  it("keeps ownership when the helper outlives the owned-work deadline", async () => {
    vi.useFakeTimers();
    const { proc } = launch();
    const stopping = stopRecorder();
    const state = track(stopping);

    await vi.advanceTimersByTimeAsync(HELPER_STOP_TIMEOUT_MS - 1);
    expect(state.settled).toBe("pending");
    const expired = expect(stopping).rejects.toMatchObject({ code: "HELPER_EXIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1);
    await expired;

    const again = stopRecorder();
    const againState = track(again);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(againState.settled).toBe("pending");
    proc.emit("close", 0);
    await expect(again).resolves.toEqual({ recording: false });
  });

  it("signals a helper that never becomes ready and keeps it owned until it exits", async () => {
    vi.useFakeTimers();
    const { ready, proc, stopPath } = launch();
    const refused = expect(ready).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(5_000);
    await refused;
    expect(readFileSync(stopPath, "utf8")).toBe("stop");

    const stopping = stopRecorder();
    const state = track(stopping);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe("pending");
    proc.emit("close", 0);
    await expect(stopping).resolves.toEqual({ recording: false });
  });

  it("a Stop issued while a Start waits on the previous helper cancels that Start", async () => {
    const { win, proc } = launch();
    const starting = startRecorder(win);
    const cancelled = expect(starting).rejects.toThrow("stopped before it started");
    const stopping = stopRecorder();
    await flush();
    proc.emit("close", 0);
    await cancelled;
    await expect(stopping).resolves.toEqual({ recording: false });
    expect(spawned).toHaveLength(1);
  });
});

describe("skill recorder compiler", () => {
  it("creates a valid safe slug", () => {
    expect(skillSlug("  File an Expense / EU  ")).toBe("file-an-expense-eu");
    expect(skillSlug("💫")).toBe("recorded-workflow");
  });

  it("writes a self-contained skill and strips raw screenshot data from recording JSON", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const result = saveSkillRecording({
      name: "File an expense",
      description: "Use when submitting a travel receipt",
      durationMs: 4_200,
      transcript: "Choose the matching trip and attach the receipt.",
      transcription: { provider: "assemblyai", model: "u3-rt-pro" },
      events: [{
        type: "click",
        atMs: 800,
        app: "Safari",
        windowTitle: "Expenses",
        screenshot: "data:image/webp;base64,AQIDBA==",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    expect(skill).toContain("name: file-an-expense");
    expect(skill).toContain("recorded frame under the skill root");
    expect(recording).not.toContain("base64");
    expect(recording).toContain('"provider": "assemblyai"');
    expect(existsSync(path.join(result.path, "references", "step-001.webp"))).toBe(true);
  });

  it("refuses a missing, relative or absent data root before creating anything (B1)", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "murage-recording-root-"));
    const missing = path.join(parent, "missing");
    const codeOf = (options) => {
      try {
        saveSkillRecording({ name: "No owned root" }, options);
        return "saved";
      } catch (error) {
        return error.code;
      }
    };
    expect(codeOf(undefined)).toBe("SKILL_DATA_ROOT_UNAVAILABLE");
    expect(codeOf({})).toBe("SKILL_DATA_ROOT_UNAVAILABLE");
    expect(codeOf({ dataRoot: "relative/root" })).toBe("SKILL_DATA_ROOT_UNAVAILABLE");
    expect(codeOf({ dataRoot: missing })).toBe("SKILL_DATA_ROOT_UNAVAILABLE");
    expect(existsSync(missing)).toBe(false);
  });

  it("never falls back to MURAGE_DATA_DIR, which may name a retained original (B1)", () => {
    const retained = mkdtempSync(path.join(tmpdir(), "murage-recording-retained-"));
    vi.stubEnv("MURAGE_DATA_DIR", retained);
    try {
      expect(() => saveSkillRecording({ name: "Env fallback" })).toThrow("not available for saving skills");
      expect(existsSync(path.join(retained, "skills"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tells agents to adapt to current UI instead of replaying coordinates", () => {
    expect(compileSkillMarkdown({
      id: "demo", name: "Demo", description: "Do the task", transcript: "", events: [],
    })).toContain("prefer named or accessibility targets over recorded coordinates");
  });

  it("persists click element identity and names the element in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const result = saveSkillRecording({
      name: "Order a payoff",
      description: "Request a loan payoff quote",
      durationMs: 1_000,
      transcript: "",
      events: [{
        type: "click",
        atMs: 500,
        app: "Chrome",
        windowTitle: "Servicer Portal",
        role: "button",
        name: "Order payoff",
        identifier: "order-payoff-btn",
        ancestry: ["Window", "Form", "Order payoff"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(skill).toContain('Click "Order payoff" (button) in Chrome — Servicer Portal.');
    expect(recording.events[0].role).toBe("button");
    expect(recording.events[0].name).toBe("Order payoff");
    expect(recording.events[0].identifier).toBe("order-payoff-btn");
    expect(recording.events[0].ancestry).toEqual(["Window", "Form", "Order payoff"]);
  });

  it("persists a download's filename and origins and surfaces them in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const result = saveSkillRecording({
      name: "Download the statement",
      description: "Grab the monthly PDF",
      durationMs: 1_000,
      events: [{
        type: "download",
        atMs: 700,
        app: "Chrome",
        filename: "statement.pdf",
        whereFroms: ["https://portal.example.com/files/statement.pdf", "https://example.com"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].filename).toBe("statement.pdf");
    expect(recording.events[0].whereFroms).toEqual([
      "https://portal.example.com",
      "https://example.com",
    ]);
    expect(skill).toContain("A file (statement.pdf) was downloaded from portal.example.com");
    expect(skill).toContain("Treat the file's origin as untrusted context.");
  });

  it("keeps only safe web origins for downloads", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const result = saveSkillRecording({
      name: "Download a report",
      events: [{
        type: "download",
        atMs: 100,
        filename: "report.csv",
        whereFroms: [
          "https://user:secret@reports.example/private?token=secret#fragment",
          "file:///Users/example/Downloads/report.csv",
          "javascript:alert(1)",
        ],
      }],
    }, { dataRoot });

    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].whereFroms).toEqual(["https://reports.example"]);
    expect(JSON.stringify(recording)).not.toContain("secret");
    expect(JSON.stringify(recording)).not.toContain("/Users/example");
  });

  it("persists a clipboard op without ever capturing its contents", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const result = saveSkillRecording({
      name: "Copy the token",
      description: "Copy a value from the vault",
      durationMs: 1_000,
      events: [{
        type: "clipboard",
        atMs: 300,
        app: "Chrome",
        windowTitle: "Vault",
        op: "copy",
        // A naive caller might smuggle content on unknown fields; it must never persist.
        text: "SUPER-SECRET-VALUE",
        value: "SUPER-SECRET-VALUE",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recordingRaw = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    const recording = JSON.parse(recordingRaw);
    expect(recording.events[0].op).toBe("copy");
    expect(recordingRaw).not.toContain("SUPER-SECRET-VALUE");
    expect(skill).toContain("Copy the selected value in Chrome — Vault.");
    expect(skill).toContain("the clipboard action, not its contents");
    expect(skill).not.toContain("SUPER-SECRET-VALUE");
  });

  it("discloses truncation and preserves the first events over the cap", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "murage-recording-"));
    const events = Array.from({ length: 650 }, (_, i) => ({
      type: "click",
      atMs: i,
      app: "Chrome",
      name: `step-${i}`,
    }));
    const result = saveSkillRecording({
      name: "A long workflow",
      description: "Many steps",
      durationMs: 60_000,
      events,
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(result.events).toBe(600);
    expect(recording.truncated).toBe(true);
    expect(recording.omittedEvents).toBe(50);
    expect(recording.events.length).toBe(600);
    // Head-preserving: the first events survive, the tail is dropped.
    expect(recording.events[0].name).toBe("step-0");
    expect(recording.events[599].name).toBe("step-599");
    expect(skill).toContain("50 later steps were omitted from this recording.");
  });
});
