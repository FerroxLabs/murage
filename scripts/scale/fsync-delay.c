// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Slow-disk shim for the scale rig: LD_PRELOAD it into the server and every fsync
// and fdatasync waits FSYNC_DELAY_US first (default 8000), the cost of a busy
// laptop disk. Linux containers only:  cc -O2 -shared -fPIC -o fsync-delay.so fsync-delay.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <time.h>

static void slow(void) {
  static long us = -1;
  if (us < 0) { const char *e = getenv("FSYNC_DELAY_US"); us = e ? atol(e) : 8000; }
  struct timespec ts = { us / 1000000, (us % 1000000) * 1000 };
  nanosleep(&ts, 0);
}
int fsync(int fd) { static int (*real)(int); if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync"); slow(); return real(fd); }
int fdatasync(int fd) { static int (*real)(int); if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync"); slow(); return real(fd); }
