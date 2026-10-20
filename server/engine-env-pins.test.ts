// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 74c (b) through handEnv (APP-GRANT-FIXPLAN-r6 (e)+(h) "Tests for (b)"): the askpass and credential pins in every handed
// env on posix and win32 fixtures, one resolved pin map, T106's subset over the resolved values, the displaced-settings rule
// reaching the pinned GIT_SSH_COMMAND, the owner's own git and ssh setup left byte-identical, and the structural owner rule.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSENT_PINS, ENV_PINS, resetSshIdentityCacheForTests, valuePins, type PinRun } from "../shared/arg-vocabulary.ts";
import { execEnvHanded, handedPinsOf, handEnv, promptFactsOf, sshPinNotes } from "./engine-env.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
let home: string;
let bin: string;

const run = (coreSshCommand?: string): PinRun => async (file, args) => {
  if (args[0] === "-V") return readFileSync(file, "utf8").includes("OPENSSH") ? { ok: true, stdout: "", stderr: "OpenSSH_9.6p1\n" } : { ok: true, stdout: "other\n", stderr: "" };
  if (file === "git" && args[0] === "config") return coreSshCommand === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: `${coreSshCommand}\n`, stderr: "" };
  return { ok: false, stdout: "", stderr: "" };
};

beforeEach(() => {
  // the native real path: on Windows an 8.3 short name (RUNNER~1) reads as its long name, as the pin names the identified program
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "engine-pins-")));
  home = join(dir, "home");
  bin = join(dir, "bin");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\n# OPENSSH\n");
  chmodSync(join(bin, "ssh"), 0o755);
  resetSshIdentityCacheForTests();
});
afterEach(() => removeTempDirSync(dir));

const ownerOf = (env: Record<string, string>) => ({ env: { PATH: bin, HOME: home, ...env }, capture: "session" as const });

