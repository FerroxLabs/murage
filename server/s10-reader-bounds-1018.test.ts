// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10): the bounds and memos the reader's other rows reach only through the whole verdict, each pinned on its own.
// Every row fails when its bound or memo is taken away (the S10 mutation run). A tempered row finds the same matches as
// its plain form; the plain form costs by the square of a long run of its first word, so those rows are timed.
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_RULES, autoVerdict } from "./auto-approve.ts";
import { approvalSummary } from "../shared/approval-summary.ts";
import { MAX_COMMAND_SEPARATORS, overCommandBudget, pinOverrideIn, promptVerdict } from "../shared/prompt-capable.ts";
import { GLOB_BUDGET_REASON, globFailClosed, globKeyRead } from "../shared/sensitive-globs.ts";
import { SENSITIVE_RULES } from "../shared/sensitive-paths.ts";
import { TEXT_RULES } from "./key-text.ts";

const PINS = new Map([["GIT_TERMINAL_PROMPT", "0"]]);
const script = (lines: number) => Array.from({ length: lines }, (_, k) => `echo "step ${k}" && mkdir -p build/${k % 9} # line`).join("\n");

describe("the split memo and the prompt reader's bounds", () => {
  it("the split memo keys on the whole text: a long text read first never answers for a longer one", () => {
    const long = script(400);
    expect(promptVerdict(long, undefined)).toBeNull();
    expect(promptVerdict(`${long}\nssh h ls`, undefined)?.rule).toBe("direct-ssh");
    expect(pinOverrideIn(long, PINS)).toBeNull();
    expect(pinOverrideIn(`${long}\ngit -c core.askPass=x fetch`, PINS)).toMatch(/core\.askPass/);
  });

  it("the separator budget is 40,000: one more and the text is past it", () => {
    expect(MAX_COMMAND_SEPARATORS).toBe(40_000);
    expect(overCommandBudget("a;".repeat(40_000))).toBe(false);
    expect(overCommandBudget("a;".repeat(40_001))).toBe(true);
  });

  it("past the separator budget the pin read is the name scan only (the always-ask reader holds the text)", () => {
    const over = "a;".repeat(40_001);
    expect(pinOverrideIn("git -c core.askPass=x fetch", PINS)).toMatch(/core\.askPass/);
    expect(pinOverrideIn(`${over}git -c core.askPass=x fetch`, PINS)).toBeNull();
    expect(pinOverrideIn(`${over}env GIT_TERMINAL_PROMPT=1 git fetch`, PINS)).toMatch(/GIT_TERMINAL_PROMPT/);
  });

  it("past 32 wrappers the prompt reader says it could not read the command", () => {
    expect(promptVerdict(`${"nohup ".repeat(10)}ssh h ls`, undefined)?.rule).toBe("direct-ssh");
    for (const wrapper of ["nohup ", "command ", "env ", "time "]) expect(promptVerdict(`${wrapper.repeat(40)}ssh h ls`, undefined)?.rule).toBe("unreadable");
  });

  it("past 16 pin-bearing program names behind the first the pin read holds", () => {
    expect(pinOverrideIn(`${"git ".repeat(10)}status`, PINS)).toBeNull();
    expect(pinOverrideIn(`${"git ".repeat(20)}status`, PINS)).toMatch(/A long list of program names/);
    expect(pinOverrideIn(`nohup ${"git ".repeat(20)}status`, PINS)).toMatch(/A long list of program names/);
  });

  it("a glob longer than 1,024 characters is not read, and could name a key file", () => {
    expect(globKeyRead(`x*${"y".repeat(1000)}`)).toBeNull();
    expect(globKeyRead(`x*${"y".repeat(1100)}`)).toMatch(/a glob longer than Murage reads/);
  });
});

describe("the glob reader reads a long run of brackets in linear time (Grok r7)", () => {
  const timedUnder = (label: string, run: () => unknown, ms = 100) => {
    const start = performance.now();
    run();
    expect(performance.now() - start, label).toBeLessThan(ms);
  };
  const GATE = 128 * 1024;
  it("131,072 of `[` with no `]` returns in under 100 ms, and a real glob is still found", () => {
    timedUnder("globKeyRead [", () => expect(globKeyRead("[".repeat(GATE))).toBeNull());
    timedUnder("globKeyRead word", () => expect(globKeyRead(`cat ${"[".repeat(GATE)}]`)).toMatch(/a glob longer than Murage reads/));
    timedUnder("globKeyRead lines", () => expect(globKeyRead(`${"[\n".repeat(GATE / 2)}`)).toBeNull());
    expect(globKeyRead("cat ~/.aw?/credentials")).not.toBeNull();
    // a `[` closed by a later `]` is a glob (it could name `.env`), as before
    expect(globKeyRead(`${"[".repeat(1000)}]`)).not.toBeNull();
    // a `]` after a `[` on another line is not a bracket expression, as before
    expect(globKeyRead("[\n]")).toBeNull();
  });
  it("the Full access verdict on the same text returns in time", () => {
    const FULL = { id: "fa", autoApprove: true, fullAccess: true };
    for (const command of ["[".repeat(GATE), `cat <<'EOF'\n${"[".repeat(60_000)}\nEOF`]) {
      timedUnder(`verdict ${command.length}`, () => autoVerdict(FULL as never, "shell", approvalSummary(command), { exactCommand: { command } } as never), 1500);
    }
  });
});

