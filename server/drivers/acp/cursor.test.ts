import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../../config.ts";
import { engineJob, spawnCli, type execCli } from "../../procs.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { OWN_READS } from "../../../shared/own-servers.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import {
  classifyCursorError,
  createCursorAgentDriver,
  CursorAgentDriver,
  CURSOR_HOST_COMPUTER_ALLOW,
  cursorOwnReadAllow,
  cursorSupport,
  decodeCursorAuthStatus,
  decodeCursorAuthText,
  decodeCursorModelCatalog,
  decodeCursorModelText,
  probeCursorAuth,
  STATIC_CURSOR_MODELS,
  resolveCursorAcpModelId,
  fetchCursorModels,
  cursorCatalogFromSession,
  probeCursorSessionModels,
  linkCursorSessions,
  removeCursorSessionsLink,
} from "./cursor.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("decodeCursorAuthStatus", () => {
  it("reads isAuthenticated from live CLI JSON", () => {
    expect(decodeCursorAuthStatus({ isAuthenticated: true })).toBe(true);
    expect(decodeCursorAuthStatus({ isAuthenticated: false })).toBe(false);
  });

  it("accepts sibling field names without inventing a yes from a missing flag", () => {
    expect(decodeCursorAuthStatus({ authenticated: true })).toBe(true);
    expect(decodeCursorAuthStatus({ loggedIn: false })).toBe(false);
    expect(decodeCursorAuthStatus({ auth: { isAuthenticated: true } })).toBe(true);
    expect(decodeCursorAuthStatus({ email: "user@example.com" })).toBeNull();
    expect(decodeCursorAuthStatus("logged in")).toBeNull();
  });
});

describe("probeCursorAuth", () => {
  type Run = typeof execCli;
  /** One answer per call, in order. */
  const answering = (...answers: Array<[Error | null, string, string]>): Run => {
    let call = 0;
    return ((_cli: string, _args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      done(...answers[Math.min(call++, answers.length - 1)]!);
    }) as unknown as Run;
  };
  const failed = new Error("Command failed");

  it("is unknown, not signed out, when no status answers", async () => {
    await expect(probeCursorAuth("cursor-agent", {}, answering([failed, "", ""]))).resolves.toBeUndefined();
    await expect(probeCursorAuth("cursor-agent", {}, answering([null, "", ""]))).resolves.toBeUndefined();
    await expect(probeCursorAuth("cursor-agent", {}, answering([null, "Cursor Agent CLI", ""]))).resolves.toBeUndefined();
  });

  it("still reads a real signed out, even from a status that exited non-zero", async () => {
    await expect(probeCursorAuth("cursor-agent", {}, answering([null, '{"isAuthenticated":false}', ""]))).resolves.toBe(false);
    await expect(probeCursorAuth("cursor-agent", {}, answering([failed, "Not logged in", ""]))).resolves.toBe(false);
    await expect(probeCursorAuth("cursor-agent", {}, answering([failed, "", "Not logged in"]))).resolves.toBe(false);
  });

  it("believes signed in only from a status that finished", async () => {
    await expect(probeCursorAuth("cursor-agent", {}, answering([null, '{"isAuthenticated":true}', ""]))).resolves.toBe(true);
    await expect(probeCursorAuth("cursor-agent", {}, answering([failed, "logged in", ""]))).resolves.toBeUndefined();
    await expect(probeCursorAuth("cursor-agent", {}, answering([failed, "", ""], [null, "Logged in", ""]))).resolves.toBe(true);
  });
});

describe("decodeCursorAuthText", () => {
  it("recognizes the documented status output without confusing logged-out text", () => {
    expect(decodeCursorAuthText("✓ Login successful! Logged in")).toBe(true);
    expect(decodeCursorAuthText("Not logged in")).toBe(false);
    expect(decodeCursorAuthText("Cursor Agent CLI")).toBeNull();
  });
});

