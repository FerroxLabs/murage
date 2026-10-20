// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 74c (b), APP-GRANT-FIXPLAN-r6 (e)+(h) "Tests for (b)" and design deltas 1, 2, 3, 5: the strict one-command grammar of
// owner ssh command text, OpenSSH identification, the resolved pins, the displaced-settings rule, the direct ssh row, the
// per-command pin overrides (U19) and the per-repository core.sshCommand row.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import {
  DIRECT_SSH_REASON, SSH_REASONS, directSshMeetsRow, gitNetworkCommand, parseSshCommand, pinOverride, repoSshCommandMismatch,
  resetSshIdentityCacheForTests, resolvePins, sshPinCommand, valuePins, type PinRun,
} from "./arg-vocabulary.ts";

let dir: string;
let bin: string;
let home: string;
let runs: string[][];

/** A program file: `OPENSSH` in its body makes the fake `-V` print an OpenSSH line, anything else a plink-style banner. */
function program(at: string, body: string): string {
  mkdirSync(join(at, ".."), { recursive: true });
  writeFileSync(at, `#!/bin/sh\n# ${body}\n`);
  chmodSync(at, 0o755);
  return at;
}

function fakeRun(coreSshCommand?: string): PinRun {
  return async (file, args) => {
    runs.push([file, ...args]);
    if (args[0] === "-V") {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(file, "utf8");
      return text.includes("OPENSSH") ? { ok: true, stdout: "", stderr: "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13\n" } : { ok: true, stdout: "plink: Release 0.81\n", stderr: "" };
    }
    if (file === "git" && args.join(" ") === "config --get core.sshCommand") {
      return coreSshCommand === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: `${coreSshCommand}\n`, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "" };
  };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ssh-pins-")));
  bin = join(dir, "bin");
  home = join(dir, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  program(join(bin, "ssh"), "OPENSSH");
  program(join(bin, "plink"), "PuTTY");
  runs = [];
  resetSshIdentityCacheForTests();
});
afterEach(() => removeTempDirSync(dir));

const owner = (extra: Record<string, string> = {}) => ({ PATH: bin, HOME: home, ...extra });
const resolveWith = (env: Record<string, string>, coreSshCommand?: string) =>
  resolvePins(env, "linux", { run: fakeRun(coreSshCommand), cwd: dir, env });
const PLAIN = "'ssh' '-o' 'BatchMode=yes'";
/** The pin names the identified OpenSSH executable (its real path), never the bare spelling (Astra r6 item 7). */
const IDENT = () => `'${bin}/ssh' '-o' 'BatchMode=yes'`;

describe("the askpass and credential pins (deltas 1, 2, 4')", () => {
  it("are empty or off on every platform, with no POSIX helper path and no Git for Windows true.exe", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const pins = valuePins(platform);
      expect(pins.get("GIT_ASKPASS"), platform).toBe("");
      expect(pins.get("SSH_ASKPASS"), platform).toBe("");
      expect(pins.get("SSH_ASKPASS_REQUIRE"), platform).toBe("never");
      expect(pins.get("GIT_TERMINAL_PROMPT"), platform).toBe("0");
      expect(pins.get("GCM_INTERACTIVE"), platform).toBe("0");
      expect(pins.get("GIT_SSH_VARIANT"), platform).toBe("ssh");
      expect(pins.has("DISPLAY") || pins.has("WAYLAND_DISPLAY")).toBe(false);
      for (const [, value] of pins) expect(value).not.toMatch(/true\.exe/i);
    }
  });
});

