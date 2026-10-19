// SPDX-License-Identifier: AGPL-3.0-or-later
// Build-time generator for the cloud turn seccomp denylist (bwrap --seccomp).
// Usage: murage-seccomp OUTPUT.bpf   (cc ... -lseccomp). x86_64 and aarch64; the
// filter is generated for the architecture it is compiled on (see
// lanes/cloud-v2/arm/SECCOMP-ARM64.md for the rule-by-rule mapping).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#if defined(__x86_64__)
#define MURAGE_NATIVE_ARCH SCMP_ARCH_X86_64
#elif defined(__aarch64__)
#define MURAGE_NATIVE_ARCH SCMP_ARCH_AARCH64
#else
#error "murage-seccomp supports only x86_64 and aarch64"
#endif

#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif

static const char *const deny[] = {
    "unshare", "setns", "keyctl", "add_key", "request_key", "bpf", "perf_event_open",
    "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register", "ptrace",
    "process_vm_readv", "process_vm_writev", "kexec_load", "kexec_file_load",
    "init_module", "finit_module", "delete_module", "mount", "umount2", "umount",
    "pivot_root", "open_tree", "move_mount", "fsopen", "fsmount", "fsconfig", "fspick",
    "mount_setattr", "swapon", "swapoff", "reboot", "acct", "quotactl", "quotactl_fd", NULL};

// An unknown name in `deny` is a HARD BUILD FAILURE (a typo or a too-old
// libseccomp must not silently ship a weaker filter). mount_setattr (Linux 5.12)
// and quotactl_fd (Linux 5.14) are MANDATORY: mount_setattr can act on an
// existing mount without fsopen/fsmount/move_mount, and quotactl does not cover
// quotactl_fd, so neither may be skipped. The supported image (Ubuntu 24.04,
// libseccomp 2.5.5) knows both.
//
// The only name with no syscall on a supported architecture is the legacy
// umount(2): it is absent on BOTH x86_64 and aarch64 in libseccomp's tables
// (umount2, which is denied, is the real unmount call on both). It is skipped
// by exact name only. Every other name must resolve to a real number (nr >= 0);
// any negative number (including pseudo-syscalls that libseccomp would silently
// omit from the exported BPF) is a hard build failure.
static const char *const absent_everywhere[] = {"umount", NULL};

static int is_absent_everywhere(const char *name) {
  for (int i = 0; absent_everywhere[i]; i++)
    if (strcmp(absent_everywhere[i], name) == 0) return 1;
  return 0;
}

static int check(int rc, const char *what) {
  if (rc < 0) { fprintf(stderr, "seccomp: %s failed: %d\n", what, rc); _exit(1); }
  return rc;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) return 1;
  // Only the native ABI is added (x86_64, or aarch64), so any other arch
  // (ia32 and x32 on x86_64; AArch32 on aarch64) is killed by the BADARCH action.
  if (seccomp_arch_native() != MURAGE_NATIVE_ARCH) { fprintf(stderr, "seccomp: native arch mismatch\n"); _exit(1); }
  check(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS), "badarch");
  for (int i = 0; deny[i]; i++) {
    int nr = seccomp_syscall_resolve_name(deny[i]);
    if (is_absent_everywhere(deny[i])) { fprintf(stderr, "seccomp: note: %s has no syscall on x86_64 or aarch64, skipped (umount2 is denied)\n", deny[i]); continue; }
    if (nr < 0) { fprintf(stderr, "seccomp: deny-list name %s resolved to %d (unknown or pseudo syscall)\n", deny[i], nr); _exit(1); }
    check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0), deny[i]);
  }
  // clone: EPERM when any namespace flag is requested (flags are arg0 on both
  // x86_64 and aarch64).
  const unsigned long ns = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID |
                           CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP;
  for (unsigned long bit = 1; bit; bit <<= 1)
    if (ns & bit)
      check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
                             SCMP_A0(SCMP_CMP_MASKED_EQ, bit, bit)), "clone");
  // clone3 hides its flags in a struct; ENOSYS makes glibc fall back to clone.
  check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0), "clone3");
  // personality is left allowed: libseccomp rejects two comparisons on one
  // argument (EINVAL on the first real image build), and a persona change
  // only affects the calling process, not a kernel attack surface.
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0) { perror("open"); return 1; }
  check(seccomp_export_bpf(ctx, fd), "export");
  if (close(fd) != 0) return 1;
  seccomp_release(ctx);
  return 0;
}
