// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 hook self-guard. Antigravity's relay hook (DATA_DIR/native/antigravity-relay/<turn>/murage-agy-relay.cjs and
// its .env), the Ask hook (native/antigravity-ask/ask-hook-<hex>.cjs), the scoped home (native/antigravity-scope) and
// Codex's hook files (murage-hook.mjs/.cmd/.env under native/codex-scope) are re-read by the engine on every call. At
// Full access a call that writes over one would replace the guard that judges every later call, so any call that
// names one is held at every level, No limits included, and never answered by a mode or a grant.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { autoVerdict, looksSensitive, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { routeDelivery } from "./drivers/codex-hook.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { globKeyRead } from "../shared/sensitive-globs.ts";

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
      ["run_command", "node scripts/hook.mjs > out.txt", { command: "node scripts/hook.mjs > out.txt" }],
      ["run_command", "npx vitest run server/drivers/antigravity-relay.test.ts", { command: "npx vitest run server/drivers/antigravity-relay.test.ts" }],
      ["write_to_file", "write_to_file /Users/jo/work/app/.agents/skills/lint/SKILL.md", { TargetFile: "/Users/jo/work/app/.agents/skills/lint/SKILL.md", CodeContent: "x" }],
      ["run_command", "cat src/agents/hooks.json", { command: "cat src/agents/hooks.json" }],
    ] as const) {
      expect(autoVerdict(full, tool, summary, at(tool, input)), summary).toMatchObject({ source: "full-access" });
      expect(autoVerdict(full, tool, summary, at(tool, input)).approve, summary).toBeTruthy();
    }
  });
});
