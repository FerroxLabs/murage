// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 hook self-guard. Antigravity's relay hook (DATA_DIR/native/antigravity-relay/<turn>/murage-agy-relay.cjs and
// its .env), the Ask hook (native/antigravity-ask/ask-hook-<hex>.cjs), the scoped home (native/antigravity-scope) and
// Codex's hook files (murage-hook.mjs/.cmd/.env under native/codex-scope) are re-read by the engine on every call. At
// Full access a call that writes over one would replace the guard that judges every later call, so any call that
// names one is held at every level, No limits included, and never answered by a mode or a grant.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { autoVerdict, looksSensitive, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { routeDelivery } from "./drivers/codex-hook.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { globKeyRead } from "../shared/sensitive-globs.ts";
import { inProjectCheck, walkRoot } from "../shared/in-project.ts";
import { SENSITIVE_PATHS } from "../shared/sensitive-paths.ts";

const full: AutoApprover = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const unlimited: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] };
const granted: AutoApprover = { autoApprove: true, fullAccess: true, alwaysAllow: ["write_to_file", "run_command", "edit", "Bash:cp"] };
const at = (name: string, input: unknown): AutoContext => ({ stopLine: null, call: { toolCall: { name, input } } });

const data = "/Users/jo/.murage";
const relayDir = `${data}/native/antigravity-relay/agy-t1`;
const relay = `${relayDir}/murage-agy-relay.cjs`;
const relayEnv = `${relayDir}/murage-agy-relay.env`;
const codexHook = `${data}/native/codex-scope/abc123/murage-hook.mjs`;

