// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { posix as path } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installSourceCageAppArmor, sourceCageProfile, SOURCE_CAGE_PROFILE } from "./cage-apparmor.mjs";

describe("the explicit source cage AppArmor command", () => {
  const repoRoot = "/home/developer/fixture checkout";
  const base = { platform: "linux", arch: "x64", repoRoot, realpath: value => value, exists: () => true };

  it.each(["x64", "arm64"])("attaches only to the absolute repo path and linux-%s directory", arch => {
    const profile = sourceCageProfile(repoRoot, arch);
    expect(profile).toBe(`abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile murage-src-cage-bwrap "${path.join(repoRoot, "dist-native/cage", `linux-${arch}`, "bwrap")}" flags=(unconfined) {\n  userns,\n}\n`);
    expect(profile).not.toContain("/opt/Murage");
    expect(profile).not.toContain("linux-*");
  });

  it("prints the profile before sudo and writes and loads it only through sudo", () => {
    const events = [];
    const say = vi.fn(message => events.push(["print", message]));
    const exec = vi.fn((command, args) => events.push([command, args]));
    installSourceCageAppArmor({ ...base, exec, say });
    const profile = sourceCageProfile(repoRoot, "x64");
    expect(events[0][0]).toBe("print");
    expect(events[0][1]).toContain(`${SOURCE_CAGE_PROFILE}`);
    expect(events[0][1]).toContain(profile);
    expect(exec.mock.calls).toEqual([
      ["sudo", ["tee", SOURCE_CAGE_PROFILE], { input: profile, stdio: ["pipe", "ignore", "inherit"] }],
      ["sudo", ["apparmor_parser", "-r", SOURCE_CAGE_PROFILE], { stdio: "inherit" }],
    ]);
  });

  it("uses the resolved checkout when the repo path is a symlink", () => {
    const resolvedRoot = "/home/developer/real checkout";
    const exec = vi.fn();
    const realpath = vi.fn(() => resolvedRoot);
    installSourceCageAppArmor({ ...base, realpath, exec, say: () => {} });
    expect(realpath).toHaveBeenCalledWith(repoRoot);
    expect(exec.mock.calls[0][2].input).toBe(sourceCageProfile(resolvedRoot, "x64"));
  });

  it.each(["darwin", "win32"])("refuses %s before reading paths or invoking sudo", platform => {
    const exec = vi.fn(), realpath = vi.fn(), exists = vi.fn(), say = vi.fn();
    expect(() => installSourceCageAppArmor({ ...base, platform, exec, realpath, exists, say })).toThrow("Linux only");
    for (const mock of [exec, realpath, exists, say]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["a*", "a?", "a[b]", "a{b,c}", 'a"b', "a\\b", "a\nb", "a\u0000b"])("refuses policy syntax in the repo path (%j)", name => {
    const exec = vi.fn();
    expect(() => installSourceCageAppArmor({ ...base, repoRoot: path.join("/home/developer", name), exec })).toThrow("repository path");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses an unknown architecture and a missing build before sudo", () => {
    const exec = vi.fn();
    expect(() => installSourceCageAppArmor({ ...base, arch: "riscv64", exec })).toThrow("architecture riscv64");
    expect(() => installSourceCageAppArmor({ ...base, exists: () => false, exec })).toThrow("pnpm build:murage-cage");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["tee", "apparmor_parser"])("propagates a sudo %s failure without reporting completion", failing => {
    const exec = vi.fn((command, args) => { if (args[0] === failing) throw new Error("fixture failure"); });
    const say = vi.fn();
    expect(() => installSourceCageAppArmor({ ...base, exec, say })).toThrow("fixture failure");
    expect(exec).toHaveBeenCalledTimes(failing === "tee" ? 1 : 2);
    expect(say).toHaveBeenCalledOnce();
    expect(exec.mock.calls.every(([command]) => command === "sudo")).toBe(true);
  });

  it("exposes installation as an explicit package command", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(scripts["cage:apparmor"]).toBe("node scripts/cage-apparmor.mjs");
  });
});
