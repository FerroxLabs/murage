// Test fixture (MEMW WP1 S21i leg 2): an LD_PRELOAD shim that makes ftruncate/ftruncate64 on a file named *-wal fail with EIO while the
// flag file named by MEMW_SHIM_FLAG exists. Inert otherwise. Built and loaded only by the runner command of index-wal-ldpreload.test.ts.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
static int failing(int fd) {
  const char *flag = getenv("MEMW_SHIM_FLAG");
  if (!flag || access(flag, F_OK) != 0) return 0;
  char link[64], path[4096];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, path, sizeof path - 1);
  if (n < 4) return 0;
  path[n] = 0;
  return strcmp(path + n - 4, "-wal") == 0;
}
int ftruncate(int fd, off_t length) {
  static int (*real)(int, off_t);
  if (!real) real = dlsym(RTLD_NEXT, "ftruncate");
  if (failing(fd)) { errno = EIO; return -1; }
  return real(fd, length);
}
int ftruncate64(int fd, off64_t length) {
  static int (*real)(int, off64_t);
  if (!real) real = dlsym(RTLD_NEXT, "ftruncate64");
  if (failing(fd)) { errno = EIO; return -1; }
  return real(fd, length);
}
