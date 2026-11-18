// secret-scan: fixture
import { expect, it, vi } from "vitest";
import { autoVerdict, prepareShellJudgement, resolveShellDirectories, expandCredentialGlob, type CredentialGlobFs } from "./auto-approve.ts";
import { credentialTextFallback, rememberShellCwds, shellDirectoryEffects, unavailableAnchoredGlobRead } from "../shared/sensitive-globs.ts";

const bot = { id: "x3", autoApprove: true, fullAccess: true, noLimits: false };
function listing(names: string[]): { fs: CredentialGlobFs; reads: () => number } {
  let reads = 0;
  return { reads: () => reads, fs: {
    realpath: async path => path,
    opendir: async () => {
      let index = 0;
      return { read: async () => { reads++; const name = names[index++]; return name === undefined ? null : { name, isDirectory: () => false, isSymbolicLink: () => false }; }, close: async () => {} };
    },
  } };
}
/** r5 [A4] fixture for H2: ~ holds the folder .ssh, which holds id.pem. */
function homeSsh(): CredentialGlobFs {
  const tree: Record<string, [string, boolean][]> = { "/home/me": [[".ssh", true]], "/home/me/.ssh": [["id.pem", false]] };
  return { realpath: async path => path, opendir: async path => {
    const names = tree[String(path).replace(/\/$/, "")] ?? [];
    let index = 0;
    return { read: async () => { const entry = names[index++]; return entry === undefined ? null : { name: entry[0], isDirectory: () => entry[1], isSymbolicLink: () => false }; }, close: async () => {} };
  } };
}
const verdict = (command: string, rule: string | null, cwd = "/proj") => autoVerdict(bot, "Bash", command, {
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, commandCwd: cwd, globExpansionRule: rule,
});
it.each([["as*e*r*", "as.serviceaccount.json"], ["*s*e*r*", "as.serviceaccount.json"], ["?serv*", "-serviceaccount.json"]])("X3 C observed H1 witness %s", async (token, file) => {
  const { fs } = listing([file, "README.md", "index.ts"]);
  const result = await expandCredentialGlob(token, { cwd: "/work", fs });
  expect(result.available).toBe(true);
  expect(result.witness).toBe("/work/" + file);
  expect(verdict(`cat /work/${token}`, result.rule).approve).toBeNull();
});
it.each(["/work/as*e*r*", "~/as*e*r*"])("X3 C own anchor runs without cwd %s", async token => {
  const fixture = listing(["as.serviceaccount.json"]);
  const result = await expandCredentialGlob(token, { home: "/home/me", fs: fixture.fs });
  expect(fixture.reads()).toBeGreaterThan(0);
  expect(result.available).toBe(true);
  expect(result.witness).toBeTruthy();
  expect(autoVerdict(bot, "Bash", `cat ${token}`, { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: `cat ${token}`, globExpansionRule: result.rule })).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it.each(["README*", "*.ts", "nat*", "src/**/*.md"])("X3 C known listable control %s", async token => {
  const result = await expandCredentialGlob(token, { cwd: "/work", fs: listing(["README.md", "index.ts"]).fs });
  expect(result.rule).toBeNull();
});
it("X3 C incremental entry cap and witness-free known-anchor fail closed", async () => {
  const fixture = listing([...Array.from({ length: 2001 }, (_, i) => `ordinary${i}`), "as.serviceaccount.json"]);
  const result = await expandCredentialGlob("/work/as*e*r*", { fs: fixture.fs, deadline: performance.now() + 5000 });
  expect(fixture.reads()).toBe(2001);
  expect(result.available).toBe(false);
  expect(result.witness).toBeNull();
  expect(result.reason).toBe("entries");
  expect(result.rule).toBeTruthy();
  expect(verdict("cat /work/as*e*r*", result.rule).approve).toBeNull();
});
it.each(["/work/README*", "/work/*.ts", "/tmp/*"])("X3 C cap and timeout control %s", async token => {
  const fixture = listing(Array.from({ length: 2002 }, (_, i) => `ordinary${i}`));
  const cap = await expandCredentialGlob(token, { fs: fixture.fs, deadline: performance.now() + 5000 });
  const timeout = await expandCredentialGlob(token, { fs: fixture.fs, deadline: performance.now() - 1 });
  for (const result of [cap, timeout]) {
    expect(result.available).toBe(false);
    expect(result.witness).toBeNull();
    expect(result.rule).toBeNull();
    expect(verdict(`cat ${token}`, result.rule).approve).not.toBeNull();
    if (token === "/tmp/*") expect(verdict(`ls ${token}`, result.rule).approve).not.toBeNull();
  }
});
it("X3 C timeout is witness-free CARD for a known sparse anchor", async () => {
  const result = await expandCredentialGlob("/work/as*e*r*", { fs: listing([]).fs, deadline: performance.now() - 1 });
  expect(result.available).toBe(false);
  expect(result.witness).toBeNull();
  expect(result.rule).toBeTruthy();
  expect(verdict("cat /work/as*e*r*", result.rule).approve).toBeNull();
});
it("X3 C relative sparse unavailable expansion cards on its frontier (r5 section 4)", async () => {
  const result = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs: listing([]).fs, deadline: performance.now() - 1 });
  expect(result.available).toBe(false);
  expect(result.outcome).toMatchObject({ kind: "cannot", code: "timeout", cards: true });
  expect(result.rule).toBeTruthy();
});
it("X3 C A4 threshold one uses original row positions", () => {
  expect(unavailableAnchoredGlobRead("/work/as*e*r*")).toBeTruthy();
  for (const token of ["/work/README*", "/work/*.ts", "/tmp/*"]) expect(unavailableAnchoredGlobRead(token)).toBeNull();
});

