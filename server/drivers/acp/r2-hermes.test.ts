import "../../testing/port-integrity.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoVerdict } from "../../auto-approve.ts";
import { HERMES_BOUND_ASK_HOOK_SOURCE, HERMES_BOUND_ASK_NOTE, HERMES_ADMIN_HOOK_REFUSAL, applyHermesAskHook, normalizeHermesAsk, hermesAcpSupport } from "./hermes.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const raw = { command: "<terminal> (plugin approval rule)", description: '{"murage":1,"v":1,"bound":true}' };
describe("LASTRESORT §7.3 Hermes escalation", () => {
  it("T-HERMES-BOUND-MARKER", () => {
    const child = spawnSync(process.execPath, ["-e", HERMES_BOUND_ASK_HOOK_SOURCE], {
      input: JSON.stringify({ tool_name: "terminal", tool_input: { command: "private-command-sentinel" } }), encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('{"action":"approve","message":"{\\"murage\\":1,\\"v\\":1,\\"bound\\":true}"}');
    expect(child.stderr).toBe("");
  });
  it("T-HERMES-NORMALIZE-BOUND", () => {
    expect(normalizeHermesAsk(raw)).toEqual({ ok: true, bound: true, tool: "terminal" });
    expect(hermesAcpSupport.normalizeAsk!(raw)).toEqual({ ok: true, bound: true, tool: "terminal", summary: HERMES_BOUND_ASK_NOTE });
    expect(HERMES_BOUND_ASK_NOTE).toBe("This request's details stay out of this card. Allow it only if you expect this tool now; otherwise deny it.");
  });
  it("T-HERMES-NO-AUTO-ALLOW: all approval modes retain the owner card", () => {
    // MAIN RULING 1114-SC-SAFETY-HSCOPE4: original No limits element retained; explicit element is additional.
    for (const bot of [{}, { autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }, { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true }]) {
      const result = autoVerdict(bot, "terminal", HERMES_BOUND_ASK_NOTE,
        { fullAccessOrigin: "owner", ownerStarted: true, call: { inputMissing: "hermes-bound" } });
      // MAIN RULING 2026-11-13 narrow-wipe (Sean), WIPE-NARROW.md:
      // only a visible catastrophe may card on an authenticated owner No limits turn.
      // Keep this historical case ID; lower levels still require the owner card.
      if ("noLimits" in bot && bot.noLimits === true) {
        expect(result.approve).toBeTruthy();
        expect(result.source).toBe("no-limits");
      } else {
        expect(result.approve).toBeNull();
        expect(result.source).toBe("always-ask");
      }
    }
  });
  it.each([
    { fullAccessOrigin: "other" as const, ownerStarted: true },
    { fullAccessOrigin: undefined, ownerStarted: false },
  ])("an unread Hermes request does not grant owner authority: %j", authority => {
    const result = autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, "terminal", HERMES_BOUND_ASK_NOTE,
      { ...authority, call: { inputMissing: "hermes-bound" } });
    expect(result.approve).toBeNull();
    expect(result.source).toBe("always-ask");
  });
  it("unread Hermes metadata cannot hide a visible recursive root wipe", () => {
    const result = autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, "terminal", "rm -rf /",
      { fullAccessOrigin: "owner", ownerStarted: true, commandText: "rm -rf /",
        call: { inputMissing: "hermes-bound", toolCall: { name: "terminal", input: { command: "rm -rf /" } } } });
    expect(result).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root" });
  });
  it.each([true, false])("T-X1-HERMES-ADMIN-HOOK: present=%s", present => {
    const root = mkdtempSync(join(tmpdir(), "r2-hermes-admin-"));
    try {
      const home = join(root, "home"), managed = join(root, "managed");
      mkdirSync(home); mkdirSync(managed);
      writeFileSync(join(home, "config.yaml"), "{}\n");
      writeFileSync(join(managed, "config.yaml"), present ? "hooks:\n  pre_tool_call:\n    - command: owner-hook\n" : "{}\n");
      const env = { HERMES_HOME: home, HERMES_MANAGED_DIR: managed, MURAGE_DATA_DIR: root };
      const apply = () => applyHermesAskHook(env, { hostComputer: false, bound: true });
      if (present) expect(apply).toThrow(HERMES_ADMIN_HOOK_REFUSAL);
      else expect(apply).not.toThrow();
    } finally { removeTempDirSync(root); }
  });
});
