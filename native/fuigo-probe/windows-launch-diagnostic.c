/* C2 diagnostic only. Reuse exact production identity/quoting helpers without
 * modifying the launcher. Neither suspended child is ever resumed. */
#define wmain production_wmain
#include "launcher.c"
#undef wmain

static void security(const char *label, HANDLE handle, SE_OBJECT_TYPE type, const wchar_t *path) {
  PSECURITY_DESCRIPTOR sd = NULL; LPWSTR sddl = NULL;
  SECURITY_INFORMATION fields = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
  DWORD error = path ? GetNamedSecurityInfoW((LPWSTR)path, type, fields, NULL, NULL, NULL, NULL, &sd)
    : GetSecurityInfo(handle, type, fields, NULL, NULL, NULL, NULL, &sd);
  if (!error && ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, fields, &sddl, NULL)) {
    printf("security %s %ls\n", label, sddl); LocalFree(sddl);
  } else printf("security-error %s %lu\n", label, error ? error : GetLastError());
  if (sd) LocalFree(sd);
}
static void token_details(void) {
  HANDLE token = NULL; DWORD bytes = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { printf("token-error %lu\n", GetLastError()); return; }
  TOKEN_INFORMATION_CLASS classes[] = { TokenUser, TokenGroups, TokenRestrictedSids, TokenIntegrityLevel, TokenDefaultDacl };
  for (unsigned i = 0; i < sizeof(classes)/sizeof(classes[0]); i++) {
    GetTokenInformation(token, classes[i], NULL, 0, &bytes);
    void *data = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
    if (!data || !GetTokenInformation(token, classes[i], data, bytes, &bytes)) { printf("token-class-error %d %lu\n", classes[i], GetLastError()); if (data) HeapFree(GetProcessHeap(), 0, data); continue; }
    if (classes[i] == TokenDefaultDacl) {
      SECURITY_DESCRIPTOR sd; LPWSTR text = NULL; InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
      SetSecurityDescriptorDacl(&sd, TRUE, ((TOKEN_DEFAULT_DACL *)data)->DefaultDacl, FALSE);
      if (ConvertSecurityDescriptorToStringSecurityDescriptorW(&sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, NULL)) { printf("token-default-dacl %ls\n", text); LocalFree(text); }
    } else {
      TOKEN_GROUPS *groups = data;
      DWORD count = classes[i] == TokenIntegrityLevel || classes[i] == TokenUser ? 1 : groups->GroupCount;
      SID_AND_ATTRIBUTES *entries = classes[i] == TokenUser ? &((TOKEN_USER *)data)->User : classes[i] == TokenIntegrityLevel ? &((TOKEN_MANDATORY_LABEL *)data)->Label : groups->Groups;
      for (DWORD j = 0; j < count; j++) { LPWSTR text = NULL; if (ConvertSidToStringSidW(entries[j].Sid, &text)) { printf("token-class %d sid=%ls attributes=%lu\n", classes[i], text, entries[j].Attributes); LocalFree(text); } }
    }
    HeapFree(GetProcessHeap(), 0, data);
  }
  DWORD value = 0;
  if (GetTokenInformation(token, TokenIsAppContainer, &value, sizeof(value), &bytes)) printf("parent-appcontainer %lu\n", value);
  if (GetTokenInformation(token, TokenElevation, &value, sizeof(value), &bytes)) printf("parent-elevated %lu\n", value);
  printf("parent-restricted %d\n", IsTokenRestricted(token)); CloseHandle(token);
}
static DWORD attempt(const wchar_t *image, const wchar_t *cwd, PSID sid, int inherit) {
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup);
  SECURITY_CAPABILITIES capabilities = {0}; capabilities.AppContainerSid = sid;
  SIZE_T bytes = 0; DWORD error = 0; HANDLE handles[3] = {0}; PROCESS_INFORMATION child = {0};
  InitializeProcThreadAttributeList(NULL, inherit ? 2 : 1, 0, &bytes);
  startup.lpAttributeList = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, inherit ? 2 : 1, 0, &bytes)) return GetLastError();
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL)) { error = GetLastError(); goto done; }
  if (inherit) {
    DWORD ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    for (int i = 0; i < 3; i++) if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(ids[i]), GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) { error = GetLastError(); goto done; }
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), NULL, NULL)) { error = GetLastError(); goto done; }
  }
  wchar_t command[32768] = {0}; size_t used = 0;
  if (!quote(command, 32768, &used, image) || !quote(command, 32768, &used, L"hold")) { error = ERROR_BUFFER_OVERFLOW; goto done; }
  SetLastError(0);
  if (!CreateProcessW(image, command, NULL, NULL, inherit, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, cwd, &startup.StartupInfo, &child)) error = GetLastError();
  printf("create-process inherit=%d result=%lu pid=%lu suspended=1 capabilities=0\n", inherit, error, child.dwProcessId);
  if (child.hProcess) {
    HANDLE token = NULL; DWORD isContainer = 0, returned = 0;
    if (OpenProcessToken(child.hProcess, TOKEN_QUERY, &token)) { if (GetTokenInformation(token, TokenIsAppContainer, &isContainer, sizeof(isContainer), &returned)) printf("child-appcontainer inherit=%d value=%lu\n", inherit, isContainer); CloseHandle(token); }
    if (!TerminateProcess(child.hProcess, 0) || WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0) { printf("child-cleanup-failed %lu\n", GetLastError()); error = ERROR_TIMEOUT; }
    else printf("child-terminated inherit=%d\n", inherit);
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
  }
