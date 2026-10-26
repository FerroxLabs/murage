// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r#7 (1.0.7): Fuigo edits files with Codex's apply_patch (fuigo-tools codex/apply_patch). Its stamp names the namespace
// `codex`, which Murage did not read, so every patch was an unproven call that asked at every level, Full access and No
// limits included. The ask below is the one fuigo-shell sends for ToolInput::ApplyPatch (acp_session_impl/tool_calls.rs):
// kind `edit`, no locations, no content, rawInput `{patch}`, and the CanonicalToolMeta stamp. The patch is read with the
// one apply_patch reader (shared/apply-patch.ts) and judged exactly as Fuigo's `write` of the same paths; a patch it
// cannot read whole stays unread and holds at every level.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { parseApplyPatch, patchTextOf } from "../../../shared/apply-patch.ts";
import { resolveCall, type GrantCall } from "../../../shared/app-action-grant.ts";
import { autoVerdict, type AutoApprover } from "../../auto-approve.ts";
import { classifyAsk, type StopLinePlace } from "../../stop-line.ts";
import { GrokAgentDriver } from "./grok.ts";
import { acpPatchPaths } from "./core.ts";

vi.mock("node:child_process", async (original) => (await import("../../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const ASK: AutoApprover = { autoApprove: false };
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, AutoApprover]> = [["Ask", ASK], ["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]];

const stamp = (name = "apply_patch", namespace = "codex") => ({ "fuigo/tool": { version: 1, name, kind: "edit", namespace, label: "Apply patch", read_only: false } });
const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch\n`;
/** fuigo-shell's request_permission tool call for ToolInput::ApplyPatch. */
const fuigoPatch = (rawInput: unknown, meta: object = stamp(), kind = "edit") => ({ toolCallId: "call-patch", kind, title: "Apply patch", status: "pending", rawInput, _meta: meta });
const fuigoWrite = (file: string) => ({
  toolCallId: "call-write", kind: "edit", title: `Write \`${file}\``, status: "pending",
  rawInput: { file_path: file, content: "# notes\n" }, locations: [{ path: file }],
  _meta: { "fuigo/tool": { version: 1, name: "write", kind: "write", namespace: "opencode", label: "Write", read_only: false } },
});

describe("the apply_patch reader, as the engines' parser reads a patch", () => {
  it("reports every place a patch writes and removes", () => {
    const parsed = parseApplyPatch(envelope("*** Add File: a.md\n+hi\n*** Update File: b.md\n*** Move to: c.md\n@@\n-x\n+y\n*** Delete File: d.md"));
    expect(parsed?.destinations).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(parsed?.deletes).toEqual(["b.md", "d.md"]);
    expect(parsed?.added.get("c.md")).toBe("y");
  });

  it.each([
    ["an indented header after an Add hunk (the engine trims it into a header)", "*** Add File: a.md\n+hi\n  *** Add File: /etc/cron.d/x\n+evil"],
    ["a tab-indented header", "*** Add File: a.md\n+hi\n\t*** Delete File: /etc/passwd"],
    ["a header indented by U+0085", "*** Add File: a.md\n+hi\n\u0085*** Delete File: /etc/passwd"],
    ["a header path with trailing whitespace", "*** Add File: a.md \n+hi"],
    ["a header path with leading whitespace", "*** Add File:  /etc/x\n+hi"],
    ["a Move with nothing to move", "*** Move to: a.md"],
    ["an unknown marker", "*** Add File: a.md\n+hi\n*** Rename File: b.md"],
  ])("is unread for %s", (_label, body) => {
    expect(parseApplyPatch(envelope(body))).toBeNull();
  });

  it("is unread for a patch that is not one whole envelope", () => {
    expect(parseApplyPatch(`<<EOF\n${envelope("*** Add File: a.md\n+hi")}EOF\n`)).toBeNull();
    expect(parseApplyPatch("*** Begin Patch\n*** Add File: a.md\n+hi\n")).toBeNull();
    expect(parseApplyPatch(`  ${envelope("*** Add File: a.md\n+hi")}`)).toBeNull();
    expect(parseApplyPatch(envelope(""))).toBeNull();
  });

  it("keeps a markdown rule and other context lines inside an update", () => {
    expect(parseApplyPatch(envelope("*** Update File: notes.md\n@@\n ***\n-old\n+new\n*** End of File"))?.destinations).toEqual(["notes.md"]);
  });

  it("takes the patch text the engine takes, and nothing ambiguous", () => {
    expect(patchTextOf("p")).toBe("p");
    expect(patchTextOf({ patch: "p" })).toBe("p");
    expect(patchTextOf({ input: "p" })).toBe("p");
    expect(patchTextOf({ raw: "p" })).toBe("p");
    expect(patchTextOf({ patch: "p", raw: "q" })).toBeUndefined();
    expect(patchTextOf({ patch: "p", cmd: " " })).toBeUndefined();
    expect(patchTextOf({ patch: "p", command: "echo hi" })).toBeUndefined();
    expect(patchTextOf({ patch: "p", paths: ["x"] }, ["paths"])).toBe("p");
    expect(patchTextOf({ patch: "p", paths: ["x"], cmd: " " }, ["paths"])).toBeUndefined();
    expect(patchTextOf({ patch: 1 })).toBeUndefined();
    expect(patchTextOf({})).toBeUndefined();
  });
});

describe.runIf(process.platform === "win32")("a Fuigo patch path on Windows, as the engine's join writes it", () => {
  const cwd = "D:\\work\\bot";
  const placed = (path: string) => acpPatchPaths({ kind: "edit", rawInput: { patch: envelope(`*** Add File: ${path}\n+x`) }, _meta: stamp() }, cwd);
  it.each([
    ["a relative path, in Windows' own separator", "notes/a.md", "D:\\work\\bot\\notes\\a.md"],
    ["a climb, never collapsed", "jump/../a.md", "D:\\work\\bot\\jump\\..\\a.md"],
    ["a root-relative path, on the session folder's drive", "\\secret.md", "D:\\secret.md"],
    ["a root-relative path with a forward slash", "/secret.md", "D:/secret.md"],
    ["a drive path, byte for byte", "C:/x/a.md", "C:/x/a.md"],
    ["a UNC path, byte for byte", "//host/share/a.md", "//host/share/a.md"],
    ["a \\\\?\\ path, where / is a plain character", "\\\\?\\C:\\foo/bar.md", "\\\\?\\C:\\foo/bar.md"],
  ])("%s", (_label, path, expected) => {
    expect(placed(path)).toEqual([expected]);
  });
});

describe("Fuigo's codex/apply_patch over ACP", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  let workspace: string;
  let place: StopLinePlace;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-fuigo-patch-"));
    workspace = join(scratch, "home", ".murage", "workspaces", "bot-ember");
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    mkdirSync(join(scratch, "home", "Documents"), { recursive: true });
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
    await instance.adapter.sendTurn({ threadId: id, text: "go", cwd: workspace } as any);
    const opened = (await recorder.until((e) => e.type === "request.opened")) as any;
    await instance.adapter.respondToRequest(id, opened.requestId, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    await instance.dispose();
    instance = undefined;
    recorder.stop();
    recorder = undefined;
    return opened;
  };
  const callOf = (opened: any): GrantCall => ({
    toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
    mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing, truncated: false,
  });
  const judged = (opened: any) => {
    const call = callOf(opened);
    const stopHit = classifyAsk({ ...call, tool: opened.tool, summary: opened.summary }, place);
    const verdict = (bot: AutoApprover) => autoVerdict(bot, opened.tool, opened.summary, { call, stopLine: stopHit });
    return { call, stopHit, verdict };
  };

  it("reads a patch into the bot's own folder whole and judges it as Fuigo's write of the same file, at every level", async () => {
    const file = join(workspace, "outputs", "brief.md");
    const patch = await asked("t-patch-in", fuigoPatch({ patch: envelope("*** Add File: outputs/brief.md\n+# Brief\n+- follow up") }));
    expect(patch.toolIdentity).toEqual({ namespace: "codex", name: "apply_patch", kind: "edit" });
    expect(patch.toolInputMissing).toBeUndefined();
    expect(patch.filePaths).toEqual([file]);
    expect(patch.summary).toBe(file);
    const p = judged(patch);
    expect(resolveCall(p.call)).toMatchObject({ kind: "engine", name: "apply_patch", wrapped: false });
    expect(p.stopHit).toBeNull();
    const w = judged(await asked("t-write-in", fuigoWrite(file)));
    for (const [label, bot] of LEVELS) {
      const verdict = p.verdict(bot);
      expect(verdict.source, label).not.toBe("unread-call");
      expect(verdict.approve === null, label).toBe(w.verdict(bot).approve === null);
    }
    expect(p.verdict(AUTO).approve).toEqual(expect.any(String));
    expect(p.verdict(FULL).approve).toEqual(expect.any(String));
  }, 120_000);

  it("judges a patch outside the bot's folder as the same write outside: the same card, never unread", async () => {
    const file = join(scratch, "home", "Documents", "notes.md");
    const p = judged(await asked("t-patch-out", fuigoPatch({ patch: envelope(`*** Update File: ${file}\n@@\n-a\n+b`) })));
    const w = judged(await asked("t-write-out", fuigoWrite(file)));
    expect(p.stopHit).toBeNull();
    for (const [label, bot] of LEVELS) {
      expect(p.verdict(bot).source, label).not.toBe("unread-call");
      expect(p.verdict(bot).approve === null, label).toBe(w.verdict(bot).approve === null);
    }
  }, 120_000);

  it.skipIf(process.platform === "win32")("places a path through a link as the engine does: `link/..` is kept, never collapsed into the bot's folder", async () => {
    // outputs/jump points at ~/Documents, so outputs/jump/../taxes.md is ~/taxes.md to the engine (cwd.join keeps `..`)
    symlinkSync(join(scratch, "home", "Documents"), join(workspace, "outputs", "jump"));
    const given = `${workspace}/outputs/jump/../taxes.md`;
    const patch = await asked("t-patch-link", fuigoPatch({ patch: envelope("*** Add File: outputs/jump/../taxes.md\n+x") }));
    expect(patch.filePaths).toEqual([given]);
    expect(patch.filePaths).not.toContain(join(workspace, "outputs", "taxes.md"));
    const p = judged(patch);
    const w = judged(await asked("t-write-link", fuigoWrite(given)));
    for (const [label, bot] of LEVELS) expect(p.verdict(bot).approve === null, label).toBe(w.verdict(bot).approve === null);
  }, 120_000);

  it("a patch that deletes or moves away a file outside the bot's folders stops, as a delete does", async () => {
    const outside = join(scratch, "home", "Documents", "keep.md");
    for (const body of [`*** Delete File: ${outside}`, `*** Update File: ${outside}\n*** Move to: outputs/keep.md\n@@\n-a\n+b`]) {
      const opened = await asked("t-patch-del", fuigoPatch({ patch: envelope(body) }));
      const { stopHit, verdict } = judged(opened);
      expect(stopHit).toMatchObject({ kind: "delete" });
      expect(verdict(FULL)).toMatchObject({ approve: null, source: "stop-line" });
    }
    // inside, a delete is the bot's own housekeeping: no stop
    const inside = judged(await asked("t-patch-del-in", fuigoPatch({ patch: envelope("*** Delete File: outputs/old.md") })));
    expect(inside.stopHit).toBeNull();
  }, 120_000);

  it.each([
    ["an indented header the engine would read", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi\n  *** Add File: /etc/cron.d/x\n+evil") })],
    ["a heredoc-wrapped patch", fuigoPatch({ patch: `<<EOF\n${envelope("*** Add File: outputs/a.md\n+hi")}EOF` })],
    ["a patch with no envelope", fuigoPatch({ patch: "*** Add File: outputs/a.md\n+hi" })],
    ["two patch keys", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi"), input: envelope("*** Add File: /etc/x\n+hi") })],
    ["a path key beside the patch", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi"), file_path: "outputs/a.md" })],
    ["a cmd beside a patch that deletes outside", fuigoPatch({ patch: envelope("*** Delete File: C:\\Users\\owner\\Documents\\taxes.pdf"), cmd: " " })],
    ["a command beside the patch", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi"), command: "echo hi" })],
    ["a drive-relative destination", fuigoPatch({ patch: envelope("*** Add File: C:notes.md\n+hi") })],
    ["no patch at all", fuigoPatch({})],
  ])("holds a patch it cannot read whole at every level: %s", async (_label, toolCall) => {
    const opened = await asked("t-patch-unread", toolCall);
    expect(opened.toolInputMissing).toBe("patch");
    const { stopHit, verdict } = judged(opened);
    expect(stopHit).not.toBeNull();
    for (const [label, bot] of LEVELS) expect(verdict(bot), label).toMatchObject({ approve: null, source: "unread-call" });
  }, 120_000);

  it.each([
    ["another tool in the codex namespace", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi") }, stamp("shell"))],
    ["apply_patch filed under another kind", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi") }, stamp(), "other")],
    ["apply_patch in a namespace Murage does not read", fuigoPatch({ patch: envelope("*** Add File: outputs/a.md\n+hi") }, stamp("apply_patch", "codex_next"))],
  ])("keeps an identity it cannot prove unproven: %s", async (_label, toolCall) => {
    const opened = await asked("t-patch-unproven", toolCall);
    const { call, stopHit, verdict } = judged(opened);
    expect(resolveCall(call).kind).toBe("unproven");
    expect(stopHit).not.toBeNull();
    for (const [label, bot] of [["Ask", ASK], ["Auto", AUTO]] as const) expect(verdict(bot), label).toMatchObject({ approve: null, source: "unread-call" });
  }, 120_000);
});
