import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-TRUST-V2 r7 addendum 2026-11-01: an unrouted Cloud Fuigo turn's launcher-made home counts
// as fresh for R4 and R5. The real core and Fuigo support run against the fake ACP CLI with only the
// launcher hand-off stubbed, so the assertions read the render the launcher would receive. The
// launcher half is in cloud-home/fuigo-seed-launcher.test.ts.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The launcher needs root and a turn namespace: the engine starts directly, with the env the core built.
vi.mock("./cloud-home/turn-process.ts", async (original) => {
  const actual = await original<typeof import("./cloud-home/turn-process.ts")>();
  return { ...actual, cloudTurnEnvironment: (_engine: string, source: NodeJS.ProcessEnv) => source, cloudTurnLaunch: () => null };
});

import { TURN_RENDER } from "./cloud-home/turn-process.ts";
import { ensureDirs } from "./config.ts";
import type { FolderTrustTurnInput, ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { FolderTrustStore } from "./folder-trust.ts";
import { CLOUD_SEED_MAX_PATHS, cloudUnroutedFuigoHome } from "./folder-trust-seed.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { folderTrustNotice } from "../shared/folder-trust.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const TRUST_REPLY = '{"jsonrpc":"2.0","id":9006,"result":{"outcome":"trust","scope":"configAndCommands"}}';
const posixOnly = process.platform === "win32" ? describe.skip : describe;

describe("which homes count as fresh", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("an unrouted Fuigo turn on a Cloud home, and nothing else", () => {
    expect(cloudUnroutedFuigoHome("fuigoAgent", false)).toBeUndefined();
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(cloudUnroutedFuigoHome("fuigoAgent", false)).toEqual({ path: "/data/engine-homes/fuigoAgent/.fuigo", cloud: true });
    expect(cloudUnroutedFuigoHome("fuigoAgent", true)).toBeUndefined();
    expect(cloudUnroutedFuigoHome("codex", false)).toBeUndefined();
  });
});

posixOnly("an unrouted turn on the real Fuigo driver", () => {
  let scratch: string;
  let cwd: string;
  let trustLog: string;
  let dump: string;
  let store: FolderTrustStore;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-trust-cloud-")));
    cwd = join(scratch, "work");
    mkdirSync(cwd);
    mkdirSync(join(scratch, "home"));
    trustLog = join(scratch, "trust.log");
    dump = join(scratch, "dump.json");
    store = new FolderTrustStore(join(scratch, "folder-trust.json"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  const create = async (config: { cli?: string } = {}) => {
    instance = await FuigoAgentDriver.create({
      instanceId: `fuigo-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "Fuigo",
      environment: { HOME: join(scratch, "home"), FUIGO_HOME: join(scratch, "home"), FUIGO_API_KEY: "sk-flux-fixture-only", FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_MCP_READY: "1", FAKE_ACP_TRUST_LOG: trustLog, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, ...config },
    });
    recorder = recordEvents(instance.adapter);
  };
  const log = () => (existsSync(trustLog) ? readFileSync(trustLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) as Array<{ event: string; raw?: string }>;
  const replies = () => log().filter((entry) => entry.event === "reply").map((entry) => entry.raw);
  const render = () => JSON.parse((JSON.parse(readFileSync(dump, "utf8")).env as Record<string, string>)[TURN_RENDER] ?? "{}") as { fuigoDeclinedFolders?: string[]; fuigoTrustedFolders?: string[] };
  const gate = (over: Partial<FolderTrustTurnInput> = {}): FolderTrustTurnInput => ({ key: cwd, folder: cwd, sources: [], ...store.turnRecords(), ...over });
  const send = async (threadId: string, input: Partial<SendTurnInput> = {}) => (await instance!.adapter.sendTurn({ threadId, text: "go", cwd, folderTrust: gate(), ...input })).turnId;
  const done = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  const cards = () => recorder.events.filter((e: RuntimeEvent) => e.type === "request.opened");
  const passed = () => recorder.events.filter((e) => e.type === "item.started").map((e) => folderTrustNotice((e as { title?: string }).title ?? "")).filter((notice) => notice?.kind === "passed");
  const decline = (key: string) => store.remember(key, "reject", "card", { key, consent: 2 });
  const grant = (key: string) => store.remember(key, "trust", "card", { key, consent: 2 });

  it("carries every decline and trust in the render, and an unrelated reject brings no card (rule 3)", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await create();
    grant(cwd);
    const other = join(scratch, "elsewhere");
    mkdirSync(other);
    decline(other);
    await done(await send("cloud-seeded"));
    expect(render()).toEqual({ fuigoDeclinedFolders: [other], fuigoTrustedFolders: [cwd] });
    expect(cards()).toEqual([]);
    expect(replies()).toEqual([TRUST_REPLY]);
  }, 60_000);

  // The byte cap has the same outcome (the plan test in folder-trust-v2-seeds.test.ts); the count fits in this rig's spawn env.
  it("past the launcher's limit a decline counts as skipped: no trust is seeded and the card returns", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await create();
    grant(cwd);
    for (let index = 0; index <= CLOUD_SEED_MAX_PATHS; index += 1) decline(`/w/${index}`);
    const turnId = await send("cloud-overflow");
    await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId);
    expect(render().fuigoTrustedFolders).toBeUndefined();
    expect(render().fuigoDeclinedFolders).toHaveLength(CLOUD_SEED_MAX_PATHS);
    expect(cards()).toHaveLength(1);
  }, 60_000);

  it("the passed chip waits for the engine's first answer", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await create();
    decline(cwd);
    const turnId = await send("cloud-chip");
    expect(passed()).toEqual([]);
    await done(turnId);
    expect(passed().map((notice) => notice!.key)).toEqual([cwd]);
  }, 60_000);

  it("the policy line arrives once the engine answers, with the policy folder in the render", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await create();
    const applied = vi.fn();
    const turnId = await send("cloud-policy", { onFolderPolicyApplied: applied, folderTrust: gate({ decision: "trust" }) });
    // No launcher here writes the seed, so the fake asks: its question proves the engine answered first.
    await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId);
    expect(render().fuigoTrustedFolders).toEqual([cwd]);
    expect(applied).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("an engine that never starts shows neither", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await create({ cli: "/bin/false" });
    decline(cwd);
    const other = join(scratch, "policy");
    mkdirSync(other);
    const applied = vi.fn();
    const turnId = await send("cloud-refused", { onFolderPolicyApplied: applied, cwd: other, folderTrust: gate({ key: other, folder: other, decision: "trust" }) }).catch(() => null);
    if (turnId) await done(turnId);
    expect(passed()).toEqual([]);
    expect(applied).not.toHaveBeenCalled();
  }, 60_000);

  it("a desktop unrouted turn seeds nothing: that home is the owner's own", async () => {
    await create();
    grant(cwd);
    await done(await send("desktop-unrouted"));
    expect(render()).toEqual({});
    expect(log().filter((entry) => entry.event === "request")).toHaveLength(1);
  }, 60_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
