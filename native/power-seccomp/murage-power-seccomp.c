// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Build-time generator for S4: murage-power-seccomp OUTPUT.bpf (cc ... -lseccomp).
// Generate on the target architecture, x86_64 or aarch64 only.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <seccomp.h>
#include <stdio.h>
#include <unistd.h>

#if defined(__x86_64__)
#define MURAGE_NATIVE_ARCH SCMP_ARCH_X86_64
#elif defined(__aarch64__)
#define MURAGE_NATIVE_ARCH SCMP_ARCH_AARCH64
#else
#error "murage-power-seccomp supports only x86_64 and aarch64"
#endif

static const char *const deny[] = {
    "reboot", "kexec_load", "kexec_file_load", "mount", "umount2", "pivot_root",
    "move_mount", "mount_setattr", "open_tree", "fsopen", "fsmount", "fsconfig", "fspick", NULL};

static int check(int rc, const char *what) {
  if (rc < 0) { fprintf(stderr, "power-seccomp: %s failed: %d\n", what, rc); _exit(1); }
  return rc;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) return 1;
  if (seccomp_arch_native() != MURAGE_NATIVE_ARCH) { fprintf(stderr, "power-seccomp: native arch mismatch\n"); _exit(1); }
  check(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS), "badarch");
  for (int i = 0; deny[i]; i++) {
    int nr = seccomp_syscall_resolve_name(deny[i]);
    // Negative pseudo-syscall numbers would be omitted from the BPF too.
    if (nr < 0) { fprintf(stderr, "power-seccomp: deny-list name %s resolved to %d\n", deny[i], nr); _exit(1); }
    check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0), deny[i]);
  }
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0) { perror("open"); return 1; }
  check(seccomp_export_bpf(ctx, fd), "export");
  if (close(fd) != 0) return 1;
  seccomp_release(ctx);
  return 0;
}