it("X3 C A1 timed out operations retain shared slots until settle and ignore late results", async () => {
  const release: ((value: string) => void)[] = [];
  const fs: CredentialGlobFs = { ...listing(["as.serviceaccount.json"]).fs, realpath: () => new Promise(resolve => release.push(resolve)) };
  const results = await Promise.all(Array.from({ length: 8 }, () => expandCredentialGlob("/work/as*e*r*", { fs, deadline: performance.now() + 20 })));
  expect(release).toHaveLength(8);
  expect(results.every(result => !result.available && result.reason === "timeout" && result.witness === null)).toBe(true);
  const saturated = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs: listing([]).fs });
  expect(saturated).toMatchObject({ available: false, reason: "timeout", witness: null });
  expect(saturated.outcome).toMatchObject({ kind: "cannot", cards: true });
  const h3 = await resolveShellDirectories("cd /ordinary", { targets: new Map([["/proj", "launch"]]) }, { fs: listing([]).fs });
  expect(h3.parent.unknown).toBeTruthy();
  const snapshot = JSON.stringify(results);
  for (const resolve of release) resolve("/work");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(JSON.stringify(results)).toBe(snapshot);
  const next = await expandCredentialGlob("/work/as*e*r*", { fs: listing(["as.serviceaccount.json"]).fs });
  expect(next.available).toBe(true);
  expect(next.witness).toBeTruthy();
});
it("X3 C A1 queue and physical-directory-position visited set are bounded", async () => {
  const wide: CredentialGlobFs = {
    realpath: async path => path,
    opendir: async () => {
      let n = 0;
      return { read: async () => n < 1000 ? { name: `dir${n++}`, isDirectory: () => true, isSymbolicLink: () => false } : null, close: async () => {} };
    },
  };
  const queue = await expandCredentialGlob("/work/**/as*e*r*", { fs: wide, deadline: performance.now() + 5000 });
  expect(queue).toMatchObject({ available: false, reason: "queue", witness: null });
  let directories = 0;
  const deep: CredentialGlobFs = { ...wide, opendir: async () => {
    directories++;
    let read = false;
    return { read: async () => { if (read) return null; read = true; return { name: "dir", isDirectory: () => true, isSymbolicLink: () => false }; }, close: async () => {} };
  } };
  const visited = await expandCredentialGlob("/work/**/as*e*r*", { fs: deep, deadline: performance.now() + 5000 });
  expect(visited).toMatchObject({ available: false, reason: "visited", witness: null });
  expect(directories).toBeLessThanOrEqual(256);
  directories = 0;
  const cycle = await expandCredentialGlob("/work/**/as*e*r*", { fs: { ...deep, realpath: async () => "/work" }, deadline: performance.now() + 5000 });
  expect(cycle.available).toBe(true);
  expect(directories).toBeLessThan(5);
});
it("X3 C sensitive witness survives a later entry cap", async () => {
  const fixture = listing(["as.serviceaccount.json", ...Array.from({ length: 2001 }, (_, i) => `ordinary${i}`)]);
  const result = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs: fixture.fs, deadline: performance.now() + 5000 });
  expect(result).toMatchObject({ available: false, reason: "entries", witness: "/work/as.serviceaccount.json" });
  expect(result.rule).toBeTruthy();
});
it("X3 C completed globstar sibling retains its witness before later cap", async () => {
  const fs: CredentialGlobFs = { realpath: async path => path, opendir: async path => {
    const names = path === "/work" ? ["as.serviceaccount.json", "child"] : Array.from({ length: 2002 }, (_, i) => `ordinary${i}`);
    let index = 0;
    return { read: async () => { const name = names[index++]; return name === undefined ? null : { name, isDirectory: () => name === "child", isSymbolicLink: () => false }; }, close: async () => {} };
  } };
  const result = await expandCredentialGlob("**/as*e*r*", { cwd: "/work", fs, deadline: performance.now() + 5000 });
  expect(result.available).toBe(false);
  expect(result.witness).toBe("/work/as.serviceaccount.json");
  expect(result.rule).toBeTruthy();
});

