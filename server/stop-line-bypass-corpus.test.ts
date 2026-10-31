// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ISSUE-PERMS-1010, the 1.0.10 subset (designs/ISSUE-PERMS-DESIGN-1010.md rev 2, sections 3 and 4.1/4.4).
// Every reviewer form from rounds 1-5 lives in server/testing/stop-line-bypass-corpus.json. Each row is judged the way
// the server judges it (the stop line's reader, the Codex hook route, the verdict at Full access, Auto and No limits), and
// compared with what shipped 1.0.9 (ed8af4fd5) did with the same row, recorded in server/testing/stop-line-bypass-109.json.
// The strictness proof: whatever 1.0.9 held, the subset still holds, on every row and at every level. The only holds the
// subset removes on purpose (the U20 waiver on Full access / No limits routine runs, #7a, and Fuigo's codex/apply_patch
// read by its patch instead of held unproven, #7b) are not on these routes; issue-perms-1010.test.ts covers them.
//
// Re-recording the 1.0.9 column: run this file on an ed8af4fd5 tree with STOPLINE_CORPUS_RECORD=<file>.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { GrantCall } from "../shared/app-action-grant.ts";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { classifyAsk, classifyStopLine, deletesPlacedInside, type StopHit, type StopLinePlace } from "./stop-line.ts";
import { routeDelivery } from "./drivers/codex-hook.ts";
import { acpApplyPatchCall } from "./drivers/acp/core.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
type Row = { id: string; form: string; text: string | string[]; expect: "stop" | "unread" | "run" | "109"; removes?: string };
const corpus = JSON.parse(readFileSync(join(HERE, "testing", "stop-line-bypass-corpus.json"), "utf8")) as { rows: Row[] };

const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const ROUTINE: Partial<AutoContext> = { fullAccessOrigin: "routine", routineLevel: true, automated: true };
const OWNER: Partial<AutoContext> = { fullAccessOrigin: "owner" };

const scratch = mkdtempSync(join(tmpdir(), "murage-bypass-corpus-"));
const home = join(scratch, "home");
const project = join(home, ".murage", "workspaces", "bot-ember");
const outside = join(scratch, "elsewhere");
mkdirSync(project, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(project, "a.md"), "a\n");
writeFileSync(join(outside, "x"), "x\n");
afterAll(async () => { await removeTempDir(scratch); });

const place: StopLinePlace = { cwd: project, roots: [project], home, knownRecipients: new Set<string>(), realpath: (path: string) => path };
const win: StopLinePlace = { cwd: "C:\\Users\\o\\bot", roots: ["C:\\Users\\o\\bot"], home: "C:\\Users\\o", knownRecipients: new Set<string>(), realpath: (path: string) => path };

