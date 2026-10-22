// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lanes/release103/SG-WIN-PATHTRICKS.md on a real Windows file system: the
// spellings Win32 reads as one file (a trailing dot or space, the default
// and a named stream, the \\?\ and \\.\ prefixes, a loopback admin share)
// stat to the same file as the plain spelling, and the hook self-guard
// holds every one of them at every boundary: the in-project check, the
// broker's verdict at Full access, and Antigravity's relay self-check.
// Windows only: on any other OS each of these spellings is a file name of
// its own.

import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoVerdict, realKeyPaths, type AutoApprover } from "../server/auto-approve.ts";
import { antigravityRelayAsk } from "../server/drivers/antigravity-relay.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { inProjectCheck, walkRoot, win32Canonical } from "./in-project.ts";

describe.runIf(process.platform === "win32")("the Win32 spellings of a hook file on a real NTFS tree", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "in-project-w32-")));
  const project = join(base, "proj");
  const hooks = join(project, ".agents", "hooks.json");
  const skill = join(project, ".agents", "skills", "lint", "SKILL.md");
  const source = join(project, "src", "a.ts");
  const own = join(base, "data", "native", "antigravity-relay", "agy-t1");
  const relay = join(own, "murage-agy-relay.cjs");
  mkdirSync(join(project, ".agents", "skills", "lint"), { recursive: true });
  mkdirSync(join(project, ".agents", "plugins", "p"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(own, { recursive: true });
  writeFileSync(hooks, "{}");
  writeFileSync(join(project, ".agents", "plugins", "p", "hooks.json"), "{}");
  writeFileSync(skill, "x");
  writeFileSync(source, "x");
  writeFileSync(join(project, ".env.example"), "PORT=");
  writeFileSync(relay, "x");
  let streams = true;
  try {
    writeFileSync(`${hooks}:evil`, "x"); // a named stream on the hooks file (NTFS only)
  } catch {
    streams = false;
  }
  afterAll(() => removeTempDirSync(base));

  const drive = project.slice(0, 1);
  const rest = project.slice(2); // `\Users\...\proj`
  /** Every Win32 spelling of `real`, a file under the project. */
  const formsOf = (real: string): string[] => {
    const tail = real.slice(2);
    return [
      `${real}.`, `${real} `, `${real}. . `, `${real}::$DATA`, `${real}. ::$DATA`,
      `\\\\?\\${real}`, `\\\\.\\${real}`,
      `\\\\localhost\\${drive}$${tail}`, `\\\\127.0.0.1\\${drive}$${tail}`, `\\\\?\\UNC\\localhost\\${drive}$${tail}`, `\\\\LOCALHOST\\${drive.toLowerCase()}$${tail}::$DATA`,
      real.replace(/\\/g, "/"), `//?/${real.replace(/\\/g, "/")}`,
    ];
  };
  const full: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["write_to_file", "run_command"] };
  const sameFile = (form: string, real: string): boolean | "unreachable" => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(form);
    } catch {
      return "unreachable";
    }
    const want = statSync(real);
    return st.ino === want.ino && st.dev === want.dev && st.size === want.size;
  };

  it("every spelling stats to the one hooks file, and realpath reads the plain spelling back", () => {
    const unreachable: string[] = [];
    for (const form of [...formsOf(hooks), ...(streams ? [`${hooks}:evil`, `${hooks}:evil:$DATA`] : [])]) {
      const same = sameFile(form, hooks);
      if (same === "unreachable") {
        // a loopback admin share needs the Server service and an administrator, and `//?/` is read by some Windows builds as
        // verbatim: not every box resolves them, and the guard holds them either way
        expect(form, form).toMatch(/^(?:\\\\(?:\?\\UNC\\)?(?:localhost|127\.0\.0\.1)\\|\/\/\?\/)/i);
        unreachable.push(form);
        continue;
      }
      expect(same, form).toBe(true);
    }
    // the plain, dotted, spaced, streamed and prefixed spellings read back as the one real path
    for (const form of formsOf(hooks).slice(0, 7)) expect(realpathSync.native(form).toLowerCase(), form).toBe(hooks.toLowerCase());
    for (const form of formsOf(hooks)) expect(win32Canonical(form).replace(/\//g, "\\").toLowerCase(), form).toBe(hooks.toLowerCase());
    if (unreachable.length) console.log(`loopback admin share not reachable here: ${unreachable.length} spellings held by the guard without a stat`);
  });

  it("the in-project check holds every spelling of the hook file and places every spelling of an ordinary file", () => {
    for (const form of [...formsOf(hooks), ...(streams ? [`${hooks}:evil`] : [])]) {
      expect(inProjectCheck(form, project, "x"), form).toMatchObject({ ok: false, reason: "sensitive", rule: "agy-workspace-hooks" });
    }
    for (const form of [`${project}\\.agents\\plugins.`, `${project}\\.agents\\plugins::$DATA`, `${project}\\.agents\\plugins\\p\\hooks.json.`, `\\\\?\\${project}\\.agents\\plugins\\p\\hooks.json`]) {
      expect(inProjectCheck(form, project, "x"), form).toMatchObject({ ok: false, reason: "sensitive", rule: "agy-workspace-hooks" });
    }
    for (const real of [skill, source]) {
      for (const form of formsOf(real)) {
        const checked = inProjectCheck(form, project, "x");
        expect(checked, form).not.toMatchObject({ reason: "sensitive" });
        // a spelling that resolves here is placed inside, except a loopback share, which names the file by the share, not the
        // drive: that is outside (a card), never a hook file
        if (sameFile(form, real) === true && !/^\\\\(?:\?\\UNC\\)?[^?.]/.test(form)) expect(checked, form).toMatchObject({ ok: true });
      }
    }
    // the template carve-out reads the Win32 spelling: `.env.example.` is the template, and a real key in its body still holds
    expect(inProjectCheck(`${project}\\.env.example.`, project, "PORT=1")).toMatchObject({ ok: true });
    expect(inProjectCheck(`${project}\\.env.example::$DATA`, project, "PORT=1")).toMatchObject({ ok: true });
    expect(inProjectCheck(`${project}\\.env.example.`, project, "KEY=sk-proj-abcdefghijklmnopqrstuvwxyz")).toMatchObject({ ok: false, reason: "sensitive", rule: "key-literal" });
    expect(inProjectCheck(`${project}\\.env.`, project, "PORT=1")).toMatchObject({ ok: false, reason: "sensitive", rule: "env" });
    // a walk through the prefixed root still finds the hooks file, by its plain relative path
    const walked = walkRoot(`\\\\?\\${project}`, project);
    expect(walked.ok).toBe(true);
    if (walked.ok) expect(walked.hits.map((hit) => hit.path).sort()).toEqual([".agents/hooks.json", ".agents/plugins"]);
  });

  it("the broker holds every spelling at No limits, and the key text carries the plain real path", () => {
    for (const form of formsOf(hooks)) {
      const input = { TargetFile: form, CodeContent: "{}" };
      const found = realKeyPaths(input, [form], project);
      expect(found.paths.map((path) => path.toLowerCase()), form).toContain(hooks.toLowerCase());
      const verdict = autoVerdict(full, "write_to_file", `write_to_file ${form}`, { stopLine: null, call: { toolCall: { name: "write_to_file", input } }, realPaths: found.paths, ...(found.cannot ? { realPathCannot: found.cannot } : {}) });
      expect(verdict, form).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    for (const command of [`Copy-Item -Recurse x ${project}\\.agents\\plugins.`, `Move-Item x "${project}\\.agents\\agents:evil"`, `Copy-Item h.json \\\\localhost\\${drive}$${rest}\\.agents\\hooks.json.`]) {
      expect(autoVerdict(full, "run_command", command, { stopLine: null, call: { toolCall: { name: "run_command", input: { command } } } }), command).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    const plain = { TargetFile: `\\\\?\\${source}.`, CodeContent: "x" };
    const found = realKeyPaths(plain, [plain.TargetFile], project);
    expect(found.paths.map((path) => path.toLowerCase())).toContain(source.toLowerCase());
    expect(autoVerdict(full, "write_to_file", `write_to_file ${plain.TargetFile}`, { stopLine: null, call: { toolCall: { name: "write_to_file", input: plain } }, realPaths: found.paths })).toMatchObject({ source: "no-limits" });
  });

  it("Antigravity's relay self-check holds every spelling of its own files and of a workspace hooks folder", () => {
    const ask = (tool_name: string, tool_input: Record<string, unknown>) => antigravityRelayAsk({ tool_name, tool_input, tool_use_id: "c:1" }, project, own);
    for (const form of formsOf(relay)) {
      expect(ask("write_to_file", { TargetFile: form, CodeContent: "x" }).toolInputMissing, form).toMatch(/Murage's check/);
    }
    for (const command of [`Copy-Item x ${project}\\.agents\\plugins.`, `Move-Item x .agents\\agents::$DATA`, `Copy-Item x \\\\?\\${relay}.`]) {
      expect(ask("run_command", { CommandLine: command }).toolInputMissing, command).toMatch(/Murage's check/);
    }
    for (const form of formsOf(source)) expect(ask("write_to_file", { TargetFile: form, CodeContent: "x" }).toolInputMissing, form).toBeUndefined();
  });
});
