import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../../config.ts";
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
  STATIC_CURSOR_MODELS,
  resolveCursorAcpModelId,
  fetchCursorModels,
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
