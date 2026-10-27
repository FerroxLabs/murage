import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../native/power-seccomp/murage-power-seccomp.c", import.meta.url), "utf8");

describe("the S4 power filter", () => {
  it("denies exactly the agreed names, with no extra syscall rules", () => {
    const list = /static const char \*const deny\[\] = \{([\s\S]*?)\};/.exec(source);
    expect(list).not.toBeNull();
    expect([...list[1].matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1])).toEqual([
      "reboot", "kexec_load", "kexec_file_load", "mount", "umount2", "pivot_root",
      "move_mount", "mount_setattr", "open_tree", "fsopen", "fsmount", "fsconfig", "fspick",
    ]);
    expect(source.match(/\bseccomp_rule_add\(/g)).toHaveLength(1);
    expect(source).toContain("seccomp_init(SCMP_ACT_ALLOW)");
    expect(source).toContain("seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0)");
  });

  it("requires real syscall numbers and only the native x86_64 or aarch64 ABI", () => {
    expect(source).toContain("seccomp_syscall_resolve_name(deny[i])");
    expect(source).toMatch(/if \(nr < 0\) \{[^}]*_exit\(1\); \}/);
    expect(source).not.toMatch(/\bcontinue\s*;/);
    expect(source).toContain("#if defined(__x86_64__)");
    expect(source).toContain("#elif defined(__aarch64__)");
    expect(source).toContain('#error "murage-power-seccomp supports only x86_64 and aarch64"');
    expect(source).toContain("seccomp_arch_native() != MURAGE_NATIVE_ARCH");
    expect(source).toContain("SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS");
  });
});
