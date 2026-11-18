// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixture for the Windows anchored-open helper (CONTRACTS-B 1.3, R8 ii). Never packaged; built only with the test-hooks addon
// (scripts/build-engine-exclusion.mjs --test-hooks) into dist-native/engine-exclusion-test/win32-<arch>/oplock-holder.exe.
//
//   oplock-holder.exe <file> <ready-file>
//
// Opens <file> with full sharing, requests a BATCH oplock (FSCTL_REQUEST_BATCH_OPLOCK) and, once it is granted, creates <ready-file>.
// It then holds the oplock and never acknowledges the break another open triggers (like a stuck filter or a hung sync client), until the
// test kills it or 60 s pass. Exit codes: 2 usage, 3 open failed, 4 oplock not granted, 5 ready file failed.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>

int wmain(int argc, wchar_t **argv) {
  if (argc != 3) return 2;
  HANDLE file = INVALID_HANDLE_VALUE;
  OVERLAPPED ov;
  int granted = 0;
  // A scanner can briefly hold its own handle, which makes the request fail; retry a few times.
  for (int attempt = 0; attempt < 10 && !granted; attempt++) {
    if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); file = INVALID_HANDLE_VALUE; Sleep(200); }
    file = CreateFileW(argv[1], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (file == INVALID_HANDLE_VALUE) return 3;
    ZeroMemory(&ov, sizeof ov);
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) return 4;
    BOOL ok = DeviceIoControl(file, FSCTL_REQUEST_BATCH_OPLOCK, NULL, 0, NULL, 0, NULL, &ov);
    if (!ok && GetLastError() == ERROR_IO_PENDING) granted = 1;
  }
  if (!granted) return 4;
  HANDLE ready = CreateFileW(argv[2], GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (ready == INVALID_HANDLE_VALUE) return 5;
  CloseHandle(ready);
  Sleep(60000);
  return 0;
}