describe("decodeCursorModelCatalog", () => {
  it("merges live ids onto the static cloud set", () => {
    const catalog = decodeCursorModelCatalog({
      default: "composer-2.5",
      models: [
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "cursor-live", displayName: "Cursor Live" },
        { id: "bad id" },
        "gpt-5.3-codex",
      ],
    });
    expect(catalog?.default).toBe("composer-2.5");
    expect(catalog?.options.slice(0, STATIC_CURSOR_MODELS.options.length)).toEqual(STATIC_CURSOR_MODELS.options);
    expect(catalog?.options).toContainEqual({ id: "cursor-live", label: "Cursor Live" });
    expect(catalog?.options.some((option) => option.id === "bad id")).toBe(false);
  });

  it("reads { data: [...] } and a bare array", () => {
    expect(decodeCursorModelCatalog({ data: [{ id: "extra-one", label: "Extra One" }] })?.options).toContainEqual({
      id: "extra-one",
      label: "Extra One",
    });
    expect(decodeCursorModelCatalog(["composer-2.5", "brand-new"])?.options).toContainEqual({
      id: "brand-new",
      label: "Brand New",
    });
  });

  it("returns null for an unusable payload so the static fallback can win", () => {
    expect(decodeCursorModelCatalog(null)).toBeNull();
    expect(decodeCursorModelCatalog({ models: [] })).toBeNull();
    expect(decodeCursorModelCatalog({ hello: "world" })).toBeNull();
  });
});

describe("decodeCursorModelText", () => {
  it("parses slug-label lines and (default)/(current) markers", () => {
    const catalog = decodeCursorModelText(`
Available models

auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
cursor-text - Cursor Text
`);
    expect(catalog?.default).toBe("auto");
    expect(catalog?.options).toContainEqual({ id: "cursor-text", label: "Cursor Text" });
    expect(catalog?.options).toContainEqual({ id: "composer-2.5", label: "Composer 2.5" });
  });

  it("falls back to the first parsed id when static default is absent", () => {
    const catalog = decodeCursorModelText("cursor-only - Cursor Only");
    expect(catalog?.default).toBe("cursor-only");
  });
});

describe("classifyCursorError", () => {
  it("maps auth and subscription failures onto provider codes", () => {
    expect(classifyCursorError({ code: -32000, message: "Authentication required" })).toBe("invalid_credentials");
    expect(classifyCursorError(new Error("not logged in"))).toBe("invalid_credentials");
    expect(classifyCursorError(new Error("upgrade your subscription"))).toBe("inactive_subscription");
    expect(classifyCursorError(new Error("model not found"))).toBeUndefined();
  });
});

describe("CursorAgentDriver", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_AUTH;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.XAI_API_KEY;
    for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
  });

  it("defaults to the unambiguous cursor-agent binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.driverKind).toBe("cursorAgent");
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });

  it("refreshes the catalog from `cursor-agent models` on the instance CLI", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const driver = createCursorAgentDriver();
    const instance = await driver.create({
      instanceId: "cursor-catalog",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "cursor-live")).toBe(true);
      expect(instance.models.default).toBe("auto");
    } finally {
      await instance.dispose();
    }
  });

  it("treats CURSOR_API_KEY as signed in without asking the CLI", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-key",
      displayName: "Cursor",
      environment: { CURSOR_API_KEY: "key-from-env" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("reads isAuthenticated from `cursor-agent status --format json`", async () => {
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_AUTH = "0";
    const loggedOut = await CursorAgentDriver.create({
      instanceId: "cursor-status-out",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await loggedOut.snapshot()).authenticated).toBe(false);
    } finally {
      await loggedOut.dispose();
    }

    delete process.env.FAKE_ACP_AUTH;
    const loggedIn = await CursorAgentDriver.create({
      instanceId: "cursor-status-in",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await loggedIn.snapshot()).authenticated).toBe(true);
    } finally {
      await loggedIn.dispose();
    }
  });

  it("a status check that crashes leaves the login unverified, never signed in", async () => {
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_AUTH = "crash";
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-status-crash",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const snapshot = await instance.snapshot();
      expect(snapshot).not.toHaveProperty("authenticated");
      expect(snapshot.authUnverified).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_AUTH;
      await instance.dispose();
    }
  });

  it("spawns `agent [--force] [--model …] acp` and keeps Cursor credentials", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "murage-cursor-"));
    scratchDirs.push(scratch);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.CURSOR_API_KEY = "cursor-should-keep";
    process.env.XAI_API_KEY = "xai-should-not-leak";

    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-argv",
      displayName: "Cursor",
      environment: { CURSOR_API_KEY: "cursor-should-keep" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor", text: "hi", model: "gpt-5.3-codex" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(["--force", "--model", "gpt-5.3-codex", "acp"]);
      expect(seen.env.CURSOR_API_KEY).toBe(fixtureCredentialFingerprint("cursor-should-keep"));
      expect(seen.env.XAI_API_KEY).toBeUndefined();

      const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      expect(applied).toEqual([
        { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "gpt-5.3-codex" } },
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("omits --force when fullAuto is off and still completes a turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "murage-cursor-safe-"));
    scratchDirs.push(scratch);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-safe",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-cursor-safe", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["acp"]);
      expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "cursorAgent")).toBe(true);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("keeps going when session/set_model is missing and argv already pinned the model", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_MODE = "no-session-config";
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-old",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor-old", text: "hi", model: "gpt-5.3-codex" });
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
      delete process.env.FAKE_ACP_MODE;
    }
  });
});

