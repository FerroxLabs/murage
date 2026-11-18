// secret-scan: fixture
// X3 option B shapes. Inert strings, never reads. Cwd rows live in server/auto-approve.test.ts.
import { expect, it } from "vitest";
import { rememberShellCwds, unknownShellGlobRead, type ShellCwdByThread, alignedCorePositions, cdOperands, pathGlobsIntersect, globKeyRead } from "./sensitive-globs.ts";

const read = (text: string, platform: NodeJS.Platform = "linux") => globKeyRead(text, platform);

// Part 1 matcher (rev 2 H1, H2; Fable H1; Fable M4)
it.each([
  "cat /work/*serv?ceaccount-prod.json", "cat /work/aserv?ceaccount*", "cat *serviceaccount*",
  "cat ~/.agent-browser/sessions/ab*", "cat .en?.l*", "cat .en?.local", "cat .en[v]", "cat ~/.ssh/[i]d_*",
  "ls ~/.ssh/README*", "cat ~/.grok/auth.json*",
])("X3 B matcher cards %s", text => { expect(read(text)).not.toBeNull(); });

it.each(["cat .ss?/id_*", "cat .*/id_r*", "cat **/id_r*", "cat .grok/auth.json*"])(
  "X3 B Fable shapes card %s", text => { expect(read(text)).not.toBeNull(); });
it.each(["cd ~/.ssh && cat *.pem", "pushd ~/.ssh; cat id_*", "cd ~/.ssh", "cd ~/.ss?", "sl ~/.ssh", "chdir ~/.ssh"])(
  "X3 B cd operand cards %s", text => { expect(read(text)).not.toBeNull(); });
it("X3 B cd operand cards Set-Location on win32", () => { expect(read("Set-Location ~/.ssh; type *.pem", "win32")).not.toBeNull(); });

// Anchors (Fable L5), matcher layer
it.each([
  ["cat ${env:HOME}/.ssh/*", "linux"], ["cat ~bob/.ssh/*", "linux"], ["cat /var/root/.ssh/*", "darwin"],
  ["ls //host/C$/Users/jane/.ssh/*", "win32"],
  ["cat $env:HOME/.ssh/*", "win32"], ["cat ${env:HOME}/.ssh/*", "win32"],
  ["ls //host/share/Users/jane/.ssh/*", "win32"], ["ls D:/backups/Users/jane/.ssh/*", "win32"],
] as const)("X3 B anchor cards %s on %s", (text, platform) => { expect(read(text, platform)).not.toBeNull(); });

it.each(["ls /data/nat*", "ls ~/.ss?"])("X3 B matcher stays quiet with no place %s", text => { expect(read(text)).toBeNull(); });
it.each(["cat README*", "nat*"])("X3 B cards (accepted) %s with no place", text => {
  expect(read(text)).not.toBeNull();
});


it("X3 B shell history resolves, unions and caps literal folders", () => {
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", "cd ../.ssh", "/fixture/home/project", "linux", "/fixture/home");
  rememberShellCwds(states, "one", "sl /tmp; chdir /tmp", "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh", "/tmp"]);
  for (let n = 0; n < 31; n++) rememberShellCwds(states, "one", `cd /tmp/p${n}`, "/proj", "linux");
  expect(states.get("one")!.targets.size).toBe(32);
  expect(states.get("one")!.unknown).toContain("/tmp/p30");
  expect(states.has("two")).toBe(false);
  states.delete("one");
  expect(states.size).toBe(0);
});
it.each(["$PLACE", "`pwd`", "$(pwd)", "%PLACE%", "~-"])("X3 B shell history unknown operand %s", operand => {
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", `cd ${operand}`, "/proj", "linux");
  expect(states.get("one")!.unknown).toBeTruthy();
  expect(states.get("one")!.targets.size).toBe(0);
});
it("X3 B unknown shell uses only anchored key-row file segments", () => {
  expect(unknownShellGlobRead("cat *.pem", "linux")).toBeTruthy();
  expect(unknownShellGlobRead("cat /tmp/*.pem", "linux")).toBeNull();
  expect(unknownShellGlobRead("cat zzzzz?.unlisted", "linux")).toBeTruthy();
});

