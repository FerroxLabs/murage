// SPDX-License-Identifier: AGPL-3.0-or-later
// M9 witnesses on the real claude driver with the fake CLI (no AWS call, offline): W1 W2 W9 W11 W14 W18 W19 W21 W26 W8b M1 and the No limits variants.
import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BedrockBindings } from "../bedrock-bindings.ts";
import { IdentityCache } from "../bedrock-identity.ts";
import { setBedrockRuntime } from "../bedrock-launch.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { fixedPrompt } from "../memory/fixed-prompt.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { listBedrockProfiles } from "../bedrock-identity.ts";
import { ClaudeDriver, CLAUDE_SIGNIN_TOOL, claudeSigninAnswers, claudeSigninScope } from "./claude.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
let root = ""; let instance: ProviderInstance | undefined; let recorder: EventRecorder | undefined;
let state: { block: unknown }; let account = "111111111111"; let resolves = 0; let onResolve: (() => void) | undefined;

const bound = (accountId = "111111111111", epoch = 1) => ({ profile: "personal", region: "us-east-1", accountId, epoch });
beforeEach(() => {
  ensureDirs();
  root = realpathSync(mkdtempSync(join(tmpdir(), "claude-bedrock-")));
  chmodSync(cli, 0o755);
  mkdirSync(join(root, ".aws"));
  writeFileSync(join(root, ".aws", "config"), "[profile personal]\nregion = us-east-1\n");
  writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTURE\naws_secret_access_key = fixturesecret\n");
  state = { block: bound() }; account = "111111111111"; resolves = 0; onResolve = undefined;
  const bindings = new BedrockBindings({ readBlock: () => state.block, writeBlock: async (_i, b) => { state.block = b; }, busy: { get: () => false, set: () => {} }, check: async () => account });
  setBedrockRuntime({ bindings, cache: new IdentityCache(), home: () => root, resolve: async () => { resolves++; onResolve?.(); return account; } });
  process.env.FAKE_CLAUDE_DUMP = join(root, "launch.json");
});
afterEach(async () => {
  recorder?.stop(); await instance?.dispose(); instance = undefined; setBedrockRuntime(null); vi.unstubAllEnvs();
  for (const k of ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_INPUT_LOG", "FAKE_CLAUDE_LAUNCH_WRITE", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_API_ERROR", "FAKE_CLAUDE_RESULT_SUBTYPE"]) delete process.env[k];
  removeTempDirSync(root);
});
const dumpFile = () => join(root, "launch.json");
const launched = () => existsSync(dumpFile());
const dump = () => JSON.parse(readFileSync(dumpFile(), "utf8")) as { pid: number; argv: string[]; bedrockEnv: Record<string, string>; execFile: string | null };

async function make(extra: { bedrock?: boolean; env?: Record<string, string> } = {}) {
  const configDir = join(root, "acct"); mkdirSync(configDir, { recursive: true });
  instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: "aws", displayName: "Claude on Bedrock", enabled: true, environment: extra.env ?? {}, config: { cli, permissionMode: "acceptEdits", configDir, ...(extra.bedrock === false ? {} : { bedrock: { profile: "personal", region: "us-east-1" } }) } as never }));
  recorder = recordEvents(instance.adapter);
  return instance;
}
const turn = async (text = "fixture-only", opts: Record<string, unknown> = {}) => {
  await instance!.adapter.sendTurn({ threadId: "t", cwd: root, text, ...opts } as never);
  return recorder!.until((event) => event.type === "turn.completed");
};
const rows = () => recorder!.events.filter((e) => e.type === "runtime.error") as Array<{ message: string; authRequired?: boolean; errorKind?: string }>;