describe("resolveCursorAcpModelId", () => {
  // Real payload shape from `session/new` against cursor-agent 2026.08.11.
  const ADVERTISED = [
    { modelId: "default[]", name: "Auto" },
    { modelId: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
    { modelId: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "gpt-5.3-codex" },
  ];

  it("maps the argv slug `auto` onto Cursor's `default[]` entry", () => {
    // The bug: `auto` is what --model and `cursor-agent models` call it, and
    // it earns -32602 over ACP because the session only knows `default[]`.
    expect(resolveCursorAcpModelId(ADVERTISED, "auto")).toBe("default[]");
  });

  it("maps a bare slug onto its parameterised id", () => {
    expect(resolveCursorAcpModelId(ADVERTISED, "gpt-5.3-codex")).toBe(
      "gpt-5.3-codex[reasoning=medium,fast=false]",
    );
  });

  it("maps a display name onto its parameterised id", () => {
    expect(
      resolveCursorAcpModelId(
        [{ modelId: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" }],
        "Codex 5.3",
      ),
    ).toBe("gpt-5.3-codex[reasoning=medium,fast=false]");
  });

  it("passes an already-parameterised id straight through", () => {
    expect(resolveCursorAcpModelId(ADVERTISED, "grok-4.6[effort=high,fast=true]")).toBe(
      "grok-4.6[effort=high,fast=true]",
    );
  });

  describe("when one base is advertised with and without fast", () => {
    const FAST_FIRST = [
      { modelId: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
      { modelId: "composer-2.5[fast=false]", name: "Composer 2.5" },
    ];

    it("resolves the plain slug to the non-fast variant even when fast is listed first", () => {
      expect(resolveCursorAcpModelId(FAST_FIRST, "composer-2.5")).toBe("composer-2.5[fast=false]");
    });

    it("resolves the plain slug to the non-fast variant when it is listed first", () => {
      expect(resolveCursorAcpModelId([...FAST_FIRST].reverse(), "composer-2.5")).toBe(
        "composer-2.5[fast=false]",
      );
    });

    it("resolves the `-fast` slug to the fast=true variant", () => {
      expect(resolveCursorAcpModelId(FAST_FIRST, "composer-2.5-fast")).toBe("composer-2.5[fast=true]");
    });

    it("falls back to the only advertised variant for the plain slug", () => {
      expect(resolveCursorAcpModelId([FAST_FIRST[0]], "composer-2.5")).toBe("composer-2.5[fast=true]");
    });

    it("does not map a `-fast` slug onto a non-fast variant", () => {
      expect(resolveCursorAcpModelId([FAST_FIRST[1]], "composer-2.5-fast")).toBeNull();
    });
  });

  it("returns null when the agent advertised no models, so the caller keeps the argv slug", () => {
    expect(resolveCursorAcpModelId([], "auto")).toBeNull();
  });

  it("returns null for a model this session does not offer", () => {
    expect(resolveCursorAcpModelId(ADVERTISED, "no-such-model")).toBeNull();
  });
});

describe("cursor ACP model namespace (NS: set_model wiring)", () => {
  it("sends the session's parameterised id, not the argv slug", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "murage-cursor-acpid-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    // What cursor-agent 2026.08.11 really advertises: `auto` is `default[]`.
    process.env.FAKE_ACP_SESSION_MODELS = "default[]|Auto,gpt-5.3-codex[reasoning=medium,fast=false]|gpt-5.3-codex";

    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-acpid",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor-acpid", text: "hi", model: "auto" });
      await recorder.until((e) => e.type === "turn.completed");
      const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      // Before the fix this sent modelId "auto" and Cursor answered -32602.
      expect(applied).toEqual([
        { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "default[]" } },
      ]);
      // argv keeps the CLI slug — the two namespaces stay separate.
      expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["--model", "auto", "acp"]);
    } finally {
      recorder.stop();
      await instance.dispose();
      delete process.env.FAKE_ACP_SESSION_MODELS;
      // the dir goes with it: a stale FAKE_ACP_DUMP makes the *next* test's
      // fake CLI die on ENOENT, which reads as an unrelated driver failure.
      delete process.env.FAKE_ACP_DUMP;
      await removeTempDir(scratch);
    }
  });

  it("completes the turn when set_model answers -32602, because argv already pinned the model", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_MODE = "set-model-invalid-params";
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-invalid",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor-invalid", text: "hi", model: "gpt-5.3-codex" });
      const done = await recorder.until((e) => e.type === "turn.completed");
      // Previously this threw and failed a turn that would have run correctly.
      expect(done).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
      delete process.env.FAKE_ACP_MODE;
    }
  });
});

