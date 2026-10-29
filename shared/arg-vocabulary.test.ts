// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The word lists, pinned whole (Rules 55, 56, 68f, 70, 71b4, 73b, 74c), and
// the pure rows of T101, T106 and T107.

import { describe, expect, it } from "vitest";
import {
  ABSENT_PINS, ADDRESSING_KEYS, CONTENT_KEYS, ENV_PINS, INTERACTIVE_CONTINUATIONS, INTERACTIVE_PROGRAMS, isRewritablePath,
  METADATA_KEYS, NAME_LISTERS, NARROWERS, NOT_REWRITABLE, PATH_KEYS, PAYEE_KEYS, PIN_NAMES, RECURSIVE_READERS, ROLE_PINS,
  ROUTING_KEYS, ROUTING_VALUES, valuePins,
} from "./arg-vocabulary.ts";

describe("Rule 55 / 56 lists", () => {
  it("PATH_KEYS is the delete reader's keys plus the ACP aliases, whole", () => {
    expect(PATH_KEYS).toEqual(["path", "paths", "file_path", "filePath", "notebook_path", "notebookPath", "target", "file", "files", "directory", "dir", "new_path", "destination"]);
  });

  it("every routing key has exactly one ROUTING_VALUES row, and the polarities read as the rule says", () => {
    for (const key of ROUTING_KEYS) expect(ROUTING_VALUES.filter((row) => row.key === key).length, key).toBe(1);
    expect(ROUTING_VALUES.find((row) => row.key === "private")).toMatchObject({ polarity: "widens-when-false" });
    expect(ROUTING_VALUES.find((row) => row.key === "notify")).toMatchObject({ polarity: "widens-when-true" });
    const visibility = ROUTING_VALUES.find((row) => row.key === "visibility");
    expect(visibility).toMatchObject({ polarity: "enum" });
    if (visibility?.polarity === "enum") {
      expect(visibility.widening).toContain("public");
      expect(visibility.narrowing).toContain("private");
      expect(visibility.widening.some((word) => visibility.narrowing.includes(word))).toBe(false);
    }
  });

  it("keeps the stop line's recipient keys and adds the rule's, with no duplicate in any list", () => {
    for (const key of ["to", "cc", "bcc", "channel", "chat_id", "attendees", "mentions", "handle"]) expect(ADDRESSING_KEYS).toContain(key);
    for (const list of [ADDRESSING_KEYS, PAYEE_KEYS, CONTENT_KEYS, METADATA_KEYS, ROUTING_KEYS]) expect(new Set(list).size).toBe(list.length);
    expect(METADATA_KEYS).toContain("dry_run");
    expect(CONTENT_KEYS).toContain("reply_to");
  });
});

describe("Rule 70: RECURSIVE_READERS (T101, pure rows)", () => {
  it("names every reader the rule lists, and only grep, rg, ugrep and git grep narrow", () => {
    const programs = RECURSIVE_READERS.map((row) => row.program);
    for (const program of ["grep", "rg", "ag", "ack", "ugrep", "git grep", "diff", "tar", "zip", "cp", "rsync", "scp", "find", "bfs", "xargs", "cat", "head", "tail", "sort", "wc", "strings", "od", "xxd", "sed", "awk", "less", "more"]) {
      expect(programs, program).toContain(program);
    }
    expect(RECURSIVE_READERS.filter((row) => row.narrowable).map((row) => row.program).sort()).toEqual(["git grep", "grep", "rg", "ugrep"]);
    expect(NAME_LISTERS).toEqual(["find", "bfs", "ls", "tree", "du", "stat", "file", "Glob"]);
  });

  it("every narrowable reader has a NARROWERS row", () => {
    for (const row of RECURSIVE_READERS.filter((reader) => reader.narrowable)) {
      expect(NARROWERS.some((narrower) => narrower.program === row.program), row.program).toBe(true);
    }
  });
});

describe("Rule 71b4: role pins", () => {
  it("pins a pattern slot with -e and a name slot with --", () => {
    expect(ROLE_PINS.filter((row) => row.pin === "-e").map((row) => row.program)).toEqual(["grep", "rg", "egrep", "fgrep", "ugrep", "git grep"]);
    expect(ROLE_PINS.filter((row) => row.pin === "--").map((row) => row.program)).toEqual(["basename", "dirname", "ls"]);
    expect(ROLE_PINS.some((row) => row.program === "sed")).toBe(false);
  });
});

