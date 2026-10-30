// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-CARDS-1010 (Sean, 10-30 and 10-31): bots at No limits kept raising
// cards and held his routines. The acceptance rows are the three 10-31 log
// lines (23:12:49Z sensitive-guard, 23:13:24Z unreadable, 23:13:59Z
// unattended-block) and the 10-30 sweep (truncated Write and the connected-apps
// workbench, the owner's channel DMs). Every row of the design's section 3 still
// cards. Fixture strings are inert data, never executed.
import { posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");
const { toolApprovalUnattended, unattendedMarkAction } = await import("./unattended-mark.ts");
const { applyRoutinePermissionMode, routineTurnApproval } = await import("./routine-permissions.ts");
const { classifyStopLine } = await import("./stop-line.ts");
const { decideImageApproval } = await import("./image-approval.ts");
type AutoContext = import("./auto-approve.ts").AutoContext;

const ASK = { autoApprove: false };
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS = { Ask: ASK, Auto: AUTO, "Full access": FULL, "No limits": NO_LIMITS } as const;
type Level = keyof typeof LEVELS;

const HOME = "/home/tester";
const CWD = "/home/tester/Documents/x";
const place = (cwd: string) => ({ cwd, roots: [cwd, "/tmp"], home: HOME, knownRecipients: new Set<string>(), realpath: (p: string) => posix.normalize(p) });

/** The turn's origin, as the approval listener records it. */
const ORIGINS = {
  owner: {} as AutoContext,
  routine: { routineLevel: true, automated: true } as AutoContext,
  "owner-channel": { unattended: true, automated: true, channelOwner: true } as AutoContext,
  webhook: { unattended: true, automated: true } as AutoContext,
  group: { unattended: true, automated: true, fullAccessOrigin: "other" } as AutoContext,
} as const;
type Origin = keyof typeof ORIGINS;

interface At { origin?: Origin; tool?: string; extra?: AutoContext; bot?: Record<string, unknown> }
const verdict = (level: Level, cmd: string, at: At = {}) => {
  const tool = at.tool ?? "Bash";
  return autoVerdict({ ...LEVELS[level], ...(at.bot ?? {}) }, tool, cmd, {
    commandText: cmd, commandCwd: CWD, stopLine: classifyStopLine(tool, { command: cmd }, "", place(CWD)),
    promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" },
    ...ORIGINS[at.origin ?? "owner"], ...(at.extra ?? {}),
  });
};
const passes = (level: Level, cmd: string, at: At = {}) => {
  const v = verdict(level, cmd, at);
  expect(v.approve, `${level} ${at.origin ?? "owner"}: ${cmd} -> ${v.source} ${v.rule ?? ""}`).toBeTruthy();
  return v;
};
const holds = (level: Level, cmd: string, at: At = {}) => {
  const v = verdict(level, cmd, at);
  expect(v.approve, `${level} ${at.origin ?? "owner"}: ${cmd} -> ${v.source}`).toBeNull();
  return v;
};

const SWEEP = `ls ~/.mybot/ | head -50; grep -ril "higgsfield generate\\|soul" ~/.mybot/*.md ~/.mybot/routines 2>/dev/null | head; higgsfield --help 2>&1 | head -40`;

describe("1D is cut from 1.0.10 (to 1.0.11): a glob in a home dot folder holds as in 1.0.9", () => {
  it("the sweep command and its glob still hold, on a routine run and the owner's turn, at Full access and No limits", () => {
    for (const origin of ["routine", "owner"] as const) {
      expect(holds("No limits", SWEEP, { origin }).source).toBe("sensitive-guard");
      expect(holds("Full access", SWEEP, { origin }).source).toBe("sensitive-guard");
      expect(holds("No limits", "cat ~/.mybot/*.json", { origin }).source).toBe("sensitive-guard");
    }
  });

  it("a key folder's glob holds", () => {
    for (const cmd of ["cat ~/.ssh/*", "cat ~/.aw?/credentials", "cat ~/.aws/cred*", "cat ~/.config/*/credentials.json", "cat ~/.mybot/**/x.md"]) holds("No limits", cmd);
  });
});

describe("1B is cut from 1.0.10: a residual reader failure holds as in 1.0.9", () => {
  const RESIDUAL = `ls ~/Documents/x && echo "done`;
  it("holds at every level, on a routine run and the owner's turn", () => {
    for (const level of ["Ask", "Auto", "Full access", "No limits"] as const) {
      for (const origin of ["routine", "owner"] as const) expect(holds(level, RESIDUAL, { origin })).toMatchObject({ source: "always-ask", rule: "unreadable" });
    }
  });
  it("Astra B1: two scripts before a broken quote hold at No limits", () => {
    for (const origin of ["routine", "owner"] as const) expect(holds("No limits", "bash stage.sh\nbash run.sh\necho \"", { origin }).source).toBe("always-ask");
  });
});

describe("10-31 23:13:59Z unattended-block: a Read on a scheduled run whose thread had a stale channel mark", () => {
  const read = (context: AutoContext) => autoVerdict(NO_LIMITS, "Read", `${CWD}/notes.md`, { stopLine: null, ...context });
  it("passes once the run is not marked (r1), and held as before while it was", () => {
    expect(read({ routineLevel: true, automated: true }).approve).toBeTruthy();
    expect(read({ routineLevel: true, automated: true, unattended: true })).toMatchObject({ approve: null, source: "unattended-block" });
  });

  // Behavioral (fix round): the thread's mark as startTurnAdmitting keeps it (unattendedMarkAction, the rule index.ts
  // calls), and each tool approval as the approval site judges it (toolApprovalUnattended), on a thread a channel turn
  // marked earlier.
  const marks = new Set<string>();
  const start = (thread: string, opts: Parameters<typeof unattendedMarkAction>[0], owner = true) => {
    const action = unattendedMarkAction(opts, owner);
    if (action === "mark") marks.add(thread);
    else if (action === "clear") marks.delete(thread);
    return action;
  };
  const READ_AT = (thread: string, context: AutoContext = {}, wake?: unknown) =>
    read({ routineLevel: true, automated: true, ...context, unattended: toolApprovalUnattended(marks.has(thread), wake) });

  it("a scheduled and a manual run clear a stale channel mark; its Read passes at No limits", () => {
    for (const automationSource of ["schedule", "manual"] as const) {
      marks.clear();
      expect(start("t1", { automationSource: "channel" })).toBe("mark");
      expect(READ_AT("t1")).toMatchObject({ approve: null, source: "unattended-block" });
      expect(start("t1", { automationSource })).toBe("clear");
      expect(READ_AT("t1").approve).toBeTruthy();
    }
  });

  it("a webhook, an unattended run, a run for someone else and an asker wake do not clear it", () => {
    marks.clear();
    start("t2", { automationSource: "webhook" });
    expect(start("t2", { automationSource: "schedule", unattended: true })).toBe("mark");
    expect(start("t2", { automationSource: "schedule" }, false)).toBe("keep");
    expect(start("t2", { automationSource: "manual", askerWake: {} })).toBe("keep");
    expect(start("t2", { automationSource: "schedule", commsDepth: 1 })).toBe("keep");
    expect(READ_AT("t2")).toMatchObject({ approve: null, source: "unattended-block" });
  });

  it("a project-room routine start (queued unattended, project-routines.ts) passes on its own routine ceiling, and only with it", () => {
    marks.clear();
    expect(start("room", { automationSource: "channel", unattended: true })).toBe("mark");
    const ceiling = { permissionMode: "unlimited", triggerSource: "schedule" };
    expect(READ_AT("room", {}, ceiling).approve).toBeTruthy();
    expect(READ_AT("room")).toMatchObject({ approve: null, source: "unattended-block" });
  });

  it("a routine's immediate and queued peer, and a wake, inherit the cleared thread (A6)", () => {
    marks.clear();
    start("src", { automationSource: "channel" });
    start("src", { automationSource: "schedule" });
    // peerRoutineTurnOptions hands the peer `unattended: isUnattended(source thread)` and the routine's ceiling
    const peer = (marked: boolean) => routineTurnApproval({ bot: applyRoutinePermissionMode({}, "unlimited"), run: { permissionMode: "unlimited" }, tool: "Read", summary: `${CWD}/notes.md`, context: { stopLine: null, unattended: marked } }).verdict;
    expect(peer(marks.has("src")).approve).toBeTruthy();
    // a queued peer starts later on its own thread with a comms depth: its own mark is kept, never set
    expect(start("peer", { automationSource: "schedule", commsDepth: 1 })).toBe("keep");
    expect(marks.has("peer")).toBe(false);
    expect(peer(marks.has("src")).approve).toBeTruthy();
    // a wake of the run reads the same cleared thread
    expect(READ_AT("src").approve).toBeTruthy();
    // base (the stale mark kept): the peer carded
    expect(peer(true)).toMatchObject({ approve: null, source: "unattended-block" });
  });
});

describe("10-30: truncated calls (1C, narrowed by A3)", () => {
  const write = (path: string) => ({
    call: { engine: "claude" as const, truncated: true, toolCall: { name: "Write", input: { file_path: path, content: "notes…[90000 bytes more]" } } },
    inputCut: true, stopLine: null,
  });
  const WORKBENCH = {
    tool: "other", summary: "Run code", toolKind: "other", engine: "acp" as const, truncated: true,
    toolIdentity: { namespace: "mcp", name: "murage_connectors__APPS_REMOTE_WORKBENCH" },
    toolCall: { name: "Run code", input: { code_to_execute: "print(1)…[90000 bytes more]" } },
    mcpMounts: [{ engineName: "murage_connectors", mountId: "own:connector", provenance: "own" as const }],
  };
  it("a cut Write whose path was read whole passes at No limits on a routine run", () => {
    expect(autoVerdict(NO_LIMITS, "Write", `${CWD}/brief.md`, { ...write(`${CWD}/brief.md`), ...ORIGINS.routine }).approve).toBeTruthy();
  });
  it("a cut Write that names a key file holds", () => {
    expect(autoVerdict(NO_LIMITS, "Write", `${HOME}/.ssh/id_rsa`, { ...write(`${HOME}/.ssh/id_rsa`), ...ORIGINS.routine }).approve).toBeNull();
  });
  it("the own connected-apps workbench passes at No limits", () => {
    expect(autoVerdict(NO_LIMITS, "other", "Run code", { call: WORKBENCH, inputCut: true, stopLine: null, ...ORIGINS.routine }).approve).toBeTruthy();
  });
  it("Ask and Auto keep the cut hold", () => {
    expect(autoVerdict(AUTO, "Write", `${CWD}/brief.md`, write(`${CWD}/brief.md`)).approve).toBeNull();
  });
  it("a cut shell command holds", () => {
    const cmd = "ls ~/Documents/x";
    const v = autoVerdict(NO_LIMITS, "Bash", cmd, { commandText: cmd, stopLine: null, inputCut: true, call: { engine: "claude", truncated: true, toolCall: { name: "Bash", input: { command: cmd } } }, ...ORIGINS.routine });
    expect(v.approve).toBeNull();
  });
  it("arguments past the key guard's scan hold at every level", () => {
    const deep: Record<string, unknown> = {};
    let at = deep;
    for (let k = 0; k < 80; k++) { const next: Record<string, unknown> = {}; at.x = next; at = next; }
    const v = autoVerdict(NO_LIMITS, "Write", `${CWD}/brief.md`, { call: { engine: "claude", toolCall: { name: "Write", input: { file_path: `${CWD}/brief.md`, content: "x", deep } } }, stopLine: null, ...ORIGINS.routine });
    expect(v.approve).toBeNull();
  });
});

describe("what still cards at No limits (section 3)", () => {
  const home = HOME;
  const NEVER = ["rm -rf ~", "rm -rf /", "mkfs.ext4 /dev/sda1", ":(){ :|:& };:"];
  it("the never-list, readable and unreadable, on every covered origin", () => {
    for (const cmd of NEVER) {
      for (const spelled of [cmd, `${cmd} "`, `${cmd} 'x`]) {
        for (const origin of ["owner", "routine"] as const) expect(holds("No limits", spelled, { origin }).source, spelled).toBe("always-ask");
      }
    }
  });
  it("an interpreter delete of the home folder behind a stray quote (Astra A1)", () => {
    const cmd = `python3 -c 'import shutil; shutil.rmtree("${home}")'\n"`;
    for (const origin of ["owner", "routine"] as const) expect(holds("No limits", cmd, { origin }).source).toBe("always-ask");
  });
  it("an unknown delete still cards at Full access and No limits (1B cut; the stop line marks it, A2)", () => {
    // 1B is cut: a delete whose target a value holds is unreadable and holds at every level, before the stop line, as in
    // 1.0.9; behind a stray quote too
    const posixDelete = `rm -rf "$X"/sub`;
    for (const cmd of [posixDelete, `${posixDelete} "`]) {
      for (const level of ["Full access", "No limits"] as const) {
        for (const origin of ["owner", "routine"] as const) expect(holds(level, cmd, { origin }).source).toBe("always-ask");
      }
    }
    const method = "Remove-Item ./scratch; (Get-Item $env:TARGET).Delete()";
    expect(classifyStopLine("PowerShell", { command: method }, "", place(CWD))).toMatchObject({ kind: "delete" });
    for (const level of ["Full access", "No limits"] as const) expect(holds(level, method, { tool: "PowerShell" }).source).toBe("always-ask");
  });
  it("the key guard, a stray quote included", () => {
    for (const cmd of ["cat ~/.ssh/id_rsa", `cat ~/.ss"h/id_rsa`, "cat ~/.aws/cred*"]) {
      for (const origin of ["owner", "routine"] as const) holds("No limits", cmd, { origin });
    }
    // GrokBuild G2: a waived PowerShell text meets the key rows too
    holds("No limits", `Get-Content ~\\.ssh\\id_rs"a`, { tool: "PowerShell" });
  });
  it("an unseen script outside the admitted shape keeps asking (GrokBuild G1)", () => {
    holds("No limits", "bash wipe.sh && bash note.sh");
    holds("No limits", "pwsh -File wipe.ps1");
  });
  it("a webhook, a group, an unconfirmed sender and an unproven turn still card", () => {
    for (const origin of ["webhook", "group"] as const) expect(holds("No limits", "ls", { origin }).source).toBe("unattended-block");
    expect(holds("No limits", "ls", { extra: { unattended: true, automated: true, fullAccessOrigin: "other" } }).source).toBe("unattended-block");
  });
  it("the owner who turned the channel option off still cards on a channel DM", () => {
    expect(holds("No limits", "ls", { origin: "owner-channel", bot: { fullAccessChannelMessages: false } }).source).toBe("unattended-block");
  });
  it("Ask and Auto do not change", () => {
    expect(holds("Ask", "ls", { origin: "owner-channel" }).approve).toBeNull();
    expect(holds("Auto", "ls", { origin: "owner-channel" }).approve).toBeNull();
  });
});

describe("the owner's own channel DM at No limits, option never set (r2, A7)", () => {
  it("passes a command and a Read", () => {
    passes("No limits", "ls ~/Documents/x", { origin: "owner-channel" });
    expect(autoVerdict(NO_LIMITS, "Read", `${CWD}/a.md`, { stopLine: null, ...ORIGINS["owner-channel"] }).approve).toBeTruthy();
  });
  it("makes an image without a card; a group, another sender or the option off still asks", () => {
    const base = { level: NO_LIMITS, ownerAudience: true, unattended: true, madeThisTurn: 0, count: 1 };
    expect(decideImageApproval({ ...base, origin: "owner-channel" })).toMatchObject({ ask: false, basis: "No limits" });
    expect(decideImageApproval({ ...base, origin: "other" })).toMatchObject({ ask: true, reason: "unattended" });
    expect(decideImageApproval({ ...base, origin: "owner-channel", level: { ...NO_LIMITS, fullAccessChannelMessages: false } })).toMatchObject({ ask: true });
    expect(decideImageApproval({ ...base, origin: "owner-channel", ownerAudience: false })).toMatchObject({ ask: true, reason: "audience" });
    expect(decideImageApproval({ ...base, origin: "owner-channel", level: AUTO })).toMatchObject({ ask: true });
  });
});

describe("the asked line (r5)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("names origin, unattended and the command class, and no command text", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    holds("No limits", "echo secretvalue-31337", { origin: "webhook", bot: { id: "r5-bot" } });
    autoVerdict({ ...NO_LIMITS, id: "r5-bot" }, "Read", "/tmp/secretpath-31337.md", { stopLine: null, ...ORIGINS.webhook });
    const lines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("approvals: asked"));
    expect(lines.some((line) => /origin=other unattended=1 cmd=shell/.test(line))).toBe(true);
    expect(lines.some((line) => /tool=Read .*origin=other unattended=1 cmd=none/.test(line))).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/secretvalue|secretpath|31337/);
  });
});