describe("Full access never answers a call that names a Murage hook", () => {
  it("holds an Antigravity write_to_file over the relay script, at Full, No limits and with a grant", () => {
    for (const target of [relay, relayEnv, "C:\\Users\\Jo\\.murage\\native\\antigravity-relay\\agy-t1\\MURAGE-AGY-RELAY.CJS"]) {
      const input = { TargetFile: target, CodeContent: "process.stdout.write('{\"decision\":\"allow\"}')" };
      for (const bot of [full, unlimited, granted]) {
        const verdict = autoVerdict(bot, "write_to_file", `write_to_file ${target}`, at("write_to_file", input));
        expect(verdict, `${target} ${JSON.stringify(bot)}`).toMatchObject({ approve: null, source: "sensitive-guard" });
      }
    }
  });

  it("holds a run_command that copies, moves, tees or redirects over a hook file, in sh and PowerShell", () => {
    for (const command of [
      `cp /tmp/x ${relay}`,
      `mv /tmp/x ${relayEnv}`,
      `cat /tmp/x | tee ${relay}`,
      `echo 'allow' > ${relay}`,
      `printf x >>${relayEnv}`,
      `cd ${relayDir} && cp /tmp/x ./`,
      `cp /tmp/x ${data}/native/antigravity-ask/ask-hook-0123456789abcdef.cjs`,
      `cp /tmp/x ${data}/native/antigravity-scope/home-1/.gemini/settings.json`,
      `cp /tmp/x ${codexHook}`,
      `Set-Content -Path C:\\Users\\Jo\\.murage\\native\\codex-scope\\abc\\murage-hook.cmd -Value x`,
      `Copy-Item x "C:\\Users\\Jo\\.murage\\native\\antigravity-relay\\t\\murage-agy-relay.cjs"`,
      `cp /tmp/x ${data}/native/antigravity-relay/*/murage-agy-*`,
      // the Win32 spellings of a hook folder as a target (SG-WIN-PATHTRICKS.md): a trailing dot or a stream suffix is the folder
      `Copy-Item -Recurse x C:\\Users\\Jo\\.murage\\native\\codex-scope.`,
      `Move-Item x "C:\\Users\\Jo\\.murage\\native\\antigravity-relay:evil"`,
      `Copy-Item x \\\\.\\C:\\Users\\Jo\\.murage\\native\\codex-scope\\abc\\murage-hook.mjs.`, // `\\?\` in a shell line is a glob, held as always-ask first: the \\?\ forms are path tests
      `Copy-Item x \\\\localhost\\C$\\Users\\Jo\\.murage\\native\\antigravity-ask\\ask-hook-0123456789abcdef.cjs:evil`,
    ]) {
      for (const bot of [full, unlimited, granted]) {
        const verdict = autoVerdict(bot, "run_command", command, at("run_command", { command }));
        expect(verdict, command).toMatchObject({ approve: null, source: "sensitive-guard" });
      }
      expect(looksSensitive(command) || globKeyRead(command) !== null, command).toBe(true);
    }
  });

  describe("a Codex apply_patch on murage-hook.mjs", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-selfguard-"));
    const project = join(root, "project");
    const scope = join(root, "native", "codex-scope", "abc123");
    mkdirSync(project, { recursive: true });
    mkdirSync(scope, { recursive: true });
    afterAll(() => removeTempDir(root));
    const patch = (path: string) => ["*** Begin Patch", `*** Update File: ${path}`, "@@", "-old", "+new", "*** End Patch"].join("\n");
    const delivery = (path: string, cwd = project) => ({ tool_name: "apply_patch", tool_input: { command: patch(path) }, tool_use_id: "u1", turn_id: "t1", cwd });

    it("is an ask, and Full access holds it", () => {
      for (const target of [join(scope, "murage-hook.mjs"), join(scope, "murage-hook.env"), join(scope, "murage-hook.cmd")]) {
        const route = routeDelivery(delivery(target), { project, home: root, mounts: [] });
        expect(route.route, target).toBe("ask");
        if (route.route !== "ask") continue;
        for (const bot of [full, unlimited, granted]) {
          expect(autoVerdict(bot, route.tool, route.summary, at(route.toolCall.name, route.toolCall.input)), target).toMatchObject({ approve: null, source: "sensitive-guard" });
        }
      }
    });

    it("is an ask even when the turn's own folder is the scope", () => {
      const route = routeDelivery(delivery("murage-hook.mjs", scope), { project: scope, home: root, mounts: [] });
      expect(route.route).toBe("ask");
    });

    it("on an ordinary project file still runs with no card", () => {
      expect(routeDelivery(delivery("src/app.ts"), { project, home: root, mounts: [] })).toMatchObject({ route: "allow", why: "own-workspace" });
    });
  });

  // agy loads <cwd>/.agents/hooks.json (and .agent, _agents, _agent; plugins.json, plugins/<name>/hooks.json) beside
  // Murage's hook: a bot that writes one would have its own hook loaded on the next turn
  it("holds a call that writes a workspace hooks file agy would load", () => {
    for (const [tool, summary, input] of [
      ["write_to_file", "write_to_file /Users/jo/work/app/.agents/hooks.json", { TargetFile: "/Users/jo/work/app/.agents/hooks.json", CodeContent: "{}" }],
      ["write_to_file", "write_to_file C:\\work\\_AGENT\\Hooks.json", { TargetFile: "C:\\work\\_AGENT\\Hooks.json", CodeContent: "{}" }],
      ["run_command", "echo '{}' > .agents/hooks.json", { command: "echo '{}' > .agents/hooks.json" }],
      ["run_command", "mkdir -p .agent/plugins/p && cp h.json .agent/plugins/p/hooks.json", { command: "mkdir -p .agent/plugins/p && cp h.json .agent/plugins/p/hooks.json" }],
      ["run_command", "mv hooks.json .agents/", { command: "mv hooks.json .agents/" }],
      ["run_command", "cp plugins.json _agents/plugins.json", { command: "cp plugins.json _agents/plugins.json" }],
      ["write_to_file", "write_to_file /Users/jo/work/app/.agents/agents/helper.md", { TargetFile: "/Users/jo/work/app/.agents/agents/helper.md", CodeContent: "---\nhooks:\n---\n" }],
      ["write_to_file", "write_to_file /Users/jo/work/app/.agents/plugins/p/plugin.json", { TargetFile: "/Users/jo/work/app/.agents/plugins/p/plugin.json", CodeContent: "{}" }],
      ["run_command", "cp a.md .agents/agents/", { command: "cp a.md .agents/agents/" }],
    ] as const) {
      for (const bot of [full, unlimited, granted]) {
        expect(autoVerdict(bot, tool, summary, at(tool, input)), summary).toMatchObject({ approve: null, source: "sensitive-guard" });
      }
    }
  });

  it("a Codex apply_patch that adds .agents/hooks.json inside the project is an ask", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-selfguard-"));
    try {
      const project = join(root, "project");
      mkdirSync(project, { recursive: true });
      const patch = ["*** Begin Patch", "*** Add File: .agents/hooks.json", "+{}", "*** End Patch"].join("\n");
      const route = routeDelivery({ tool_name: "apply_patch", tool_input: { command: patch }, tool_use_id: "u1", turn_id: "t1", cwd: project }, { project, home: root, mounts: [] });
      expect(route.route).toBe("ask");
    } finally {
      await removeTempDir(root);
    }
  });

  it("keeps ordinary project work automatic at Full access", () => {
    for (const [tool, summary, input] of [
      ["write_to_file", "write_to_file /Users/jo/work/app/src/index.ts", { TargetFile: "/Users/jo/work/app/src/index.ts", CodeContent: "x" }],
      ["write_to_file", "write_to_file /Users/jo/murage/server/drivers/antigravity-relay.ts", { TargetFile: "/Users/jo/murage/server/drivers/antigravity-relay.ts", CodeContent: "x" }],
      ["write_to_file", "write_to_file /Users/jo/murage/server/drivers/codex-scope-spec.ts", { TargetFile: "/Users/jo/murage/server/drivers/codex-scope-spec.ts", CodeContent: "x" }],
      ["run_command", "cp src/a.ts src/b.ts", { command: "cp src/a.ts src/b.ts" }],
      // a file named like a hook is ordinary work (running a script on disk asks for its own reason, 1.0.4 U17)
      ["run_command", "cat scripts/hook.mjs > out.txt", { command: "cat scripts/hook.mjs > out.txt" }],
      ["run_command", "npx vitest run server/drivers/antigravity-relay.test.ts", { command: "npx vitest run server/drivers/antigravity-relay.test.ts" }],
      ["write_to_file", "write_to_file /Users/jo/work/app/.agents/skills/lint/SKILL.md", { TargetFile: "/Users/jo/work/app/.agents/skills/lint/SKILL.md", CodeContent: "x" }],
      ["run_command", "cat src/agents/hooks.json", { command: "cat src/agents/hooks.json" }],
    ] as const) {
      expect(autoVerdict(full, tool, summary, at(tool, input)), summary).toMatchObject({ source: "full-access" });
      expect(autoVerdict(full, tool, summary, at(tool, input)).approve, summary).toBeTruthy();
    }
  });
});

