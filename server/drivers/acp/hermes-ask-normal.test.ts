// HERMES-BUGS-1010: the two Murage-only Hermes defects carried from 1.0.9.
// 1. An ask the Murage hook escalates reaches Murage with the placeholder
//    `<terminal> (plugin approval rule)` as its command and the hook's message
//    as its description (hermes tools/approval.py request_tool_approval,
//    acp_adapter/permissions.py _build_permission_tool_call). The command
//    reader, the policy call and the stop line judged the placeholder, and the
//    hook cut its message at 400 characters. Now one reading of the hook's
//    message feeds every reader: the real command, whole.
// 2. The overlay writer replaced the whole `pre_tool_call` list and so dropped
//    the owner's own hooks that Hermes had already allowlisted. Now they stay.
//
// Fake engine only: the scripted ACP CLI in server/testing/fake-acp-cli.ts
// sends the Hermes-shaped request; no Hermes and no model run.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { autoVerdict } from "../../auto-approve.ts";
import { classifyStopLine, type StopLinePlace } from "../../stop-line.ts";
import { commandFromToolInput, commandCwdFromToolInput } from "../../../shared/exact-command.ts";
import type { GrantCall } from "../../../shared/app-action-grant.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { HERMES_ASK_HOOK_SOURCE, HERMES_ASK_MESSAGE_CAP, hermesAcpSupport } from "./hermes.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** A test harness carrying Hermes's own ask reader and nothing else of Hermes. */
const HERMES_ASK_SUPPORT: AcpSupport = {
  driverKind: "hermesAskTest",
  displayName: "Hermes Ask Test",
  models: { default: "", options: [] },
  defaultCli: "fake-hermes-ask",
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  normalizeAsk: hermesAcpSupport.normalizeAsk,
};
const HermesAskDriver = createAcpDriver(HERMES_ASK_SUPPORT);

/** What the hook program prints for one call, run as Hermes runs it (stdin JSON in, stdout JSON out). */
const hookSays = (toolName: string, toolInput: unknown) => JSON.parse(spawnSync(process.execPath, ["-e", HERMES_ASK_HOOK_SOURCE],
  { input: JSON.stringify({ hook_event_name: "pre_tool_call", tool_name: toolName, tool_input: toolInput }), encoding: "utf8" }).stdout);

/** The permission request Hermes sends for a hook-approved call (permissions.py, approval.py). */
const hermesRequest = (toolName: string, message: string) => ({
  toolCallId: "perm-check-1",
  kind: "execute",
  status: "pending",
  title: `${message}: <${toolName}> (plugin approval rule)`,
  rawInput: { command: `<${toolName}> (plugin approval rule)`, description: message },
});

const HOME = "/home/tester";
const THREAD = "/home/tester/.murage/workspaces/bot/thread";
const place: StopLinePlace = { cwd: THREAD, roots: [THREAD, "/tmp"], home: HOME, knownRecipients: new Set(), realpath: (p) => posix.normalize(p) };

