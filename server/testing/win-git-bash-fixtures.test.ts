// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// W0 packet integrity only; these tests do not qualify a Windows executable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/win-git-bash-trust/${name}.json`, import.meta.url), "utf8"));
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("WIN-GIT-BASH W0: reproducible synthetic qualification inputs", () => {
  it("retains the reviewed package and all eight measured member identities", () => {
    const reference = fixture("reference");
    expect(reference.package.bytes).toBe(60_097_272);
    expect(reference.package.sha256).toBe("f5764d546ff9a2511b50ec4e20424c5f4669de1695abc3fa4128e7f7d4a7b2cd");
    expect(reference.manifest).toMatchObject({ schema: 1, machine: 0x8664, gitVersion: "2.51.2.windows.1", launchProtocol: 1 });
    expect(reference.manifest.layouts).toEqual([
      { id: "GFW-BIN", entry: "bin/bash.exe", implementation: "usr/bin/bash.exe" },
      { id: "GFW-USR", entry: "usr/bin/bash.exe", implementation: "usr/bin/bash.exe" },
    ]);
    expect(reference.manifest.members.map((m: { relative: string }) => m.relative)).toEqual([
      "bin/bash.exe", "usr/bin/bash.exe", "usr/bin/cygpath.exe", "usr/bin/env.exe",
      "usr/bin/msys-2.0.dll", "usr/bin/msys-iconv-2.dll", "usr/bin/msys-intl-8.dll", "usr/bin/uname.exe",
    ]);
    expect(reference.manifest.members.reduce((n: number, m: { bytes: number }) => n + m.bytes, 0)).toBe(7_304_257);
    for (const member of reference.manifest.members) expect(member.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.evidence).toEqual({ source: "DESIGN-r2.md section 2.2", runtimeQualification: "unmeasured", reproducedInBuilder: false });
  });

  it.each(["claude-plain", "claude-cd", "fuigo-pwsh", "codex-control"])("keeps %s original bytes distinct from historical receipts", name => {
    const row = fixture(name);
    expect(row.provenance).toBe("synthetic-definition");
    expect(row.inputDigest).toBe(digest(row.command));
    expect(row.effectiveCwdNative).toBe("C:\\Users\\fixture\\work");
    expect(row.runtimeEvidence).toBeNull();
    if (name === "fuigo-pwsh") {
      expect(row.dialect).toBe("pwsh");
      expect(row.command).toBe("& 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Git\\bin\\bash.exe' './build.sh'");
      expect(row.requiredProtocol).toBe("murage/bash-launch/1");
    }
    if (name === "codex-control") expect(row.expectedPrivateTrust).toBe(false);
    if (name === "claude-plain") expect(row.command).toBe("printf '#!/bin/bash\\necho ok\\n' > hello.sh && bash hello.sh");
    if (name === "claude-cd") expect(row.command).toBe(`cd /c/Users/fixture/work && ${fixture("claude-plain").command}`);
  });

  it("covers the full 192-cell same-turn matrix with separate occurrence reservations", () => {
    const matrix = fixture("same-turn-matrix");
    expect(matrix.engines).toEqual(["claude", "pi", "fuigo"]);
    expect(matrix.cases).toHaveLength(192);
    const cells = new Set<string>();
    for (const row of matrix.cases) {
      const key = [row.prefix, row.write, row.route, row.shebang, row.lineEnding, row.cwdKind].join("|");
      expect(cells.has(key), key).toBe(false);
      cells.add(key);
      const ending = row.lineEnding === "CRLF" ? "\r\n" : "\n";
      expect(row.body).toBe(`${row.shebang}${ending}echo ok${ending}`);
      expect(row.bodyDigest).toBe(digest(row.body));
      expect(row.inputDigest).toBe(digest(row.command));
      expect(row.runtimeEvidence).toBeNull();
      const occurrence = row.expectedOccurrence;
      expect(Buffer.from(row.command).subarray(occurrence.startByte, occurrence.endByte).toString())
        .toBe(row.route === "direct" ? "./hello.sh" : "bash");
      expect(occurrence.role).toBe(row.route === "direct" ? "direct-script" : "nested-bash");
      expect(row.requiresSeparateReservation).toBe(true);
      expect(row.writeInput).toEqual(row.write === "Write" ? { path: "hello.sh", content: row.body } : null);
      expect(row.command.startsWith("cd ")).toBe(row.prefix === "cd");
    }
    for (const prefix of ["plain", "cd"])
      for (const write of ["Write", "printf"])
        for (const route of ["direct", "explicit"])
          for (const shebang of ["#!/bin/bash", "#!/usr/bin/bash", "#!/usr/bin/env bash", "#!/bin/sh", "#!/usr/bin/sh", "#!/usr/bin/env sh"])
            for (const lineEnding of ["LF", "CRLF"])
              for (const cwdKind of ["native", "msys"])
                expect(cells.has([prefix, write, route, shebang, lineEnding, cwdKind].join("|"))).toBe(true);
  });

  it("keeps operand-only Bash strings and original Unicode byte offsets", () => {
    const rows = fixture("occurrence-controls");
    expect(rows.map((row: { command: string }) => row.command)).toContain("env printf bash");
    expect(rows.map((row: { command: string }) => row.command)).toContain("find . -exec printf bash \\;");
    for (const row of rows) {
      expect(row.inputDigest).toBe(digest(row.command));
      if (row.control === "operand") expect(row.expectedBashOccurrences).toEqual([]);
      for (const occurrence of row.expectedBashOccurrences) {
        expect(Buffer.from(row.command).subarray(occurrence.startByte, occurrence.endByte).toString()).toBe(occurrence.source);
      }
    }
    const unicode = rows.find((row: { control: string }) => row.control === "unicode-offset");
    expect(unicode.expectedBashOccurrences[0].startByte).toBeGreaterThan(unicode.command.lastIndexOf("bash"));
  });

  it("requires argv round trips for each native launch target preserving the Bash payload", () => {
    const rows = fixture("argv-roundtrip");
    expect(rows.targets).toEqual(["GFW-BIN", "GFW-USR", "murage-exec-win"]);
    const corpus = rows.cases.flatMap((row: { argv: string[] }) => row.argv);
    for (const value of ["", 'a"b', "C:\\space dir\\", "日本語", "printf '%s\\n' \"$HOME\""]) expect(corpus).toContain(value);
    for (const row of rows.cases) {
      expect(row.expectedArgv).toEqual(row.argv);
      expect(row.nativeRoundtripEvidence).toBeNull();
    }
  });
});