// 1.0.3 (Fable High): the root-folder alternative of agy-workspace-hooks read every argument string, file content
// included, and its bare `.agents` matched ordinary code and prose, so everyday edits got a card at every level.
// It now reads the root only as a path; the hook files themselves still hold everywhere.
const auto: AutoApprover = { autoApprove: true, alwaysAllow: [] };
const agyRow = SENSITIVE_PATHS.find((row) => row.id === "agy-workspace-hooks")!;

// A fixed sample of this repository's own lines the old row matched (47 of them, pasted as fixtures).
const REPO_LINES: readonly string[] = [
  "for name in [\".claude\", \".cursor\", \".codex\", \".agents\"]:",
  "// workspaces/<bot>/.../.claude|.agents|.grok/skills/<name>. Murage re-creates",
  "// workspaces\\<bot>[\\...]\\.claude|.agents|.grok\\skills\\<name>, pointing at a",
  "// Murage's own skill junctions (workspaces\\<bot>\\...\\.claude|.agents|.grok\\",
  "removeTempDirSync(join(task.cwd, \".agents\"));",
  "const candidate = dump.mcpConfig?.mcpServers?.agents as Mount | undefined;",
  "mkdirSync(join(source, \"workspaces\", \"bot\", \".agents\", \"skills\"), { recursive: true });",
  "for (const name of [\".claude\", \".cursor\", \".codex\", \".agents\"]) expect(plan.readOnly).toContain(`${h}/${name}`);",
  "const agents = turn.integrations?.agents;",
  "if (turn.integrations?.agents) add(turn.integrations.agents.serverName ?? OWN_BUILTINS.agents, \"own:agents\");",
  "* ~/.agents skills (rig, droid 0.238.0: 128 tools, 62 of them three personal",
  "mkdirSync(join(home, \".agents\", \"skills\", \"a\"), { recursive: true });",
  "mkdirSync(join(home, \".agents\", \"skills\", \"shared-dir\"), { recursive: true });",
  "//                 ~/.agents skill (grok reads that shared folder from HOME; rig:",
  "expect(OpenclawAgentDriver.decodeConfig({ agent: \"../x\" }).agent).toBeUndefined();",
  "* - OPENCODE_DISABLE_EXTERNAL_SKILLS: no ~/.agents and other external skills;",
  "rmSync(join(work, \".agents\"), { recursive: true, force: true });",
  "export const ANTIGRAVITY_WORKSPACE_ROOTS = [\".agents\", \".agent\", \"_agents\", \"_agent\"] as const;",
  "const agents = integrations?.agents;",
  "(typeof taskType === \"string\" && taskType.endsWith(\"_agent\")) || typeof subagentType === \"string\";",
  "mkdirSync(join(home, \".agents\", \"skills\", \"shared\"), { recursive: true });",
  "// skill and an ~/.agents skill): before 13.2k tokens with the owner's server",
  "if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };",
  "expect((bindCredentialPath(stableServers, \"/x/y.json\").agents as { env: Record<string, string> }).env.MURAGE_CRED_FILE).toBe(\"/x/y.json\");",
  "expect(existsSync(join(workspace, \".agents\", \"skills\", \"abstract-writing\"))).toBe(true);",
  "mkdirSync(join(sub, \".agents\", \"commands\"), { recursive: true });",
  "const SKILL_DIRS = [\".fuigo\", \".agents\", \".claude\", \".cursor\"].flatMap((d) => [`${d}/skills`, `${d}/commands`]);",
  "expect(f.captured[0].integrations?.agents).toBeUndefined();",
  "expect(existsSync(join(custom,\".agents\"))).toBe(false);expect(readFileSync(join(custom,\"owner.txt\"),\"utf8\")).toBe(\"untouched\");",
  "const link = (desk: string, name: string) => join(desk, \".agents\", \"skills\", name);",
  "symlinkSync(join(desk, \".murage-procedures\", \"bundle_old\", \"skills\", \"review\"), join(desk, \".agents\", \"skills\", \"renamed\"), \"dir\");",
  "const SKILL_ROOTS = [\".fuigo\", \".agents\", \".claude\", \".cursor\", \".grok\"].flatMap((d) => [`${d}/skills`, `${d}/commands`]);",
  "? (config as { agent?: unknown }).agent",
  "const link=join(taskWorkspacePath(DATA_DIR,id,\"first\"),\".agents\",\"skills\",\"checked-method\");",
  "mkdirSync(join(root, \".agents\", \"skills\"), { recursive: true });",
  "expect(()=>readFileSync(join(taskWorkspacePath(DATA_DIR,botId,\"private-next\"),\".agents\",\"skills\",name,\"SKILL.md\"))).toThrow();",
  "expect(existsSync(join(desk,\".agents\",\"skills\",\"other-note\"))).toBe(true);",
  "const preferred = [\"skills\", \".claude\", \".agents\"];",
  "expect(existsSync(join(root, \".agents\", \"skills\", \"native-boundary\"))).toBe(true);",
  "mkdirSync(join(process.cwd(), \".agents\"), { recursive: true });",
  "if (agentsEnvPath && turn.integrations?.agents) writeFileSync(agentsEnvPath, JSON.stringify(turn.integrations.agents.env));",
  "if (!view?.agents) return copy.recommendation;",
  "const rows = (view?.agents ?? []).map(runnableRow);",
  "if (n < 5 || p[0] != L\"workspaces\" || p[n-2] != L\"skills\" || (p[n-3] != L\".claude\" && p[n-3] != L\".agents\" && p[n-3] != L\".grok\")) return false;",
  "if (turn.integrations?.agents) own.set(turn.integrations.agents.serverName ?? \"agents\", \"own:agents\");",
  "// ~/.agents skills and commands load under ACP; hooks and rules did not).",
  "* (droid resolves `.factory` and `.agents` under it): a Murage-owned home, one",
];