describe("cursor model source", () => {
  it("a failed or timed-out list is static, so nothing is rewritten from it", async () => {
    const failing = ((_cli: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error("timeout"), "")) as never;
    expect((await fetchCursorModels("cursor-agent", {}, failing)).source).toBe("static");
    const ok = ((_cli: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, "auto - Auto\ngpt-5 - GPT 5\n")) as never;
    expect((await fetchCursorModels("cursor-agent", {}, ok)).source).toBe("live");
  });
});

describe("F31: the Cursor picker lists every model the ACP session offers (upstream 80012e69d)", () => {
  const textOnlyAuto = ((_cli: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
    cb(null, "auto - Auto\n")) as never;

  it("maps parameterised session ids to plain slugs and keeps a built-in entry only when the session offers it", () => {
    const catalog = cursorCatalogFromSession([
      { modelId: "default[]", name: "Auto" },
      { modelId: "composer-2.5[fast=false]", name: "Composer 2.5" },
      { modelId: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      { modelId: "gpt-5.3-codex[reasoning=high,fast=false]", name: "Codex 5.3 High" },
      { modelId: "grok-4.7[]", name: "grok-4.7" },
      { modelId: "opus-5.5-thinking[]", name: "Opus 5.5 Thinking" },
    ]);
    expect(catalog?.default).toBe("auto");
    const ids = catalog!.options.map((option) => option.id);
    expect(ids).toEqual(["auto", "composer-2.5", "gpt-5.3-codex", "grok-4.7", "opus-5.5-thinking"]);
    // A built-in entry the session does not offer is not listed.
    expect(ids).not.toContain("claude-sonnet-5-thinking-high");
    expect(catalog!.options.find((option) => option.id === "opus-5.5-thinking")?.label).toBe("Opus 5.5 Thinking");
    expect(cursorCatalogFromSession([])).toBeNull();
    expect(cursorCatalogFromSession([{ name: "no id" }])).toBeNull();
  });

  it("the session list wins over `cursor-agent models`, which prints only auto on current CLIs", async () => {
    const catalog = await fetchCursorModels("cursor-agent", {}, textOnlyAuto, async () => [
      { modelId: "default[]" },
      { modelId: "grok-4.7[]" },
      { modelId: "gpt-6-sol[reasoning=medium]" },
    ]);
    expect(catalog.source).toBe("live");
    expect(catalog.options.map((option) => option.id)).toEqual(["auto", "grok-4.7", "gpt-6-sol"]);
  });

  it("falls back to the text list, then the built-in list, when no session opens", async () => {
    const empty = await fetchCursorModels("cursor-agent", {}, textOnlyAuto, async () => []);
    expect(empty.source).toBe("live");
    expect(empty.options.map((option) => option.id)).toEqual(STATIC_CURSOR_MODELS.options.map((option) => option.id));
    const failing = ((_cli: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error("x"), "")) as never;
    const rejected = await fetchCursorModels("cursor-agent", {}, failing, async () => {
      throw new Error("spawn failed");
    });
    expect(rejected.source).toBe("static");
  });

  it("reads session/new from a real ACP process and stops it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const models = await probeCursorSessionModels(FAKE_CLI, { ...process.env, FAKE_ACP_SESSION_MODELS: "default[]|Auto,grok-4.7[]|Grok 4.7" });
    expect(models.map((model) => model.modelId)).toEqual(["default[]", "grok-4.7[]"]);
    expect(await probeCursorSessionModels(FAKE_CLI, { ...process.env })).toEqual([]);
    expect(await probeCursorSessionModels(join(tmpdir(), "no-such-cursor-agent"), { ...process.env })).toEqual([]);
  });

  it("runs the probe under the same engine job a Cursor turn gets, so the stop reaches every process it started", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const jobs: unknown[] = [];
    const recording = ((cli: string, args: string[], opts: never, job?: unknown) => {
      jobs.push(job);
      return spawnCli(cli, args, opts, job as never);
    }) as typeof spawnCli;
    const models = await probeCursorSessionModels(FAKE_CLI, { ...process.env, FAKE_ACP_SESSION_MODELS: "grok-4.7[]|Grok 4.7" }, 8_000, recording);
    expect(models.map((model) => model.modelId)).toEqual(["grok-4.7[]"]);
    expect(jobs).toHaveLength(1);
    const expected = engineJob() as { name?: string; hostPower?: boolean } | undefined;
    const got = jobs[0] as { name?: string; hostPower?: boolean } | undefined;
    expect(got).toBeDefined();
    expect(got?.hostPower).toBe(expected?.hostPower);
    if (process.platform === "win32") expect(got?.name).toMatch(/murage-pip-eng-/);
  });

  it("bounds a stalled initialize and closes its child before falling back", async () => {
    chmodSync(FAKE_CLI, 0o755);
    let closed: Promise<void> | undefined;
    const recording: typeof spawnCli = (cli, args, opts, job) => {
      const child = spawnCli(cli, args, opts, job);
      closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      return child;
    };
    const models = await probeCursorSessionModels(FAKE_CLI, {
      ...process.env,
      FAKE_ACP_INIT_DELAY_MS: "60000",
      FAKE_ACP_SESSION_MODELS: "grok-4.7[]|Grok 4.7",
    }, 100, recording);
    expect(models).toEqual([]);
    expect(closed).toBeDefined();
    await closed;
  });
});

