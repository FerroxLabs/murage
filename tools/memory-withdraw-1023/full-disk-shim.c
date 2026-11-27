/* q1023-wdfix witness helper (owner q1023-wdfix): LD_PRELOAD shim that makes the disk "full" for files the wrapper's sqlite3 session creates
   under the run lock directory (a path containing FULLDISK_DIR, except names starting fileio-). FULLDISK_LIMIT=<n>: a file takes only its
   first n bytes, then the write is short (fwrite returns less, like ENOSPC mid-write). FULLDISK_SYMLINK=1: creating a symlink there fails
   with ENOSPC. FULLDISK_LOSTERR=1: once the symlink kept.link is made, the process's stderr goes to a pipe with no reader (writes fail,
   the message is lost, as a full disk loses it). Nothing else is touched. Built by witness-wrapper.sh with gcc -shared. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int guarded(const char *path) {
  const char *dir = getenv("FULLDISK_DIR");
  const char *base;
  if (!dir || !path || !strstr(path, dir)) return 0;
  base = strrchr(path, '/');
  base = base ? base + 1 : path;
  return strncmp(base, "fileio-", 7) != 0;
}

size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream) {
  static size_t (*real)(const void *, size_t, size_t, FILE *);
  const char *lim = getenv("FULLDISK_LIMIT");
  char link[64], path[PATH_MAX];
  ssize_t n;
  if (!real) real = dlsym(RTLD_NEXT, "fwrite");
  if (lim && stream) {
    snprintf(link, sizeof link, "/proc/self/fd/%d", fileno(stream));
    n = readlink(link, path, sizeof path - 1);
    if (n > 0) {
      path[n] = 0;
      if (guarded(path)) {
        long pos = ftell(stream), room = atol(lim) - (pos < 0 ? 0 : pos);
        size_t want = size * nmemb;
        if (room < 0) room = 0;
        if ((size_t)room < want) {
          if (room > 0) real(ptr, 1, (size_t)room, stream);
          return size ? (size_t)room / size : 0;
        }
      }
    }
  }
  return real(ptr, size, nmemb, stream);
}

int symlink(const char *target, const char *linkpath) {
  static int (*real)(const char *, const char *);
  int r;
  if (!real) real = dlsym(RTLD_NEXT, "symlink");
  if (getenv("FULLDISK_SYMLINK") && guarded(linkpath)) { errno = ENOSPC; return -1; }
  r = real(target, linkpath);
  if (r == 0 && getenv("FULLDISK_LOSTERR") && guarded(linkpath) && strstr(linkpath, "kept.link")) {
    int p[2];
    if (pipe(p) == 0) { close(p[0]); signal(SIGPIPE, SIG_IGN); dup2(p[1], 2); close(p[1]); }
  }
  return r;
}