describe("Rule 68f and 74c (T106, pure rows)", () => {
  it("man is not an interactive program; pagers, editors and REPLs are", () => {
    const programs = INTERACTIVE_PROGRAMS.map((row) => row.program);
    expect(programs).not.toContain("man");
    for (const program of ["bash", "python3", "node", "psql", "sqlite3", "less", "vim", "ssh", "tmux", "irb", "php -a", "top"]) expect(programs, program).toContain(program);
    expect(INTERACTIVE_PROGRAMS.find((row) => row.program === "vim")).toMatchObject({ kind: "named" });
    expect(INTERACTIVE_PROGRAMS.find((row) => row.program === "irb")).toMatchObject({ kind: "repl-only" });
  });

  it("every name PIN_NAMES and the continuations list is a key of ENV_PINS", () => {
    const pinned = new Set(ENV_PINS.map((pin) => pin.name));
    for (const row of PIN_NAMES) for (const name of row.names) expect(pinned.has(name), `${row.program}: ${name}`).toBe(true);
    for (const row of INTERACTIVE_CONTINUATIONS) for (const name of row.names) expect(pinned.has(name), `${row.program}: ${name}`).toBe(true);
  });

  it("the absence pins are exactly the six the rule names (delta 2 adds GIT_SSH; 1.0.9 SHELLOPTS and BASHOPTS), and no name is both a value and an absence", () => {
    expect([...ABSENT_PINS].sort()).toEqual(["BASHOPTS", "BASH_ENV", "CLAUDE_ENV_FILE", "ENV", "GIT_SSH", "POSIXLY_CORRECT", "PYTHONINSPECT", "SHELLOPTS"]);
    const values = valuePins("linux");
    for (const name of ABSENT_PINS) expect(values.has(name)).toBe(false);
    expect(values.get("PAGER")).toBe("cat");
    expect(values.get("GIT_EDITOR")).toBe("true");
    expect(values.get("ZDOTDIR")).toBe("/dev/null");
    expect(valuePins("win32").get("ZDOTDIR")).toBe("NUL");
    // delta 1: the askpass pins are the empty string on every platform (git runs askpass only when it is non-empty)
    for (const name of ["GIT_ASKPASS", "SSH_ASKPASS"]) {
      expect(values.get(name)).toBe("");
      expect(valuePins("win32").get(name)).toBe("");
    }
    for (const [name, value] of valuePins("win32")) expect(value.startsWith("/"), name).toBe(false);
    expect(values.get("LESS")).toBe("");
    expect(new Set(ENV_PINS.map((pin) => pin.name)).size).toBe(ENV_PINS.length);
  });
});

describe("Rule 73b: NARROWERS and the rewritable-path rule (T107, pure rows)", () => {
  it("every row appends a trailing exclusion; permutation is documented only for GNU grep and ripgrep", () => {
    expect(NARROWERS.filter((row) => row.permutation === "documented").map((row) => `${row.program}${row.variant ? `:${row.variant}` : ""}`).sort()).toEqual(["grep:gnu", "rg"]);
    expect(NARROWERS.find((row) => row.program === "rg")?.file).toEqual(["--glob", "!/<rel>"]);
    expect(NARROWERS.find((row) => row.program === "git grep")).toMatchObject({ placement: "after-double-dash", file: [":(exclude)<rel>"] });
    expect(NARROWERS.find((row) => row.variant === "gnu")).toMatchObject({ file: ["--exclude=<base>"], dir: ["--exclude-dir=<base>"] });
  });

  it("a name holding any metacharacter of any exclusion language is never rewritable; ordinary names are", () => {
    for (const ch of NOT_REWRITABLE) expect(isRewritablePath(`a${ch}b.env`), JSON.stringify(ch)).toBe(false);
    for (const path of [".env", ".git", "node_modules", "id_rsa", "dir with space/.env", "café/.env", "a-b.c_d/.env"]) expect(isRewritablePath(path), path).toBe(true);
    expect(isRewritablePath("")).toBe(false);
  });
});