describe("host-computer turns run Murage's computer tools unasked by the engine (Murage asks per action)", () => {
  const cleanup: string[] = [];
  afterEach(async () => { while (cleanup.length) await removeTempDir(cleanup.pop()!); });
  const realConfig = () => { const d = mkdtempSync(join(tmpdir(), "cursor-real-cfg-")); cleanup.push(d); return d; };
  const turn = (integrations: Record<string, unknown>, botId = "bot-1") =>
    ({ text: "x", integrations, warmIdentity: { botId, audience: "owner" } }) as unknown as SendTurnInput;
  const host = { command: "node", args: [], env: {}, scope: "local-computer" };
  const argsOf = (t: SendTurnInput, env: Record<string, string | undefined>) =>
    cursorSupport(async () => "" as never).spawnArgs({ fullAuto: false } as never, t, { env });

  it("declares that Murage asks for the host computer", () => {
    expect(cursorSupport(async () => "" as never).hostComputerAskedByMurage).toBe(true);
  });

  it("points a host-computer child at a Murage-owned config dir that allows only the computer server", () => {
    const real = realConfig();
    const env: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    expect(argsOf(turn({ localComputer: host }), env)).toEqual(["acp"]);
    const dir = env.CURSOR_CONFIG_DIR!;
    expect(dir).toBe(join(DATA_DIR, "native", "cursor-host-config", "bot-1"));
    const cfg = JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf8"));
    expect(cfg.permissions).toEqual({ allow: [CURSOR_HOST_COMPUTER_ALLOW], deny: [] });
    expect(CURSOR_HOST_COMPUTER_ALLOW).toBe("Mcp(computer:*)");
    expect(cfg.approvalMode).toBe("allowlist");
    // sessions stay where the owner's CLI keeps them; nothing else of the owner's folder is touched or copied
    expect(lstatSync(join(dir, "acp-sessions")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "acp-sessions"))).toBe(join(real, "acp-sessions"));
    expect(existsSync(join(real, "cli-config.json"))).toBe(false);
  });

  it("is idempotent and keeps what the CLI wrote to its own config", () => {
    const real = realConfig();
    const first: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    argsOf(turn({ localComputer: host }), first);
    const file = join(first.CURSOR_CONFIG_DIR!, "cli-config.json");
    const written = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...written, model: { modelId: "m" } }));
    const second: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    argsOf(turn({ localComputer: host }), second);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.model).toEqual({ modelId: "m" });
    expect(after.permissions.allow).toEqual([CURSOR_HOST_COMPUTER_ALLOW]);
  });

  it("never pre-allows a VM or cloud computer, a host-less turn, or a local computer that is not the host desktop", () => {
    for (const integrations of [
      { computer: { boxId: "b", token: "t" } },
      { localComputer: { command: "node", args: [], env: {} } },
      {},
    ]) {
      const env: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: "/owner/cfg" };
      argsOf(turn(integrations), env);
      expect(env.CURSOR_CONFIG_DIR).toBe("/owner/cfg");
    }
  });
});