describe.skipIf(process.platform === "win32")("Bedrock turns on the real driver", () => {
  it("W1 the CLI env has no inherited routing or credential names and has the Bedrock Set; W20 keeps proxy and model names; W21 commands keep the owner's AWS names", async () => {
    for (const [k, v] of Object.entries({ AWS_ROLE_ARN: "arn:aws:iam::1:role/x", AWS_ENDPOINT_URL: "http://localstack.test", CLAUDE_CODE_USE_MANTLE: "1", AWS_ACCESS_KEY_ID: "AKIAEMPLOYER", AWS_SECRET_ACCESS_KEY: "employersecret", AWS_BEARER_TOKEN_BEDROCK: "b", AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://x.test", AWS_PROFILE: "work", AWS_REGION: "eu-west-1", HTTPS_PROXY: "http://proxy.test:3128", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem", ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture-profile-id" })) vi.stubEnv(k, v);
    await make();
    expect(await turn()).toMatchObject({ ok: true });
    const env = dump().bedrockEnv;
    for (const name of ["AWS_ROLE_ARN", "AWS_ENDPOINT_URL", "CLAUDE_CODE_USE_MANTLE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"]) expect(env[name], `W1 ${name} left the CLI env`).toBeUndefined(); // W1-drv-delete
    expect(env.CLAUDE_CODE_USE_BEDROCK, "W1 set survives the strip").toBe("1"); // W1-set
    expect(env.AWS_PROFILE).toBe("personal");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_CONFIG_FILE).toBe(join(root, ".aws", "config"));
    expect(env.HTTPS_PROXY, "W20 proxy").toBe("http://proxy.test:3128"); // W20-drv
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/fixture/ca.pem");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("fixture-profile-id");
    // W21: the exec env file the commands run with was built before the Bedrock Set
    const file = dump().execFile ?? "";
    expect(file, "W21 exec file holds the owner's profile").toContain("AWS_PROFILE=work\0"); // W21
    expect(file).toContain("AWS_REGION=eu-west-1\0");
    expect(file, "W21 commands never see the engine switch").not.toContain("CLAUDE_CODE_USE_BEDROCK");
  });

  it("W2 a repo settings AWS_PROFILE is one R7 row and 0 spawns, also under No limits and with a remembered allow", async () => {
    mkdirSync(join(root, ".claude"));
    const project = join(root, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ env: { AWS_PROFILE: "other", AWS_REGION: "eu-west-9", CLAUDE_CODE_USE_BEDROCK: "0" } }));
    claudeSigninAnswers.remember(claudeSigninScope(process.platform, [{ path: project, source: "project" }]), true);
    await make();
    const done = await turn("fixture-only", { permissionNow: () => ({ noLimits: true, stopLine: true, routeAsks: true }) });
    expect(done, "W2 No limits turn is refused").toMatchObject({ ok: false }); // W2-done
    expect(launched(), "W2 0 spawns").toBe(false); // W2-spawn
    expect(recorder!.events.some((e) => e.type === "request.opened"), "no card").toBe(false);
    expect(JSON.stringify(recorder!.events), "W2 R7 row").toContain("sets AWS_PROFILE, which would send this engine's use to a different AWS account"); // W2
  });

  it("R3-W2b without No limits, a remembered allow for the same repo settings still cannot pass R7 (0 spawns, no card)", async () => {
    mkdirSync(join(root, ".claude"));
    const project = join(root, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ env: { AWS_PROFILE: "other", AWS_REGION: "eu-west-9", CLAUDE_CODE_USE_BEDROCK: "0" } }));
    claudeSigninAnswers.remember(claudeSigninScope(process.platform, [{ path: project, source: "project" }]), true);
    await make();
    const done = await turn("fixture-only");
    expect(launched(), "R3-W2b 0 spawns with the remembered allow").toBe(false); // R3-W2b
    expect(done, "R3-W2b refused").toMatchObject({ ok: false });
    expect(recorder!.events.some((e) => e.type === "request.opened"), "no card").toBe(false);
    expect(JSON.stringify(recorder!.events)).toContain("sets AWS_PROFILE, which would send this engine's use to a different AWS account");
  });

  it("R3-W18p a prewarm on a mismatched AWS account is refused before spawn (IDENTITY runs on the prewarm launch too)", async () => {
    const marker = join(root, "launched.txt"); process.env.FAKE_CLAUDE_LAUNCH_WRITE = marker; // every CLI start writes it (a prewarm sends no prompt, so no dump)
    await make();
    // an unmounted prewarm (a mounted one is refused earlier)
    const prewarm = (threadId: string) => instance!.adapter.sendTurn({ threadId, cwd: root, text: "", prewarm: true, draftOnly: true, warmIdentity: { botId: "b1", audience: "owner" } } as never).catch(() => undefined);
    await prewarm("control");
    await vi.waitFor(() => expect(existsSync(marker), "control: a prewarm on the bound account starts the CLI").toBe(true));
    rmSync(marker);
    account = "222222222222";
    writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTURE5\naws_secret_access_key = fixturesecret5\n"); // a fresh identity call
    const before = resolves;
    await prewarm("t");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker), "R3-W18p 0 spawns for the prewarm").toBe(false); // R3-W18p
    expect(resolves, "the prewarm took the identity step").toBeGreaterThan(before);
  });

  it("W17 the user settings of the engine's own config dir cannot set a helper key either (R7 under No limits)", async () => {
    await make();
    writeFileSync(join(root, "acct", "settings.json"), JSON.stringify({ apiKeyHelper: "/fixture/not-run" }));
    expect(await turn("fixture-only", { permissionNow: () => ({ noLimits: true, stopLine: true, routeAsks: true }) }), "W17 the helper key refuses the turn").toMatchObject({ ok: false }); // W17
    expect(launched()).toBe(false);
    expect(JSON.stringify(recorder!.events)).toContain("sets apiKeyHelper");
  });

  it("W3 an account mismatch is R2 with 0 spawns, W18 also on the review path, and the review spawns with the haiku alias (W14) when the account matches", async () => {
    await make();
    account = "222222222222";
    expect(await turn()).toMatchObject({ ok: false });
    expect(launched(), "W3 0 spawns").toBe(false);
    expect(JSON.stringify(recorder!.events)).toContain("now signs in to AWS account …2222, but this engine is bound to …1111");
    await expect(instance!.reviewPermission?.("synthetic review", undefined, undefined, root), "W18 review refuses").rejects.toThrow(/now signs in to AWS account …2222/); // W18
    expect(launched(), "W18 0 spawns").toBe(false);
    account = "111111111111";
    writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTURE2\naws_secret_access_key = fixturesecret2\n"); // the owner re-points the file: a fresh identity call
    await expect(instance!.reviewPermission?.("synthetic review", undefined, undefined, root)).resolves.toBe("fake generated text");
    expect(dump().argv[dump().argv.indexOf("--model") + 1], "W14 review model").toBe("haiku"); // W14-review
    expect(dump().bedrockEnv.CLAUDE_CODE_USE_BEDROCK, "W1 review site Set").toBe("1"); // W1-review
  });

  it("W14 the picker offers the CLI aliases and no first-party id", async () => {
    await make();
    const ids = instance!.models.options.map((o) => o.id);
    expect(ids, "W14 aliases").toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"])); // W14
    expect(ids.filter((id) => /^claude-/i.test(id)), "W14 no first-party id").toEqual([]); // W14-ids
  });

  it("W8 Stop during IDENTITY: a confirmed Stop ends the turn as the Stop, with no Bedrock refusal row", async () => {
    await make();
    let entered!: () => void; const inIdentity = new Promise<void>((r) => { entered = r; });
    setBedrockRuntime({ bindings: new BedrockBindings({ readBlock: () => state.block, writeBlock: async () => {}, busy: { get: () => false, set: () => {} }, check: async () => account }), cache: new IdentityCache(), home: () => root,
      resolve: (a) => new Promise((_, reject) => { entered(); a.signal?.addEventListener("abort", () => reject(new Error("stopped"))); }) });
    const sending = instance!.adapter.sendTurn({ threadId: "t", cwd: root, text: "fixture-only" } as never);
    sending.catch(() => undefined);
    await inIdentity;
    const stopped = instance!.adapter.interruptTurn("t");
    const ended = await recorder!.until((e) => e.type === "turn.completed");
    await stopped;
    expect(launched(), "W8 0 spawns").toBe(false);
    expect(rows().map((r) => r.message).join("|"), "W8 the Stop is silent: no R3 row").not.toContain("Murage could not confirm your AWS sign-in"); // W8
    expect(ended, "the turn ends as the confirmed Stop").toMatchObject({ ok: true, stopReason: "cancelled" });
  });

  it("W9 a Cloud home refuses with R5 and spawns nothing", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await make();
    await instance!.adapter.sendTurn({ threadId: "t", cwd: root, text: "x" } as never).catch(() => {});
    expect(launched()).toBe(false);
    expect(resolves, "no STS call").toBe(0);
  });

  it("W11 / W26 driver half: an unmatched 403 frame gives the catch-all row and never the Claude sign-in card; only throttling is classed rate_limited (the backup decision itself: bedrock-server-api.test.ts W26)", async () => {
    process.env.FAKE_CLAUDE_MODE = "api-error";
    process.env.FAKE_CLAUDE_API_ERROR = "API Error: 403 The security token included in the request is invalid.";
    await make();
    expect(await turn()).toMatchObject({ ok: false });
    expect(rows()[0]?.message, "W11 catch-all").toContain("Bedrock refused this message for AWS account …1111"); // W11
    expect(rows()[0]!.authRequired, "W11 no sign-in card").toBeUndefined(); // W11-card
    expect(rows()[0]!.errorKind, "W26 not a limit").toBe("bedrock_refused"); // W26-other
    await instance!.dispose(); recorder!.stop();
    process.env.FAKE_CLAUDE_API_ERROR = "ThrottlingException: Too many requests, please wait before trying again.";
    await make();
    expect(await turn()).toMatchObject({ ok: false });
    expect(rows()[0]!.errorKind, "W26 throttling is the one limit").toBe("rate_limited"); // W26-limit
    expect(rows()[0]!.message).toContain("AWS throttled this account's Bedrock use");
  });

  it("W8b an error_max_turns result is not a Bedrock refusal", async () => {
    process.env.FAKE_CLAUDE_MODE = "result-error";
    process.env.FAKE_CLAUDE_RESULT_SUBTYPE = "error_max_turns";
    process.env.FAKE_CLAUDE_API_ERROR = "Reached maximum number of turns (3). Last tool output: 403 Forbidden";
    await make();
    await turn();
    expect(JSON.stringify(recorder!.events), "W8b today's handling").not.toContain("Bedrock refused this message"); // W8b
    process.env.FAKE_CLAUDE_RESULT_SUBTYPE = "success";
    process.env.FAKE_CLAUDE_API_ERROR = "API Error: 403 The security token included in the request is invalid.";
    await instance!.dispose(); recorder!.stop();
    await make();
    await turn();
    expect(JSON.stringify(recorder!.events), "a provider is_error result gets the row").toContain("Bedrock refused this message");
  });

  it("W19 a re-bind that changes only accountId and epoch never reuses the idle process", async () => {
    await make();
    const native = { warmIdentity: { botId: "b1", audience: "owner" as const }, draftOnly: true as const };
    let cursor: string | undefined;
    const run = async (text: string) => {
      const sent = await instance!.adapter.sendTurn({ cwd: root, threadId: "t", text, ...native, ...(cursor ? { resumeCursor: cursor } : {}) } as never);
      await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
      const started = [...recorder!.events].reverse().find((e) => e.type === "session.started") as { sessionId?: string } | undefined;
      if (started?.sessionId) cursor = started.sessionId;
    };
    await run("one"); const first = dump().pid;
    await run("two");
    expect(dump().pid, "control: an unchanged binding reuses the process").toBe(first);
    state.block = bound("333333333333", 2); account = "333333333333";
    await run("three");
    expect(dump().pid, "W19 a new process after the re-bind").not.toBe(first); // W19
  });

  it("R3-B2 a re-bind after the warm key matched (inside the reuse submission fence) is R4: the idle process gets no prompt and is not kept", async () => {
    // r4: every input any CLI process reads is logged, so the "never got the prompt" check below can fail (the launch dump holds no prompt text)
    const inputs = join(root, "inputs.log"); process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
    const got = (text: string) => existsSync(inputs) && readFileSync(inputs, "utf8").includes(text);
    await make();
    const native = { warmIdentity: { botId: "b1", audience: "owner" as const }, draftOnly: true as const };
    let cursor: string | undefined; let rebind = false;
    const run = async (text: string) => {
      // beforePrepare is the harness submission fence: the last synchronous step on the reuse path, after every await of the dispatch
      const beforePrepare = () => { if (rebind) { rebind = false; state.block = bound("111111111111", 2); } };
      const sent = await instance!.adapter.sendTurn({ cwd: root, threadId: "t", text, beforePrepare, ...native, ...(cursor ? { resumeCursor: cursor } : {}) } as never).catch((error: unknown) => ({ error }));
      const done = "turnId" in sent ? await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId) : sent;
      const started = [...recorder!.events].reverse().find((e) => e.type === "session.started") as { sessionId?: string } | undefined;
      if (started?.sessionId) cursor = started.sessionId;
      return done as { ok?: boolean; error?: unknown };
    };
    expect(await run("one")).toMatchObject({ ok: true }); const first = dump().pid;
    expect(await run("two")).toMatchObject({ ok: true });
    expect(dump().pid, "control: an unchanged binding reuses the process").toBe(first);
    expect(got("two"), "control: the input log sees the reused process's prompt").toBe(true);
    rebind = true;
    const third = await run("three");
    expect(got("three"), "R3-B2 the old-account process never got the prompt").toBe(false); // R3-B2
    expect(third.ok, "R3-B2 the reuse after a re-bind is refused").not.toBe(true);
    expect(JSON.stringify([third, recorder!.events]), "R3-B2 R4 row").toContain("changed while your message was starting");
    expect(await run("four")).toMatchObject({ ok: true });
    expect(dump().pid, "R3-B2 the next turn runs on a new process (the stale one was not kept)").not.toBe(first);
  });

  // CHANGED-EXPECTATIONS (FRICTION-1025 F13, q1024-trustquiet r6): there is no sign-in card, so no await sits between the hold
  // and the M9 fence (the window M1 re-bound in is gone). A held repository name on a Bedrock instance opens no card and the
  // turn runs on the owner's settings only (--setting-sources user); the R2-1 rows keep the re-bind-before-spawn fence proven.
  it("M1 a held repository name on a Bedrock instance opens no sign-in card; the turn runs on the owner's settings only", async () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "fixture-repository-model" } }));
    await make();
    void instance!.adapter.sendTurn({ threadId: "t", cwd: root, text: "fixture-only" } as never);
    const first = await recorder!.until((event) => event.type === "request.opened" || event.type === "turn.completed");
    expect(first.type, "M1 no sign-in card: the turn ends on its own").toBe("turn.completed"); // F13-W5
    expect(first).toMatchObject({ ok: true });
    expect(recorder!.events.some((event) => event.type === "request.opened" && event.tool === CLAUDE_SIGNIN_TOOL), "M1 no card").toBe(false);
    const argv = dump().argv;
    expect(argv[argv.indexOf("--setting-sources") + 1], "M1 owner settings only").toBe("user");
  });

  it("R2-1 a re-bind during IDENTITY on the review launch is R4 with 0 spawns (the checked epoch is carried to the spawn)", async () => {
    await make();
    await expect(instance!.reviewPermission?.("synthetic review", undefined, undefined, root), "control: an unchanged binding spawns").resolves.toBe("fake generated text");
    expect(launched(), "control spawn").toBe(true);
    rmSync(dumpFile());
    writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTURE3\naws_secret_access_key = fixturesecret3\n"); // a fresh identity call
    onResolve = () => { state.block = bound("111111111111", 2); }; // the owner re-binds in Settings while IDENTITY is in flight
    await expect(instance!.reviewPermission?.("synthetic review", undefined, undefined, root), "R2-1 review refuses").rejects.toThrow(/changed while your message was starting/); // R2-1-review
    expect(launched(), "R2-1 review 0 spawns").toBe(false);
  });

  it("R2-1 a re-bind during IDENTITY on the text-only launch is R4 with 0 spawns (the checked epoch is carried to the spawn)", async () => {
    await make();
    const textOnly = (n: number) => instance!.adapter.textOnlyTurn!({
      cwd: root, system: fixedPrompt("SYS"), text: `USER${n}`, model: "haiku", outputSchema: { type: "object", properties: {}, additionalProperties: false } as never,
      signal: new AbortController().signal, maxOutputTokens: 2000, maxOutputBytes: 12 * 1024,
      context: { botId: "bot", runId: `run${n}`, family: "lived", attempt: 1 }, transport: { gate: openLearningGate("continuity") },
    } as never);
    // the fake CLI's dump never reaches a schema run (the env allowlist drops it), so a spawn shows as a settled run whose child exited
    expect(await textOnly(1), "control: an unchanged binding spawns the child").toMatchObject({ isolation: { exited: true } });
    writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTURE4\naws_secret_access_key = fixturesecret4\n"); // a fresh identity call
    onResolve = () => { state.block = bound("111111111111", 2); };
    await expect(textOnly(2), "R2-1 text-only refuses").rejects.toThrow(/changed while your message was starting/); // R2-1-text
  });
});

