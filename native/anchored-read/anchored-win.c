// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <winternl.h>
#include <wchar.h>
#include "common.h"
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 1
#endif
// Resolve the system entry point, never a PATH-selected library or process.
typedef NTSTATUS (NTAPI *ar_ntcreate)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
static int ar_info(HANDLE handle, FILE_ID_INFO *id, FILE_STANDARD_INFO *standard, FILE_BASIC_INFO *basic, const char **code) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return 0;
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { *code = "link"; return 0; }
  if (GetFileType(handle) != FILE_TYPE_DISK) { *code = "not_regular"; return 0; }
  return GetFileInformationByHandleEx(handle, FileIdInfo, id, sizeof(*id)) &&
    GetFileInformationByHandleEx(handle, FileStandardInfo, standard, sizeof(*standard)) &&
    GetFileInformationByHandleEx(handle, FileBasicInfo, basic, sizeof(*basic));
}
static napi_value ar_read(napi_env env, napi_callback_info info) {
  ar_args a; HANDLE parent = INVALID_HANDLE_VALUE; wchar_t *root = NULL; unsigned char *bytes = NULL; napi_value result = NULL;
  const char *code = "changed"; size_t length = 0, size = 0;
  FILE_ID_INFO id; FILE_STANDARD_INFO before, after; FILE_BASIC_INFO basic, finalBasic; ULONGLONG volume = 0;
  ar_ntcreate ntcreate = (ar_ntcreate)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  if (!ntcreate) return ar_fail(env, "unsupported");
  if (!ar_parse(env, info, &a)) return ar_fail(env, "invalid_name");
  AR_NAPI(napi_get_value_string_utf16(env, a.root, NULL, 0, &length));
  if (!length || length > 32767) { code = "invalid_name"; goto done; }
  root = malloc((length + 1) * sizeof(wchar_t)); if (!root) goto done;
  AR_NAPI(napi_get_value_string_utf16(env, a.root, (char16_t *)root, length + 1, &length));
  if (wcslen(root) != length || !((length > 2 && root[1] == L':' && (root[2] == L'\\' || root[2] == L'/')) || (length > 1 && root[0] == L'\\' && root[1] == L'\\'))) { code = "invalid_name"; goto done; }
  parent = CreateFileW(root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (parent == INVALID_HANDLE_VALUE) goto done;
  if (!ar_info(parent, &id, &before, &basic, &code)) goto done;
  if (!before.Directory) { code = "not_directory"; goto done; }
  volume = id.VolumeSerialNumber;
  if (!ar_step(env, &a, "root", 0)) goto done;
  for (uint32_t i = 0; i < a.count; i++) {
    wchar_t part[256]; bool last = i + 1 == a.count; HANDLE child = INVALID_HANDLE_VALUE;
    UNICODE_STRING name; OBJECT_ATTRIBUTES attributes; IO_STATUS_BLOCK io;
    AR_NAPI(napi_get_value_string_utf16(env, a.parts[i], (char16_t *)part, 256, &length));
    name.Buffer = part; name.Length = (USHORT)(length * sizeof(wchar_t)); name.MaximumLength = name.Length;
    memset(&attributes, 0, sizeof(attributes)); attributes.Length = sizeof(attributes);
    attributes.RootDirectory = parent; attributes.ObjectName = &name; attributes.Attributes = OBJ_CASE_INSENSITIVE;
    NTSTATUS status = ntcreate(&child, (last ? FILE_READ_DATA : FILE_LIST_DIRECTORY) | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes, &io, NULL, 0, last ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | (last ? FILE_NON_DIRECTORY_FILE : FILE_DIRECTORY_FILE), NULL, 0);
    if (status < 0) {
      if ((ULONG)status == 0xC0000103UL) code = "not_directory";
      else if ((ULONG)status == 0xC00000BAUL) code = "not_regular";
      else if ((ULONG)status == 0xC000050BUL || (ULONG)status == 0x8000002DUL) code = "link";
      goto done;
    }
    CloseHandle(parent); parent = child;
    if (!ar_info(parent, &id, &before, &basic, &code)) goto done;
    if (id.VolumeSerialNumber != volume) { code = "other_volume"; goto done; }
    if (!last) {
      if (!before.Directory) { code = "not_directory"; goto done; }
      if (!ar_step(env, &a, "dir", i)) goto done;
      continue;
    }
    if (before.Directory) { code = "not_regular"; goto done; }
    if (before.NumberOfLinks != 1) { code = "hard_link"; goto done; }
    if (before.EndOfFile.QuadPart < 0 || (ULONGLONG)before.EndOfFile.QuadPart > a.max) { code = "too_large"; goto done; }
    if (!ar_step(env, &a, "file", 0)) goto done;
    bytes = malloc(a.max + 1); if (!bytes) goto done;
    while (size < a.max + 1) {
      DWORD count = 0;
      if (!ReadFile(parent, bytes + size, (DWORD)(a.max + 1 - size), &count, NULL)) goto done;
      if (!count) break;
      size += count;
    }
    if (!ar_step(env, &a, "read", 0)) goto done;
    if (!GetFileInformationByHandleEx(parent, FileStandardInfo, &after, sizeof(after)) ||
        !GetFileInformationByHandleEx(parent, FileBasicInfo, &finalBasic, sizeof(finalBasic))) goto done;
    if ((ULONGLONG)before.EndOfFile.QuadPart != size || before.EndOfFile.QuadPart != after.EndOfFile.QuadPart ||
        basic.LastWriteTime.QuadPart != finalBasic.LastWriteTime.QuadPart || after.NumberOfLinks != 1) goto done;
    char vol[32], fileId[33]; snprintf(vol, sizeof(vol), "%llu", (unsigned long long)volume);
    for (int j = 0; j < 16; j++) snprintf(fileId + j * 2, 3, "%02x", id.FileId.Identifier[j]);
    result = ar_result(env, bytes, size, vol, fileId);
  }
done:
  if (parent != INVALID_HANDLE_VALUE) CloseHandle(parent);
  free(root); free(bytes);
  return result ? result : ar_fail(env, code);
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {{"read", NULL, ar_read, NULL, NULL, NULL, napi_default, NULL}, {"version", NULL, ar_version, NULL, NULL, NULL, napi_default, NULL}};
  napi_define_properties(env, exports, 2, props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
