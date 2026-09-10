/* Linux-only native Fuigo updater isolation; Windows remains unqualified. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int failure(const char *operation) { fprintf(stderr, "FUIGO_ISOLATION_UNAVAILABLE %s errno=%d\n", operation, errno); return 72; }
static int allow_path(int ruleset, const char *path, __u64 rights, int required) {
  int descriptor = open(path, O_PATH | O_CLOEXEC);
  if (descriptor < 0) return !required && errno == ENOENT ? 0 : -1;
  struct stat status; if (fstat(descriptor, &status)) { close(descriptor); return -1; }
  if (!S_ISDIR(status.st_mode)) rights &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = descriptor };
  int result = (int)syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0); close(descriptor); return result;
}
static int filesystem(const char *cli, const char *home) {
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) { errno = ENOTSUP; return -1; }
  __u64 read = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  __u64 all = read | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr attributes = { .handled_access_fs = all };
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attributes, sizeof(attributes), 0); if (ruleset < 0) return -1;
  int result = allow_path(ruleset, cli, read, 1) || allow_path(ruleset, home, all, 1);
  const char *runtime[] = { "/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/ld.so.cache", "/etc/localtime", "/usr/share/zoneinfo" };
  for (size_t i = 0; !result && i < sizeof(runtime) / sizeof(runtime[0]); i++) result = allow_path(ruleset, runtime[i], read, 0);
  const char *devices[] = { "/dev/null", "/dev/urandom", "/dev/random" };
  for (size_t i = 0; !result && i < sizeof(devices) / sizeof(devices[0]); i++) result = allow_path(ruleset, devices[i], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 1);
  if (!result) result = (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  close(ruleset); return result;
}
#define DENY(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static int syscalls(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    /* Tokio signal delivery needs an unnamed, process-private stream pair.
     * No socket namespace or external peer is reachable through socketpair. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 11),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    DENY(SYS_socket), DENY(SYS_connect), DENY(SYS_bind), DENY(SYS_listen), DENY(SYS_accept), DENY(SYS_accept4),
    DENY(SYS_io_uring_setup), DENY(SYS_io_uring_enter), DENY(SYS_io_uring_register),
    DENY(SYS_ptrace), DENY(SYS_process_vm_readv), DENY(SYS_process_vm_writev), DENY(SYS_pidfd_getfd),
    DENY(SYS_mount), DENY(SYS_umount2), DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_bpf),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[1], "run") || argv[2][0] != '/' || argv[3][0] != '/') { errno = EINVAL; return failure("arguments"); }
  char *cli = realpath(argv[2], NULL), *home = realpath(argv[3], NULL);
  if (!cli || !home) return failure("realpath");
  struct stat status; if (lstat(home, &status) || !S_ISDIR(status.st_mode) || status.st_uid != getuid()) { errno = EINVAL; return failure("scratch-owner"); }
  if (chdir(home) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) return failure("process-policy");
  if (syscall(SYS_close_range, 3U, ~0U, 0)) return failure("descriptor-cleanup");
  if (filesystem(cli, home)) return failure("landlock");
  if (syscalls()) return failure("seccomp");
  char **arguments = calloc((size_t)argc - 2, sizeof(char *)); if (!arguments) return failure("argv");
  arguments[0] = cli; for (int i = 4; i < argc; i++) arguments[i - 3] = argv[i];
  execv(cli, arguments); return failure("exec");
}
