// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <string.h>

// The import library names node.exe, but Electron exports N-API from its
// executable (Murage.exe in a package). Reuse that loaded host; never search
// for or load another Node executable from disk.
static FARPROC WINAPI ar_host_hook(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return (FARPROC)GetModuleHandleW(NULL);
  return NULL;
}

const PfnDliHook __pfnDliNotifyHook2 = ar_host_hook;