const fill = (text: string): string => {
  const del = `*** Begin Patch\n*** Delete File: ${outside}/x\n*** End Patch`;
  return text.replaceAll("{SQDEL}", del.replace(/'/g, "'\\''")).replaceAll("{P}", project).replaceAll("{O}", outside).replaceAll("{H}", home);
};

/** One row's outcome, booleans and sources only, so the 1.0.9 column does not depend on the temp folders. */
type Outcome = {
  reader: string | null;
  inside?: boolean;
  route?: string;
  missing?: string;
  held: { fullRoutine: boolean; fullOwner: boolean; auto: boolean; noLimits: boolean };
  noLimitsSource?: string;
};

function verdicts(tool: string, summary: string, call: GrantCall, stopLine: StopHit | null): Pick<Outcome, "held" | "noLimitsSource"> {
  const at = (bot: AutoApprover, patch: Partial<AutoContext>) => autoVerdict(bot, tool, summary, { call, stopLine, ...patch });
  const noLimits = at(NO_LIMITS, OWNER);
  return {
    held: { fullRoutine: at(FULL, ROUTINE).approve === null, fullOwner: at(FULL, OWNER).approve === null, auto: at(AUTO, {}).approve === null, noLimits: noLimits.approve === null },
    noLimitsSource: noLimits.source,
  };
}

/** The Codex hook path: the delivery is routed, and an ask is judged as codex.ts opens its card. */
function codexRoute(tool_name: string, tool_input: unknown): Outcome {
  const route = routeDelivery({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: project }, { mounts: [], project, home });
  if (route.route !== "ask") return { reader: null, route: route.route, held: { fullRoutine: route.route === "deny", fullOwner: route.route === "deny", auto: route.route === "deny", noLimits: route.route === "deny" } };
  const call: GrantCall = { engine: "codex", toolCall: route.toolCall as GrantCall["toolCall"], inputMissing: route.toolInputMissing, truncated: false };
  const stopLine = classifyAsk({ ...call, tool: route.tool, summary: route.summary }, place);
  return { reader: stopLine?.kind ?? null, route: "ask", ...(route.toolInputMissing ? { missing: route.toolInputMissing } : {}), ...verdicts(route.tool, route.summary, call, stopLine) };
}

function judge(row: Row): Outcome {
  const text = Array.isArray(row.text) ? row.text.map(fill) : fill(row.text);
  switch (row.form) {
    case "patch": return codexRoute("apply_patch", { input: text });
    case "patch-missing": return codexRoute("apply_patch", {});
    case "patch-null": return codexRoute("apply_patch", null);
    case "line": {
      const line = text as string;
      // the engine-neutral reader every engine's command goes through, the Auto guard's reader, and the Codex hook route
      const reader = classifyStopLine("shell", { command: line }, line, place);
      const codex = codexRoute("exec_command", { cmd: line });
      return { ...codex, reader: reader?.kind ?? null, inside: deletesPlacedInside(line, place) };
    }
    case "argv": {
      const input = { command: text };
      const reader = classifyStopLine("shell", input, "shell", place);
      return { reader: reader?.kind ?? null, ...verdicts("shell", "shell", { toolCall: { name: "shell", input } }, reader) };
    }
    case "ps": case "ps-shell": {
      const tool = row.form === "ps" ? "powershell" : "shell";
      const input = { command: text };
      const reader = classifyStopLine(tool, input, tool, win);
      return { reader: reader?.kind ?? null, ...verdicts(tool, tool, { toolCall: { name: tool, input } }, reader) };
    }
    default: throw new Error(`unknown form ${row.form}`);
  }
}

const outcomes = new Map(corpus.rows.map((row) => [row.id, judge(row)]));

/** Astra subset M2: a patch row on the Fuigo ACP route (codex/apply_patch stamp, kind edit), built as the ACP driver
 *  opens its card: acpApplyPatchCall reads the patch into `locations`, and an unread patch is `toolInputMissing: "patch"`.
 *  1.0.9 held every codex-stamped call unproven, so on this route each stop and unread row must still be held. */
function acpPatch(patch: unknown) {
  const read = acpApplyPatchCall({ toolCallId: "c", kind: "edit", title: "Apply patch", status: "pending", rawInput: { patch }, _meta: { "fuigo/tool": { version: 1, namespace: "codex", name: "apply_patch", kind: "edit" } } }, "edit");
  const call: GrantCall = {
    engine: "acp", toolKind: "edit", toolIdentity: { namespace: "codex", name: "apply_patch", kind: "edit" }, truncated: false,
    toolCall: { name: "edit", input: { ...read.toolCall.rawInput, ...(read.toolCall.locations !== undefined ? { locations: read.toolCall.locations } : {}) } },
    ...(read.unread ? { inputMissing: "patch" } : {}),
  };
  const stopLine = classifyAsk({ ...call, tool: "Apply patch", summary: "Apply patch" }, place);
  return { unread: read.unread, stopLine, at: (bot: AutoApprover, patch: Partial<AutoContext>) => autoVerdict(bot, "Apply patch", "Apply patch", { call, stopLine, ...patch }) };
}
const record = process.env.STOPLINE_CORPUS_RECORD;

// The 1.0.9 column is a Linux recording of POSIX lines: on Windows the temp path's backslashes are shell escapes, and on macOS
// /tmp is no longer the temp folder, so another OS would compare different inputs. The patch routes run on every OS in
// server/drivers/acp/issue-perms-1010.test.ts.
describe.runIf(process.platform === "linux")("ISSUE-PERMS-1010 bypass corpus (1.0.10 subset)", () => {
  if (record) {
    it("records this tree's outcomes", () => {
      writeFileSync(record, `${JSON.stringify(Object.fromEntries(outcomes), null, 1)}\n`);
    });
    return;
  }
  const base = JSON.parse(readFileSync(join(HERE, "testing", "stop-line-bypass-109.json"), "utf8")) as Record<string, Outcome>;

  it("the 1.0.9 column covers every row", () => {
    expect(Object.keys(base).sort()).toEqual(corpus.rows.map((row) => row.id).sort());
  });

  it("frees only the patch envelope and marker forms both engines read, and nothing else", () => {
    // the bounded claim: every hold this subset removes on these routes is a patch both engines apply the same way
    expect(corpus.rows.filter((row) => row.removes).map((row) => row.id).sort()).toEqual(["p-heredoc-envelope", "p-leading-blank", "p1-eof"]);
    const freed = corpus.rows.filter((row) => !row.removes && Object.entries(base[row.id]!.held).some(([level, held]) => held && !outcomes.get(row.id)!.held[level as keyof Outcome["held"]]));
    expect(freed.map((row) => row.id)).toEqual([]);
  });

  const patchRows = corpus.rows.filter((row) => row.form === "patch" && (row.expect === "stop" || row.expect === "unread"));
  it.each(patchRows.map((row) => [row.id, row] as const))("%s on the Fuigo ACP route: held at Full access, at No limits on a routine, and at Auto", (_id, row) => {
    const acp = acpPatch(fill(row.text as string));
    if (row.expect === "unread") expect(acp.unread, "unread patch").toBe(true);
    else {
      // Astra subset r2: read, not merely held: the hit names the place and the verdict is the stop line's own
      expect(acp.unread, "patch read").toBe(false);
      expect(acp.stopLine, "stop line").not.toBeNull();
      expect(acp.stopLine?.what, "a hit on the patch itself").not.toMatch(/could not (read|tell)/);
      expect(acp.at(FULL, OWNER), "final source").toMatchObject({ approve: null, source: "stop-line" });
    }
    expect(acp.at(FULL, ROUTINE).approve, "Full access routine").toBeNull();
    expect(acp.at(FULL, OWNER).approve, "Full access owner").toBeNull();
    expect(acp.at(NO_LIMITS, ROUTINE).approve, "No limits routine").toBeNull();
    expect(acp.at(AUTO, {}).approve, "Auto").toBeNull();
    if (row.expect === "unread") expect(acp.at(NO_LIMITS, OWNER), "No limits owner").toMatchObject({ approve: null, source: "unread-call" });
  });

  it.each(corpus.rows.filter((row) => row.expect === "stop" || row.expect === "unread").map((row) => [row.id, row] as const))("%s at No limits on a routine (not the owner's turn): the stop line and unread card still hold", (_id, row) => {
    // the 1.0.9 column records No limits for the owner's own turn only, where No limits lifts the stop line; a routine,
    // webhook or someone else's turn keeps it (auto-approve.ts), so every stop and unread row is held there too
    const text = Array.isArray(row.text) ? row.text.map(fill) : fill(row.text);
    const judgeAt = (tool: string, summary: string, call: GrantCall, stopLine: StopHit | null) => autoVerdict(NO_LIMITS, tool, summary, { call, stopLine, ...ROUTINE });
    switch (row.form) {
      case "patch": case "patch-missing": case "patch-null": {
        const input = row.form === "patch" ? { input: text } : row.form === "patch-missing" ? {} : null;
        const route = routeDelivery({ tool_name: "apply_patch", tool_input: input, tool_use_id: "u1", turn_id: "t1", cwd: project }, { mounts: [], project, home });
        if (route.route !== "ask") { expect(route.route).toBe("deny"); return; }
        const call: GrantCall = { engine: "codex", toolCall: route.toolCall as GrantCall["toolCall"], inputMissing: route.toolInputMissing, truncated: false };
        expect(judgeAt(route.tool, route.summary, call, classifyAsk({ ...call, tool: route.tool, summary: route.summary }, place)).approve).toBeNull();
        return;
      }
      case "line": {
        const route = routeDelivery({ tool_name: "exec_command", tool_input: { cmd: text }, tool_use_id: "u1", turn_id: "t1", cwd: project }, { mounts: [], project, home });
        if (route.route !== "ask") { expect(route.route).toBe("deny"); return; }
        const call: GrantCall = { engine: "codex", toolCall: route.toolCall as GrantCall["toolCall"], inputMissing: route.toolInputMissing, truncated: false };
        expect(judgeAt(route.tool, route.summary, call, classifyAsk({ ...call, tool: route.tool, summary: route.summary }, place)).approve).toBeNull();
        return;
      }
      case "argv": {
        const input = { command: text };
        expect(judgeAt("shell", "shell", { toolCall: { name: "shell", input } }, classifyStopLine("shell", input, "shell", place)).approve).toBeNull();
        return;
      }
      case "ps": case "ps-shell": {
        const tool = row.form === "ps" ? "powershell" : "shell";
        const input = { command: text };
        expect(judgeAt(tool, tool, { toolCall: { name: tool, input } }, classifyStopLine(tool, input, tool, win)).approve).toBeNull();
        return;
      }
      default: throw new Error(`unknown form ${row.form}`);
    }
  });

  it.each(corpus.rows.map((row) => [row.id, row] as const))("%s: holds everything 1.0.9 held, and meets its row", (_id, row) => {
    const now = outcomes.get(row.id)!;
    const was = base[row.id]!;
    // strictness against ed8af4fd5, each hold on its own; a row that names the hold it removes on purpose is the
    // bounded exception (designs/ISSUE-PERMS-DESIGN-1010.md section 3), and 1.0.9 really held it
    if (row.removes) expect(was.held.fullRoutine, "1.0.9 held the row this subset frees").toBe(true);
    else if (was.reader !== null) expect(now.reader, "stop line").not.toBeNull();
    if (!row.removes && was.inside === false) expect(now.inside, "Auto guard placed inside").toBe(false);
    for (const level of ["fullRoutine", "fullOwner", "auto", "noLimits"] as const) {
      if (!row.removes && was.held[level]) expect(now.held[level], level).toBe(true);
    }
    switch (row.expect) {
      case "stop":
        expect(now.reader, "stop line").not.toBeNull();
        expect(now.held.fullRoutine && now.held.fullOwner && now.held.auto, "held at Full access and Auto").toBe(true);
        break;
      case "unread":
        expect(now).toMatchObject({ route: "ask", missing: "patch", noLimitsSource: "unread-call", held: { fullRoutine: true, fullOwner: true, auto: true, noLimits: true } });
        break;
      case "run":
        expect(now.reader, "stop line").toBeNull();
        expect(now.held.fullRoutine, "runs at Full access").toBe(false);
        break;
      case "109":
        // the general shell class (since 0.1.59): exactly what 1.0.9 did; 1.0.11's grammar closes it
        expect(now).toEqual(was);
        break;
    }
  });
});
