/* Qualification-only Windows launcher: remove administrator membership and
 * privileges from the current account without creating an account or profile. */
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>
static int quote(wchar_t *buffer, size_t *used, const wchar_t *value) {
  if (*used + 3 >= 32768) return 0; buffer[(*used)++] = L'"';
  while (*value) { size_t n = 0; while (*value == L'\\') { n++; value++; } size_t count = (*value == L'"' || !*value) ? n * 2 : n;
    if (*used + count + 4 >= 32768) return 0; while (count--) buffer[(*used)++] = L'\\'; if (!*value) break;
    if (*value == L'"') buffer[(*used)++] = L'\\'; buffer[(*used)++] = *value++;
  }
  buffer[(*used)++] = L'"'; buffer[(*used)++] = L' '; buffer[*used] = 0; return 1;
}
int wmain(int argc, wchar_t **argv) {
  if (argc < 2) return 2;
  HANDLE current = NULL, restricted = NULL; BYTE adminBuffer[SECURITY_MAX_SID_SIZE]; DWORD adminSize = sizeof(adminBuffer);
  if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, adminBuffer, &adminSize)
    || !OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &current)) return 3;
  SID_AND_ATTRIBUTES administrator = { adminBuffer, 0 };
  if (!CreateRestrictedToken(current, DISABLE_MAX_PRIVILEGE, 1, &administrator, 0, NULL, 0, NULL, &restricted)) { fprintf(stderr, "CreateRestrictedToken %lu\n", GetLastError()); return 4; }
  PSID medium = NULL; if (!ConvertStringSidToSidW(L"S-1-16-8192", &medium)) return 5;
  TOKEN_MANDATORY_LABEL integrity = {{ medium, SE_GROUP_INTEGRITY }};
  if (!SetTokenInformation(restricted, TokenIntegrityLevel, &integrity, sizeof(integrity) + GetLengthSid(medium))) { fprintf(stderr, "SetTokenInformation %lu\n", GetLastError()); return 6; }
  wchar_t command[32768] = {0}; size_t used = 0;
  for (int i = 1; i < argc; i++) if (!quote(command, &used, argv[i])) return 7;
  STARTUPINFOW startup = {0}; startup.cb = sizeof(startup); PROCESS_INFORMATION child = {0};
  if (!CreateProcessAsUserW(restricted, argv[1], command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) { fprintf(stderr, "CreateProcessAsUser %lu\n", GetLastError()); return 8; }
  WaitForSingleObject(child.hProcess, INFINITE); DWORD code = 9; GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(restricted); CloseHandle(current); LocalFree(medium); return (int)code;
}