describe("Murage's own reads run unasked by cursor on every turn (real-engine gate: list_bots held the turn)", () => {
  // Real cursor-agent 2026.10.19 (Linux gate, rc 20db986c7): Murage's own read asks as
  // session/request_permission {title: "agents-list_bots: list_bots", kind: "other"}, no stamp,
  // which is unproven (Rule 9), so it was held at every level and step 2 hung on the card.
  const cleanup: string[] = [];
  afterEach(async () => { while (cleanup.length) await removeTempDir(cleanup.pop()!); });
  const realConfig = () => { const d = mkdtempSync(join(tmpdir(), "cursor-real-cfg-")); cleanup.push(d); return d; };
  const turn = (integrations: Record<string, unknown>, botId = "bot-r") =>
    ({ text: "x", integrations, warmIdentity: { botId, audience: "owner" } }) as unknown as SendTurnInput;
  const own = { agents: { command: "node", args: [], env: {} }, memory: { command: "node", args: [], env: {} } };
  const argsOf = (t: SendTurnInput, env: Record<string, string | undefined>) =>
    cursorSupport(async () => "" as never).spawnArgs({ fullAuto: false } as never, t, { env });
  const reads = (mount: string) => OWN_READS.find((row) => row.mount === mount)!.tools;

  it("allows exactly the own reads of the mounts the turn hands, by server and tool", () => {
    const allow = cursorOwnReadAllow(turn(own));
    expect(allow).toEqual([
      ...reads("own:agents").map((tool) => `Mcp(agents:${tool})`),
      ...reads("own:memory").map((tool) => `Mcp(murage-memory:${tool})`),
    ]);
    expect(allow).toContain("Mcp(agents:list_bots)");
    expect(allow).toContain("Mcp(murage-memory:memory_search)");
    // a tool that acts keeps cursor's own ask (and Murage's card)
    for (const acts of ["ask_bot", "delegate_bot", "publish_site", "create_bot", "memory_save"]) {
      expect(allow.some((entry) => entry.endsWith(`:${acts})`))).toBe(false);
    }
    expect(allow.some((entry) => entry.includes("*"))).toBe(false);
  });

  it("names the agents server the turn mounts (a proposal turn's own name)", () => {
    expect(cursorOwnReadAllow(turn({ agents: { ...own.agents, serverName: "chief_proposal" } }))).toContain("Mcp(chief_proposal:list_bots)");
    expect(cursorOwnReadAllow(turn({}))).toEqual([]);
  });

  it("an ordinary turn with Murage's own servers runs on a Murage-owned config that allows their reads", () => {
    const real = realConfig();
    const env: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    expect(argsOf(turn(own), env)).toEqual(["acp"]);
    expect(env.CURSOR_CONFIG_DIR).toBe(join(DATA_DIR, "native", "cursor-host-config", "bot-r"));
    const cfg = JSON.parse(readFileSync(join(env.CURSOR_CONFIG_DIR!, "cli-config.json"), "utf8"));
    expect(cfg.approvalMode).toBe("allowlist");
    expect(cfg.permissions).toEqual({ allow: cursorOwnReadAllow(turn(own)), deny: [] });
    expect(existsSync(join(real, "cli-config.json"))).toBe(false);
  });

  it("a host-computer turn adds the computer server to the reads, and a later turn without it drops it", () => {
    const real = realConfig();
    const host = { command: "node", args: [], env: {}, scope: "local-computer" };
    const first: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    argsOf(turn({ ...own, localComputer: host }), first);
    const file = join(first.CURSOR_CONFIG_DIR!, "cli-config.json");
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toEqual([...cursorOwnReadAllow(turn(own)), CURSOR_HOST_COMPUTER_ALLOW]);
    const second: Record<string, string | undefined> = { CURSOR_CONFIG_DIR: real };
    argsOf(turn(own), second);
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toEqual(cursorOwnReadAllow(turn(own)));
  });
});