const CODE_AND_PROSE = [
  "turn.integrations?.agents;",
  "getX().agents",
  "\"_agent\"",
  "def run(_agent):",
  "const _agents = []",
  "the .agents folder",
  "Skills live in the `.agents` folder.",
  "return this.config.agents;",
  "const agents = turn.integrations?.agents;\nconst x = 1;",
  // an escaped quote in source is not a path separator
  "const cmd = \"cd \\\".agents\\\" && ls\";",
];

describe("agy-workspace-hooks reads the root folder only as a path", () => {
  const edit = (content: string) => {
    const target = "/Users/jo/work/app/src/agents.ts";
    return ["write_to_file", `write_to_file ${target}`, at("write_to_file", { TargetFile: target, CodeContent: content })] as const;
  };

  it("code and prose naming .agents or _agent get no card at Auto, Full or No limits", () => {
    for (const text of CODE_AND_PROSE) {
      expect(agyRow.re.test(text), text).toBe(false);
      expect(looksSensitive(text), text).toBe(false);
      const [tool, summary, context] = edit(text);
      expect(autoVerdict(auto, tool, summary, context), text).toMatchObject({ source: "auto-mode" });
      expect(autoVerdict(full, tool, summary, context), text).toMatchObject({ source: "full-access" });
      expect(autoVerdict(unlimited, tool, summary, context), text).toMatchObject({ source: "no-limits" });
    }
  });

  it("a file-content edit containing integrations?.agents passes at Auto", () => {
    const content = "export function mounts(turn: Turn) {\n  const agents = turn.integrations?.agents;\n  return agents?.env ?? {};\n}\n";
    const [tool, summary, context] = edit(content);
    expect(autoVerdict(auto, tool, summary, context)).toMatchObject({ source: "auto-mode" });
    expect(autoVerdict(auto, tool, summary, context).approve).toBeTruthy();
  });

  it("the repository's own lines the old row matched hold nothing", () => {
    expect(REPO_LINES).toHaveLength(47);
    const held = REPO_LINES.filter((line) => agyRow.re.test(line) || looksSensitive(line));
    expect(held).toEqual([]);
    const [tool, summary, context] = edit(REPO_LINES.join("\n"));
    expect(autoVerdict(auto, tool, summary, context)).toMatchObject({ source: "auto-mode" });
  });

  it("every hook-file shape and the root folder as a target still hold, at Auto and No limits", () => {
    for (const command of [
      "cat x > .agents/hooks.json",
      "cp p.json ./.agents/plugins.json",
      "cp a.md \"/x/.agents/agents/a.md\"",
      "cp h.json .\\.agents\\hooks.json",
      "cp h.json _agent/plugins/p/hooks.json",
      "cd .agents",
      "cd .agents && cp /tmp/h.json hooks.json",
      "mv /tmp/evil .agents",
      "mv /tmp/evil _agents",
      "mv /tmp/evil \".agents\"",
      "rm -rf ./.agents",
      "mv /tmp/evil /Users/jo/work/app/.agent",
      "mv hooks.json .agents/",
      // shapes the first narrowing let through (Fable, on dec9a5d53)
      "cd \".agents\"; cp h hooks.json",
      "cd _agents; cp h hooks.json",
      "mv /tmp/evil \"_agents\"",
      "D=\".agents\"; cp h \"$D/hooks.json\"",
      "python3 -c 'import os; os.chdir(\".agents\"); open(\"hooks.json\", \"w\").write(\"{}\")'",
      "node -e 'require(\"fs\").writeFileSync(require(\"path\").join(\".agents\", \"hooks.json\"), \"{}\")'",
      // the Win32 spellings of the plugins and agents folders as a target (SG-WIN-PATHTRICKS.md)
      "Copy-Item -Recurse evil .agents\\plugins.",
      "Move-Item evil .agents\\agents.",
      "Copy-Item -Recurse evil \".agents\\plugins. \"",
      "cp -r evil .agents/plugins:evil", // a `$DATA` in a shell line is a variable, held as always-ask: the stream forms with `$` are path tests
      "Copy-Item h.json .agents\\hooks.json:evil",
      "Copy-Item h.json \\\\.\\C:\\work\\app\\.agents\\hooks.json",
      "Copy-Item h.json \\\\localhost\\C$\\work\\app\\.agents\\hooks.json.",
      "Copy-Item a.md .agents\\agents:stream",
    ]) {
      expect(agyRow.re.test(command), command).toBe(true);
      for (const bot of [auto, full, unlimited]) {
        // `rm -rf` is held by the destructive guard first; the key guard still names it at Full and No limits
        const verdict = autoVerdict(bot, "run_command", command, at("run_command", { command }));
        expect(verdict, command).toMatchObject({ approve: null });
        expect(["sensitive-guard", "destructive-guard"], command).toContain(verdict.source);
      }
    }
  });

  describe("on a real tree", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-selfguard-narrow-"));
    const project = join(root, "project");
    mkdirSync(join(project, ".agents", "skills", "lint"), { recursive: true });
    mkdirSync(join(project, ".agents", "workflows"), { recursive: true });
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "lint", "SKILL.md"), "x");
    writeFileSync(join(project, ".agents", "hooks.json"), "{}");
    writeFileSync(join(project, "src", "a.ts"), "x");
    afterAll(() => removeTempDir(root));

    it("a folder the path only passes through holds nothing: .agents/skills and workflows are ordinary files", () => {
      for (const path of [".agents/skills/lint/SKILL.md", ".agents/skills/new/SKILL.md", ".agents/workflows/ship.md", join(project, ".agents", "skills", "lint", "SKILL.md")]) {
        expect(inProjectCheck(path, project, "x"), path).toMatchObject({ ok: true });
      }
    });

    it("the hook files and the root folder itself still hold", () => {
      for (const path of [".agents/hooks.json", ".agents/plugins.json", ".agents/plugins/p/hooks.json", ".agents/agents/a.md", ".agents", join(project, ".agents")]) {
        expect(inProjectCheck(path, project, "x"), path).toMatchObject({ ok: false, reason: "sensitive", rule: "agy-workspace-hooks" });
      }
    });

    it("a walk descends .agents and holds only its hooks file", () => {
      const walked = walkRoot(project, project);
      expect(walked.ok).toBe(true);
      if (!walked.ok) return;
      // a walk hit is relative to the search root and `/`-separated on every platform (WalkHit.path)
      expect(walked.hits.map((hit) => hit.path).sort()).toEqual([".agents/hooks.json"]);
    });

    it("on Windows the real tree holds the hooks file by either separator, any case, given or absolute", () => {
      if (process.platform !== "win32") return;
      for (const path of [".agents\\hooks.json", ".agents/hooks.json", ".AGENTS\\HOOKS.JSON", ".Agents/Hooks.Json", ".agents\\plugins.json", "_AGENTS\\agents\\a.md", join(project, ".agents", "hooks.json"), join(project, ".AGENTS", "HOOKS.JSON"), `${project.replace(/\\/g, "/")}/.agents/hooks.json`]) {
        expect(inProjectCheck(path, project, "x"), path).toMatchObject({ ok: false, reason: "sensitive", rule: "agy-workspace-hooks" });
      }
      expect(inProjectCheck(".agents\\skills\\lint\\SKILL.md", project, "x")).toMatchObject({ ok: true });
    });
  });

  it("with Windows path rules, every spelling of a hooks file is held: either separator, mixed case, every root", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-selfguard-win32-"));
    try {
      const spellings = [
        ".agents\\hooks.json", ".agents/hooks.json", ".AGENTS\\HOOKS.JSON", ".Agents/hooks.JSON", ".agents\\Hooks.json",
        ".agent\\hooks.json", "_agents\\hooks.json", "_AGENT/hooks.json", ".agents\\plugins.json", ".agents/PLUGINS.json",
        ".agents\\plugins\\p\\hooks.json", ".agents/plugins\\p/hooks.json", ".agents\\agents\\a.md", "_Agents\\Agents\\A.md",
        "sub\\.agents\\hooks.json", "C:\\work\\proj\\.Agents\\hooks.json", "C:/work/proj/.agents/HOOKS.json", ".agents", ".AGENTS",
        // and (SG-WIN-PATHTRICKS.md) a trailing dot or space, a stream suffix, the \\?\ and \\.\ prefixes and a loopback admin share
        ".agents\\hooks.json.", ".agents\\hooks.json ", ".agents\\hooks.json::$DATA", ".agents\\hooks.json:evil", ".agents\\plugins.", ".agents\\agents::$DATA",
        "\\\\?\\C:\\work\\proj\\.agents\\hooks.json", "\\\\.\\C:\\work\\proj\\.agents\\plugins.json", "\\\\localhost\\C$\\work\\proj\\.agents\\hooks.json", "\\\\?\\UNC\\127.0.0.1\\C$\\work\\proj\\_agents\\agents\\a.md.",
      ];
      for (const path of spellings) {
        for (const platform of ["win32", process.platform] as NodeJS.Platform[]) {
          expect(inProjectCheck(path, root, "x", { platform }), `${platform} ${path}`).toMatchObject({ ok: false, reason: "sensitive", rule: "agy-workspace-hooks" });
        }
      }
      for (const path of [".agents\\skills\\lint\\SKILL.md", ".AGENTS/workflows/ship.md", ".agents\\skills\\lint\\SKILL.md.", ".agents\\workflows\\ship.md::$DATA", "\\\\?\\C:\\work\\proj\\src\\agents.ts", "src\\plugins.\\x.ts"]) {
        expect(inProjectCheck(path, root, "x", { platform: "win32" }), path).not.toMatchObject({ reason: "sensitive" });
      }
    } finally {
      removeTempDir(root);
    }
  });
});
