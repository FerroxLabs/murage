// STICKY-ACTIONS (Sean 11-01): title, Close, Refresh and Save stay in view while the
// content scrolls, on every box. This reads the source, so a new box that skips
// BoxShell fails here before anyone has to find it by scrolling.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

/** The opening tag around `at`, with `>` inside {...} and "..." skipped. */
function openingTag(source: string, at: number): string {
  let start = at;
  while (start > 0 && !(source[start] === "<" && /[a-zA-Z]/.test(source[start + 1] ?? ""))) start--;
  let depth = 0, quote = "";
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === quote && source[i - 1] !== "\\") quote = ""; continue; }
    if (c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(start, i + 1);
  }
  return source.slice(start);
}

const ROOT = /<dialog\b|role="dialog"|role="alertdialog"|aria-modal="true"|role=\{ring \? "alertdialog"/g;

/** `read` finds the component a root names in data-box-content. */
export function boxProblems(source: string, read: (name: string) => string = () => ""): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let shelled = false;
  for (const match of source.matchAll(ROOT)) {
    // A selector in a string is not a box.
    const line = source.slice(source.lastIndexOf("\n", match.index) + 1, source.indexOf("\n", match.index));
    if (/querySelector|\.closest\(|^\s*'\[|^\s*\/\/|^\s*\/?\*|'\[aria-modal/.test(line)) continue;
    const tag = openingTag(source, match.index);
    if (seen.has(tag)) continue;
    seen.add(tag);
    const exempt = /data-box-exempt="([^"]*)"/.exec(tag);
    if (exempt) {
      if (exempt[1].length < 12) problems.push(`exemption gives no reason: ${tag.slice(0, 70)}`);
      continue;
    }
    const content = /data-box-content="(\w+)"/.exec(tag)?.[1];
    if (!/BOX_(FRAME|DIALOG|PANES)/.test(tag)) problems.push(`box root skips BoxShell: ${tag.slice(0, 90)}`);
    else if (content) { const child = read(content); if (!/<BoxHead\b/.test(child) || !/<BoxBody\b/.test(child)) problems.push(`${content} has no BoxHead and BoxBody`); }
    else shelled = true;
    if (/overflow-(y-)?auto|overflow-y-scroll/.test(tag)) problems.push(`box root scrolls, only BoxBody may: ${tag.slice(0, 90)}`);
  }
  if (shelled && !/<BoxHead\b/.test(source)) problems.push("box has no BoxHead");
  if (shelled && !/<BoxBody\b/.test(source)) problems.push("box has no BoxBody");
  return problems;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("._") || name === "e2e") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

describe("every box is built on BoxShell", () => {
  it("catches a box that skips the shell", () => {
    expect(boxProblems('<div role="dialog" aria-modal="true" className="max-h-96 overflow-y-auto p-4"><h2>Hi</h2></div>')).toHaveLength(2);
    expect(boxProblems('<dialog ref={r} className="m-auto"><p>Hi</p></dialog>')).toHaveLength(1);
    expect(boxProblems('<div role="dialog" className={cn(BOX_FRAME, "w-80")}><p>Hi</p></div>')).toEqual(["box has no BoxHead", "box has no BoxBody"]);
    expect(boxProblems('<div role="dialog" data-box-exempt="no">x</div>')).toHaveLength(1);
  });
  it("passes a box on the shell, and a reasoned exemption", () => {
    expect(boxProblems('<div role="dialog" className={cn(BOX_FRAME, "w-80")}><BoxHead>a</BoxHead><BoxBody>b</BoxBody></div>')).toEqual([]);
    expect(boxProblems('<div role="alertdialog" data-box-exempt="inline confirm inside a section">x</div>')).toEqual([]);
    const named = '<dialog data-box-content="Inbox" className={BOX_DIALOG}><Inbox /></dialog>';
    expect(boxProblems(named, () => "<BoxHead>a</BoxHead><BoxBody>b</BoxBody>")).toEqual([]);
    expect(boxProblems(named, () => "<div>a</div>")).toHaveLength(1);
  });
  it("holds for every box in src", () => {
    const problems = sources(SRC).flatMap(path => boxProblems(readFileSync(path, "utf8"), name => readFileSync(join(SRC, "components", `${name}.tsx`), "utf8")).map(problem => `${relative(SRC, path)}: ${problem}`));
    expect(problems).toEqual([]);
  });
});

describe("full pages keep their head out of the scroller", () => {
  it.each(["Inbox", "Files", "today/TodayView", "ProjectBoardShell", "health/HealthPageBody"])("%s", name => {
    const source = readFileSync(join(SRC, "components", `${name}.tsx`), "utf8");
    expect(source).toMatch(/<BoxHead\b/);
    expect(source).toMatch(/<BoxBody\b/);
  });
});

describe("a long form inside a page keeps its Save row in reach", () => {
  it.each(["AboutMeSettings", "BackupRemoteSettings", "BotAccessSettings", "BotTeamsSection", "HouseRulesSettings", "LocalModelsSettings", "McpServersPanel", "NotificationSettings", "skills/SkillEditor"])("%s", name => {
    expect(readFileSync(join(SRC, "components", `${name}.tsx`), "utf8")).toMatch(/className=\{[^}\n]*BOX_SAVE_ROW/);
  });
});

describe("the shell keeps its promises", () => {
  const shell = readFileSync(join(SRC, "components/ui/BoxShell.tsx"), "utf8");
  it("only the body scrolls", () => {
    expect(shell.match(/overflow-y-auto/g)).toHaveLength(1);
    expect(shell).toMatch(/data-box-body[^\n]*overflow-y-auto/);
    expect(shell).toMatch(/data-box-head[^\n]*shrink-0/);
    expect(shell).toMatch(/data-box-foot[^\n]*shrink-0/);
  });
  it("clips rather than hides, so focus cannot scroll the head away", () => {
    for (const name of ["BOX_FRAME", "BOX_DIALOG", "BOX_PANES"]) expect(new RegExp(`${name} = "[^"]*overflow-clip`).test(shell)).toBe(true);
  });
  it("a closed native dialog stays closed", () => {
    expect(shell).toMatch(/BOX_DIALOG = "[^"]*open:flex/);
    expect(/BOX_DIALOG = "[^"]*(?<!open:)\bflex\b/.test(shell)).toBe(false);
  });
  it("the native dialog box follows the keyboard", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const rule = /\.box-dialog \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("var(--vvh-inset)");
    expect(rule).toContain("var(--vvt");
  });
});