describe.skipIf(process.platform === "win32")("W12 and W28", () => {
  it("W12 registry half: a deleted Bedrock instance is gone from the registry and its reload spawns nothing (the dispatched turn: bedrock-server-api.test.ts W12)", async () => {
    const registry = new ProviderRegistry([ClaudeDriver]);
    const configDir = join(root, "acct"); mkdirSync(configDir, { recursive: true });
    const aws = { driver: "claudeAgent", displayName: "AWS", enabled: true, config: { cli, permissionMode: "acceptEdits", configDir, bedrock: bound() } };
    const plain = { driver: "claudeAgent", displayName: "Claude", enabled: true, config: { cli, permissionMode: "acceptEdits" } };
    await registry.load({ claude: plain, aws } as never);
    expect(registry.get("aws"), "the bedrock instance exists before removal").not.toBeNull();
    await registry.reload(new Set(["aws"]), { claude: plain } as never);
    expect(registry.get("aws"), "W12 removed: R6 (the existing refusal)").toBeNull(); // W12
    expect(launched(), "W12 the default Claude account is spawned 0 times").toBe(false);
    await registry.disposeAll();
  });

  it("W28 the profiles dropdown, the snapshot and the persisted block carry names and suffixes only, never a key value", async () => {
    writeFileSync(join(root, ".aws", "credentials"), "[personal]\naws_access_key_id = AKIAFIXTUREKEYVALUE\naws_secret_access_key = fixturesecretvalue\n[other]\naws_access_key_id = AKIAOTHERVALUE\n");
    const listed = listBedrockProfiles({ configFile: join(root, ".aws", "config"), credentialsFile: join(root, ".aws", "credentials") });
    expect(listed, "W28 names only").toEqual(["other", "personal"]); // W28
    for (const leak of ["AKIAFIXTUREKEYVALUE", "fixturesecretvalue", "AKIAOTHERVALUE"]) expect(JSON.stringify(listed), `W28 ${leak}`).not.toContain(leak);
    await make();
    const snap = JSON.stringify(await instance!.snapshot());
    for (const leak of ["AKIAFIXTUREKEYVALUE", "fixturesecretvalue", "111111111111"]) expect(snap, `W28 snapshot ${leak}`).not.toContain(leak);
    expect(JSON.stringify(state.block), "the persisted block holds no key").not.toMatch(/AKIA|secret/i);
  });
});
void rmSync;
