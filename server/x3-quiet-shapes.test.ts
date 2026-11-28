import { expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";

const quiet = [
  "ls 2>&1", "cat README.md > /tmp/out.txt", "grep -r foo . 2>&1 | head",
  "rtk *.md", "grep --include=*.md -rn x .", "cat README*", "ls *.ts",
  "echo $(date) *.md", 'for f in *.md; do echo "$f"; done',
  "cd /proj/src && ls *.ts 2>&1", "cd subfolder && cat README* > /tmp/x",
  "cd /proj && git status", "cat README* ; echo `date`",
];
// Ruling M5: base's always-ask restriction is back, so a literal `< file` into a named script is no longer a quiet shape.
const carded = ["cat as*e*r*", "cd ~/.ssh && cat *", "cd $DIR && cat *.pem",
  'cd "$(pick)" && cat *', 'eval "$X"; cat *', "cd /proj && cd $UNK && cat *.md"];
function tree(mode = "normal"): CredentialGlobFs {
  return { realpath: async path => path, opendir: async path => {
    if (mode === "eacces") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    if (mode === "timeout") await new Promise(resolve => setTimeout(resolve, 80));
    const names = path.endsWith("/docs") ? ["a.md"] : ["README.md", "index.ts", "docs", "as.serviceaccount.json"];
    let i = 0;
    return { read: async () => { const name = names[i++]; return name === undefined ? null : { name, isDirectory: () => name === "docs", isSymbolicLink: () => false }; }, close: async () => {} };
  } };
}
async function judge(command: string, mode = "normal", retained = "/proj") {
  const prepared = await prepareShellJudgement(command, { targets: new Map([[retained, "recorded launch"]]) }, {
    attributed: true, namedCwd: retained, home: "/home/me", fs: tree(mode),
  });
  const verdict = autoVerdict({ id: "x3", autoApprove: true, fullAccess: true, noLimits: false }, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, commandCwd: "/proj",
    unseen: { platform: "posix", fs: { realpath: path => path, stat: path => ({ isFile: () => path === "/proj/script.py", isDirectory: () => path === "/proj" }) } },
    shellCwdPrepared: true, shellCwdByThread: new Map([["test", prepared.local]]), threadId: "test", globExpansionRule: prepared.rule,
  });
  if (process.env.X3_SHAPES_REPORT) console.log(JSON.stringify({ command, mode, retained, rule: prepared.rule, source: verdict.source, quiet: verdict.approve !== null }));
  return { prepared, verdict };
}
it.each(quiet)("QUIET %s", async command => {
  const { prepared, verdict } = await judge(command);
  expect(prepared.rule).toBeNull();
  expect(verdict).toMatchObject({ approve: expect.any(String) });
});
it.each(carded)("CARDED %s", async command => {
  const { prepared, verdict } = await judge(command);
  expect(prepared.rule).toBeTruthy();
  if (command.includes("$")) expect(prepared.local.unknown).toBeTruthy();
  // OVERREACH #6: the owner's own Full access turn runs the unreadable eval, as No limits does; the key guard still cards the rest
  if (command.startsWith("eval ")) {
    if (verdict.approve === null) expect(["always-ask", "sensitive-guard"]).toContain(verdict.source); // a glob that may name a key file keeps its card
    else expect(verdict).toMatchObject({ source: "full-access" });
  }
  else expect(verdict).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it.each(["eacces", "timeout"])("CARDED unreadable anchored glob: %s", async mode => {
  const { prepared, verdict } = await judge("cat /proj/as*e*r*", mode);
  expect(prepared.expansions.some(result => !result.available)).toBe(true);
  expect(verdict).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it("QUIET ordinary cd with retained ssh history", async () => {
  const { prepared, verdict } = await judge("cd /proj && git status", "normal", "/home/me/.ssh");
  expect(prepared.rule).toBeNull();
  expect(verdict.approve).toEqual(expect.any(String));
});
it.each(["cd $DIR", "echo $VAR", "if true; then echo ok; fi", "while false; do echo ok; done"])("QUIET no dependent glob %s", async command => {
  expect((await judge(command)).verdict.approve).toEqual(expect.any(String));
});

it("dynamic eval without a glob has no X3 finding; the existing reader still holds", async () => {
  const { prepared, verdict } = await judge('eval "$X"');
  expect(prepared.rule).toBeNull();
  // OVERREACH #6: the owner's own Full access turn runs the unreadable eval, as No limits does
  expect(verdict).toMatchObject({ approve: expect.any(String), source: "full-access" });
});
it.each(["python3 - < in.txt", "python3 /dev/stdin < in.txt", "python3 script.py < $INPUT", "python3 script.py < in.txt"])("stdin code or dynamic input remains CARDED %s", async command => {
  // OVERREACH #6: the owner's own Full access turn runs it, as No limits does
  expect((await judge(command)).verdict).toMatchObject({ approve: expect.any(String), source: "full-access" });
});
