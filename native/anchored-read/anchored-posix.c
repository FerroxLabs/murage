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
static napi_value ar_read(napi_env env, napi_callback_info info) {
  ar_args a; int fd = -1; char *root = NULL; unsigned char *bytes = NULL; napi_value result = NULL;
  const char *code = "changed"; size_t length = 0, size = 0; struct stat before, after; dev_t volume;
  if (!ar_parse(env, info, &a)) return ar_fail(env, "invalid_name");
  AR_NAPI(napi_get_value_string_utf8(env, a.root, NULL, 0, &length));
  if (!length || length > 131072) { code = "invalid_name"; goto done; }
  root = malloc(length + 1); if (!root) goto done;
  AR_NAPI(napi_get_value_string_utf8(env, a.root, root, length + 1, &length));
  if (root[0] != '/' || strlen(root) != length) { code = "invalid_name"; goto done; }
  fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (fd < 0) { code = ar_errno(); goto done; }
  if (fstat(fd, &before)) goto done;
  volume = before.st_dev;
  if (!ar_step(env, &a, "root", 0)) goto done;
  for (uint32_t i = 0; i < a.count; i++) {
    char part[1021]; bool last = i + 1 == a.count;
    AR_NAPI(napi_get_value_string_utf8(env, a.parts[i], part, sizeof(part), &length));
    int child = openat(fd, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (last ? O_NONBLOCK : O_DIRECTORY));
    if (child < 0) { code = ar_errno(); goto done; }
    close(fd); fd = child;
    if (fstat(fd, &before)) goto done;
    if (before.st_dev != volume) { code = "other_volume"; goto done; }
    if (!last) {
      if (!S_ISDIR(before.st_mode)) { code = "not_directory"; goto done; }
      if (!ar_step(env, &a, "dir", i)) goto done;
      continue;
    }
    if (!S_ISREG(before.st_mode)) { code = "not_regular"; goto done; }
    if (before.st_nlink != 1) { code = "hard_link"; goto done; }
    if (before.st_size < 0 || (uint64_t)before.st_size > a.max) { code = "too_large"; goto done; }
    if (!ar_step(env, &a, "file", 0)) goto done;
    bytes = malloc(a.max + 1); if (!bytes) goto done;
    while (size < a.max + 1) {
      ssize_t count = read(fd, bytes + size, a.max + 1 - size);
      if (count < 0) { if (errno == EINTR) continue; goto done; }
      if (!count) break;
      size += (size_t)count;
    }
    if (!ar_step(env, &a, "read", 0)) goto done;
    if (fstat(fd, &after)) goto done;
    if ((uint64_t)before.st_size != size || before.st_size != after.st_size || after.st_nlink != 1 ||
        before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) goto done;
    char vol[32], id[32]; snprintf(vol, sizeof(vol), "%llu", (unsigned long long)volume); snprintf(id, sizeof(id), "%llu", (unsigned long long)before.st_ino);
    result = ar_result(env, bytes, size, vol, id);
  }
done:
  if (fd >= 0) close(fd);
  free(root); free(bytes);
  return result ? result : ar_fail(env, code);
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {{"read", NULL, ar_read, NULL, NULL, NULL, napi_default, NULL}, {"version", NULL, ar_version, NULL, NULL, NULL, napi_default, NULL}};
  napi_define_properties(env, exports, 2, props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
