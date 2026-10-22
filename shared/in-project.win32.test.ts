// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lanes/release103/SG-WIN-PATHTRICKS.md on a real Windows file system: the
// spellings Win32 reads as one file (a trailing dot or space, the default
// and a named stream, the \\?\ and \\.\ prefixes, a loopback admin share)
// reach the same file as the plain spelling, and the hook self-guard holds
// every one of them at every boundary: the in-project check, the broker's
// verdict at No limits, and Antigravity's relay self-check.
//
// Two readers prove "the same file". Node namespaces every path as verbatim
// (`\\?\`), so to it `hooks.json.` and `hooks.json ` do not exist (ENOENT):
// those spellings are proven through Win32 proper (PowerShell, which reads
// the file), and the guard reads them by their canonical spelling because
// the walk keeps a name Node cannot open as written. Streams and the
// prefixes Node resolves itself (stat, realpath). Windows only: on any
// other OS each of these spellings is a file name of its own.

import { spawnSync } from "node:child_process";
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
  /** The spellings Win32 reads as `real` and Node resolves too: streams, the prefixes, a loopback share, `/`. */
  const nodeForms = (real: string): string[] => {
    const tail = real.slice(2);
    return [
      `${real}::$DATA`, `\\\\?\\${real}`, `\\\\.\\${real}`, real.replace(/\\/g, "/"), `//?/${real.replace(/\\/g, "/")}`,
      `\\\\localhost\\${drive}$${tail}`, `\\\\127.0.0.1\\${drive}$${tail}`, `\\\\?\\UNC\\localhost\\${drive}$${tail}`, `\\\\LOCALHOST\\${drive.toLowerCase()}$${tail}::$DATA`,
    ];
  };
  /** The spellings only Win32 proper reads as `real`: a trailing dot or space on the last part, or on a folder part. */
  const win32OnlyForms = (real: string): string[] => {
    const at = real.lastIndexOf("\\");
    return [`${real}.`, `${real} `, `${real}. . `, `${real.slice(0, at)}.${real.slice(at)}`, `\\\\?\\${real}. ::$DATA`];
  };
  const formsOf = (real: string): string[] => [...nodeForms(real), ...win32OnlyForms(real)];
  const loopback = (form: string) => /^\\\\(?:\?\\UNC\\)?[^?.]/.test(form);
  const full: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["write_to_file", "run_command"] };
  const sameFile = (form: string, real: string): boolean | "unreachable" => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(form);
    } catch {
      return "unreachable";
    }
    const want = statSync(real);
    return st.ino === want.ino && st.dev === want.dev; // one file index on one volume (a named stream has its own size)
  };
  /** What Win32 proper reads at this spelling: PowerShell's Get-Content, or null when it opens nothing. */
  const win32Reads = (form: string): string | null => {
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Content -LiteralPath '${form.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`], { encoding: "utf8", timeout: 20_000 });
    const out = (run.stdout ?? "").trim();
    return out === "" ? null : out;
  };

  it("every spelling reaches the one hooks file: Node resolves streams and the prefixes, Win32 proper the trailing dots and spaces", () => {
    const unreachable: string[] = [];
    for (const form of [...nodeForms(hooks), ...(streams ? [`${hooks}:evil`, `${hooks}:evil:$DATA`] : [])]) {
      const same = sameFile(form, hooks);
      if (same === "unreachable") {
        // a loopback admin share needs the Server service and an administrator: not every box has it, and the guard holds it anyway
        expect(loopback(form), form).toBe(true);
        unreachable.push(form);
        continue;
      }
      expect(same, form).toBe(true);
      // realpath reads the plain spelling back (a named stream keeps its name, a share its share: both canonical to the file)
      expect(win32Canonical(realpathSync.native(form)).toLowerCase(), form).toBe(hooks.toLowerCase());
    }
    for (const form of win32OnlyForms(hooks).slice(0, 4)) {
      expect(sameFile(form, hooks), form).toBe("unreachable"); // Node namespaces the path as verbatim: the dot stays, nothing is there
      expect(win32Reads(form), form).toBe("{}"); // Win32 proper strips it and reads the hooks file
    }
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
        // placed inside by its real path (a name Node cannot open is kept as written beneath its real folder), except through a
        // loopback share, which names the file by the share, not the drive: that is outside (a card), never a hook file
        if (loopback(form)) expect(checked, form).toMatchObject({ ok: false, reason: "outside" });
        else expect(checked, form).toMatchObject({ ok: true });
      }
    }
    // the template carve-out reads the Win32 spelling: `.env.example.` is the template, and a real key in its body still holds
    expect(inProjectCheck(`${project}\\.env.example.`, project, "PORT=1")).toMatchObject({ ok: true });
    expect(inProjectCheck(`${project}\\.env.example::$DATA`, project, "PORT=1")).toMatchObject({ ok: true });
    expect(inProjectCheck(`${project}\\.env.example.`, project, "KEY=sk-proj-abcdefghijklmnopqrstuvwxyz")).toMatchObject({ ok: false, reason: "sensitive", rule: "key-literal" });
    expect(inProjectCheck(`${project}\\.env.`, project, "PORT=1")).toMatchObject({ ok: false, reason: "sensitive", rule: "env" });
    // a walk through the prefixed root still finds the hook files, by their plain relative paths
    const walked = walkRoot(`\\\\?\\${project}`, project);
    expect(walked.ok).toBe(true);
    if (walked.ok) expect(walked.hits.map((hit) => hit.path).sort()).toEqual([".agents/hooks.json", ".agents/plugins"]);
  });

  it("the broker holds every spelling at No limits, and the key text carries the plain real path", () => {
    const plainOf = (path: string) => win32Canonical(path).replace(/\//g, "\\").toLowerCase();
    for (const form of formsOf(hooks)) {
      const input = { TargetFile: form, CodeContent: "{}" };
      const found = realKeyPaths(input, [form], project);
      expect(found.paths.map(plainOf), form).toContain(hooks.toLowerCase());
      const verdict = autoVerdict(full, "write_to_file", `write_to_file ${form}`, { stopLine: null, call: { toolCall: { name: "write_to_file", input } }, realPaths: found.paths, ...(found.cannot ? { realPathCannot: found.cannot } : {}) });
      expect(verdict, form).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    for (const command of [`Copy-Item -Recurse x ${project}\\.agents\\plugins.`, `Move-Item x "${project}\\.agents\\agents:evil"`, `Copy-Item h.json \\\\localhost\\${drive}$${rest}\\.agents\\hooks.json.`]) {
      expect(autoVerdict(full, "run_command", command, { stopLine: null, call: { toolCall: { name: "run_command", input: { command } } } }), command).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    for (const form of [`\\\\?\\${source}`, `${source}.`, `//?/${source.replace(/\\/g, "/")}`]) {
      const plain = { TargetFile: form, CodeContent: "x" };
      const found = realKeyPaths(plain, [form], project);
      expect(found.cannot, form).toBeNull();
      expect(found.paths.map(plainOf), form).toContain(source.toLowerCase());
      expect(autoVerdict(full, "write_to_file", `write_to_file ${form}`, { stopLine: null, call: { toolCall: { name: "write_to_file", input: plain } }, realPaths: found.paths }), form).toMatchObject({ source: "no-limits" });
    }
  });

  it("Antigravity's relay self-check holds every spelling of its own files and of a workspace hooks folder", () => {
    const ask = (tool_name: string, tool_input: Record<string, unknown>) => antigravityRelayAsk({ tool_name, tool_input, tool_use_id: "c:1" }, project, own);
    for (const form of formsOf(relay)) {
      expect(ask("write_to_file", { TargetFile: form, CodeContent: "x" }).toolInputMissing, form).toMatch(/Murage's check/);
    }
    for (const command of [`Copy-Item x ${project}\\.agents\\plugins.`, `Move-Item x .agents\\agents:evil`, `Copy-Item x \\\\.\\${relay}.`]) {
      expect(ask("run_command", { CommandLine: command }).toolInputMissing, command).toMatch(/Murage's check/);
    }
    for (const form of formsOf(source)) expect(ask("write_to_file", { TargetFile: form, CodeContent: "x" }).toolInputMissing, form).toBeUndefined();
  });
});