describe("cursor acp-sessions link on Windows (no symlink privilege)", () => {
  const dirs: string[] = [];
  afterEach(async () => { while (dirs.length) await removeTempDir(dirs.pop()!); });
  const scratch = () => { const d = mkdtempSync(join(tmpdir(), "cursor-link-")); dirs.push(d); return d; };

  it("win32 makes a junction; POSIX keeps the directory symlink", () => {
    const calls: string[] = [];
    linkCursorSessions("T", "L", "win32", (t, p, type) => { calls.push(`${type} ${t} ${p}`); });
    linkCursorSessions("T", "L", "darwin", (t, p, type) => { calls.push(`${type} ${t} ${p}`); });
    expect(calls).toEqual(["junction T L", "dir T L"]);
  });

  it("win32 where even a junction is refused still gets a sessions folder; POSIX errors still throw", () => {
    const root = scratch();
    const refuse = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    linkCursorSessions("T", join(root, "s"), "win32", refuse);
    expect(lstatSync(join(root, "s")).isDirectory()).toBe(true);
    expect(() => linkCursorSessions("T", join(root, "p"), "linux", refuse)).toThrow(/EPERM/);
  });

  it("removing the link removes only the link, never the sessions it points to", () => {
    const root = scratch();
    const target = join(root, "real", "acp-sessions");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "s1.json"), "keep");
    const link = join(root, "cfg-acp-sessions");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(removeCursorSessionsLink(link)).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(target, "s1.json"), "utf8")).toBe("keep");
    mkdirSync(join(root, "plain"));
    expect(() => removeCursorSessionsLink(join(root, "plain"))).toThrow();
    expect(existsSync(join(root, "plain"))).toBe(true);
  });
});

it("offers the fast alias only with a resolvable advertised fast variant", () => {
  for (const param of ["fast=false", "", "fast=true", "reasoning=high,fast=true"]) {
    const available = [{ modelId: `composer-2.5[${param}]` }];
    const ids = cursorCatalogFromSession(available)!.options.map(row => row.id);
    expect(ids.includes("composer-2.5-fast")).toBe(param.includes("fast=true"));
    if (ids.includes("composer-2.5-fast")) expect(resolveCursorAcpModelId(available, "composer-2.5-fast")).toBe(available[0]!.modelId);
  }
});
it.each(["unterminated", "records"])("stops a flooding probe on %s output before the deadline", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "cursor-flood-"));
  const cli = join(root, "flood.cjs");
  writeFileSync(cli, `setInterval(() => process.stdout.write(${JSON.stringify(kind === "records" ? "{}\n".repeat(20000) : "x".repeat(65536))}), 10);`);
  let closed: Promise<void> | undefined;
  let bytes = 0;
  const recording: typeof spawnCli = (command, _args, opts, job) => {
    const child = spawnCli(process.execPath, [command], opts, job);
    child.stdout?.on("data", chunk => { bytes += chunk.length; });
    closed = new Promise(resolve => child.once("close", () => resolve()));
    return child;
  };
  try {
    const started = Date.now();
    expect(await probeCursorSessionModels(cli, { ...process.env }, 8000, recording)).toEqual([]);
    expect(bytes).toBeGreaterThan(65536);
    expect(Date.now() - started).toBeLessThan(4000);
    await closed;
  } finally { await removeTempDir(root); }
});