describe("the strict one-command grammar (delta 5)", () => {
  it("parses literal words with POSIX quoting on every platform", () => {
    expect(parseSshCommand("ssh", { platform: "linux", home })).toEqual({ program: "ssh", argv: [] });
    expect(parseSshCommand("/usr/bin/ssh -i ~/.ssh/k", { platform: "linux", home })).toEqual({ program: "/usr/bin/ssh", argv: ["-i", `${home}/.ssh/k`] });
    expect(parseSshCommand('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -p 2222', { platform: "win32" })).toEqual({ program: "C:\\Program Files\\Git\\usr\\bin\\ssh.exe", argv: ["-p", "2222"] });
    expect(parseSshCommand('ssh "a\\"b"', { platform: "linux" })).toEqual({ program: "ssh", argv: ['a"b'] });
    expect(parseSshCommand("ssh\t-F ~/cfg -i k", { platform: "linux", home })).toEqual({ program: "ssh", argv: ["-F", `${home}/cfg`, "-i", "k"] });
    expect(parseSshCommand("ssh -o'User=x'y", { platform: "linux" })).toEqual({ program: "ssh", argv: ["-oUser=xy"] });
  });

  it("refuses everything that is not one simple command of literal words, with its panel reason", () => {
    const cases: [string, string][] = [
      ["ssh; curl x", SSH_REASONS.moreThanOne],
      ["ssh && rm -rf ~", SSH_REASONS.moreThanOne],
      ["ssh | tee x", SSH_REASONS.moreThanOne],
      ["ssh\nid", SSH_REASONS.moreThanOne],
      ["ssh $(cat o)", SSH_REASONS.expansion],
      ["ssh `id`", SSH_REASONS.expansion],
      ["ssh -i *.pem", SSH_REASONS.expansion],
      ['ssh "a$b"', SSH_REASONS.expansion],
      ["C:\\x\\ssh.exe", SSH_REASONS.expansion],
      ["ssh -i ~other/k", SSH_REASONS.expansion],
      ["ssh 'open", SSH_REASONS.expansion],
      ["FOO=1 ssh", SSH_REASONS.notOpenSsh],
      ["", SSH_REASONS.notFound],
      ["   ", SSH_REASONS.notFound],
    ];
    for (const [text, why] of cases) expect(parseSshCommand(text, { platform: "linux", home }), JSON.stringify(text)).toEqual({ cannot: why });
  });

  it("quotes every word, so no owner character reaches a shell outside one quoted word", () => {
    expect(sshPinCommand("ssh", [])).toBe(PLAIN);
    expect(sshPinCommand("C:\\Program Files\\Git\\usr\\bin\\ssh.exe", ["-p", "2222"])).toBe("'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' '-o' 'BatchMode=yes' '-p' '2222'");
    expect(sshPinCommand("ssh", ["it's"])).toBe("'ssh' '-o' 'BatchMode=yes' 'it'\\''s'");
  });
});

