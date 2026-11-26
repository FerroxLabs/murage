// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser to computer handover (1.0.22): the browser routes cannot serve a turn and the local computer mount is granted.
import { describe, expect, it } from "vitest";
import { computerHandoverLayer, handoverComputerGranted, handoverLayerForTurn, handoverStatusLine, handoverTriggerForUnavailable } from "./computer-handover.ts";
import { extensionBrowserUnavailablePrompt } from "./browser-extension-prompt.ts";
import { COMPUTER_LOCAL_CONTROL_OFF, directTurnLayers, joinShapeLayers, type DirectTurnShapeInput } from "./bot-shapes.ts";
import { codedBrowserReason, readBrowserFailure } from "../shared/browser-choice-eligibility.ts";

const base = (over: Partial<DirectTurnShapeInput>): DirectTurnShapeInput => ({
  houseRules: "", persona: "", computerKind: null, vmPerBot: false, driverKind: "x", connectors: "", requiredApps: "", browser: "",
  coordination: "", credential: "", image: "", webSearchBackup: false, routines: "", learn: "", importedSkills: "", teamBrief: "", memory: "",
  primer: "", skills: [], playbooks: "", outputFolder: "", tagged: [], ...over,
});
const prompt = (browser: string, over: Partial<DirectTurnShapeInput> = {}) => joinShapeLayers(directTurnLayers(base({ browser, ...over })));
/** The trigger index.ts derives from a real coded reason, exactly as the mount site does. */
const triggerOf = (code: string) => handoverTriggerForUnavailable(readBrowserFailure(codedBrowserReason(code, "details", 0))?.code);

describe("browser to computer handover", () => {
  it.each([
    ["browser_extension_setup_required", "setup_required"],
    ["browser_extension_not_ready", "not_connected"],
    ["host_offline", "not_connected"],
    ["chrome_closed", "not_connected"],
    ["debugging_off", "not_connected"],
    ["builtin_missing", "unavailable"],
    ["builtin_check_failed", "unavailable"],
    ["builtin_restart", "unavailable"],
    ["browser_sandbox_enable", "unavailable"],
  ])("the real code %s hands over as %s", (code, trigger) => {
    expect(triggerOf(code)).toBe(trigger);
  });

  it("a route that waits on the owner or the check never hands over", () => {
    for (const code of ["paused", "handoff", "uncertain", "connection_lost", "allow_not_given", "stopped", "direct_reserved", "binding_capacity", "builtin_page_locked", "update_murage"]) expect(triggerOf(code), code).toBeUndefined();
    expect(handoverTriggerForUnavailable(undefined)).toBeUndefined(); // an uncoded reason is a check still running
    expect(handoverTriggerForUnavailable("constructor")).toBeUndefined();
  });

  it("only the owner's own computer is a granted handover target", () => {
    expect(handoverComputerGranted("local")).toBe(true);
    for (const kind of ["box", "vps", "vm", null]) expect(handoverComputerGranted(kind)).toBe(false);
  });

  it("extension setup required + local computer: one labelled line, continue on the computer, and it overrides the wait instruction", () => {
    const hint = readBrowserFailure(codedBrowserReason("browser_extension_setup_required", "Connect the extension.", 0))!;
    const trigger = handoverTriggerForUnavailable(hint.code);
    const browser = extensionBrowserUnavailablePrompt("Connect the extension.", true) + computerHandoverLayer({ browserMounted: false, trigger, computerGranted: true });
    const out = prompt(browser, { computerKind: "local" });
    expect(handoverStatusLine("setup_required")).toBe("Switching to the computer: the browser extension is not set up, so I'll use the screen instead.");
    expect(out).toContain(handoverStatusLine("setup_required"));
    expect(out).toContain("accessibility tree first");
    expect(out).toContain("asks the owner first");
    expect(out).toContain("Never solve a captcha");
    expect(out).toContain("replaces any earlier instruction to wait for the browser");
    expect(out).toContain("do not end your turn to wait");
  });

  it("no handover text for a cloud box, vps or vm, and local control off keeps its own notice", () => {
    for (const kind of ["box", "vps", "vm"]) expect(computerHandoverLayer({ browserMounted: false, trigger: "setup_required", computerGranted: handoverComputerGranted(kind) })).toBe("");
    const off = prompt(computerHandoverLayer({ browserMounted: false, trigger: "setup_required", computerGranted: handoverComputerGranted(null) }), { localControlOff: true });
    expect(off).toContain(COMPUTER_LOCAL_CONTROL_OFF);
    expect(off).not.toContain("BROWSER TO COMPUTER");
  });

  it("no trigger and no mount hands over nothing", () => {
    expect(computerHandoverLayer({ browserMounted: false, computerGranted: true })).toBe("");
  });

  it("mounted browser + local computer: the mid-turn rule names every failure", () => {
    const text = computerHandoverLayer({ browserMounted: true, computerGranted: true });
    for (const word of ["browser_extension_setup_required", "tab_gone", "captcha", "403", "Switching to the computer:"]) expect(text).toContain(word);
    expect(computerHandoverLayer({ browserMounted: true, computerGranted: false })).toBe("");
  });

  it("the local computer prompt reads the tree first", () => {
    expect(prompt("", { computerKind: "local" })).toContain("accessibility tree first and take a screenshot second");
  });
});

describe("the handover step at the mount site", () => {
  /** What index.ts does for a turn: the mint's refusal reason and mount state in, the bot's browser prompt out. */
  const turn = (code: string | undefined, computerKind: string | null, browserMounted = false) => prompt(
    handoverLayerForTurn({ unavailable: code === undefined ? undefined : codedBrowserReason(code, "details", 0), browserMounted, computerKind }),
    { computerKind: computerKind as DirectTurnShapeInput["computerKind"] },
  );

  it("a refused extension on the local computer tells the bot to continue on the screen with the one status line", () => {
    const out = turn("browser_extension_not_ready", "local");
    expect(out).toContain(handoverStatusLine("not_connected"));
    expect(out).toContain("continue the task with the computer tools");
    expect(out).toContain("do not end your turn to wait");
  });

  it("each trigger code reaches its own status line through the real reason", () => {
    expect(turn("browser_extension_setup_required", "local")).toContain(handoverStatusLine("setup_required"));
    expect(turn("builtin_missing", "local")).toContain(handoverStatusLine("unavailable"));
  });

  it("a waiting reason, a missing reason or a non-local computer adds no handover instruction", () => {
    for (const out of [turn("paused", "local"), turn(undefined, "local"), turn("browser_extension_setup_required", "box"), turn("browser_extension_setup_required", null)]) expect(out).not.toContain("BROWSER TO COMPUTER");
  });

  it("a mounted browser on the local computer carries the mid-turn rule, not the unmounted line", () => {
    const out = turn(undefined, "local", true);
    expect(out).toContain("if a browser tool reports browser_extension_setup_required");
    expect(out).not.toContain("the browser route cannot serve this turn");
  });
});