describe("HERMES-BUGS-1010: a Hermes hook ask is judged by its real command, whole", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-hermes-ask-normal-"));
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  const askedWith = async (threadId: string, toolCall: object) => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify(toolCall);
    instance = await HermesAskDriver.create({ instanceId: "hermes-ask-test", displayName: "Hermes Ask Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: "go" } as any);
    const opened = (await recorder.until((e) => e.type === "request.opened")) as any;
    await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    return opened;
  };
  const callOf = (opened: any): GrantCall => ({
    toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
    mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing,
  });

  it("the hook's message is the call's whole arguments, past the old 400-character cut", () => {
    const command = `echo ${"x".repeat(600)} && rm -rf ${HOME}/Documents/taxes`;
    const said = hookSays("terminal", { command, workdir: THREAD });
    expect(said.action).toBe("approve");
    expect(JSON.parse(said.message)).toEqual({ murage: 1, v: 1, tool: "terminal", input: { command, workdir: THREAD }, truncated: false });
    // Above the cap the message says so and carries no arguments, so nothing cut is ever judged.
    const huge = hookSays("terminal", { command: "y".repeat(HERMES_ASK_MESSAGE_CAP + 10) });
    expect(JSON.parse(huge.message)).toEqual({ murage: 1, v: 1, tool: "terminal", input: null, truncated: true });
    expect(huge.message.length).toBeLessThanOrEqual(HERMES_ASK_MESSAGE_CAP);
  });

  it("every reader takes the real command: the card, the policy's command, its folder and the stop line", async () => {
    // The tail past character 400 is the part that deletes outside the bot's folder.
    const command = `echo ${"x".repeat(600)} && rm -rf ${HOME}/Documents/taxes`;
    const opened = await askedWith("hermes-real-command", hermesRequest("terminal", hookSays("terminal", { command, workdir: THREAD }).message));
    expect(opened.toolCall.name).toBe("shell");
    expect(commandFromToolInput(opened.toolCall.input)).toBe(command);
    expect(commandCwdFromToolInput(opened.toolCall.input)).toBe(THREAD);
    expect(opened.summary).toContain("echo xxx");
    expect(opened.summary).not.toContain("plugin approval rule");
    expect(opened.toolInputMissing).toBeUndefined();
    expect(classifyStopLine(opened.toolCall.name, opened.toolCall.input, opened.summary, place)?.what).toBe("Delete 1 item outside its folder: ~/Documents/taxes");
    // The request's own fields stay in the input, so a scan of every string still sees them.
    expect(opened.toolCall.input.hermesAsk.placeholder).toBe("<terminal> (plugin approval rule)");
    expect(opened.toolCall.input.description).toContain("rm -rf");
  });

  it("a plain command reads as itself at Auto, and a key file named in its tail still hits the key guard", async () => {
    const plain = await askedWith("hermes-plain", hermesRequest("terminal", hookSays("terminal", { command: "ls -la" }).message));
    expect(commandFromToolInput(plain.toolCall.input)).toBe("ls -la");
    expect(plain.summary).toBe("ls -la");
    await instance?.dispose();
    instance = undefined;
    const keyed = `echo ${"z".repeat(500)}; cat ${HOME}/.aws/credentials`;
    const key = await askedWith("hermes-key", hermesRequest("terminal", hookSays("terminal", { command: keyed }).message));
    const verdict = autoVerdict({ autoApprove: true, fullAccess: true }, key.tool, key.summary, { call: callOf(key), commandText: commandFromToolInput(key.toolCall.input) });
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("sensitive-guard");
  });

  it("a model-added `cwd` is not taken as the command's folder: only the fields Hermes runs by are read", async () => {
    const opened = await askedWith("hermes-cwd", hermesRequest("terminal", hookSays("terminal", { command: "ls", cwd: "/tmp" }).message));
    expect(commandCwdFromToolInput(opened.toolCall.input)).toBeUndefined();
    expect(opened.toolCall.input.hermesAsk.input.cwd).toBe("/tmp");
  });

  it("a hook message Murage does not recognise is a call it could not read, never judged by the placeholder", async () => {
    for (const [id, message] of [
      ["hermes-old-hook", `terminal: ${"q".repeat(400)}`],
      ["hermes-cut", hookSays("terminal", { command: "y".repeat(HERMES_ASK_MESSAGE_CAP + 10) }).message],
      ["hermes-other-tool", JSON.stringify({ murage: 1, v: 1, tool: "execute_code", input: { code: "print(1)" }, truncated: false })],
      ["hermes-no-command", JSON.stringify({ murage: 1, v: 1, tool: "terminal", input: {}, truncated: false })],
    ] as const) {
      const opened = await askedWith(id, hermesRequest("terminal", message));
      expect(opened.toolInputMissing).toBe("hermes-hook");
      // the card shows what the hook sent, never the placeholder
      expect(opened.summary).toContain("terminal: ");
      expect(opened.summary).not.toContain("plugin approval rule");
      // held at every level, Full access included: a card, never a silent allow
      const verdict = autoVerdict({ autoApprove: true, fullAccess: true }, opened.tool, opened.summary, { call: callOf(opened) });
      expect(verdict.approve).toBeNull();
      expect(["unread-call", "always-ask"]).toContain(verdict.source);
      await instance?.dispose();
      instance = undefined;
    }
  });

  it("another tool's arguments are shown on the card but never read as a shell command", async () => {
    const opened = await askedWith("hermes-code", hermesRequest("execute_code", hookSays("execute_code", { code: "import os\nos.listdir('.')" }).message));
    expect(opened.toolInputMissing).toBeUndefined();
    expect(opened.summary).toContain("execute_code: import os");
    expect(commandFromToolInput(opened.toolCall.input)).toBe("<execute_code> (plugin approval rule)");
  });

  it("Hermes's own approvals (a dangerous command, an edit) are read as sent", async () => {
    const opened = await askedWith("hermes-own", { toolCallId: "perm-check-2", kind: "execute", title: "recursive delete: rm -rf build",
      rawInput: { command: "rm -rf build", description: "recursive delete" } });
    expect(opened.toolCall.input).toEqual({ command: "rm -rf build", description: "recursive delete" });
    expect(opened.toolInputMissing).toBeUndefined();
  });
});