// These rows model a POSIX host on the real disk: a ':'-separated PATH, '/' paths and extensionless #! programs, resolved with
// platform "linux". A Windows drive path splits on that ':' and its programs need an extension, so they cannot run there; the
// win32 hand has its own rows in server/engine-env-pins.test.ts.
describe.skipIf(process.platform === "win32")("resolvePins: the owner's ssh setting is kept with BatchMode second, or replaced for engines only", () => {
  it("keeps a setting that parses and whose program is OpenSSH, every word quoted and -o BatchMode=yes second", async () => {
    const kept: [string, string][] = [
      ["ssh", IDENT()],
      [`${bin}/ssh -i ~/.ssh/k`, `'${bin}/ssh' '-o' 'BatchMode=yes' '-i' '${home}/.ssh/k'`],
      ['ssh "a\\"b"', `${IDENT()} 'a"b'`],
      ["ssh -o BatchMode=no", `${IDENT()} '-o' 'BatchMode=no'`],
      ["ssh -F ~/cfg -i k", `${IDENT()} '-F' '${home}/cfg' '-i' 'k'`],
    ];
    for (const [text, command] of kept) {
      const { pins, ssh } = await resolveWith(owner({ GIT_SSH_COMMAND: text }));
      expect(pins.get("GIT_SSH_COMMAND"), text).toBe(command);
      expect(pins.get("RSYNC_RSH"), text).toBe(command);
      expect(ssh.kept, text).toBe(true);
      expect(ssh.notes, text).toEqual([]);
    }
  });

  it("replaces one that does not parse or is not OpenSSH with plain ssh and one Engines panel line naming it", async () => {
    program(join(dir, "other", "ssh"), "not the real one");
    const replaced: [string, string][] = [
      ["ssh; curl x", SSH_REASONS.moreThanOne],
      ["ssh && rm -rf ~", SSH_REASONS.moreThanOne],
      ["ssh $(cat o)", SSH_REASONS.expansion],
      ["ssh `id`", SSH_REASONS.expansion],
      ["ssh -i *.pem", SSH_REASONS.expansion],
      ["FOO=1 ssh", SSH_REASONS.notOpenSsh],
      ["plink -batch", SSH_REASONS.notOpenSsh],
      [`${dir}/other/ssh`, SSH_REASONS.notOpenSsh],
      ["'/no/such/ssh'", SSH_REASONS.notFound],
      ['ssh "a$b"', SSH_REASONS.expansion],
      ["C:\\x\\ssh.exe", SSH_REASONS.expansion],
      ["ssh\nid", SSH_REASONS.moreThanOne],
    ];
    for (const [text, why] of replaced) {
      const { pins, ssh } = await resolveWith(owner({ GIT_SSH_COMMAND: text }));
      expect(pins.get("GIT_SSH_COMMAND"), text).toBe(IDENT());
      expect(pins.get("RSYNC_RSH"), text).toBe(IDENT());
      expect(ssh.kept, text).toBe(false);
      expect(ssh.notes.length, text).toBe(1);
      expect(ssh.notes[0], text).toContain("GIT_SSH_COMMAND");
      expect(ssh.notes[0], text).toContain(why);
      expect(ssh.notes[0], text).toContain("Your own git is unchanged.");
      expect(ssh.notes[0], text).not.toMatch(/—|\bsafe|unsafe|safety/i);
    }
  });

  it("shortens the owner's home to ~ in the panel line", async () => {
    const { ssh } = await resolveWith(owner({ GIT_SSH_COMMAND: `${home}/bin/ssh; true` }));
    expect(ssh.notes[0]).toContain("~/bin/ssh; true");
    expect(ssh.notes[0]).not.toContain(home);
  });

  it("follows git's precedence: GIT_SSH_COMMAND, then GIT_SSH, then core.sshCommand from git config", async () => {
    const both = await resolveWith(owner({ GIT_SSH_COMMAND: "ssh -p 1", GIT_SSH: `${bin}/ssh` }), "ssh -p 3");
    expect(both.pins.get("GIT_SSH_COMMAND")).toBe(`${IDENT()} '-p' '1'`);
    expect(both.ssh.source).toEqual({ setting: "GIT_SSH_COMMAND", value: "ssh -p 1" });
    const gitSsh = await resolveWith(owner({ GIT_SSH: `${bin}/ssh` }), "ssh -p 3");
    expect(gitSsh.pins.get("GIT_SSH_COMMAND")).toBe(`'${bin}/ssh' '-o' 'BatchMode=yes'`);
    expect(gitSsh.ssh.source.setting).toBe("GIT_SSH");
    const config = await resolveWith(owner(), "ssh -p 3");
    expect(config.pins.get("GIT_SSH_COMMAND")).toBe(`${IDENT()} '-p' '3'`);
    expect(config.ssh.source).toEqual({ setting: "core.sshCommand", value: "ssh -p 3" });
    expect(runs).toContainEqual(["git", "config", "--get", "core.sshCommand"]);
    const replaced = await resolveWith(owner(), "ssh $X");
    expect(replaced.pins.get("GIT_SSH_COMMAND")).toBe(IDENT());
    expect(replaced.ssh.notes[0]).toContain("core.sshCommand");
    const none = await resolveWith(owner());
    expect(none.ssh.source).toEqual({ setting: "none" });
    expect(none.pins.get("GIT_SSH_COMMAND")).toBe(IDENT());
    expect(none.ssh.notes).toEqual([]);
  });

  it("an owner GIT_SSH is a program path, not shell text: kept only when it is OpenSSH", async () => {
    const plink = await resolveWith(owner({ GIT_SSH: `${bin}/plink` }));
    expect(plink.pins.get("GIT_SSH_COMMAND")).toBe(IDENT());
    expect(plink.ssh.notes[0]).toContain("GIT_SSH");
    expect(plink.ssh.notes[0]).toContain(SSH_REASONS.notOpenSsh);
  });

  it("with no OpenSSH on the handed PATH both pins are plain ssh with BatchMode and the panel says so", async () => {
    const env = { PATH: join(dir, "empty"), HOME: home };
    const { pins, ssh } = await resolvePins(env, "linux", { run: fakeRun(), cwd: dir, env });
    expect(pins.get("GIT_SSH_COMMAND")).toBe(PLAIN);
    expect(pins.get("RSYNC_RSH")).toBe(PLAIN);
    expect(ssh.notes.length).toBe(1);
    expect(ssh.notes[0]).toMatch(/OpenSSH/);
  });

  it("identifies a program once per file identity and again when the file changes", async () => {
    await resolveWith(owner());
    await resolveWith(owner());
    expect(runs.filter((run) => run[1] === "-V").length).toBe(1);
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\n# OPENSSH, rebuilt with a longer body\n");
    await resolveWith(owner());
    expect(runs.filter((run) => run[1] === "-V").length).toBe(2);
  });

  it("every value pin comes through, with the ssh pins resolved and GIT_SSH absent", async () => {
    const { pins } = await resolveWith(owner());
    for (const [name, value] of valuePins("linux")) expect(pins.get(name), name).toBe(value);
    expect(pins.has("GIT_SSH")).toBe(false);
  });
});

