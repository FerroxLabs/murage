// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one sensitive list (Rule 35), its template carve-out (Rule 64) and the
// Claude projection generated from it (Rule 63, T90a).

import { describe, expect, it } from "vitest";
import { claudeSensitiveAskRules, SENSITIVE_PATHS, SENSITIVE_RULES, SENSITIVE_TEXT, sensitiveNameRow, sensitivePathRow, TEMPLATE_BASENAMES } from "./sensitive-paths.ts";
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

describe("NOLIMITS-KEY-TEXT Part A rows", () => {
  const rowsOf = (text: string) => [...SENSITIVE_PATHS, ...SENSITIVE_TEXT].filter((row) => row.re.test(text)).map((row) => row.id);
  it("A2: the word goes, the file and the mounted folder stay", () => {
    for (const text of ["kubectl get serviceaccount", "grep -n serviceAccount deploy/"]) expect(rowsOf(text), text).toEqual([]);
    for (const text of ["cat sa-serviceaccount.json", "cat app_serviceaccount.p12", "cat serviceaccount.pem", "cat /var/run/secrets/kubernetes.io/serviceaccount/token", "cat C:\\x\\serviceaccount\\token"]) expect(rowsOf(text), text).toContain("credentials-json");
  });
  it("A3: the dot file is a whole basename", () => {
    for (const text of ["cat user.profile.json", "bot.profile", "ls src/api.profile.test.ts"]) expect(rowsOf(text), text).toEqual([]);
    for (const text of ["cat ~/.zshrc", "cat ~/.zshrc.bak", "cat .profile", "cat ./.profile", "cat $HOME/.bash_profile", "cat ${HOME}/.zshenv", "type %USERPROFILE%\\.bashrc", "X=~/.profile"]) expect(rowsOf(text), text).toContain("shell-rc");
  });
  it("A4: npmrc is the key place, the shims are tooling", () => {
    expect(rowsOf("type C:\\Users\\ada\\AppData\\Roaming\\npm\\etc\\npmrc")).toEqual(["windows-credential-files"]);
    expect(rowsOf("type %APPDATA%\\npm\\etc\\npmrc")).toEqual(["windows-credential-files"]);
    expect(rowsOf("C:\\Users\\ada\\AppData\\Roaming\\npm\\codex.cmd --version")).toEqual(["project-tooling"]);
    expect(rowsOf("cat C:/Users/ada/AppData/Roaming/gcloud/x")).toEqual(["windows-credential-files"]);
  });
  it("A7: a key has length", () => {
    expect(rowsOf("pip install sk-learn")).toEqual([]);
    expect(rowsOf(`x sk-${"a".repeat(16)}`)).toEqual(["key-literal"]);
  });
  it("A8: a print of one variable or of PowerShell's whole environment joins the dump row", () => {
    for (const text of ["declare -p OPENAI_API_KEY", "typeset -p HOME", "export -p HOME", "declare -xp HOME", "gci env:", "Get-ChildItem Env:", "dir env:", "ls; gci env:\\*"]) expect(rowsOf(text), text).toContain("env-dump");
    for (const text of ["declare -x FOO", "declare FOO=1", "export FOO=1", "gci src", "dir"]) expect(rowsOf(text), text).not.toContain("env-dump");
  });
  it("the Claude projection changes by exactly A2 and A4's spellings", () => {
    const rules = claudeSensitiveAskRules();
    for (const gone of ["Read(**/*serviceaccount*)", "Bash(*serviceaccount*)"]) expect(rules).not.toContain(gone);
    for (const added of ["Read(**/*serviceaccount*.json)", "Read(**/*serviceaccount*.p12)", "Read(**/*serviceaccount*.pem)", "Read(**/serviceaccount/**)", "Bash(*serviceaccount*.json*)", "Bash(*/serviceaccount/*)", "Read(~/AppData/Roaming/npm/etc/npmrc)", "Read(~/AppData/Roaming/npm/**)", "Bash(*AppData*Roaming*npm*)"]) expect(rules).toContain(added);
  });
  it("sensitiveNameRow is the one row test", () => {
    expect(sensitiveNameRow(".env")).toBe("env");
    expect(sensitiveNameRow("user.profile.json")).toBeNull();
    expect(sensitiveNameRow("config.toml")).toBeNull();
  });
});