describe("HERMES-BUGS-1010: the overlay keeps the owner's allowlisted Hermes hooks", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await removeTempDir(d); });
  const overlayOf = (env: Record<string, string | undefined>) =>
    parseYaml(readFileSync(join(env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8")) as { hooks: Record<string, any[]> };
  const ownerHome = (config: string, approvals: unknown) => {
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-owner-"));
    dirs.push(root);
    const home = join(root, "hermes");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), config);
    if (approvals !== undefined) writeFileSync(join(home, "shell-hooks-allowlist.json"), JSON.stringify(approvals));
    return { root, home };
  };
  const turnEnv = (root: string, home: string, extra: Record<string, string | undefined> = {}) =>
    ({ MURAGE_DATA_DIR: join(root, "data"), HERMES_MANAGED_DIR: join(root, "no-admin"), HERMES_HOME: home, ...extra }) as Record<string, string | undefined>;
  const OWNER_CONFIG = [
    "hooks:",
    "  pre_tool_call:",
    "    - matcher: terminal",
    "      command: /opt/owner/approved-guard.sh",
    "      fail_closed: true",
    "    - command: /opt/owner/never-approved.sh",
    "  post_tool_call:",
    "    - command: /opt/owner/post.sh",
    "",
  ].join("\n");
  const APPROVALS = { approvals: [
    { event: "pre_tool_call", command: "/opt/owner/approved-guard.sh", approved_at: "2026-10-01T00:00:00Z" },
    { event: "post_tool_call", command: "/opt/owner/post.sh", approved_at: "2026-10-01T00:00:00Z" },
    // approved for another event only: not a pre_tool_call approval
    { event: "post_tool_call", command: "/opt/owner/never-approved.sh", approved_at: "2026-10-01T00:00:00Z" },
  ] };

  it("keeps the owner's pre_tool_call hooks Hermes already allowlisted, after Murage's own, and no others", () => {
    const { root, home } = ownerHome(OWNER_CONFIG, APPROVALS);
    const env = turnEnv(root, home);
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env });
    const pre = overlayOf(env).hooks.pre_tool_call;
    expect(pre.map((h) => h.command)).toEqual([expect.stringContaining("ask-hook-"), "/opt/owner/approved-guard.sh"]);
    expect(pre[1]).toEqual({ matcher: "terminal", command: "/opt/owner/approved-guard.sh", fail_closed: true });
    // the other events stay replaced by none for the turn, as before
    expect(overlayOf(env).hooks.post_tool_call).toEqual([]);
  });

  it("keeps the administrator's hooks too, once each, and an owner with no allowlist keeps none", () => {
    const { root, home } = ownerHome(`${OWNER_CONFIG.replace("  post_tool_call:", "    - command: /opt/owner/second.sh\n  post_tool_call:")}`,
      { approvals: [...APPROVALS.approvals, { event: "pre_tool_call", command: "/opt/owner/second.sh" }] });
    const admin = join(root, "admin");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "config.yaml"), "hooks:\n  pre_tool_call:\n    - command: /opt/admin-hook\n    - matcher: terminal\n      command: /opt/owner/approved-guard.sh\n");
    const env = turnEnv(root, home, { HERMES_MANAGED_DIR: admin });
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env });
    // the owner's approved-guard is the administrator's too (same matcher and command): kept once
    expect(overlayOf(env).hooks.pre_tool_call.map((h) => h.command)).toEqual([expect.stringContaining("ask-hook-"), "/opt/admin-hook", "/opt/owner/approved-guard.sh", "/opt/owner/second.sh"]);
    const bare = ownerHome(OWNER_CONFIG, undefined);
    const none = turnEnv(bare.root, bare.home);
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env: none });
    expect(overlayOf(none).hooks.pre_tool_call.map((h) => h.command)).toEqual([expect.stringContaining("ask-hook-")]);
  });

  it("reads the named profile's home, and never writes the owner's files", () => {
    const { root, home } = ownerHome("model:\n  default: x\n", { approvals: [] });
    const profile = join(home, "profiles", "work");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "config.yaml"), OWNER_CONFIG);
    writeFileSync(join(profile, "shell-hooks-allowlist.json"), JSON.stringify(APPROVALS));
    const before = [readFileSync(join(profile, "config.yaml"), "utf8"), readFileSync(join(profile, "shell-hooks-allowlist.json"), "utf8")];
    const env = turnEnv(root, home);
    hermesAcpSupport.spawnArgs({ profile: "work" } as any, { integrations: {} } as any, { env });
    expect(overlayOf(env).hooks.pre_tool_call.map((h) => h.command)).toEqual([expect.stringContaining("ask-hook-"), "/opt/owner/approved-guard.sh"]);
    expect([readFileSync(join(profile, "config.yaml"), "utf8"), readFileSync(join(profile, "shell-hooks-allowlist.json"), "utf8")]).toEqual(before);
  });
});