describe("the direct ssh row (delta 3): nothing runs at verdict time", () => {
  const words = (line: string) => line.split(" ");
  it("holds a line without BatchMode=yes and ProxyCommand=none first, a jump host, or an scp program", () => {
    for (const line of [
      "ssh h",
      "ssh -o BatchMode=yes h",
      "ssh -o BatchMode=no -o BatchMode=yes -o ProxyCommand=none h",
      "ssh -o BatchMode=yes -o ProxyCommand=none -J j h",
      "ssh -o BatchMode=yes -o ProxyCommand=none -o ProxyJump=j h",
      "scp -S x -o BatchMode=yes -o ProxyCommand=none a h:b",
      "rsync -e ssh a h:b",
      "rsync --rsh=ssh;id a h:b",
    ]) expect(directSshMeetsRow(words(line)), line).toEqual({ meets: false, reason: DIRECT_SSH_REASON });
  });

  it("passes the required form and rsync on the pinned RSYNC_RSH", () => {
    for (const line of [
      "ssh -o BatchMode=yes -o ProxyCommand=none h",
      "ssh -oBatchMode=yes -oProxyCommand=none -o ProxyJump=none h ls",
      "sftp -o BatchMode=yes -o ProxyCommand=none h",
      "rsync a h:b",
      "rsync -av -e ssh_-o_BatchMode=yes_-o_ProxyCommand=none a h:b",
    ]) expect(directSshMeetsRow(words(line).map((word) => word.replace(/_/g, " "))), line).toEqual({ meets: true });
    expect(directSshMeetsRow(["ssh", "-o", "BatchMode=yes", "-o", "ProxyCommand=none", "h", "-J", "x"])).toEqual({ meets: true });
  });
});

