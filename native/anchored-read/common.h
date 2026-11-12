// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#define AR_NAPI(call) do { if ((call) != napi_ok) goto done; } while (0)
typedef struct {
  napi_value root, parts[32], hook;
  uint32_t count;
  size_t max;
} ar_args;
static napi_value ar_fail(napi_env env, const char *code) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, code, "Anchored file read refused");
  return NULL;
}
static int ar_name(napi_env env, napi_value value) {
  char16_t s[256]; size_t n = 0; napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &n) != napi_ok || !n || n > 255 ||
      napi_get_value_string_utf16(env, value, s, 256, &n) != napi_ok) return 0;
  if (s[n-1] == '.' || s[n-1] == ' ') return 0;
  char base[5] = {0}; size_t b = 0;
  for (size_t i = 0; i < n; i++) {
    if (!s[i] || s[i] == '/' || s[i] == '\\' || s[i] == ':' || s[i] == '\r' || s[i] == '\n') return 0;
  }
  while (b < n && s[b] != '.') { if (b >= 4) break; base[b] = s[b] >= 'a' && s[b] <= 'z' ? (char)(s[b] - 32) : s[b] < 128 ? (char)s[b] : '?'; b++; }
  if (b == n || s[b] == '.') {
    if (!strcmp(base, "CON") || !strcmp(base, "PRN") || !strcmp(base, "AUX") || !strcmp(base, "NUL") ||
        (b == 4 && (!memcmp(base, "COM", 3) || !memcmp(base, "LPT", 3)) && base[3] >= '1' && base[3] <= '9')) return 0;
  }
  return 1;
}
static int ar_parse(napi_env env, napi_callback_info info, ar_args *a) {
  napi_value argv[4]; size_t argc = 4; bool array = false; double max; napi_valuetype type;
  memset(a, 0, sizeof(*a));
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3 ||
      napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string ||
      napi_is_array(env, argv[1], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[1], &a->count) != napi_ok || !a->count || a->count > 32 ||
      napi_get_value_double(env, argv[2], &max) != napi_ok || !isfinite(max) || max < 0 || max > 2147483646.0 || floor(max) != max) return 0;
  a->root = argv[0]; a->max = (size_t)max;
  for (uint32_t i = 0; i < a->count; i++) if (napi_get_element(env, argv[1], i, &a->parts[i]) != napi_ok || !ar_name(env, a->parts[i])) return 0;
  if (argc == 4 && napi_typeof(env, argv[3], &type) == napi_ok && type == napi_function) a->hook = argv[3];
  return 1;
}
static int ar_step(napi_env env, ar_args *a, const char *kind, uint32_t index) {
  if (!a->hook) return 1;
  napi_value step, name, n, receiver, out;
  if (napi_create_object(env, &step) != napi_ok || napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_set_named_property(env, step, "kind", name) != napi_ok || napi_get_undefined(env, &receiver) != napi_ok) return 0;
  if (!strcmp(kind, "dir") && (napi_create_uint32(env, index, &n) != napi_ok || napi_set_named_property(env, step, "index", n) != napi_ok)) return 0;
  return napi_call_function(env, receiver, a->hook, 1, &step, &out) == napi_ok;
}
static napi_value ar_result(napi_env env, const void *bytes, size_t size, const char *volume, const char *fileId) {
  napi_value out, buffer, value; void *copy;
  if (napi_create_object(env, &out) != napi_ok || napi_create_arraybuffer(env, size, &copy, &buffer) != napi_ok) return NULL;
  if (size) memcpy(copy, bytes, size);
  if (napi_set_named_property(env, out, "bytes", buffer) != napi_ok || napi_create_double(env, (double)size, &value) != napi_ok ||
      napi_set_named_property(env, out, "size", value) != napi_ok || napi_create_string_utf8(env, volume, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, out, "volume", value) != napi_ok || napi_create_string_utf8(env, fileId, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, out, "fileId", value) != napi_ok) return NULL;
  return out;
}
static napi_value ar_version(napi_env env, napi_callback_info info) { (void)info; napi_value value; napi_create_uint32(env, 1, &value); return value; }