it("X3 R3 CARD Push-Location ~/.ssh; gc *.pem on win32", () => {
  const command = "Push-Location ~/.ssh; gc *.pem";
  expect(read(command, "win32")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "win32");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD Push-Location ~/.ssh; gc *.pem on linux", () => {
  const command = "Push-Location ~/.ssh; gc *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD cd -P ~/.ssh; cat *.pem on linux", () => {
  const command = "cd -P ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect(states.get("one")!.unknown).toBeTruthy();
});

it("X3 R3 CARD cd -- ~/.ssh; cat *.pem on linux", () => {
  const command = "cd -- ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD Set-Location -Path ~/.ssh; gc *.pem on linux", () => {
  const command = "Set-Location -Path ~/.ssh; gc *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD Set-Location -LiteralPath ~/.ssh; gc *.pem on linux", () => {
  const command = "Set-Location -LiteralPath ~/.ssh; gc *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD pushd -n ~/.ssh; cat *.pem on linux", () => {
  const command = "pushd -n ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD env -C ~/.ssh sh -c 'cat *.pem' on linux", () => {
  const command = "env -C ~/.ssh sh -c 'cat *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD env --chdir=~/.ssh sh -c 'cat *.pem' on linux", () => {
  const command = "env --chdir=~/.ssh sh -c 'cat *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD pwsh -WorkingDirectory ~/.ssh -c 'gc *.pem' on linux", () => {
  const command = "pwsh -WorkingDirectory ~/.ssh -c 'gc *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD sudo -D ~/.ssh sh -c 'cat *.pem' on linux", () => {
  const command = "sudo -D ~/.ssh sh -c 'cat *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD builtin cd ~/.ssh; cat *.pem on linux", () => {
  const command = "builtin cd ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD command cd ~/.ssh; cat *.pem on linux", () => {
  const command = "command cd ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD cd -L -e ~/.ssh; cat *.pem on linux", () => {
  const command = "cd -L -e ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD cd /d ~/.ssh; cat *.pem on linux", () => {
  const command = "cd /d ~/.ssh; cat *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD Set-Location -PSPath ~/.ssh; gc *.pem on linux", () => {
  const command = "Set-Location -PSPath ~/.ssh; gc *.pem";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 R3 CARD env --chdir ~/.ssh sh -c 'cat *.pem' on linux", () => {
  const command = "env --chdir ~/.ssh sh -c 'cat *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD runner --chdir ~/.ssh sh -c 'cat *.pem' on linux", () => {
  const command = "runner --chdir ~/.ssh sh -c 'cat *.pem'";
  expect(read(command, "linux")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["~/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "linux");
  // M6: the child folder is a current-call read, never parent history.
  expect(states.has("one")).toBe(false);
});

it("X3 R3 CARD cd \"/Users/Jane Doe/.ssh\"; cat *.pem on win32", () => {
  const command = "cd \"/Users/Jane Doe/.ssh\"; cat *.pem";
  expect(read(command, "win32")).not.toBeNull();
  expect(cdOperands(command)).toEqual(["/Users/Jane Doe/.ssh"]);
  const states: ShellCwdByThread = new Map();
  rememberShellCwds(states, "one", command, "/proj", "win32");
  expect([...states.get("one")!.targets.keys()]).toEqual(["~/.ssh"]);
});

it("X3 C H3 conservative card cd -P /proj && cat *.ts", () => { expect(read("cd -P /proj && cat *.ts")).not.toBeNull(); });

it("X3 R3 quiet cd -- src && ls src/*", () => { expect(read("cd -- src && ls src/*")).toBeNull(); });

it("X3 R3 quiet env -C /tmp sh -c 'cat *.txt'", () => { expect(read("env -C /tmp sh -c 'cat *.txt'")).toBeNull(); });

it("X3 R3 former MB-2 now covered by H2 folder alignment", () => {
  expect(read("cd ~/.config")).toBeNull();
  // H2 now recognizes the aligned gcloud folder without the cd join.
  expect(read("cat gclou?/*")).not.toBeNull();
  expect(read("cd ~/.config; cat gclou?/*")).not.toBeNull();
});
it("X3 R3 character intersection already handles row literals", () => {
  expect(pathGlobsIntersect(["aserv?ceaccount*"], ["xserviceaccount*"])).toBe(false);
  expect(pathGlobsIntersect(["xserv?ceaccount*"], ["xserviceaccount*"])).toBe(true);
  expect(pathGlobsIntersect(["xserv[i]ceaccount*"], ["xserviceaccount*"])).toBe(true);
});

// Round 4: this existing required shape is also the second-pass mutation witness.
it("X3 R4 MB-13 cat /work/aserv?ceaccount*", () => {
  expect(read("cat /work/aserv?ceaccount*")).not.toBeNull();
});
it.each([
  "cat src/*.ts", "ls *.md", "cat *.json", "cat */*.json", "ls /tmp/*", "cat [x]", "cd src && cat *.ts",
])("X3 R4 everyday quiet %s", text => { expect(read(text)).toBeNull(); });
it("X3 R4 non-witness cd ~/.ssh && cat id_*", () => {
  expect(read("cd ~/.ssh && cat id_*")).not.toBeNull();
});

it("X3 R4 second pass accepts four literal core characters", () => {
  expect(read("cat /work/aserv?c?a?c?u?t*")).not.toBeNull();
});
it.each(["cat /work/z[serviceaccount]*", "cat /work/aserv?unrelated"])(
  "X3 R4 second pass stays quiet %s", text => { expect(read(text)).toBeNull(); });

it.each(["aserv*ceaccount*", "aser?i?e?c?o?n?*"])("X3 C H1 aligned relative text evidence %s", word => {
  expect(read(`cat ${word}`)).not.toBeNull();
});
it("X3 C M5 relative text evidence belongs to the matched segment", () => {
  expect(read("cat work/services/README*")).toBeNull();
  expect(read("cat aserv*ceaccount*")).not.toBeNull();
});
it.each(["cat ~/.ss?/*.pem", "cat .ss?/*.pem"])("X3 C H2 aligned key folder %s", text => {
  expect(read(text)).not.toBeNull();
});

it("X3 C H1 counts distinct aligned core positions", () => {
  expect(read("cat /work/aser?i?e?c?o?n?*")).not.toBeNull();
  expect(alignedCorePositions("aserv*ceaccount*", "*serviceaccount*")).toBe(13);
  expect(alignedCorePositions("as*e*r*", "*serviceaccount*")).toBe(3);
  expect(alignedCorePositions("aser?i?e?c?o?n?*", "*serviceaccount*")).toBe(14);
  expect(alignedCorePositions("as[e]rv*", "*serviceaccount*")).toBe(4);
  expect(alignedCorePositions("as[erviceaccount]*", "*serviceaccount*")).toBe(2);
  for (const glob of ["README*", "*.ts", "nat*", "*.md"]) expect(alignedCorePositions(glob, "*serviceaccount*")).toBeLessThanOrEqual(0);
  expect(read("cat /work/aser?i?e?c?o?n?*")).not.toBeNull();
});