done:
  for (int i = 0; i < 3; i++) if (handles[i]) CloseHandle(handles[i]);
  DeleteProcThreadAttributeList(startup.lpAttributeList); HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  return error;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 4 || !directory(argv[3])) return 2;
  PSID sid = NULL; if (!checked_sid(argv[1], argv[2], &sid)) return 3;
  wchar_t image[32768], path[32768];
  _snwprintf_s(image, 32768, _TRUNCATE, L"%s\\probe-fuigo.exe", argv[3]);
  printf("image %ls\ncwd %ls\n", image, argv[3]);
  printf("image-attributes %lu cwd-attributes %lu\n", GetFileAttributesW(image), GetFileAttributesW(argv[3]));
  HANDLE readable = CreateFileW(image, GENERIC_READ | GENERIC_EXECUTE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  printf("parent-image-read-execute %lu\n", readable == INVALID_HANDLE_VALUE ? GetLastError() : 0);
  if (readable != INVALID_HANDLE_VALUE) CloseHandle(readable);
  readable = CreateFileW(argv[3], FILE_TRAVERSE | FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  printf("parent-cwd-traverse-list %lu\n", readable == INVALID_HANDLE_VALUE ? GetLastError() : 0);
  if (readable != INVALID_HANDLE_VALUE) CloseHandle(readable);
  security("image", NULL, SE_FILE_OBJECT, image);
  wcscpy_s(path, 32768, argv[3]);
  for (;;) { printf("ancestor %ls\n", path); security("cwd-or-ancestor", NULL, SE_FILE_OBJECT, path); wchar_t *slash = wcsrchr(path, L'\\'); if (!slash || slash <= path + 2) break; *slash = 0; }
  token_details(); security("parent-process", GetCurrentProcess(), SE_KERNEL_OBJECT, NULL);
  DWORD ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; i++) { HANDLE h = GetStdHandle(ids[i]); DWORD flags = 0; GetHandleInformation(h, &flags); printf("stdio index=%d type=%lu flags=%lu\n", i, GetFileType(h), flags); security("stdio", h, SE_KERNEL_OBJECT, NULL); }
  DWORD baseline = attempt(image, argv[3], sid, 1);
  DWORD discriminator = attempt(image, argv[3], sid, 0);
  printf("classification baseline=%lu without-inherited-stdio=%lu\n", baseline, discriminator);
  FreeSid(sid); return 0;
}