describe("the handed env pins every askpass and credential UI off", () => {
  for (const platform of ["linux", "win32"] as const) {
    it(`on ${platform}: empty askpass, never, GCM off, the resolved ssh pins, GIT_SSH absent, DISPLAY kept`, async () => {
      const owner = ownerOf({ GIT_ASKPASS: "/usr/lib/ssh/x11-ssh-askpass", SSH_ASKPASS: "/x", GIT_SSH: "/usr/bin/plink", GCM_INTERACTIVE: "always", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" });
      const handed = await handEnv(owner, { platform, run: run(), cwd: dir });
      expect(handed.env.GIT_ASKPASS).toBe("");
      expect(handed.env.SSH_ASKPASS).toBe("");
      expect(handed.env.SSH_ASKPASS_REQUIRE).toBe("never");
      expect(handed.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(handed.env.GCM_INTERACTIVE).toBe("0");
      expect(handed.env.GIT_SSH_VARIANT).toBe("ssh");
      expect(handed.env.GIT_SSH_COMMAND).toMatch(/^'[^']*ssh' '-o' 'BatchMode=yes'/);
      expect(handed.env.RSYNC_RSH).toBe(handed.env.GIT_SSH_COMMAND);
      expect("GIT_SSH" in handed.env).toBe(false);
      expect(handed.absent).toContain("GIT_SSH");
      expect(handed.env.DISPLAY).toBe(":0");
      expect(handed.env.WAYLAND_DISPLAY).toBe("wayland-0");
    });
  }

  it("returns one resolved pin map: every ENV_PINS value pin is in the env with the map's value (T106, resolved)", async () => {
    // the host's own form: on Windows the owner's setting names the program as a quoted drive path (a bare backslash is an escape)
    const platform = process.platform === "win32" ? "win32" : "linux";
    const ssh = platform === "win32" ? join(bin, "ssh") : `${bin}/ssh`;
    const setting = platform === "win32" ? `"${ssh}" -p 2222` : `${ssh} -p 2222`;
    const handed = await handEnv(ownerOf({ GIT_SSH_COMMAND: setting }), { platform, run: run(), cwd: dir });
    for (const pin of ENV_PINS) {
      if ("absent" in pin) {
        expect(pin.name in handed.env, pin.name).toBe(false);
        expect(handed.pins.has(pin.name), pin.name).toBe(false);
      } else {
        expect(handed.pins.has(pin.name), pin.name).toBe(true);
        expect(handed.env[pin.name], pin.name).toBe(handed.pins.get(pin.name));
      }
    }
    for (const [name, value] of valuePins(platform)) expect(handed.pins.get(name), name).toBe(value);
    expect(handed.pins.get("GIT_SSH_COMMAND")).toBe(`'${ssh}' '-o' 'BatchMode=yes' '-p' '2222'`);
    for (const name of ABSENT_PINS) expect(handed.absent).toContain(name);
  });

  // a Linux hand on this host: its PATH splits on ":", which cuts a Windows temp folder (C:\...) in two, so its stand-in ssh is not found
  it.skipIf(process.platform === "win32")("a kept owner core.sshCommand reaches the pinned GIT_SSH_COMMAND; a replaced one shows its panel line", async () => {
    const kept = await handEnv(ownerOf({}), { platform: "linux", run: run("ssh -i ~/.ssh/work"), cwd: dir });
    expect(kept.env.GIT_SSH_COMMAND).toBe(`'${bin}/ssh' '-o' 'BatchMode=yes' '-i' '${home}/.ssh/work'`);
    expect(kept.ssh?.source).toEqual({ setting: "core.sshCommand", value: "ssh -i ~/.ssh/work" });
    expect(sshPinNotes()).toEqual([]);
    const replaced = await handEnv(ownerOf({}), { platform: "linux", run: run("ssh -i $KEY"), cwd: dir });
    expect(replaced.env.GIT_SSH_COMMAND).toBe(`'${bin}/ssh' '-o' 'BatchMode=yes'`);
    expect(sshPinNotes()).toHaveLength(1);
    expect(sshPinNotes()[0]).toContain("core.sshCommand");
    expect(sshPinNotes()[0]).toContain("ssh -i $KEY");
  });

  it("leaves the owner's global git config and ~/.ssh/config byte-identical", async () => {
    const gitconfig = join(home, ".gitconfig");
    const sshConfig = join(home, ".ssh", "config");
    writeFileSync(gitconfig, "[core]\n\tsshCommand = ssh -i ~/.ssh/k\n[user]\n\tname = Owner\n");
    writeFileSync(sshConfig, "Host *\n  ProxyJump jump\n  IdentityFile ~/.ssh/k\n");
    const before = [readFileSync(gitconfig), readFileSync(sshConfig), statSync(gitconfig).mtimeMs, statSync(sshConfig).mtimeMs];
    const listing = readdirSync(home).sort();
    await handEnv(ownerOf({}), { platform: "linux", run: run("ssh -i ~/.ssh/k"), cwd: dir });
    await handEnv(ownerOf({ GIT_SSH_COMMAND: "ssh; id" }), { platform: "linux", run: run(), cwd: dir });
    expect([readFileSync(gitconfig), readFileSync(sshConfig), statSync(gitconfig).mtimeMs, statSync(sshConfig).mtimeMs]).toEqual(before);
    expect(readdirSync(home).sort()).toEqual(listing);
  });
});

describe("structure: one owner of the pin resolution", () => {
  it("valuePins( and resolvePins( are called only in server/engine-env.ts", () => {
    const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
    const hits: string[] = [];
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const at = join(folder, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const rel = relative(root, at).replace(/\\/g, "/"); // '/' on every platform, as the names below are written
          if (rel === "server/engine-env.ts" || rel === "shared/arg-vocabulary.ts") continue;
          if (/\b(valuePins|resolvePins)\(/.test(readFileSync(at, "utf8"))) hits.push(rel);
        }
      }
    };
    for (const top of ["server", "shared", "src"]) walk(join(root, top));
    expect(hits).toEqual([]);
    expect(readFileSync(join(root, "server", "engine-env.ts"), "utf8")).toMatch(/\bresolvePins\(/);
    // the old Windows askpass literal and "refuse without Git" are gone
    expect(readFileSync(join(root, "shared", "arg-vocabulary.ts"), "utf8")).not.toMatch(/true\.exe/);
  });
});

describe("prompt facts come from the requesting engine's own hand (Astra r6 item 4)", () => {
  // a Linux hand on this host: its PATH splits on ":", which cuts a Windows temp folder (C:\...) in two, so its stand-in ssh is not found
  it.skipIf(process.platform === "win32")("a later hand of another session does not change the facts of an earlier engine's ask", async () => {
    const first = await handEnv(ownerOf({}), { platform: "linux", run: run("ssh -i ~/.ssh/work"), cwd: dir });
    const firstAsk = execEnvHanded(first, dir, ["/bin/sh", "-c"]);
    // another session is handed later, with no core.sshCommand of its own
    const second = await handEnv(ownerOf({ HOME: join(dir, "other-home") }), { platform: "linux", run: run(), cwd: dir });
    const secondAsk = execEnvHanded(second, dir, ["/bin/sh", "-c"]);
    expect(promptFactsOf(firstAsk, dir)).toEqual({ cwd: dir, home, ssh: { source: { setting: "core.sshCommand", value: "ssh -i ~/.ssh/work" }, kept: true } });
    expect(promptFactsOf(secondAsk, dir)).toEqual({ cwd: dir, home: join(dir, "other-home"), ssh: { source: { setting: "none" }, kept: false } });
    // the pins are that engine's too
    expect(handedPinsOf(firstAsk).get("GIT_SSH_COMMAND")).toBe(first.env.GIT_SSH_COMMAND);
    expect(handedPinsOf(secondAsk).get("GIT_SSH_COMMAND")).toBe(second.env.GIT_SSH_COMMAND);
    expect(handedPinsOf(firstAsk).get("GIT_ASKPASS")).toBe("");
    expect(handedPinsOf(firstAsk).has("GIT_SSH")).toBe(false);
  });

  it("no record, or a U20 record, gives no facts; the harness reads the event's own record", () => {
    expect(promptFactsOf(undefined, dir)).toBeUndefined();
    expect(promptFactsOf({ env: {}, absent: [], cwd: dir, shell: ["sh"], capture: "session", unread: { code: "U20", cause: "x" } }, dir)).toBeUndefined();
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(index).not.toMatch(/promptFactsBasis/);
    expect(index).toMatch(/promptFactsOf\(event\.execEnv, promptCwd\)/);
    expect(index).toMatch(/handedPins: handedPinsOf\(event\.execEnv\)/);
  });
});
