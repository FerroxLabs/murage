// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ISSUE-PERMS-1010 (designs/ISSUE-PERMS-1010.md), on a fake ACP engine.
// B, murage-releases #7 (b): Fuigo's codex toolset stamps apply_patch as codex/apply_patch, filed as kind `edit`
// with rawInput `{patch}` and no locations (fuigo-shell acp_session_impl tool_calls.rs ToolInput::ApplyPatch).
// The codex namespace was not read, so every patch of a Full access routine was unproven and waited on a card.
// A, murage-releases #7 (a): a slow environment check held every command of a Full access routine run.
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { resolveCall, STAMP_SPELLING_WHY, type GrantCall } from "../../../shared/app-action-grant.ts";
import { autoVerdict, type AutoApprover, type AutoContext } from "../../auto-approve.ts";
import { classifyAsk, type StopLinePlace } from "../../stop-line.ts";
import { acpApplyPatchCall, acpAskControlsComputer, acpStampedIdentity } from "./core.ts";
import { proposalAskAllowed, proposalToolItemStops } from "../../project-proposal-engines.ts";
import { parseApplyPatch, routeDelivery } from "../codex-hook.ts";
import { GrokAgentDriver } from "./grok.ts";

vi.mock("node:child_process", async (original) => (await import("../../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const ROUTINE: Partial<AutoContext> = { fullAccessOrigin: "routine", routineLevel: true, automated: true };

const patchStamp = (key = "fuigo/tool", name = "apply_patch", namespace = "codex") => ({ [key]: { version: 1, name, kind: "edit", namespace, label: "Apply patch", read_only: false } });
/** fuigo-shell's request_permission tool call for ToolInput::ApplyPatch: title "Apply patch", kind edit, no locations. */
const fuigoPatch = (patch: unknown, meta: object = patchStamp(), kind = "edit") => ({
  toolCallId: "call-patch", kind, title: "Apply patch", status: "pending", rawInput: { patch }, _meta: meta,
});
const addFile = (path: string, body = "hello") => `*** Begin Patch\n*** Add File: ${path}\n+${body}\n*** End Patch\n`;
const deleteFile = (path: string) => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch\n`;

describe("ISSUE-PERMS-1010 B: codex/apply_patch is read as an edit of its destinations", () => {
  it("resolves only the exact name filed as an edit", () => {
    const call = (name: string, toolKind: string): GrantCall => ({ engine: "acp", toolKind, toolIdentity: { namespace: "codex", name }, toolCall: { name: toolKind, input: { patch: addFile("a.md") } } });
    expect(resolveCall(call("apply_patch", "edit"))).toMatchObject({ kind: "engine", name: "apply_patch", wrapped: false });
    expect(resolveCall(call("apply_patch", "other"))).toMatchObject({ kind: "unproven" });
    expect(resolveCall(call("read_file", "read"))).toMatchObject({ kind: "unproven" });
    expect(resolveCall(call("shell", "execute"))).toMatchObject({ kind: "unproven" });
  });

  it("puts the patch's destinations in locations, and leaves every other call as it came", () => {
    const read = acpApplyPatchCall(fuigoPatch(`*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts\n*** End Patch`), "edit");
    expect(read.unread).toBe(false);
    expect(read.toolCall.locations).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
    for (const [call, kind] of [[fuigoPatch(addFile("a.md"), patchStamp("fuigo/tool", "write", "opencode")), "edit"], [fuigoPatch(addFile("a.md")), "other"]] as const) {
      expect(acpApplyPatchCall(call, kind)).toEqual({ toolCall: call, unread: false });
    }
    for (const bad of ["not a patch", 42, undefined, "*** Begin Patch\n*** Run: rm -rf /\n*** End Patch", "*** Begin Patch\n*** Move to: b.ts\n*** End Patch"]) expect(acpApplyPatchCall(fuigoPatch(bad), "edit").unread).toBe(true);
    // Astra r1: an update hunk that ends with the End of File marker is read, not refused
    const eof = acpApplyPatchCall(fuigoPatch("*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End of File\n*** End Patch"), "edit");
    expect(eof).toMatchObject({ unread: false, toolCall: { locations: [{ path: "a.ts" }] } });
  });

  it("names what a patch takes away: each Delete File and each moved file's old name", () => {
    expect(parseApplyPatch("*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts\n*** Add File: d.ts\n+z\n*** End Patch")?.removed).toEqual(["a.ts", "c.ts"]);
  });

  // Design section 7 rev 4: nothing trims a stamp. A part with whitespace at either end or a Cc/Cf/Zl/Zp character anywhere
  // is unproven everywhere; every other part compares exactly, as in 1.0.9.
  const HIDDEN = ["codex ", " codex", "\tcodex", "codex\n", "\u00A0codex", "codex\uFEFF", "  codex  ", "\tcodex\n", "codex\u0085", "co\u200Bdex", "co\u200Ddex", "codex\u2028", "codex\u2029", "\u180Ecodex", "codex\u3000"];
  const PLACE: StopLinePlace = { cwd: "/project", roots: ["/project"], home: "/home/u", knownRecipients: new Set<string>(), realpath: (path: string) => path };
  it("rev 4: a hidden spelling is never read as codex: the ACP reader does not parse it, the resolver and the stop line hold it", () => {
    const patch = deleteFile("/outside/x");
    for (const namespace of HIDDEN) {
      const label = JSON.stringify(namespace);
      const toolCall = fuigoPatch(patch, patchStamp("fuigo/tool", "apply_patch", namespace));
      expect(acpStampedIdentity(toolCall), label).toMatchObject({ namespace, name: "apply_patch" });
      expect(acpApplyPatchCall(toolCall, "edit"), label).toEqual({ toolCall, unread: false });
      const call: GrantCall = { engine: "acp", toolKind: "edit", toolIdentity: { namespace, name: "apply_patch" }, toolCall: { name: "edit", input: { patch, locations: [{ path: "/outside/x" }] } } };
      expect(resolveCall(call), label).toEqual({ kind: "unproven", why: STAMP_SPELLING_WHY });
      expect(classifyAsk({ ...call, tool: "Apply patch", summary: "Apply patch" }, PLACE), label).toMatchObject({ kind: "delete", what: "Murage could not tell which tool this runs, so it is waiting for you." });
      for (const [bot, context] of [[AUTO, {}], [FULL, ROUTINE], [FULL, { fullAccessOrigin: "owner" }], [NO_LIMITS, ROUTINE], [NO_LIMITS, { fullAccessOrigin: "owner" }]] as const) {
        expect(autoVerdict(bot, "edit", "Apply patch", { call, ...context }), label).toMatchObject({ approve: null, source: "unread-call" });
      }
    }
    for (const name of ["apply_patch ", " apply_patch", "apply_patch\t", "apply\u200D_patch"]) {
      const toolCall = fuigoPatch(patch, patchStamp("fuigo/tool", name));
      expect(acpApplyPatchCall(toolCall, "edit"), JSON.stringify(name)).toEqual({ toolCall, unread: false });
      expect(resolveCall({ engine: "acp", toolKind: "edit", toolIdentity: { namespace: "codex", name } }), JSON.stringify(name)).toEqual({ kind: "unproven", why: STAMP_SPELLING_WHY });
    }
  });

  it("rev 4: an inner space or a confusable is no hidden spelling, it just names no known namespace", () => {
    for (const namespace of ["co dex", "Codex", "\u0441odex"]) {
      expect(resolveCall({ engine: "acp", toolKind: "edit", toolIdentity: { namespace, name: "apply_patch" } }), namespace).toEqual({ kind: "unproven", why: "a stamp in a namespace Murage does not read" });
    }
  });

  it("rev 4 (rev 3 C1): an exact non-ASCII or inner-space tool name resolves and runs as in 1.0.9, at Full access and No limits on a routine", () => {
    const mcpMounts = [{ engineName: "files", mountId: "custom:files", provenance: "custom" as const }];
    for (const name of ["files__read r\u00E9sum\u00E9", "files__read my file"]) {
      const call: GrantCall = { engine: "acp", toolKind: "other", toolIdentity: { namespace: "mcp", name }, mcpMounts, toolCall: { name: "other", input: {} } };
      expect(resolveCall(call), name).toMatchObject({ kind: "mcp" });
      expect(autoVerdict(FULL, name, name, { call, ...ROUTINE }).approve, name).not.toBeNull();
      expect(autoVerdict(NO_LIMITS, name, name, { call, ...ROUTINE }).approve, name).not.toBeNull();
    }
    // a hidden character in the same name holds
    const held: GrantCall = { engine: "acp", toolKind: "other", toolIdentity: { namespace: "mcp", name: "files__read\u200B" }, mcpMounts, toolCall: { name: "other", input: {} } };
    expect(autoVerdict(NO_LIMITS, "files__read", "files__read", { call: held, ...ROUTINE })).toMatchObject({ approve: null, source: "unread-call" });
  });

  it("rev 4 (GrokBuild subset r2): a padded mcp stamp stays a computer action and an unscoped Always-allow does not run it at Ask", () => {
    const toolCall = { kind: "other", title: "Open", rawInput: {}, _meta: { "fuigo/tool": { version: 1, namespace: "mcp ", name: "browser__open" } } };
    expect(acpAskControlsComputer(toolCall)).toBe(true);
    const call: GrantCall = { engine: "acp", toolKind: "other", toolIdentity: acpStampedIdentity(toolCall), toolCall: { name: "other", input: {} } };
    expect(autoVerdict({ alwaysAllow: ["browser__open", "mcp__browser__open", "other"] }, "browser__open", "Open", { call })).toMatchObject({ approve: null, source: "unread-call" });
  });

  it("rev 4 (GrokBuild/Astra subset r2): a padded proposal stamp is refused and stops the proposal turn, as in 1.0.9", () => {
    const opened = (identity: { namespace: string; name: string; kind?: string }) => ({ requestType: "permission", toolKind: "other", toolIdentity: identity, toolCall: { name: "other", input: { tool_name: "m__project_propose" } } });
    const ask = (identity: { namespace: string; name: string; kind?: string }) => proposalAskAllowed(opened(identity) as Parameters<typeof proposalAskAllowed>[0], { acp: true, server: "m" });
    expect(ask({ namespace: "mcp", name: "m__project_propose" })).toBe(true);
    for (const identity of [{ namespace: "mcp ", name: "m__project_propose" }, { namespace: "mcp", name: "m__project_propose " }, { namespace: "fuigo_build ", name: "use_tool", kind: "use_tool" }, { namespace: "fuigo_build", name: " use_tool", kind: "use_tool" }]) {
      expect(ask(identity), JSON.stringify(identity)).toBe(false);
      expect(proposalToolItemStops("fuigoAgent", { toolIdentity: identity }, "m"), JSON.stringify(identity)).toBe(true);
    }
  });
});

describe("ISSUE-PERMS-1010 on a fake ACP engine", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  let workspace: string;
  let place: StopLinePlace;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-issue-perms-"));
    workspace = join(scratch, "home", ".murage", "workspaces", "bot-ember");
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    place = { cwd: workspace, roots: [workspace], home: join(scratch, "home"), knownRecipients: new Set<string>(), realpath: (path: string) => path };
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  const asked = async (id: string, toolCall: object) => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify(toolCall);
    instance = await GrokAgentDriver.create({ instanceId: "acp-test", displayName: "ACP Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: id, text: "go" } as any);
    const opened = (await recorder.until((e) => e.type === "request.opened")) as any;
    await instance.adapter.respondToRequest(id, opened.requestId, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    return opened;
  };
  const judged = (opened: any) => {
    const call: GrantCall = {
      toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
      mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing, truncated: false,
    };
    const stopLine = classifyAsk({ ...call, tool: opened.tool, summary: opened.summary }, place);
    return (bot: AutoApprover, patch: Partial<AutoContext> = ROUTINE) => autoVerdict(bot, opened.tool, opened.summary, { call, stopLine, ...patch });
  };

  it.each(["fuigo/tool", "x.ai/tool"])("a Full access routine's patch inside the project runs with no card (%s)", async (key) => {
    const file = join(workspace, "outputs", "brief.md");
    const opened = await asked("t-patch", fuigoPatch(addFile(file), patchStamp(key)));
    expect(opened.toolIdentity).toMatchObject({ namespace: "codex", name: "apply_patch" });
    expect(opened.filePaths).toEqual([file]);
    expect(opened.toolInputMissing).toBeUndefined();
    const verdict = judged(opened);
    // before: "the tool this runs cannot be proven: a codex tool Murage does not read" at every level
    expect(verdict(FULL).approve).toEqual(expect.any(String));
    expect(verdict(NO_LIMITS).approve).toEqual(expect.any(String));
    expect(verdict(AUTO, {}).source).not.toBe("unread-call");
  });

  it("a patch that writes a key file still waits, at No limits too", async () => {
    const opened = await asked("t-key", fuigoPatch(addFile(join(scratch, "home", ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----")));
    const verdict = judged(opened);
    expect(verdict(FULL).approve).toBeNull();
    expect(verdict(NO_LIMITS).approve).toBeNull();
  });

  it("a patch that deletes outside the project meets the stop line on a routine at Full access", async () => {
    const opened = await asked("t-del", fuigoPatch(deleteFile(join(scratch, "elsewhere", "ledger.csv"))));
    expect(opened.filePaths).toEqual([join(scratch, "elsewhere", "ledger.csv")]);
    expect(judged(opened)(FULL).approve).toBeNull();
  });

  it("a patch that moves a file out from outside the project meets the stop line too (its old name is a delete)", async () => {
    const outside = join(scratch, "elsewhere", "ledger.csv");
    const opened = await asked("t-move", fuigoPatch(`*** Begin Patch\n*** Update File: ${outside}\n*** Move to: ${join(workspace, "outputs", "ledger.csv")}\n@@\n-a\n+b\n*** End Patch`));
    expect(judged(opened)(FULL).approve).toBeNull();
    // inside the project, the same move is an ordinary edit
    const inside = await asked("t-move-in", fuigoPatch(`*** Begin Patch\n*** Update File: ${join(workspace, "outputs", "a.md")}\n*** Move to: ${join(workspace, "outputs", "b.md")}\n@@\n-a\n+b\n*** End Patch`));
    expect(judged(inside)(FULL).approve).toEqual(expect.any(String));
  });

  it("a patch Murage cannot read whole keeps one card that says so", async () => {
    const opened = await asked("t-bad", fuigoPatch("rewrite everything"));
    expect(opened.toolInputMissing).toBe("patch");
    const verdict = judged(opened);
    expect(verdict(NO_LIMITS)).toMatchObject({ approve: null, source: "unread-call" });
  });

  // Rev 3 (#7(b)): one strict reader. Each patch runs on the Fuigo ACP path (the fake engine) and on the Codex hook path
  // (routeDelivery, then classifyAsk and the verdict exactly as the Codex driver opens its card).
  describe("ISSUE-PERMS-1010 Rev 3: the patch reader reads only what Fuigo and Codex both run", () => {
    const inside = () => join(workspace, "outputs", "a.md");
    const inside2 = () => join(workspace, "outputs", "b.md");
    const outside = () => join(scratch, "elsewhere", "ledger.csv");
    const env = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    let n = 0;
    /** The Fuigo ACP path: the fake engine asks with the patch, and the card is judged as the server judges it. */
    const fuigo = async (toolCall: object) => {
      recorder?.stop();
      await instance?.dispose();
      instance = undefined;
      const opened = await asked(`t-r3-${++n}`, toolCall);
      return { opened, verdict: judged(opened) };
    };
    const fuigoRun = (patch: unknown) => fuigo(fuigoPatch(patch));
    /** The Codex hook path: the delivery is routed, and an ask is judged as codex.ts opens it. */
    const codex = (tool_name: string, tool_input: unknown) => {
      const route = routeDelivery({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: workspace }, { mounts: [], project: workspace, home: place.home });
      const ask = route.route === "ask" ? route : undefined;
      const call: GrantCall | undefined = ask && { engine: "codex", toolCall: ask.toolCall as GrantCall["toolCall"], inputMissing: ask.toolInputMissing, truncated: false };
      const stopLine = ask && call ? classifyAsk({ ...call, tool: ask.tool, summary: ask.summary }, place) : null;
      const verdict = (bot: AutoApprover, patch: Partial<AutoContext> = ROUTINE) => ask && call ? autoVerdict(bot, ask.tool, ask.summary, { call, stopLine, ...patch }) : undefined;
      return { route, stopLine, verdict };
    };
    const codexPatch = (patch: unknown) => codex("apply_patch", { input: patch });
    const expectUnread = async (patch: string) => {
      expect(parseApplyPatch(patch)).toBeNull();
      const f = await fuigoRun(patch);
      expect(f.opened.toolInputMissing).toBe("patch");
      expect(f.verdict(NO_LIMITS).approve).toBeNull();
      const c = codexPatch(patch);
      expect(c.route).toMatchObject({ route: "ask", tool: "edit", toolInputMissing: "patch" });
      expect(c.verdict(NO_LIMITS)?.approve).toBeNull();
    };
    const hunks = (): Record<string, string[]> => ({
      delete: [`*** Delete File: ${outside()}`],
      add: [`*** Add File: ${outside()}`, "+x"],
      update: [`*** Update File: ${outside()}`, "@@", "-a", "+b"],
    });

    it("R3-1: an indented header after an Add hunk is unread on both engines", async () => {
      for (const pad of [" ", "  ", "\t", " "]) {
        for (const [first, ...rest] of Object.values(hunks())) await expectUnread(env(`*** Add File: ${inside()}`, "+hi", `${pad}${first}`, ...rest));
      }
    }, 60_000);

    it("R3-2: the same indented header inside an Update hunk is unread (ambiguous across engines)", async () => {
      // Astra subset M2: two spaces, NBSP, U+0085 and U+FEFF beside the space and the tab
      for (const pad of [" ", "\t", "  ", "\u00A0", "\u0085", "\uFEFF"]) {
        for (const [first, ...rest] of Object.values(hunks())) await expectUnread(env(`*** Update File: ${inside()}`, "@@", "-a", "+b", `${pad}${first}`, ...rest));
      }
    }, 60_000);

    it("R3-3: CRLF line endings are read with the same destinations; a header ending \\r\\r, a space or a tab is unread", async () => {
      const body = [`*** Add File: ${inside()}`, "+hi", `*** Update File: ${inside2()}`, "@@", "-a", "+b"];
      const lf = env(...body);
      const crlf = `${["*** Begin Patch", ...body, "*** End Patch"].join("\r\n")}\r\n`;
      expect(parseApplyPatch(crlf)?.destinations).toEqual(parseApplyPatch(lf)?.destinations);
      expect(parseApplyPatch(crlf)?.destinations).toEqual([inside(), inside2()]);
      const f = await fuigoRun(crlf);
      expect(f.opened.toolInputMissing).toBeUndefined();
      expect(f.opened.filePaths).toEqual([inside(), inside2()]);
      expect(f.verdict(FULL).approve).toEqual(expect.any(String));
      expect(codexPatch(crlf).route).toMatchObject({ route: "allow", why: "own-workspace", destinations: [inside(), inside2()] });
      for (const tail of ["\r\r", " ", "\t"]) await expectUnread(env(`*** Add File: ${inside()}`, "+hi", `*** Delete File: ${outside()}${tail}`));
    }, 60_000);

    it("R3-4: an unknown *** line is unread", async () => {
      for (const marker of ["*** Environment ID: x", "*** Frobnicate", "***", "*** End Patch"]) await expectUnread(env(`*** Add File: ${inside()}`, "+hi", marker, `*** Add File: ${inside2()}`, "+x"));
    }, 60_000);

    it("R3-5: a Move to out from outside the project meets the stop line; a Move not straight after its header is unread", async () => {
      const move = env(`*** Update File: ${outside()}`, `*** Move to: ${inside()}`, "@@", "-a", "+b");
      expect(parseApplyPatch(move)?.removed).toEqual([outside()]);
      const f = await fuigoRun(move);
      expect(f.verdict(FULL).approve).toBeNull();
      const c = codexPatch(move);
      expect(c.route).toMatchObject({ route: "ask", toolCall: { name: "edit", input: { removed: [outside()] } } });
      expect(c.stopLine).toMatchObject({ kind: "delete" });
      expect(c.verdict(FULL)?.approve).toBeNull();
      await expectUnread(env(`*** Update File: ${inside()}`, "@@", "-a", "+b", `*** Move to: ${inside2()}`));
    }, 60_000);

    it("R3-6: a Delete outside the project meets the stop line at Full access on Fuigo and on Codex; inside it runs", async () => {
      const out = env(`*** Delete File: ${outside()}`);
      const f = await fuigoRun(out);
      expect(f.verdict(FULL).approve).toBeNull();
      const c = codexPatch(out);
      expect(c.route).toMatchObject({ route: "ask", toolCall: { name: "edit", input: { removed: [outside()] } } });
      expect(c.stopLine).toMatchObject({ kind: "delete" });
      expect(c.verdict(FULL)?.approve).toBeNull();
      const inn = env(`*** Delete File: ${inside()}`);
      expect((await fuigoRun(inn)).verdict(FULL).approve).toEqual(expect.any(String));
      expect(codexPatch(inn).route).toMatchObject({ route: "allow", why: "own-workspace" });
    }, 60_000);

    it("R3-7: a heredoc-wrapped and a whitespace-padded envelope are read like the plain one", async () => {
      const plain = env(`*** Add File: ${inside()}`, "+hi");
      for (const wrapped of [`<<'EOF'\n${plain}\nEOF\n`, `<<EOF\n${plain}\nEOF`, `  \n\t*** Begin Patch \n*** Add File: ${inside()}\n+hi\n  *** End Patch \n\n`]) {
        expect(parseApplyPatch(wrapped)?.destinations).toEqual([inside()]);
        const f = await fuigoRun(wrapped);
        expect(f.opened.toolInputMissing).toBeUndefined();
        expect(f.verdict(FULL).approve).toEqual(expect.any(String));
        expect(codexPatch(wrapped).route).toMatchObject({ route: "allow", why: "own-workspace", destinations: [inside()] });
      }
    }, 60_000);

    it("R3-8 (G3, 1.0.10): apply_patch named in a shell command is a delete nobody can place, in-project patches included", async () => {
      // designs/ISSUE-PERMS-DESIGN-1010.md section 3 item 4: no accepted form. Codex itself runs the plain argv and heredoc
      // forms as its apply_patch tool (read by the strict reader above); only forms it did not take reach its PATH helper.
      const shell = (command: string) => ({ toolCallId: "call-sh", kind: "execute", title: "Run command", status: "pending", rawInput: { command } });
      const stops = [
        `apply_patch <<'EOF'\n${env(`*** Delete File: ${outside()}`)}\nEOF`,
        `applypatch '${env(`*** Delete File: ${outside()}`)}'`,
        `apply_patch <<'EOF'\n${env(`*** Update File: ${outside()}`, `*** Move to: ${inside()}`, "@@", "-a", "+b")}\nEOF`,
        `echo "$P" | apply_patch`,
        `apply_patch <<'EOF'\nnot a patch\nEOF`,
        // before (rev 3-5): the one plain form inside the project ran with no card
        `apply_patch <<'EOF'\n${env(`*** Add File: ${inside()}`, "+hi")}\nEOF`,
        `apply_patch <<'EOF'\n${env(`*** Delete File: ${inside()}`)}\nEOF`,
      ];
      for (const command of stops) {
        const f = await fuigo(shell(command));
        expect(f.verdict(FULL).approve, command).toBeNull();
        const c = codex("exec_command", { cmd: command });
        expect(c.stopLine, command).toMatchObject({ kind: "delete" });
        expect(c.verdict(FULL)?.approve, command).toBeNull();
      }
      // a command that does not name the helper is judged exactly as before
      for (const command of ["ls -la", `cat ${inside()}`]) {
        expect((await fuigo(shell(command))).verdict(FULL).approve, command).toEqual(expect.any(String));
        expect(codex("exec_command", { cmd: command }).stopLine, command).toBeNull();
      }
    }, 90_000);

    it("R3-16 (GrokBuild r2 UNVERIFIED, now proven): an empty or missing Codex patch keeps its card at No limits", () => {
      // codex-hook.ts routeDelivery: no patch it can read is an edit ask with toolInputMissing "patch"; contracts.ts
      // requiredFields reads that as unread, and auto-approve.ts holds an unread call at every level, No limits included
      for (const input of [{ input: "" }, { input: "   \n" }, { input: "*** Begin Patch\n*** End Patch" }, {}, { input: 42 }]) {
        const c = codex("apply_patch", input);
        expect(c.route, JSON.stringify(input)).toMatchObject({ route: "ask", tool: "edit", toolInputMissing: "patch" });
        expect(c.verdict(NO_LIMITS, { fullAccessOrigin: "owner" }), JSON.stringify(input)).toMatchObject({ approve: null, source: "unread-call" });
        expect(c.verdict(NO_LIMITS), JSON.stringify(input)).toMatchObject({ approve: null, source: "unread-call" });
      }
      expect(codex("apply_patch", null).route).toMatchObject({ route: "ask", toolInputMissing: "patch" });
      expect(codex("apply_patch", "").route).toMatchObject({ route: "ask", toolInputMissing: "patch" });
    });

    it("R3-9: Astra r2's regression (an Add inside, then ' *** Delete File:' elsewhere) is unread on both", async () => {
      await expectUnread(env(`*** Add File: ${inside()}`, "+hi", ` *** Delete File: ${join(scratch, "elsewhere", "ledger.csv")}`));
    }, 30_000);

    it("H1 (Astra subset): the exact \"codex \" request with an outside Delete still cards at Full access and No limits", async () => {
      const astra = (namespace: string, key = "fuigo/tool") => ({
        toolCallId: "patch-1", kind: "edit", title: "Apply patch", status: "pending",
        _meta: { [key]: { version: 1, namespace, name: "apply_patch", kind: "edit" } },
        locations: [{ path: outside() }],
        rawInput: { patch: `*** Begin Patch\n*** Delete File: ${outside()}\n*** End Patch` },
      });
      // before: core.ts kept "codex " (patch never read), stop-line.ts compared it untrimmed, app-action-grant.ts trimmed it
      // and accepted the stamp, so the outside delete ran at Full access
      for (const [namespace, key] of [["codex ", "fuigo/tool"], ["codex ", "x.ai/tool"], [" codex", "fuigo/tool"], ["\tcodex\n", "fuigo/tool"], ["\u00A0codex\uFEFF", "fuigo/tool"], ["codex\u200B", "fuigo/tool"]] as const) {
        const f = await fuigo(astra(namespace, key));
        const label = JSON.stringify([namespace, key]);
        expect(f.verdict(FULL).approve, label).toBeNull();
        expect(f.verdict(NO_LIMITS).approve, label).toBeNull();
        expect(f.verdict(FULL, { fullAccessOrigin: "owner" }).approve, label).toBeNull();
      }
      const padded = await fuigo(astra("codex "));
      expect(padded.opened.toolIdentity).toMatchObject({ namespace: "codex ", name: "apply_patch" });
      expect(padded.verdict(FULL)).toMatchObject({ approve: null, source: "unread-call", rule: `the tool this runs cannot be proven: ${STAMP_SPELLING_WHY}` });
      expect(padded.verdict(NO_LIMITS)).toMatchObject({ approve: null, source: "unread-call" });
      expect(padded.verdict(FULL, { fullAccessOrigin: "owner" })).toMatchObject({ approve: null, source: "unread-call" });
    }, 90_000);

    it("GrokBuild subset M1: the heredoc closer is exactly EOF; NOTEOF, XEOF or an indented EOF closes nothing", async () => {
      const plain = env(`*** Add File: ${inside()}`, "+hi");
      for (const closer of ["NOTEOF", "XEOF", " EOF", "EOFX", "eof"]) {
        await expectUnread(`<<'EOF'\n${plain}\n${closer}`);
        await expectUnread(`<<EOF\n${plain}\n${closer}\n`);
      }
      // the exact closer still reads (R3-7), and an outside Delete inside the exact form still stops
      expect(parseApplyPatch(`<<'EOF'\n${plain}\nEOF`)?.destinations).toEqual([inside()]);
      const del = `<<"EOF"\n${env(`*** Delete File: ${outside()}`)}\nEOF`;
      expect(codexPatch(del).stopLine).toMatchObject({ kind: "delete" });
      expect((await fuigoRun(del)).verdict(FULL).approve).toBeNull();
    }, 90_000);

    it("Codex G2 (subset M1): an outside Delete or Move on the Codex route cards with the delete wording, not 'could not read'", () => {
      const rows = [
        env(`*** Delete File: ${outside()}`),
        env(`*** Update File: ${outside()}`, `*** Move to: ${inside()}`, "@@", "-a", "+b"),
        env(`*** Add File: ${inside()}`, "+hi", `*** Delete File: ${outside()}`),
      ];
      for (const patch of rows) {
        const c = codexPatch(patch);
        expect(c.stopLine, patch).toMatchObject({ kind: "delete" });
        expect(c.stopLine?.what, patch).toContain("ledger.csv");
        expect(c.stopLine?.what, patch).not.toMatch(/could not read/);
        // the final verdict too, so this cannot pass on the stop-line hit alone: the Codex edit contract still reads `changes`
        for (const bot of [FULL, NO_LIMITS]) {
          expect(c.verdict(bot), patch).toMatchObject({ approve: null, source: "unread-call", rule: "the call does not carry what this tool needs (changes)" });
        }
      }
      // a readable outside edit that removes nothing is not a delete: the contract still holds it as one it cannot read
      const edit = codexPatch(env(`*** Update File: ${outside()}`, "@@", "-a", "+b"));
      expect(edit.route).toMatchObject({ route: "ask", toolCall: { name: "edit" } });
      expect(edit.stopLine?.what ?? "").not.toContain("ledger.csv");
      expect(edit.verdict(FULL)?.approve).toBeNull();
      // a missing patch keeps its unread card (R3-16), never a delete wording
      expect(codexPatch("").stopLine?.what ?? "").not.toContain("ledger.csv");
    });

    // R3-10..R3-15 (rounds 3-5's shell-form reader) are dropped with that reader; every row they held, and every
    // reviewer form from rounds 1-5, is in server/stop-line-bypass-corpus.test.ts with the 1.0.9 strictness proof.
  });
});

describe("ISSUE-PERMS-1010 A: a slow environment check at the routine's own level", () => {
  const command = (bot: AutoApprover, patch: Partial<AutoContext>) => autoVerdict(bot, "shell", "echo brief", {
    commandText: "echo brief", call: { engine: "acp", toolKind: "execute", toolCall: { name: "shell", input: { command: "echo brief" } } },
    envUnchecked: { reason: "timeout" } as AutoContext["envUnchecked"], ...patch,
  });
  it("is waived for a routine run judged at Full access or No limits", () => {
    // before: held with "the environment check took too long" on every routine command
    expect(command(FULL, ROUTINE).approve).toEqual(expect.any(String));
    expect(command(NO_LIMITS, ROUTINE).approve).toEqual(expect.any(String));
    expect(command(FULL, { fullAccessOrigin: "owner" }).approve).toEqual(expect.any(String));
    expect(command(FULL, { fullAccessOrigin: "routine", routineLevel: true }).approve).toEqual(expect.any(String));
  });
  it("still holds at Auto and Ask, for someone else's turn, an unattended turn and the owner's channel message", () => {
    expect(command(AUTO, ROUTINE)).toMatchObject({ approve: null, source: "unread-call" });
    expect(command({}, ROUTINE).approve).toBeNull();
    expect(command(FULL, { fullAccessOrigin: "other", automated: true }).approve).toBeNull();
    expect(command(FULL, { fullAccessOrigin: "other", unattended: true, routineLevel: true }).approve).toBeNull();
    // conflicting fields: a stored "other" origin with a routine level but nobody's own run stays held
    expect(command(FULL, { fullAccessOrigin: "other", routineLevel: true, unattended: true, automated: true }).approve).toBeNull();
    expect(command(FULL, {}).approve).toBeNull();
    expect(command({ ...FULL, fullAccessChannelMessages: true }, { fullAccessOrigin: "owner-channel", channelOwner: true }).approve).toBeNull();
  });
  it("A7 (Rev 3 #7(a)): a stored \"other\" origin is never waived, whatever its routine level", () => {
    // before: fullAccessOriginOf read routineLevel first and called this turn the routine's own, so the check was waived
    expect(command(FULL, { fullAccessOrigin: "other", routineLevel: true, unattended: false }).approve).toBeNull();
    expect(command(FULL, { fullAccessOrigin: "owner-channel", routineLevel: true, unattended: false }).approve).toBeNull();
  });
});