describe("per-command pin overrides are U19 (Rule 68f PIN_NAMES)", () => {
  const pins = valuePins("linux");
  const words = (line: string) => line.split(" ");
  it("a per-command value other than its pin, or a listed option, is U19; the pin's own value and plain git log are not", () => {
    expect(pinOverride(words("GIT_ASKPASS=/x git fetch"), pins)).toMatchObject({ unknown: expect.stringContaining("GIT_ASKPASS") });
    expect(pinOverride(words("git -c core.sshCommand=x fetch"), pins)).toMatchObject({ unknown: expect.stringContaining("core.sshCommand") });
    expect(pinOverride(words("git -c core.askPass=x fetch"), pins)).not.toBeNull();
    expect(pinOverride(words("git -c credential.interactive=always fetch"), pins)).not.toBeNull();
    expect(pinOverride(words("GIT_SSH=/x git fetch"), pins)).not.toBeNull();
    expect(pinOverride(words("GCM_INTERACTIVE=always git push"), pins)).not.toBeNull();
    expect(pinOverride(words("SSH_ASKPASS_REQUIRE=force ssh h ls"), pins)).not.toBeNull();
    expect(pinOverride(words("RSYNC_RSH=rsh rsync a h:b"), pins)).not.toBeNull();
    expect(pinOverride(words("PAGER=less git log"), pins)).not.toBeNull();
    expect(pinOverride(words("git log"), pins)).toBeNull();
    expect(pinOverride(words("git log -p"), pins)).toBeNull();
    expect(pinOverride(words("GIT_TERMINAL_PROMPT=0 git fetch"), pins)).toBeNull();
  });
});

describe("a repository's own core.sshCommand (per repository row data)", () => {
  const none = { setting: "none" } as const;
  it("names the git network commands", () => {
    for (const line of ["fetch", "pull --rebase", "push origin main", "ls-remote origin", "remote update", "submodule update --init", "archive --remote=x HEAD", "-C sub fetch", "-c a.b=c push"]) {
      expect(gitNetworkCommand(line.split(" ")), line).toBe(true);
    }
    for (const line of ["log", "status", "remote -v", "submodule status", "archive HEAD", "-C fetch log"]) expect(gitNetworkCommand(line.split(" ")), line).toBe(false);
  });

  it("holds a network command whose repository sets another core.sshCommand or cannot be read, naming what engines use", () => {
    const fetch = ["fetch"];
    expect(repoSshCommandMismatch({ source: none, kept: true, gitArgs: fetch, chain: { ok: true, sshCommand: "ssh -i k" } })).toEqual({
      hold: true, reason: "this repository sets its own core.sshCommand, which engines do not use; they use plain ssh",
    });
    expect(repoSshCommandMismatch({ source: none, kept: true, gitArgs: fetch, chain: { ok: false } })).toMatchObject({ hold: true });
    expect(repoSshCommandMismatch({ source: none, kept: true, gitArgs: fetch, chain: { ok: true } })).toEqual({ hold: false });
    const config = { setting: "core.sshCommand", value: "ssh -p 3" } as const;
    expect(repoSshCommandMismatch({ source: config, kept: true, gitArgs: fetch, chain: { ok: true, sshCommand: "ssh -p 3" } })).toEqual({ hold: false });
    expect(repoSshCommandMismatch({ source: config, kept: true, gitArgs: fetch, chain: { ok: true, sshCommand: "ssh -p 4" } })).toEqual({
      hold: true, reason: "this repository sets its own core.sshCommand, which engines do not use; they use ssh -p 3",
    });
    expect(repoSshCommandMismatch({ source: config, kept: false, gitArgs: fetch, chain: { ok: true, sshCommand: "ssh -p 4" } })).toMatchObject({ reason: expect.stringMatching(/plain ssh$/) });
    // git puts the owner's GIT_SSH_COMMAND and GIT_SSH above core.sshCommand: skipped
    expect(repoSshCommandMismatch({ source: { setting: "GIT_SSH_COMMAND", value: "ssh" }, kept: true, gitArgs: fetch, chain: { ok: false } })).toEqual({ hold: false });
    expect(repoSshCommandMismatch({ source: { setting: "GIT_SSH", value: "/usr/bin/ssh" }, kept: true, gitArgs: fetch, chain: { ok: false } })).toEqual({ hold: false });
    expect(repoSshCommandMismatch({ source: none, kept: true, gitArgs: ["log"], chain: { ok: false } })).toEqual({ hold: false });
  });
});
