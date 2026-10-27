// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ExecFileOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import { errorTextCases, ERROR_TEXT_LEAK } from "./testing/error-text-fixtures.ts";
import { updateClaudeCli } from "./claude-update.ts";

type Callback = (error: Error | null, stdout: string, stderr?: string) => void;

describe("updateClaudeCli", () => {
  it.each(errorTextCases())("redacts updater stderr before the HTTP error cut: $name", async ({ raw, name }) => {
    const execute = (_cli: string, _args: string[], _options: ExecFileOptions, callback: Callback) => {
      callback(Object.assign(new Error("exit 1"), { code: 1 }), "", raw);
    };
    const error = await updateClaudeCli("claude", {}, execute).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toMatch(ERROR_TEXT_LEAK);
    if (name === "short diagnostic") expect(message).toBe(`Claude update failed: ${raw}. Run \`claude update\` in Terminal, then try again.`);
  });

  it("runs the official updater before reading the installed version", async () => {
    const calls: Array<{ cli: string; args: string[]; options: ExecFileOptions }> = [];
    const execute = (cli: string, args: string[], options: ExecFileOptions, callback: Callback) => {
      calls.push({ cli, args, options });
      callback(null, args[0] === "--version" ? "2.1.280 (Claude Code)\n" : "updated\n");
    };
    await expect(updateClaudeCli("/opt/claude", { PATH: "/bin" }, execute)).resolves.toEqual({ version: "2.1.280 (Claude Code)" });
    expect(calls.map((call) => call.args)).toEqual([["update"], ["--version"]]);
    expect(calls[0].options).toMatchObject({ timeout: 180_000, killSignal: "SIGKILL" });
    expect(calls[0].options.env).toEqual({ PATH: "/bin" });
  });

  it("does not read the version after a failed update and says how to do it by hand", async () => {
    let calls = 0;
    const execute = (_cli: string, _args: string[], _options: ExecFileOptions, callback: Callback) => {
      calls += 1;
      callback(Object.assign(new Error("exit 1"), { code: 1, stderr: "permission denied by updater\nmore" }), "", "permission denied by updater");
    };
    await expect(updateClaudeCli("claude", {}, execute)).rejects.toThrow("Claude update failed: permission denied by updater. Run `claude update` in Terminal");
    expect(calls).toBe(1);
  });

  it("reports when the update finishes but the version cannot be read", async () => {
    const execute = (_cli: string, args: string[], _options: ExecFileOptions, callback: Callback) => {
      if (args[0] === "update") callback(null, "updated");
      else callback(Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "");
    };
    await expect(updateClaudeCli("claude", {}, execute)).rejects.toThrow("Claude finished updating, but Murage could not read");
  });
});
