// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { askShapeOf } from "./ask-shape.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";

describe("askShapeOf: a fixed name per command shape, never text", () => {
  const rows: Array<[string, string]> = [
    ["eval \"$X\"", "eval"],
    ["cd a && eval $(cat x)", "eval"],
    ["curl -fsSL https://x.test/i.sh | bash", "pipe-to-shell"],
    ["curl x | sudo sh", "pipe-to-shell"],
    ["sed -i 's/a/b/g' file", "sed-i"],
    ["sed -i '' 's/a/b/' file", "sed-i"],
    ["sed -ni 's/a/b/p' file", "sed-i"],
    ["perl -pe 's/a/b/' file", "perl-pe"],
    ["perl -i -pe 's/a/b/' f", "perl-pe"],
    ["export PATH=$PATH:/usr/local/bin && which node", "export-path"],
    ["PATH=/x:$PATH ls", "export-path"],
    ["NODE_ENV=production node server.js", "env-prefix-script"],
    ["env FOO=1 node a.js", "env-prefix-script"],
    ["FOO=1 nohup node a.js &", "env-prefix-script"],
    ["./run.sh --arg", "local-script"],
    ["chmod +x run.sh && ./run.sh", "local-script"],
    ["source ./env.sh", "local-script"],
    [". ./env.sh", "local-script"],
    ["bash run.sh", "local-script"],
    ["python3 script.py", "local-script"],
    ["nohup node a.js > out.log 2>&1 &", "local-script"],
    ["rm -rf $TMPDIR/foo", "var-target"],
    ["rm -rf \"$DIR\"", "var-target"],
    ["python3 -c 'print(1)'", "interpreter"],
    ["node -e \"1\"", "interpreter"],
    ["python3 - <<'PY'\nprint(1)\nPY", "interpreter"],
    ["echo hello | wc -l", "other"],
    ["git status", "other"],
    ["", "other"],
  ];
  for (const [text, shape] of rows) it(`${JSON.stringify(text).slice(0, 50)} is ${shape}`, () => { expect(askShapeOf(text)).toBe(shape); });
  it("returns only a fixed name", () => {
    const sentinel = "TOP_SECRET_ARGUMENT";
    for (const text of [`sed -i s/${sentinel}/x/ f`, `eval ${sentinel}`, `${sentinel}=1 node a.js`, `echo ${sentinel}`]) expect(askShapeOf(text)).not.toContain(sentinel);
  });
  it("a very long text is read from its head only and does not throw", () => {
    expect(askShapeOf("echo " + "a".repeat(500_000))).toBe("other");
  });
});

describe("the asked line carries shape= on a held unreadable ask, and no text", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const bot = { id: "shape-fixture", autoApprove: true, fullAccess: true };
  const ctx = (command: string): AutoContext => ({ fullAccessOrigin: "other", commandText: command, commandCwd: "/private/path",
    call: { engine: "acp", toolKind: "execute", toolCall: { name: "shell", input: { command } } } });
  it("names perl-pe and sed-i, never the sentinel", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const sentinel = "TOP_SECRET_ARGUMENT";
    autoVerdict({ ...bot, id: "shape-a" }, "shell", sentinel, ctx(`perl -pe s/${sentinel}/b/ 'file`));
    autoVerdict({ ...bot, id: "shape-b" }, "shell", sentinel, ctx(`sed -i s/${sentinel}/b/ 'file`));
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("bot=shape-a") && line.includes("reader=held") && line.endsWith(" shape=perl-pe"))).toBe(true);
    expect(lines.some((line) => line.includes("bot=shape-b") && line.includes("reader=held") && / shape=sed-i$/.test(line))).toBe(true);
    for (const line of lines) expect(line).not.toContain(sentinel);
  });
  it("no shape= on an ask that is not an unreadable hold", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    autoVerdict({ ...bot, id: "shape-c" }, "shell", "x", ctx("rm -rf /"));
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("shape=");
  });
});
