/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Murage qualification probe. Built ON the VM by negative-tests.sh
 * (gcc -static -O2) and run inside a launcher turn. Prints OK or an errno name.
 *   probe status | unshare-user | stat <path> | connect <ip> <port> | bind <port>
 *         | mask <dir> | chattr <dir>
 * mask prints `rmdir|rename-away|rename-onto|mkdir-inside <ERRNO>` for an (immutable)
 * workspace placeholder; chattr prints the errno of clearing its immutable flag.
 * Through the launcher the argv must match the engine's grammar (CLOUD-ENGINES-DESIGN.md
 * 4), so negative-tests.sh starts it as `codex app-server` (or Claude's stream-json argv)
 * and sends the probe command on stdin, one line of space-separated words. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/fs.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *en(int e) {
  switch (e) {
  case 0: return "OK";
  case EPERM: return "EPERM";
  case ENOENT: return "ENOENT";
  case EACCES: return "EACCES";
  case ENOSPC: return "ENOSPC";
  case EINVAL: return "EINVAL";
  case ECONNREFUSED: return "ECONNREFUSED";
  case ENETUNREACH: return "ENETUNREACH";
  case EHOSTUNREACH: return "EHOSTUNREACH";
  case ETIMEDOUT: return "ETIMEDOUT";
  case EADDRINUSE: return "EADDRINUSE";
  case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
  case ENOSYS: return "ENOSYS";
  case ENOTDIR: return "ENOTDIR";
  case EAFNOSUPPORT: return "EAFNOSUPPORT";
  case ECONNRESET: return "ECONNRESET";
  case EBUSY: return "EBUSY";
  case EROFS: return "EROFS";
  case EEXIST: return "EEXIST";
  case ENOTEMPTY: return "ENOTEMPTY";
  case EXDEV: return "EXDEV";
  case ENETDOWN: return "ENETDOWN";
  default: { static char b[24]; snprintf(b, sizeof b, "E%d", e); return b; }
  }
}

static int do_status(void) {
  FILE *f = fopen("/proc/self/status", "r");
  char line[256];
  if (!f) { puts(en(errno)); return 1; }
  while (fgets(line, sizeof line, f))
    if (!strncmp(line, "Seccomp:", 8) || !strncmp(line, "NoNewPrivs:", 11) || !strncmp(line, "CapEff:", 7))
      fputs(line, stdout);
  fclose(f);
  return 0;
}

static int do_connect(const char *ip, int port) {
  struct sockaddr_in a = {0};
  int s = socket(AF_INET, SOCK_STREAM, 0), e = 0;
  if (s < 0) { puts(en(errno)); return 1; }
  a.sin_family = AF_INET; a.sin_port = htons(port);
  if (inet_pton(AF_INET, ip, &a.sin_addr) != 1) { puts("EINVAL"); return 1; }
  fcntl(s, F_SETFL, O_NONBLOCK);
  if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) {
    if (errno != EINPROGRESS) e = errno;
    else {
      struct pollfd p = { s, POLLOUT, 0 };
      if (poll(&p, 1, 3000) == 0) e = ETIMEDOUT;
      else { socklen_t l = sizeof e; getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &l); }
    }
  }
  puts(en(e));
  return e != 0;
}

static void bind_one(const char *label, const char *ip, int port) {
  struct sockaddr_in a = {0};
  int s = socket(AF_INET, SOCK_STREAM, 0), e = 0, one = 1;
  if (s < 0) { printf("%s %s\n", label, en(errno)); return; }
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  a.sin_family = AF_INET; a.sin_port = htons(port); inet_pton(AF_INET, ip, &a.sin_addr);
  if (bind(s, (struct sockaddr *)&a, sizeof a) != 0) e = errno;
  else if (listen(s, 1) != 0) e = errno;
  printf("%s %s\n", label, en(e));
  close(s);
}

static void report(const char *op, int r) { printf("%s %s\n", op, r == 0 ? "OK" : en(errno)); }

/* The operations a turn could use to remove, replace or fill a placeholder directory. */
static int do_mask(const char *p) {
  char moved[4096], src[4096], inside[4096];
  snprintf(moved, sizeof moved, "%s.moved", p);
  snprintf(src, sizeof src, "%s.src", p);
  snprintf(inside, sizeof inside, "%s/x", p);
  report("rmdir", rmdir(p));
  report("rename-away", rename(p, moved));
  if (mkdir(src, 0755) != 0 && errno != EEXIST) { printf("rename-onto %s\n", en(errno)); }
  else { report("rename-onto", rename(src, p)); rmdir(src); }
  report("mkdir-inside", mkdir(inside, 0755));
  return 0;
}

static int do_chattr(const char *p) {
  int fd = open(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW), e = 0, flags = 0;
  if (fd < 0) { puts(en(errno)); return 1; }
  if (ioctl(fd, FS_IOC_GETFLAGS, &flags) != 0) e = errno;
  else { flags &= ~FS_IMMUTABLE_FL; if (ioctl(fd, FS_IOC_SETFLAGS, &flags) != 0) e = errno; }
  puts(en(e));
  close(fd);
  return e != 0;
}

static int dispatch(int argc, char **argv);

int main(int argc, char **argv) {
  if (argc >= 2 && (!strcmp(argv[1], "app-server") || !strcmp(argv[1], "-p"))) {
    static char line[1024];
    char *words[8] = { argv[0] };
    int n = 1;
    if (!fgets(line, sizeof line, stdin)) { puts("EINVAL"); return 2; }
    for (char *w = strtok(line, " \t\r\n"); w && n < 8; w = strtok(NULL, " \t\r\n")) words[n++] = w;
    return dispatch(n, words);
  }
  return dispatch(argc, argv);
}

static int dispatch(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "status")) return do_status();
  if (argc >= 2 && !strcmp(argv[1], "unshare-user")) {
    int r = unshare(CLONE_NEWUSER);
    puts(r == 0 ? "OK" : en(errno));
    return r != 0;
  }
  if (argc >= 3 && !strcmp(argv[1], "stat")) {
    struct stat st;
    int r = stat(argv[2], &st);
    puts(r == 0 ? "OK" : en(errno));
    return r != 0;
  }
  if (argc >= 4 && !strcmp(argv[1], "connect")) return do_connect(argv[2], atoi(argv[3]));
  if (argc >= 3 && !strcmp(argv[1], "bind")) {
    int p = atoi(argv[2]);
    bind_one("bind-127.0.0.1", "127.0.0.1", p);
    bind_one("bind-0.0.0.0", "0.0.0.0", p);
    return 0;
  }
  if (argc >= 3 && !strcmp(argv[1], "mask")) return do_mask(argv[2]);
  if (argc >= 3 && !strcmp(argv[1], "chattr")) return do_chattr(argv[2]);
  fputs("usage: probe status|unshare-user|stat <path>|connect <ip> <port>|bind <port>|mask <dir>|chattr <dir>\n", stderr);
  return 2;
}
