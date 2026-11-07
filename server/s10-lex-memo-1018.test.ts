// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10): a long text is lexed once per text. The memo moves no bound and changes no verdict, and no reader writes to the
// tokens every other reader will get.
import { describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { lex, Unreadable } from "./shell/lex.ts";
import { parse } from "./shell/parse.ts";
import { approvalSummary } from "../shared/approval-summary.ts";
import { pinOverrideIn } from "../shared/prompt-capable.ts";

const script = (lines: number, tail = "") => Array.from({ length: lines }, (_, k) => `echo "step ${k}" && mkdir -p build/${k % 9} # line`).join("\n") + tail;
const BOT = { id: "owned", autoApprove: true, fullAccess: true };
const verdict = (command: string) => {
  const v = autoVerdict(BOT as never, "shell", approvalSummary(command), { exactCommand: { command } as never } as never);
  return { approve: v.approve, source: v.source, rule: "rule" in v ? v.rule : undefined };
};

describe("the lex memo", () => {
  it("hands a long text's kept tokens back in a fresh array each time, and lexes a short one fresh", () => {
    const long = script(100);
    expect(long.length).toBeGreaterThanOrEqual(1024);
    const [a, b] = [lex(long), lex(long)];
    // the same token objects (lexed once), each caller its own array (the parser writes to its array: Astra r7 #2)
    expect(a).not.toBe(b);
    expect(a[0]).toBe(b[0]);
    expect(a).toEqual(b);
    expect(lex("echo short")).not.toBe(lex("echo short"));
    expect(lex("echo short")).toEqual(lex("echo short"));
  });

  it("a long text parses the same every time: the parser's `))` rewrite never reaches the kept tokens (Astra r7 #2)", () => {
    const text = "( (echo ok))\n#" + "a".repeat(1024);
    const runs = [0, 1, 2].map(() => { try { parse(text); return "ok"; } catch (error) { return String(error); } });
    expect(runs).toEqual(["ok", "ok", "ok"]);
    const nested = "( (echo ok)) && echo " + "b".repeat(1100);
    expect(verdict(nested)).toEqual(verdict(nested));
  });

  it("keys on the whole text: two long texts that differ only at the end never share an answer", () => {
    const long = script(400);
    // A comment yields no token, so the two texts differ in a word lex keeps.
    expect(JSON.stringify(lex(`${long}\necho a`))).not.toBe(JSON.stringify(lex(`${long}\necho b`)));
    // the same two texts through the whole verdict, the split reader included
    const plain = verdict(long);
    const wipe = verdict(`${long}\nrm -rf /`);
    expect(plain.approve).not.toBeNull();
    expect(wipe.approve).toBeNull();
    expect(verdict(long)).toEqual(plain);
    const pinned = (command: string) => pinOverrideIn(command, new Map([["GIT_TERMINAL_PROMPT", "0"]]));
    expect(pinned(long)).toBeNull();
    expect(pinned(`${long}\nexport GIT_TERMINAL_PROMPT=1`)).not.toBeNull();
    expect(pinned(long)).toBeNull();
  });

  it("keeps a refusal too, as the same refusal", () => {
    const open = `${script(100)}\necho 'never closed`;
    const refusal = (): unknown => { try { lex(open); } catch (error) { return error; } return null; };
    const first = refusal();
    expect(first).toBeInstanceOf(Unreadable);
    expect(refusal()).toBe(first);
  });

  it("moves no bound: past the length limit stays a refusal, every time", () => {
    const over = "a ".repeat(200 * 1024);
    for (let k = 0; k < 2; k++) expect(() => lex(over)).toThrow(Unreadable);
  });

  it("keeps a few texts, and an evicted one reads the same when it comes back", () => {
    const first = script(100, "\n# first");
    const tokens = lex(first);
    const same = JSON.stringify(tokens);
    for (let k = 0; k < 8; k++) lex(script(100, `\n# other ${k}`));
    const again = lex(first);
    expect(again).not.toBe(tokens);
expect(again[0]).not.toBe(tokens[0]);
    expect(JSON.stringify(again)).toBe(same);
  });

  it("no reader in a verdict writes to the tokens, and the second verdict on a text is the first", () => {
    for (const command of [script(100), `${script(100)}\nrm -rf /`, `${script(100)}\necho 'never closed`, `${script(100)} | sh`, `cat <<X\n${script(100)}\nX\n`, `eval '${script(100).replace(/"/g, "")}'`]) {
      let before: string | undefined;
      try { before = JSON.stringify(lex(command)); } catch (error) { expect(error).toBeInstanceOf(Unreadable); }
      const first = verdict(command);
      if (before !== undefined) expect(JSON.stringify(lex(command))).toBe(before);
      expect(verdict(command)).toEqual(first);
    }
  });
});
