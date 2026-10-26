// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one sensitive list (Rule 35), its template carve-out (Rule 64) and the
// Claude projection generated from it (Rule 63, T90a).

import { describe, expect, it } from "vitest";
import { claudeSensitiveAskRules, SENSITIVE_PATHS, SENSITIVE_RULES, SENSITIVE_TEXT, sensitivePathRow, TEMPLATE_BASENAMES } from "./sensitive-paths.ts";
import { looksSensitive } from "../server/auto-approve.ts";

describe("Rule 35 rows", () => {
  it("every path row has a Read and a Bash spelling, and the projection carries them all (T90a)", () => {
    const rules = claudeSensitiveAskRules();
    for (const row of SENSITIVE_PATHS) {
      expect(row.read.length, row.id).toBeGreaterThan(0);
      expect(row.bash.length, row.id).toBeGreaterThan(0);
      for (const read of row.read) expect(rules).toContain(`Read(${read})`);
      for (const bash of row.bash) expect(rules).toContain(`Bash(${bash})`);
    }
    expect(rules.some((rule) => rule.startsWith("Read(!"))).toBe(false);
  });

  it("the verdict reads every row, the original order first", () => {
    expect(SENSITIVE_RULES.length).toBe(SENSITIVE_PATHS.length + SENSITIVE_TEXT.length);
    expect(SENSITIVE_RULES[0]).toBe(SENSITIVE_PATHS[0]!.re);
  });

  it("holds the Windows spellings, the startup files, ~/.gitconfig and the in-project rows", () => {
    for (const text of [
      "type C:\\Users\\me\\_netrc", "cat ~/.azure/accessTokens.json", "C:/Users/me/AppData/Roaming/gcloud/credentials.db",
      "cat ~/.ssh/id_ecdsa", "cat ~/.kube/config", "cat ~/.git-credentials", "cat ~/.pgpass", "cat ~/.zlogin", "cat ~/.bash_logout",
      "cat ~/.config/fish/config.fish", "cat /etc/zshenv", "cat /etc/profile.d/x.sh", "cat ~/.psqlrc", "git config --global -e # ~/.gitconfig",
      "cat ./.git/config", "echo x > .git/hooks/pre-commit", "cat .claude/settings.json", "cat .vscode/tasks.json", "cat .husky/pre-push",
      "./node_modules/.bin/x", "cat .envrc", "reg add \"HKCU\\Software\\Microsoft\\Command Processor\" /v AutoRun",
    ]) expect(looksSensitive(text), text).toBe(true);
    for (const text of ["git status", "cat README.md", "ls src", "git config user.name"]) expect(looksSensitive(text), text).toBe(false);
  });
});

describe("Rule 64 template carve-out", () => {
  it("removes only the .env row, only inside the project", () => {
    expect(TEMPLATE_BASENAMES).toEqual([".env.example", ".env.sample", ".env.template", ".env.dist"]);
    for (const name of TEMPLATE_BASENAMES) {
      expect(sensitivePathRow(`/p/${name}`, true), name).toBeNull();
      expect(sensitivePathRow(`/p/${name}`, false), name).toBe("env");
    }
    for (const name of [".env.local", ".env.production", ".env.backup", ".env"]) expect(sensitivePathRow(`/p/${name}`, true), name).toBe("env");
    expect(sensitivePathRow("/p/.envrc", true)).toBe("envrc");
  });
});

describe("09-A3: a native Windows path to .env is a key file", () => {
  it("matches a backslash before .env", () => {
    const env = SENSITIVE_PATHS.find((row) => row.id === "env")!;
    expect(env.re.test("C:\\work\\project\\.env")).toBe(true);
    expect(env.re.test("C:\\work\\project\\.env.local")).toBe(true);
  });
});

describe("09-B1: environment dumps and $HOME profile reads are sensitive text and paths", () => {
  it("reads $HOME spellings of the shell profile", () => {
    for (const text of ["cat $HOME/.zshrc", 'cat "$HOME/.zshrc"', "cat ${HOME}/.zshrc", "type %USERPROFILE%\\.bashrc", "cat ~/.zshrc"]) {
      expect(sensitivePathRow(text, false), text).toBe("shell-rc");
    }
  });
  it("matches a bare environment dump and leaves wrappers and prose alone", () => {
    const row = SENSITIVE_TEXT.find((r) => r.id === "env-dump")!;
    for (const text of ["env", "printenv", "printenv HOME", "export -p", "declare -p", "set", "ls; env", "env > /tmp/x", "sudo env"]) expect(row.re.test(text), text).toBe(true);
    for (const text of ["env FOO=1 ls", "export FOO=1", "set -e", "the environment is fine", "node --env-file x"]) expect(row.re.test(text), text).toBe(false);
  });
});