it.each(["pushd +1", "pushd -1", "popd +1", "popd -1", "popd", "pushd", "cd -", "cd"])("X3 C H3 selector is not a filesystem operand: %s", async command => {
  let lookedUp = 0;
  const fs = { ...listing([]).fs, realpath: async (path: string) => { lookedUp++; return path; } };
  const result = await resolveShellDirectories(command, { targets: new Map([["/proj", "launch"]]) }, { fs });
  expect(lookedUp).toBe(0);
  expect(result.parent.unknown).toBeTruthy();
  expect([...result.parent.targets.keys()]).toEqual(["/proj"]);
  expect(shellDirectoryEffects(command)[0]?.kind).not.toBe("filesystem");
});
it.each(["cd -P /proj", "cd /proj/dir/.."])("X3 C H3 physical flags and unresolved parents hold %s", async command => {
  const result = await resolveShellDirectories(command, { targets: new Map([["/proj", "launch"]]) }, { fs: {
    ...listing([]).fs, realpath: async path => path === "/proj/dir/.." ? "/proj" : path,
  } });
  expect(result.parent.unknown).toBeTruthy();
});
it("X3 C H3c stores physical destination independently of H1 expansion", async () => {
  const fs = { ...listing([]).fs, realpath: async (path: string) => path === "/proj/link" ? "/home/me/.ssh" : path };
  const result = await resolveShellDirectories("cd /proj/link", { targets: new Map([["/proj", "launch"]]) }, { fs });
  expect(result.parent.unknown).toBeUndefined();
  expect([...result.parent.targets.keys()]).toContain("/home/me/.ssh");
  expect([...result.parent.targets.keys()]).not.toContain("/proj/link");
  // r5 section 1: the finding is the expander's at every place (here both time out; ~/.ssh's frontier cards)
  const expansions = await Promise.all([...result.parent.targets.keys()].map(cwd => expandCredentialGlob("zzzzz?.unlisted", { cwd, fs, deadline: performance.now() - 1 })));
  expect(expansions.every(expansion => !expansion.available)).toBe(true);
  const actual = autoVerdict(bot, "Bash", "cat zzzzz?.unlisted", { commandText: "cat zzzzz?.unlisted", commandCwd: "/proj", stopLine: null,
    shellCwdPrepared: true, shellCwdByThread: new Map([["test", result.parent]]), threadId: "test", globExpansionRule: expansions.find(expansion => expansion.rule)?.rule ?? null });
  expect(actual).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it.each(["env -C ~/.ssh sh -c 'pwd'", "sh -c 'cd ~/.ssh; pwd'", "(cd ~/.ssh)", "cd ~/.ssh | cat", "cd ~/.ssh &"])("X3 C M6 child effects leave parent launch state: %s", async command => {
  const result = await resolveShellDirectories(command, { targets: new Map([["/proj", "launch"]]) }, { fs: listing([]).fs, home: "/home/me" });
  expect(result.parent.unknown).toBeUndefined();
  expect([...result.parent.targets.keys()]).toEqual(["/proj"]);
  expect([...result.local.targets.keys()]).toContain("/home/me/.ssh");
  expect(autoVerdict(bot, "Bash", "cat *.ts", { commandText: "cat *.ts", stopLine: null, commandCwd: "/proj", shellCwdPrepared: true,
    shellCwdByThread: new Map([["test", result.parent]]), threadId: "test" }).approve).not.toBeNull();
});

// The base has no async lookup entry point. This adapter invokes its real
// synchronous judge unchanged, so red-before failures report verdicts.
it.each(["cap", "timeout", "listable"])("X3 C base full verdict sparse known anchor %s", async kind => {
  const fixture = listing(kind === "cap" ? [...Array.from({ length: 2001 }, (_, n) => `ordinary${n}`), "as.serviceaccount.json"] : ["as.serviceaccount.json"]);
  const expanded = typeof expandCredentialGlob === "function" ? await expandCredentialGlob("/work/as*e*r*", {
    fs: fixture.fs, deadline: performance.now() + (kind === "timeout" ? -1 : 5000),
  }) : undefined;
  expect(verdict("cat /work/as*e*r*", expanded?.rule ?? null)).toMatchObject({ approve: null, source: "sensitive-guard" });
  if (kind === "listable") expect(expanded?.witness).toBeTruthy();
  else expect(expanded).toMatchObject({ available: false, witness: null });
});
it.each(["cd -P /proj", "cd /proj/dir/..", "pushd +1", "popd +1", "popd", 'cd "$D"'])("X3 C base full verdict H3 H4 state %s", async command => {
  const initial = { targets: new Map([["/proj", "launch"]]) };
  let state = initial;
  if (typeof resolveShellDirectories === "function") state = (await resolveShellDirectories(command, initial, { fs: listing([]).fs })).parent;
  else { const states = new Map([["test", initial]]); rememberShellCwds(states, "test", command, "/proj"); state = states.get("test")!; }
  // r5 section 1: the unknown card is the prepare loop's (A's P5), carried as globExpansionRule
  const prepared = typeof prepareShellJudgement === "function" ? await prepareShellJudgement("cat zzzzz?.unlisted", state, { fs: listing([]).fs }) : undefined;
  expect(autoVerdict(bot, "Bash", "cat zzzzz?.unlisted", { commandText: "cat zzzzz?.unlisted", commandCwd: "/proj", stopLine: null,
    shellCwdPrepared: true, shellCwdByThread: new Map([["test", state]]), threadId: "test", globExpansionRule: prepared?.rule ?? null })).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it("X3 C base H3c full verdict uses physical place with H1 unavailable", async () => {
  const initial = { targets: new Map([["/proj", "launch"]]) };
  let state = initial;
  // H1 unavailable: the listing itself is refused (EACCES), so ~/.ssh is CANNOT and its frontier cards (r5 section 4)
  const fs: CredentialGlobFs = { realpath: async () => "/home/me/.ssh", opendir: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
  if (typeof resolveShellDirectories === "function") state = (await resolveShellDirectories("cd /proj/link", initial, { fs })).parent;
  else { const states = new Map([["test", initial]]); rememberShellCwds(states, "test", "cd /proj/link", "/proj"); state = states.get("test")!; }
  const expansions = await Promise.all([...state.targets.keys()].map(cwd => expandCredentialGlob("zzzzz?.unlisted", { cwd, fs: { ...fs, realpath: async (path: string) => path } })));
  expect(autoVerdict(bot, "Bash", "cat zzzzz?.unlisted", { commandText: "cat zzzzz?.unlisted", commandCwd: "/proj", stopLine: null,
    shellCwdPrepared: true, shellCwdByThread: new Map([["test", state]]), threadId: "test", globExpansionRule: expansions.find(expansion => expansion.rule)?.rule ?? null })).toMatchObject({ approve: null, source: "sensitive-guard" });
  expect([...state.targets.keys()]).toContain("/home/me/.ssh");
});
it.each(["env -C ~/.ssh sh -c 'pwd'", "sh -c 'cd ~/.ssh; pwd'"])("X3 C base M6 child parent followup %s", command => {
  const states = new Map();
  rememberShellCwds(states, "test", command, "/proj");
  expect(autoVerdict(bot, "Bash", "cat *.ts", { commandText: "cat *.ts", commandCwd: "/proj", stopLine: null,
    shellCwdByThread: states, threadId: "test" }).approve).not.toBeNull();
});

it("X3 C H1 relative text alignment and fallback controls", async () => {
  expect(credentialTextFallback("work/aserv*ceaccount*")).toBeTruthy();
  expect(credentialTextFallback("work/aser?i?e?c?o?n?*")).toBeTruthy();
  expect(credentialTextFallback("work/services/README*")).toBeNull();
  const fixture = listing(Array.from({ length: 2002 }, (_, n) => `ordinary${n}`));
  const result = await expandCredentialGlob("README*", { cwd: "/work", fs: fixture.fs, deadline: performance.now() + 5000 });
  // r5 section 4: README* at the cap is CANNOT and its frontier is under the threshold: QUIET (no text fallback)
  expect(result).toMatchObject({ available: false, witness: null, rule: null });
  expect(result.outcome).toMatchObject({ kind: "cannot", code: "entries", cards: false });
});
it("X3 C forced I/O timeout is unavailable and witness-free", async () => {
  let opened = false;
  let release!: (dir: Awaited<ReturnType<CredentialGlobFs["opendir"]>>) => void;
  const fs = { ...listing([]).fs, opendir: async () => { opened = true; return new Promise<Awaited<ReturnType<CredentialGlobFs["opendir"]>>>(resolve => { release = resolve; }); } };
  const result = await expandCredentialGlob("/work/as*e*r*", { fs, deadline: performance.now() + 20 });
  expect(opened).toBe(true);
  expect(result).toMatchObject({ available: false, reason: "timeout", witness: null });
  expect(result.rule).toBeTruthy();
  release({ read: async () => null, close: async () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
});

it.each(["README*", "*.ts", "nat*", "src/**/*.md", "src/*.ts", "/tmp/*"])("X3 C recorded launch owner No limits full verdict control %s", async glob => {
  const initial = { targets: new Map([["/proj", "recorded launch"]]) };
  const prepared = typeof prepareShellJudgement === "function" ? await prepareShellJudgement(`cat ${glob}`, initial, { attributed: true, fs: listing(["README.md", "index.ts"]).fs }) : { parent: initial, local: { ...initial, unknown: undefined }, rule: null };
  expect(prepared.local.unknown).toBeUndefined();
  const actual = autoVerdict(bot, "Bash", `cat ${glob}`, { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null, commandText: `cat ${glob}`, stopLine: null, commandCwd: "/proj", shellCwdPrepared: true,
    shellCwdByThread: new Map([["test", prepared.local]]), threadId: "test", globExpansionRule: prepared.rule });
  expect(actual, JSON.stringify(actual)).toMatchObject({ approve: expect.any(String) });
});
it("X3 C named call folder is local and cannot repair missing attribution", async () => {
  const initial = { targets: new Map<string, string>(), unknown: "unproven parent" };
  const prepared = await prepareShellJudgement("cat src/*.ts", initial, { attributed: true, namedCwd: "/proj", fs: listing([]).fs });
  expect(prepared.local.unknown).toBeUndefined();
  expect(prepared.parent.unknown).toBe("unproven parent");
  // X3-SIMPLIFY-SaSb S-b: an N4 per-call folder is ADDED to the places, and on its own it keeps unknown
  expect([...prepared.parent.targets.keys()]).toEqual(["/proj"]);
  const unbound = await prepareShellJudgement("cat src/*.ts", initial, { attributed: false, namedCwd: "/proj", fs: listing([]).fs });
  expect(unbound.local.unknown).toBeTruthy();
});
it("X3 C H3 combined physical cd and relative read", async () => {
  const prepared = await prepareShellJudgement("cd /proj/link && cat zzzzz?.unlisted", { targets: new Map([["/proj", "launch"]]) }, {
    attributed: true, fs: { ...listing([]).fs, realpath: async path => path === "/proj/link" ? "/home/me/.ssh" : path },
  });
  expect([...prepared.parent.targets.keys()]).toContain("/home/me/.ssh");
  expect(autoVerdict(bot, "Bash", "cd /proj/link && cat zzzzz?.unlisted", { commandText: "cd /proj/link && cat zzzzz?.unlisted", stopLine: null,
    shellCwdPrepared: true, shellCwdByThread: new Map([["test", prepared.local]]), threadId: "test", globExpansionRule: prepared.rule }).approve).toBeNull();
});
it("X3 C H3 CDPATH prevents guessing a relative destination", async () => {
  const result = await resolveShellDirectories("cd ordinary", { targets: new Map([["/proj", "launch"]]) }, { fs: listing([]).fs, cdpath: "/other" });
  expect(result.parent.unknown).toBeTruthy();
  expect([...result.parent.targets.keys()]).toEqual(["/proj"]);
});

it("X3 C owner No limits H2 physical placement and H4 UNKNOWN are cards", async () => {
  for (const [command, initial] of [
    ["cat .ss?/*.pem", { targets: new Map([["/home/me", "launch"]]) }],
    ["cat zzzzz?.unlisted", { targets: new Map<string, string>(), unknown: "unproven cd" }],
  ] as const) {
    // r5 [A4]: the H2 row carded on pattern text alone, so its listing now holds the file it names
    const fs: CredentialGlobFs = command.startsWith("cat .ss?") ? homeSsh() : listing([]).fs;
    const prepared = await prepareShellJudgement(command, initial, { attributed: true, home: "/home/me", fs });
    expect(verdict(command, prepared.rule)).toMatchObject({ approve: null, source: "sensitive-guard" });
  }
});

it("X3 C H1 relative expansion verdict has no anchored fallback masking", async () => {
  const result = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs: listing(["as.serviceaccount.json"]).fs });
  expect(verdict("cat as*e*r*", result.rule, "/work")).toMatchObject({ approve: null, source: "sensitive-guard" });
  expect(result.witness).toBe("/work/as.serviceaccount.json");
});
it("X3 C H1 relative cap before an unseen witness cards on its frontier (r5 section 4, `cat big/as*e*r*`)", async () => {
  const fixture = listing([...Array.from({ length: 2001 }, (_, n) => `ordinary${n}`), "as.serviceaccount.json"]);
  const result = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs: fixture.fs, deadline: performance.now() + 5000 });
  expect(result).toMatchObject({ available: false, witness: null, reason: "entries" });
  expect(result.rule).toBeTruthy();
  expect(verdict("cat as*e*r*", result.rule, "/work").approve).toBeNull();
});

it("X3 C unknown relative case keeps H1 text-only apart from H4 CARD", async () => {
  // with no folder, the whole word is the frontier, as if it could sit anywhere (fail closed; A never calls this under unknown)
  const expansion = await expandCredentialGlob("as*e*r*", { fs: listing([]).fs });
  expect(expansion).toMatchObject({ available: false, witness: null, reason: "cwd" });
  expect(expansion.rule).toBeTruthy();
  const prepared = await prepareShellJudgement("cat as*e*r*", { targets: new Map(), unknown: "missing launch" }, { fs: listing([]).fs });
  expect(verdict("cat as*e*r*", prepared.rule)).toMatchObject({ approve: null, source: "sensitive-guard" });
});
it("X3 C observed witness survives a later I/O timeout", async () => {
  let release!: (entry: null) => void;
  const fs: CredentialGlobFs = { realpath: async path => path, opendir: async () => {
    let n = 0;
    return { read: async () => ++n === 1 ? { name: "as.serviceaccount.json", isDirectory: () => false, isSymbolicLink: () => false }
      : new Promise<null>(resolve => { release = resolve; }), close: async () => {} };
  } };
  const result = await expandCredentialGlob("as*e*r*", { cwd: "/work", fs, deadline: performance.now() + 50 });
  expect(result).toMatchObject({ available: false, reason: "timeout", witness: "/work/as.serviceaccount.json" });
  expect(verdict("cat as*e*r*", result.rule, "/work").approve).toBeNull();
  const snapshot = JSON.stringify(result);
  release(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(JSON.stringify(result)).toBe(snapshot);
});
it("X3 C H3c owner No limits B uses physical state when every H1 listing fails", async () => {
  const fs: CredentialGlobFs = { realpath: async path => path === "/proj/link" ? "/home/me/.ssh" : path, opendir: async () => { throw new Error("EACCES"); } };
  const resolved = await resolveShellDirectories("cd /proj/link", { targets: new Map([["/proj", "launch"]]) }, { fs });
  const prepared = await prepareShellJudgement("cat zzzzz?.unlisted", resolved.parent, { fs, attributed: true });
  expect(prepared.expansions.length).toBeGreaterThan(0);
  expect(prepared.expansions.every(result => !result.available && result.witness === null)).toBe(true);
  expect(verdict("cat zzzzz?.unlisted", prepared.rule)).toMatchObject({ approve: null, source: "sensitive-guard" });
  expect([...resolved.parent.targets.keys()]).toEqual(["/proj", "/home/me/.ssh"]);
});
it("X3 C Windows own drive anchor expands without cwd and fails closed when capped", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const fixture = listing(["as.serviceaccount.json"]);
    const result = await expandCredentialGlob("C:/work/as*e*r*", { fs: fixture.fs });
    expect(fixture.reads()).toBeGreaterThan(0);
    expect(result).toMatchObject({ available: true, witness: "C:/work/as.serviceaccount.json" });
    const cap = await expandCredentialGlob("C:/work/as*e*r*", { fs: listing(Array.from({ length: 2002 }, (_, i) => `ordinary${i}`)).fs, deadline: performance.now() + 5000 });
    expect(cap).toMatchObject({ available: false, reason: "entries", witness: null });
    expect(cap.rule).toBeTruthy();
    const physical = await resolveShellDirectories("cd C:/proj/link", { targets: new Map([["C:/proj", "launch"]]) }, {
      fs: { ...fixture.fs, realpath: async path => path === "C:/proj/link" ? "C:/Users/me/.ssh" : path },
    });
    expect([...physical.parent.targets.keys()]).toContain("C:/Users/me/.ssh");
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("X3 C A1 H3 stops iterating effects when its deadline is spent", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1);
  try {
    const result = await resolveShellDirectories("cd ordinary;".repeat(1000), { targets: new Map([["/proj", "launch"]]) }, { fs: listing([]).fs, deadline: 0 });
    expect(result.parent.unknown).toBeTruthy();
    expect(clock.mock.calls.length).toBeLessThanOrEqual(3);
  } finally { clock.mockRestore(); }
});
it.each(["sh -c 'cat as*e*r*'", "env -C /work sh -c 'cat as*e*r*'"])("X3 C base child payload read discovery %s", async command => {
  const prepared = typeof prepareShellJudgement === "function" ? await prepareShellJudgement(command, { targets: new Map([["/work", "launch"]]) }, { attributed: true, fs: listing(["as.serviceaccount.json"]).fs }) : undefined;
  expect(verdict(command, prepared?.rule ?? null, "/work")).toMatchObject({ approve: null, source: "sensitive-guard" });
  expect(prepared?.expansions.some(result => result.witness === "/work/as.serviceaccount.json")).toBe(true);
  expect([...prepared!.parent.targets.keys()]).toEqual(["/work"]);
});
it("X3 C text matching budget exhaustion cannot be a negative", () => {
  expect(credentialTextFallback("x".repeat(5000) + "*")).toBeTruthy();
});
it("X3 C child payload discovery does not execute echo arguments", async () => {
  const result = await prepareShellJudgement("echo sh -c 'cat as*e*r*'", { targets: new Map([["/work", "launch"]]) }, { attributed: true, fs: listing(["as.serviceaccount.json"]).fs });
  expect(result.expansions).toEqual([]);
});
it("X3 C PowerShell preparation preserves drive backslashes", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const fs = listing(["as.serviceaccount.json"]).fs;
    const prepared = await prepareShellJudgement(String.raw`cat C:\work\as*e*r*`, { targets: new Map() }, { shell: "pwsh", fs });
    expect(prepared.expansions.some(result => result.witness === "C:/work/as.serviceaccount.json")).toBe(true);
    const physical = await resolveShellDirectories(String.raw`cd C:\proj\link`, { targets: new Map([["C:/proj", "launch"]]) }, {
      shell: "pwsh", fs: { ...fs, realpath: async path => path === "C:/proj/link" ? "C:/Users/me/.ssh" : path },
    });
    expect([...physical.parent.targets.keys()]).toContain("C:/Users/me/.ssh");
  } finally { Object.defineProperty(process, "platform", platform); }
});
