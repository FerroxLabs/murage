// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixture for the Windows anchored-open helper (CONTRACTS-B 1.3, R18 and R22b). Never packaged; built only with the test-hooks addon
// (scripts/build-engine-exclusion.mjs --test-hooks) into dist-native/engine-exclusion-test/win32-<arch>/reparse-convert.exe.
//
//   reparse-convert.exe [--restricted] <dir> <target> [<arrived-event> <release-event>]
//
// Turns the EMPTY directory <dir> into a mount point (junction) to <target>, in place, through FSCTL_SET_REPARSE_POINT on a handle opened
// for write (a directory the helper holds is shareable for read and write, never for delete, so this is the one way to swap it).
// With --restricted the work runs in a child whose token went through CreateRestrictedToken(DISABLE_MAX_PRIVILEGE): the standard-user case.
// With the two event names it first waits (up to 20 s) for <arrived-event> (the helper's I/O thread is parked inside its open), converts,
// then sets <release-event>. Exit codes: 2 usage, 3 wait failed, 4 open failed, 5 set failed, 6 token or child failed.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef IO_REPARSE_TAG_MOUNT_POINT
#define IO_REPARSE_TAG_MOUNT_POINT (0xA0000003L)
#endif

static int restricted_child(int argc, wchar_t **argv) {
  HANDLE token = NULL, limited = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &token)) return 6;
  if (!CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 0, NULL, &limited)) { CloseHandle(token); return 6; }
  CloseHandle(token);
  size_t cap = 64;
  for (int i = 0; i < argc; i++) cap += wcslen(argv[i]) + 3;
  wchar_t *line = (wchar_t *)calloc(cap, sizeof(wchar_t));
  if (!line) return 6;
  size_t used = 0;
  for (int i = 0; i < argc; i++) {
    if (i == 1) continue;  // the --restricted flag itself
    used += (size_t)swprintf(line + used, cap - used, L"%ls\"%ls\"", used ? L" " : L"", argv[i]);
  }
  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  memset(&startup, 0, sizeof startup);
  startup.cb = sizeof startup;
  memset(&child, 0, sizeof child);
  if (!CreateProcessAsUserW(limited, NULL, line, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &child)) return 6;
  WaitForSingleObject(child.hProcess, 60000);
  DWORD code = 6;
  GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess);
  CloseHandle(child.hThread);
  CloseHandle(limited);
  free(line);
  return (int)code;
}

static HANDLE open_named_event(const wchar_t *name) {
  for (int attempt = 0; attempt < 200; attempt++) {
    HANDLE event = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, name);
    if (event) return event;
    Sleep(100);
  }
  return NULL;
}

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--restricted") == 0) return restricted_child(argc, argv);
  if (argc != 3 && argc != 5) return 2;
  const wchar_t *dir = argv[1], *target = argv[2];
  HANDLE release = NULL;
  if (argc == 5) {
    HANDLE arrived = open_named_event(argv[3]);
    release = open_named_event(argv[4]);
    if (!arrived || !release) return 3;
    if (WaitForSingleObject(arrived, 20000) != WAIT_OBJECT_0) return 3;
  }
  wchar_t substitute[2100];
  int sub_len = swprintf(substitute, 2100, L"\\??\\%ls", target);
  if (sub_len <= 0) return 2;
  size_t s = (size_t)sub_len * sizeof(wchar_t), p = wcslen(target) * sizeof(wchar_t);
  size_t data = 8 + s + 2 + p + 2;
  size_t total = 8 + data;
  unsigned char *buffer = (unsigned char *)calloc(total, 1);
  if (!buffer) return 2;
  *(ULONG *)(buffer + 0) = IO_REPARSE_TAG_MOUNT_POINT;
  *(USHORT *)(buffer + 4) = (USHORT)data;
  *(USHORT *)(buffer + 8) = 0;
  *(USHORT *)(buffer + 10) = (USHORT)s;
  *(USHORT *)(buffer + 12) = (USHORT)(s + 2);
  *(USHORT *)(buffer + 14) = (USHORT)p;
  memcpy(buffer + 16, substitute, s);
  memcpy(buffer + 16 + s + 2, target, p);
  HANDLE h = CreateFileW(dir, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h == INVALID_HANDLE_VALUE) return 4;
  DWORD returned = 0;
  BOOL ok = DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, buffer, (DWORD)total, NULL, 0, &returned, NULL);
  CloseHandle(h);
  free(buffer);
  if (release) SetEvent(release);
  return ok ? 0 : 5;
}
