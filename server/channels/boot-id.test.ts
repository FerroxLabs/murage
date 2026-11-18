// SPDX-License-Identifier: AGPL-3.0-or-later
// The boot-session identifier per OS: the macOS sysctl branch, and that nothing but a well-formed identifier ever counts as a boot proof.
import { beforeEach, expect, it, vi } from "vitest";

const sysctl = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: readonly string[] }>, answer: (): string => "" }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFileSync: (file: string, args: readonly string[]) => { sysctl.calls.push({ file, args }); return sysctl.answer(); } };
});
import { bootId } from "./boot-id.ts";

const UUID = "0F8C2B7A-3D41-4E9B-A6C5-71D2E3F4A5B6";
beforeEach(() => { sysctl.calls.length = 0; sysctl.answer = () => `${UUID}\n`; });

it("W-BOOT-MAC: macOS asks the system sysctl for kern.bootsessionuuid and returns it trimmed and lower-cased", () => {
  expect(bootId("darwin")).toBe(UUID.toLowerCase());
  expect(sysctl.calls).toEqual([{ file: "/usr/sbin/sysctl", args: ["-n", "kern.bootsessionuuid"] }]);
});

it("W-BOOT-MAC-UNAVAILABLE: a sysctl that cannot run, times out or exits non-zero is no boot proof", () => {
  for (const code of ["ENOENT", "ETIMEDOUT", "EACCES"]) {
    sysctl.answer = () => { throw Object.assign(new Error("sysctl"), { code }); };
    expect(bootId("darwin"), code).toBeNull();
  }
  sysctl.answer = () => { throw Object.assign(new Error("exit 1"), { status: 1 }); };
  expect(bootId("darwin")).toBeNull();
});

it("W-BOOT-MAC-MALFORMED: an answer that is not one boot-session identifier is no boot proof (mutant: accept any hex-and-dash text)", () => {
  const malformed = ["", "\n", "--------", "deadbeef", "0f8c2b7a3d414e9ba6c571d2e3f4a5b6", `${UUID}-00`, `${UUID}\n${UUID}`, `kern.bootsessionuuid: ${UUID}`,
    "sysctl: unknown oid 'kern.bootsessionuuid'", "00000000-0000-0000-0000-000000000000", UUID.replace("A", "G")];
  for (const answer of malformed) { sysctl.answer = () => answer; expect(bootId("darwin"), JSON.stringify(answer)).toBeNull(); }
});

it("W-BOOT-OTHER: Windows and unknown systems never run a command and never infer a boot", () => {
  expect(bootId("win32")).toBeNull(); expect(bootId("freebsd")).toBeNull();
  if (process.platform === "linux") expect(bootId("linux")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(sysctl.calls).toEqual([]);
});