describe("the shared nothing-known state is never written to", () => {
  it("a line that sets names after an eval it cannot read does not leave them behind for the next line", () => {
    const pins = new Map([["SSH_ASKPASS", "x"], ["SSH_ASKPASS_REQUIRE", "force"]]);
    // the eval's text cannot be split, so the shell state after it is "nothing known"
    pinOverrideIn(`eval "'"; export SSH_ASKPASS=x SSH_ASKPASS_REQUIRE=force`, pins);
    pinOverrideIn(`eval "'"; SSH_ASKPASS=x; SSH_ASKPASS_REQUIRE=force`, pins);
    expect(pinOverrideIn(`eval "'"; ssh h ls`, pins)).toMatch(/SSH_ASKPASS is not known/);
  });
});

describe("the tempered rows read a long run of their first word in linear time", () => {
  const rows = [...DESTRUCTIVE_RULES, ...SENSITIVE_RULES, ...TEXT_RULES];
  const row = (needle: string): RegExp => {
    const found = rows.filter((re) => re.source.includes(needle));
    expect(found.length, needle).toBeGreaterThan(0);
    return found[0]!;
  };
  const cases: [string, string, string][] = [
    ["dd", "\\bdd\\s+", "dd x ".repeat(25_000)],
    ["git push", "\\bgit\\s+push\\s+", "git push ".repeat(14_000)],
    ["fork bomb", ":\\(\\)\\s*\\{", ":(){ ".repeat(25_000)],
    ["env | grep", "\\benv\\b", "env ".repeat(30_000)],
    ["Command Processor AutoRun", "Command Processor", "Command Processor ".repeat(14_000)],
    ["Fuigo home", "FUIGO_HOME", ".fuigo ".repeat(36_000)],
  ];
  for (const [name, needle, text] of cases) {
    it(`${name}: under 250 ms on ${text.length.toLocaleString("en-US")} characters`, () => {
      const re = row(needle);
      const start = performance.now();
      expect(re.test(text)).toBe(false);
      expect(performance.now() - start).toBeLessThan(250);
    });
  }

  it("the .ssh key row follows a path no further than 4,096 characters, the longest path a system takes", () => {
    // the pem/ppk row (another row reads the .ssh folder itself)
    const re = row("\\.(pem|ppk)");
    expect(re.test(`cat ~/.ssh/${"a".repeat(4000)}.pem`)).toBe(true);
    expect(re.test(`cat ~/.ssh/${"a".repeat(5000)}.pem`)).toBe(false);
  });

  it("the tempered rows still find their real cases", () => {
    expect(row("\\bdd\\s+").test("dd if=x.img of=/dev/disk2 bs=1m")).toBe(true);
    expect(row("\\bgit\\s+push\\s+").test("git push origin main --force")).toBe(true);
    expect(row(":\\(\\)\\s*\\{").test(":(){ :|:& };:")).toBe(true);
    expect(row("\\benv\\b").test("env | grep TOKEN")).toBe(true);
    expect(row("Command Processor").test("reg add \"HKCU\\Software\\Microsoft\\Command Processor\" /v AutoRun /d x")).toBe(true);
  });
});

// 1.0.18 (S10, MurageMain's ruling 11-07): the glob read carries a work budget linear in the text's length. Spent, the
// text is held as a key read (fail closed, logged), never passed.
describe("the glob read's work budget", () => {
  const timedRead = (text: string, platform: NodeJS.Platform = "linux") => {
    const before = globFailClosed.count;
    const start = performance.now();
    const verdict = globKeyRead(text, platform);
    return { verdict, ms: performance.now() - start, failedClosed: globFailClosed.count - before };
  };

  it("holds a text whose globs cost more than its length allows, quickly and with the budget's reason", () => {
    const text = Array.from({ length: 128 }, (_, k) => `**/a${k}/**/b/**/c/**/d/**/e/**/f/**/g/**/h/qq`).join(" ");
    const run = timedRead(text);
    expect(run.failedClosed).toBe(1);
    expect(run.verdict).toBe(GLOB_BUDGET_REASON);
    expect(run.ms).toBeLessThan(100);
  });

  it("does not fire on the everyday globs, which read as before", () => {
    const run = timedRead("ls src/**/*.ts && cat ~/.aw?/credentials");
    expect(run.failedClosed).toBe(0);
    expect(run.verdict).not.toBeNull();
    expect(timedRead("prettier --write 'src/**/*.{ts,tsx}' '*.json'").verdict).toBeNull();
  });

  it("every Grok r7 input and each repeated unit at 128 KiB finishes under 100 ms, and a stopped read never passes", () => {
    const K = 128 * 1024;
    const fill = (unit: string, chars = K) => unit.repeat(Math.floor(chars / unit.length));
    const texts = [".".repeat(131069) + " x *", "[".repeat(K), "cat <<'EOF'\n" + "[".repeat(60000) + "\nEOF", "[".repeat(200000), fill("FUIGO_HOME "),
      // 128 long globs, each with the most `**` read: every tail of each is matched against every key sample
      Array.from({ length: 128 }, (_, k) => `${"**/a/".repeat(8)}${"b/".repeat(480)}q${k}`).join(" "),
      Array.from({ length: 128 }, (_, k) => `~/${"**/.ssh/".repeat(8)}${"x/".repeat(450)}q${k}?`).join(" "),
      ...["[", "[]", "*", "?", "**/", "~/.ssh/", "[a-z]", "[!x]", "a*b?", "*/*/", "~/.aw?/", " ** ", "\\\\?\\c:\\", "[[:alpha:]]", "-x="].map((unit) => fill(unit))];
    for (const platform of ["linux", "win32"] as const) for (const text of texts) {
      const run = timedRead(text, platform);
      expect(run.ms, `${JSON.stringify(text.slice(0, 16))}… (${text.length} chars)`).toBeLessThan(100);
      if (run.failedClosed > 0) expect(run.verdict).toBe(GLOB_BUDGET_REASON);
    }
  });
});