describe("fix round: the stop line, the key guard's depth and gcloud", () => {
  it("final round: a value set in a branch is no known value, so the delete it names stays unknown (1.0.9 shape)", () => {
    for (const cmd of ['if true; then D=/; else D=./x; fi; rm -r "$D"', 'if true; then D=a; else D=b; fi; rm -r "$D"', 'D=./x; if c; then D=/; fi; rm -r "$D"']) {
      expect(classifyStopLine("Bash", { command: cmd }, "", place(CWD)), cmd).toMatchObject({ kind: "delete" });
      expect(holds("Full access", cmd).approve).toBeNull();
    }
    // a name with "-delete" in it is not a find -delete
    const cmd = "touch notes/tmp-delete-me.txt && rm notes/tmp-delete-me.txt";
    expect(classifyStopLine("Bash", { command: cmd }, cmd, place(CWD))).toBeNull();
  });

  it("a delete the stop line cannot place is unknown even after another was placed (Astra High 3, Grok Medium)", () => {
    const branch = `rm ./scratch\nif true; then rm "$TARGET"; fi\n"`;
    expect(classifyStopLine("Bash", { command: branch }, "", place(CWD))).toMatchObject({ kind: "delete" });
    const readable = `rm ./scratch; if true; then rm "$TARGET"; fi`;
    expect(classifyStopLine("Bash", { command: readable }, "", place(CWD))).toMatchObject({ kind: "delete" });
    const py = `python3 -c 'import shutil, os; shutil.rmtree("/tmp/ok"); shutil.rmtree(os.environ["TARGET"])'`;
    expect(classifyStopLine("Bash", { command: py }, "", place(CWD))).toMatchObject({ kind: "delete" });
    expect(classifyStopLine("Bash", { command: `${py} "` }, "", place(CWD))).toMatchObject({ kind: "delete" });
    // a single literal delete inside the permitted folders is still placed
    expect(classifyStopLine("Bash", { command: `python3 -c 'import shutil; shutil.rmtree("/tmp/ok")'` }, "", place(CWD))).toBeNull();
    // Full access cards each; No limits lifts the stop line, and none of them is never-list
    for (const cmd of [branch, readable, py]) {
      expect(holds("Full access", cmd).approve).toBeNull();
      expect(verdict("No limits", cmd).source).not.toBe("stop-line");
      expect(verdict("No limits", cmd).rule ?? "").not.toMatch(/delete-home|delete-system|disk|fork/);
    }
  });

  it("nested substitutions past the reader's depth still hold at every level, as in 1.0.9 (the depth fallback went with 1B)", () => {
    const deep = "echo $(echo $(echo $(echo $(echo $(echo done)))))";
    for (const origin of ["owner", "routine"] as const) {
      expect(holds("No limits", deep, { origin }).source).toBe("sensitive-guard");
      expect(holds("Full access", deep, { origin }).source).toBe("sensitive-guard");
    }
    holds("No limits", "echo $(echo $(echo $(echo $(echo $(cat ~/.ssh/id_rsa)))))");
  });

  it("gcloud's folder holds before expansion, in both shells, and its application default credentials by name (Grok High)", () => {
    for (const origin of ["owner", "routine"] as const) {
      expect(holds("No limits", "cat ~/.config/gcloud/*", { origin }).source).toBe("sensitive-guard");
    }
    holds("No limits", "Get-Content ~\\.config\\gcloud\\*", { tool: "PowerShell" });
    holds("No limits", "cat ~/.cfgx/application_default_credentials.json");
  });
});
