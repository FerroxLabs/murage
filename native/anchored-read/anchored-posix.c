// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "common.h"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#ifndef O_NOFOLLOW_ANY
#error macOS SDK with O_NOFOLLOW_ANY is required
#endif
static const char *ar_errno(void) { return errno == ELOOP ? "link" : errno == ENOTDIR ? "not_directory" : "changed"; }
// Preserve the syscall errno before close/free or N-API can overwrite it.
// Semantic guard failures have errno=0; the frozen refusal code is unchanged.
static napi_value ar_posix_fail(napi_env env, const char *code, const char *phase, int saved_errno) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return ar_fail(env, code);
  {
    char message[192];
    snprintf(message, sizeof(message), "Anchored file read refused (phase=%s errno=%d)", phase, saved_errno);
    napi_throw_error(env, code, message);
  }
  return NULL;
}
static napi_value ar_read(napi_env env, napi_callback_info info) {
  ar_args a; int fd = -1; char *root = NULL; unsigned char *bytes = NULL; napi_value result = NULL;
  const char *code = "changed", *phase = "arguments"; int saved_errno = 0; size_t length = 0, size = 0; struct stat before, after; dev_t volume;
  if (!ar_parse(env, info, &a)) return ar_posix_fail(env, "invalid_name", phase, 0);
  AR_NAPI(napi_get_value_string_utf8(env, a.root, NULL, 0, &length));
  if (!length || length > 131072) { code = "invalid_name"; goto done; }
  phase = "root.allocate";
  root = malloc(length + 1); if (!root) { saved_errno = errno; goto done; }
  AR_NAPI(napi_get_value_string_utf8(env, a.root, root, length + 1, &length));
  phase = "root.validate";
  if (root[0] != '/' || strlen(root) != length) { code = "invalid_name"; goto done; }
  phase = "root.open";
  // xnu vn_open_auth refuses O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL), which surfaced as
  // the generic `changed` on every root. O_NOFOLLOW_ANY alone is the stricter guard: it refuses a
  // symbolic link in ANY component of the root, the final one included (ELOOP -> `link`).
  fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (fd < 0) { saved_errno = errno; code = ar_errno(); goto done; }
  phase = "root.stat";
  if (fstat(fd, &before)) { saved_errno = errno; goto done; }
  volume = before.st_dev;
  phase = "root.checkpoint";
  if (!ar_step(env, &a, "root", 0)) goto done;
  for (uint32_t i = 0; i < a.count; i++) {
    char part[1021]; bool last = i + 1 == a.count;
    AR_NAPI(napi_get_value_string_utf8(env, a.parts[i], part, sizeof(part), &length));
    phase = last ? "file.open" : "dir.open";
    int child = openat(fd, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (last ? O_NONBLOCK : O_DIRECTORY));
    if (child < 0) { saved_errno = errno; code = ar_errno(); goto done; }
    close(fd); fd = child;
    phase = last ? "file.stat" : "dir.stat";
    if (fstat(fd, &before)) { saved_errno = errno; goto done; }
    phase = "volume.verify";
    if (before.st_dev != volume) { code = "other_volume"; goto done; }
    if (!last) {
      phase = "dir.verify";
      if (!S_ISDIR(before.st_mode)) { code = "not_directory"; goto done; }
      phase = "dir.checkpoint";
      if (!ar_step(env, &a, "dir", i)) goto done;
      continue;
    }
    phase = "file.verify";
    if (!S_ISREG(before.st_mode)) { code = "not_regular"; goto done; }
    if (before.st_nlink != 1) { code = "hard_link"; goto done; }
    if (before.st_size < 0 || (uint64_t)before.st_size > a.max) { code = "too_large"; goto done; }
    phase = "file.checkpoint";
    if (!ar_step(env, &a, "file", 0)) goto done;
    phase = "file.allocate";
    bytes = malloc(a.max + 1); if (!bytes) { saved_errno = errno; goto done; }
    phase = "file.read";
    while (size < a.max + 1) {
      ssize_t count = read(fd, bytes + size, a.max + 1 - size);
      if (count < 0) { if (errno == EINTR) continue; saved_errno = errno; goto done; }
      if (!count) break;
      size += (size_t)count;
    }
    phase = "read.checkpoint";
    if (!ar_step(env, &a, "read", 0)) goto done;
    phase = "read.stat";
    if (fstat(fd, &after)) { saved_errno = errno; goto done; }
    phase = "read.verify";
    if ((uint64_t)before.st_size != size || before.st_size != after.st_size || after.st_nlink != 1 ||
        before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) goto done;
    char vol[32], id[32]; snprintf(vol, sizeof(vol), "%llu", (unsigned long long)volume); snprintf(id, sizeof(id), "%llu", (unsigned long long)before.st_ino);
    phase = "result";
    result = ar_result(env, bytes, size, vol, id);
  }
done:
  if (fd >= 0) close(fd);
  free(root); free(bytes);
  return result ? result : ar_posix_fail(env, code, phase, saved_errno);
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {{"read", NULL, ar_read, NULL, NULL, NULL, napi_default, NULL}, {"version", NULL, ar_version, NULL, NULL, NULL, napi_default, NULL}};
  napi_define_properties(env, exports, 2, props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