import { readFileSync } from "node:fs";
import * as glob11 from "../shared/sensitive-globs.ts";
it("R5b long glob held before canonical", () => {
  const start = performance.now(); expect(globKeyRead(".".repeat(131069) + "*", "win32")).toBe("a glob longer than Murage reads could name a key file"); expect(performance.now()-start).toBeLessThan(100);
});
it("R5d canonical cannot erase an overlong glob", () => expect(globKeyRead("a".repeat(1025) + ":*", "win32")).toBe("a glob longer than Murage reads could name a key file"));
it("the inventory holds: no REWRITE regex is left and every cap is in place", () => {
  for (const file of ["../shared/in-project.ts", "../shared/sensitive-paths.ts", "./drivers/pi-permission-gate.ts", "../shared/sensitive-globs.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const forbidden of ["/^-[a-z]*r[a-z]*$/i", "/:.*$/", "/[. ]+$/", "(?:^|[;&|(`\\n]|\\$\\()\\s*(?:(?:sudo"]) expect(source, file).not.toContain(forbidden);
  }
  expect(glob11.MAX_GLOB_CHARS).toBe(1024);
  expect(readFileSync(new URL("../shared/sensitive-globs.ts", import.meta.url), "utf8")).toContain("(segment.match(/[*?]/g)?.length ?? 0) > 16");
});

const globGenerators11 = [(k: number) => ".".repeat(k-1)+"*", (k: number) => ":".repeat(k-2)+"\n*", (k: number) => "a".repeat(k-2)+":*", (k: number) => "*/".repeat(Math.floor(k/2)), (k: number) => "[".repeat(k), (k: number) => "~/.ssh/"+"?".repeat(k-7)];
it("A3 glob sweeps both platforms", () => {
  for (const platform of ["linux", "win32"] as const) for (const shape of globGenerators11) {
    const times = [8192,32768,131072].map(k => { const text = shape(k); let best = Infinity;
      for (let n=0;n<3;n++) { const before=globFailClosed.count, start=performance.now(); const result=globKeyRead(text,platform); best=Math.min(best,performance.now()-start); if(globFailClosed.count>before) expect(result).not.toBeNull(); } return best; });
    expect(times[2]).toBeLessThan(100); expect(times[2]!).toBeLessThanOrEqual(24*Math.max(times[0]!,1));
  }
});
it("A3 fixed-seed 2000 glob texts per generator both platforms", { timeout: 7_200_000 }, () => {
  let seed=11; const next=() => (seed=(Math.imul(seed,1664525)+1013904223)>>>0);
  const alphabet=["=",":",".","\n","\u2028","\uFDFA","İ","-"];
  for(const [g,shape] of globGenerators11.entries()) for(let n=0;n<2000;n++) {
    const tail=Array.from({length:16},()=>alphabet[next()%alphabet.length]).join(""); const text=(shape(131056)+tail).slice(0,131072);
    for(const platform of ["linux","win32"] as const) { const before=globFailClosed.count,start=performance.now();const result=globKeyRead(text,platform);
      expect(performance.now()-start,`generator ${g}, seed ${seed}, ${JSON.stringify(text.slice(0,80))}`).toBeLessThan(100); if(globFailClosed.count>before) expect(result).not.toBeNull(); }
  }
});
it("A3 tempered-row repeated start sweeps", () => {
  for (const unit of [".fuigo ","env ","Command Processor "]) {
    const times=[8192,32768,131072].map(k=>{const text=unit.repeat(Math.floor(k/unit.length));let best=Infinity;for(let n=0;n<3;n++){const start=performance.now(); for(const re of SENSITIVE_RULES) re.test(text);best=Math.min(best,performance.now()-start);}return best;});
    expect(times[2]).toBeLessThan(100);expect(times[2]!).toBeLessThanOrEqual(24*Math.max(times[0]!,1));
  }
});
