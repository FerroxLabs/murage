// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 fix/104-approval-readable: Fuigo (and Grok Build) write a whole file
// with the OpenCode `write` tool their preset adds. Its stamp names the
// namespace `opencode`, which Murage did not read, so every plain write into
// the bot's own outputs folder was an unproven call: the card said "Murage
// could not read this action whole", the stop line held it as a tool it could
// not tell, and the phone rated it high risk (Deny-only in a paired browser).
// The ask below is the one fuigo-shell sends for ToolInput::Write
// (acp_session_impl/tool_calls.rs): kind `edit`, the file in `locations`,
// rawInput `{file_path, content}`, a diff content block, and the
// CanonicalToolMeta stamp (fuigo-tools opencode/write, ToolNamespace::OpenCode).
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { resolveCall, stampedToolCall, type GrantCall } from "../../../shared/app-action-grant.ts";
import { approvalHoldNote, autoVerdict, type AutoApprover } from "../../auto-approve.ts";
import { classifyAsk, type StopLinePlace } from "../../stop-line.ts";
import { liveRating, pushRiskFor, workspaceInside } from "../../mobile-push-risk.ts";
import { GrokAgentDriver } from "./grok.ts";

vi.mock("node:child_process", async (original) => (await import("../../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const ASK: AutoApprover = { autoApprove: false };
const AUTO: AutoApprover = { autoApprove: true };
const UNREAD_NOTE = "Murage could not read this action whole. Review it before allowing it.";

/** A plain markdown brief, long enough to pass every card display cap. */
const BRIEF = `# Brightline follow-ups\n\n${"- Rosa Delgado: confirm the $6,800 quote and the week of Nov 9.\n".repeat(120)}`;

const writeStamp = (key = "fuigo/tool") => ({ [key]: { version: 1, name: "write", kind: "write", namespace: "opencode", label: "Write", read_only: false } });
/** fuigo-shell's request_permission tool call for ToolInput::Write. */
const fuigoWrite = (file: string, meta: object = writeStamp(), kind = "edit") => ({
  toolCallId: "call-write", kind, title: `Write \`${file}\``, status: "pending",
  rawInput: { file_path: file, content: BRIEF },
  locations: [{ path: file }],
  content: [{ type: "diff", path: file, oldText: "", newText: BRIEF }],
  _meta: meta,
});

describe("a plain file write from Fuigo's write tool", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  let workspace: string;
  let place: StopLinePlace;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-fuigo-write-"));
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
  // the GrantCall server/index.ts builds from request.opened
  const callOf = (opened: any): GrantCall => ({
    toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
    mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing, truncated: false,
  });
  const judged = (opened: any) => {
    const call = callOf(opened);
    const stopHit = classifyAsk({ ...call, tool: opened.tool, summary: opened.summary }, place);
    const verdict = (bot: AutoApprover) => autoVerdict(bot, opened.tool, opened.summary, { call, stopLine: stopHit });
    // the push rating as server/index.ts takes it (pushRiskCall, pushWriteInside), then the card's live re-rating
    const stamped = stampedToolCall(call);
    const engine = stamped ? { input: stamped.input, name: [stamped.name, call.toolCall?.name].filter(Boolean).join(" ") } : { input: call.toolCall?.input, name: stamped === null ? "use tool" : call.toolCall?.name };
    const inside = workspaceInside(place, []);
    const base = pushRiskFor(stopHit, opened.tool, opened.summary, { ...engine, filePaths: opened.filePaths, inside });
    const phone = liveRating(base, { stopHit, tool: opened.tool, summary: opened.summary, inside });
    return { call, stopHit, verdict, phone };
  };

  it.each([
    ["Fuigo's stamp", writeStamp("fuigo/tool")],
    ["Grok Build's stamp", writeStamp("x.ai/tool")],
  ])("reads a .md write into the bot's own outputs folder whole (%s)", async (_label, meta) => {
    const file = join(workspace, "outputs", "brightline-follow-ups.md");
    const opened = await asked("t-write", fuigoWrite(file, meta));
    expect(opened.toolKind).toBe("edit");
    expect(opened.toolIdentity).toEqual({ namespace: "opencode", name: "write", kind: "write" });
    const { call, stopHit, verdict, phone } = judged(opened);

    expect(resolveCall(call)).toMatchObject({ kind: "engine", name: "write", wrapped: false });
    // no stop: a write inside the bot's own folder deletes, pays and messages nobody
    expect(stopHit).toBeNull();
    // Ask keeps its ordinary card, with no "could not read" line
    const ask = verdict(ASK);
    expect(ask.approve).toBeNull();
    expect(ask.source).not.toBe("unread-call");
    expect(approvalHoldNote(ask)).not.toBe(UNREAD_NOTE);
    // Auto answers it as it answers any ordinary edit
    const auto = verdict(AUTO);
    expect(auto.source).not.toBe("unread-call");
    expect(auto.approve).toEqual(expect.any(String));
    // the phone follows its existing rule: a write that lands inside is rated low (lowRisk: Allow offered)
    expect(phone).toBe("low");
  }, 120_000);

  it("keeps the existing phone rule for a write outside the bot's folders: rated high risk", async () => {
    const opened = await asked("t-write-out", fuigoWrite(join(scratch, "home", "Documents", "notes.md")));
    const { call, verdict, phone } = judged(opened);
    expect(resolveCall(call)).toMatchObject({ kind: "engine", name: "write" });
    expect(verdict(ASK).source).not.toBe("unread-call");
    expect(phone).toBe("risky");
  }, 120_000);

  it.each([
    ["another tool in the opencode namespace", fuigoWrite("/x/notes.md", { "fuigo/tool": { version: 1, name: "bash", kind: "execute", namespace: "opencode" } }, "edit")],
    ["the write tool filed under another kind", fuigoWrite("/x/notes.md", writeStamp(), "other")],
    ["a namespace Murage does not read", fuigoWrite("/x/notes.md", { "fuigo/tool": { version: 1, name: "write", kind: "write", namespace: "opencode_next" } })],
    ["a stamp it cannot read", fuigoWrite("/x/notes.md", { "fuigo/tool": { version: 1, name: "", namespace: "opencode" } })],
  ])("still holds a call it cannot read whole, with the warning: %s", async (_label, toolCall) => {
    place = { ...place, roots: ["/x"], cwd: "/x" };
    const opened = await asked("t-unread", toolCall);
    const { call, stopHit, verdict, phone } = judged(opened);
    expect(resolveCall(call).kind).toBe("unproven");
    expect(stopHit).not.toBeNull();
    for (const bot of [ASK, AUTO]) {
      const held = verdict(bot);
      expect(held).toMatchObject({ approve: null, source: "unread-call" });
      expect(approvalHoldNote(held)).toBe(UNREAD_NOTE);
    }
    expect(phone).toBe("risky");
  }, 120_000);
});
