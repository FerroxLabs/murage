import { describe, expect, it } from "vitest";
import { DownloadRegistry, TextBudget, type FsHooks } from "./download-registry.ts";
import { registerText } from "./outside-register.ts";
import { cwdOutsideMark } from "./outside-wire.ts";

const fs: FsHooks = {
  realpath: p => p,
  lstat: () => ({ dir: true, ctime: 1 }),
};
function marked(text: string, cwd = "/bots/a", isMarked = true) {
  const entries = registerText(text, { cwd, now: 10_000, marked: isMarked, readOnly: false, turn: "fixture", roots: ["/"], budget: new TextBudget(fs) });
  const registry = new DownloadRegistry(); registry.add(entries);
  return { entries, at: (path: string) => cwdOutsideMark(path, registry, fs, "codex", () => []) };
}
const shapes = [
  ["/bots/a", 'cd "/bots/a" && echo hello > hello.txt', "/bots/b"],
  ["/bots/a", 'cd "/bots/a/"; echo hello > hello.txt', "/bots/b"],
  ["C:/bots/a", 'cd "C:/bots/a" && echo hello > hello.txt', "C:/bots/b"],
  ["C:/bots/a", "cd 'C:\\bots\\a' && echo hello > hello.txt", "C:/bots/b"],
  // r9 P4: a double-quoted backslash cd word (coverage only: green on base d8edf63c32 too; its RED is N3/M1, the W1 relief mutant)
  ["C:/bots/a", 'cd "C:\\bots\\a" && echo hello > hello.txt', "C:/bots/b"],
] as const;
describe("CLONED-CWD r9 amended plain no-op cd relief", () => {
  it.each(shapes)("the no-op cd in %s does not mark a pre-existing sibling", (cwd, text, sibling) => {
    const view = marked(text, cwd);
    expect(view.at(sibling)).toBeNull();
    expect(view.at(cwd)).not.toBeNull();
  });
  it.each([
    'cd "/bots/b" && touch x', 'cd "/bots/a" && cd .. && touch x',
    'cd /d "/bots/a" && touch x', '(cd "/bots/a"); touch x',
    'cd "/bots/a" 2>/dev/null && touch x', 'cd -P "/bots/a" && touch x',
    'cd "/bots/a" && python3 -c \'open(chr(46)*2+chr(47)+"AGENTS.md","w")\'',
    'cd "/bots/a" && bash hello.sh', 'cd "/bots/a" && pnpm run build',
    'cd "/bots/a" && echo "$OLDPWD"', 'cd "/bots/a" && echo parent',
  ])("unproved remainder retains the baseline parent mark: %s", text => {
    expect(marked(text).at("/bots/b")).not.toBeNull();
  });
  // Windows run 44132434893 (MAIN 17:13Z): inside double quotes listB reads `\` as an escape, so `"C:\bots\a"` lost its
  // separators and gave no parent window; the A1 over-mark must hold on a Windows cwd as on POSIX (the single-quoted row is the control).
  it.each([
    'cd "C:\\bots\\a" && bash hello.sh', 'cd "C:\\bots\\a" && echo hello > hello.sh',
    'cd "C:\\bots\\a" && echo hello > hello.node', 'cd "C:\\bots\\a" && echo hello > hello.cmd',
    "cd 'C:\\bots\\a' && bash hello.sh",
  ])("Windows cwd: unproved remainder retains the baseline parent mark: %s", text => {
    expect(marked(text, "C:/bots/a").at("C:/bots/b")).not.toBeNull();
  });
  it.each([true, false])("a URL-bearing generated script marks its actual destination, marked=%s", isMarked => {
    const view = marked("printf 'curl -o /outside/drop/X https://example.invalid/p\\n' > run.sh; sh run.sh", "/bots/a", isMarked);
    expect(view.at("/outside/drop")).not.toBeNull();
  });
});
