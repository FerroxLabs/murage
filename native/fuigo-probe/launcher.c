/* Native, per-process isolation for the updater's offline compatibility probe.
 * No service, firewall configuration, installer, user namespace or shell. */
#ifdef _WIN32
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <wchar.h>

static int failure(const char *operation, DWORD code) {
  fprintf(stderr, "FUIGO_ISOLATION_UNAVAILABLE %s %lu\n", operation, (unsigned long)code);
  return 72;
}
static int valid_name(const wchar_t *name) {
  const wchar_t *prefix = L"murage-fuigo-probe-";
  size_t start = wcslen(prefix), length = wcslen(name);
  if (wcsncmp(name, prefix, start) || length != start + 36) return 0;
  for (size_t i = start; i < length; i++) {
    wchar_t c = name[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-')) return 0;
  }
  return 1;
}
static int directory(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return wcslen(path) > 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')
    && attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY)
    && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
}
static DWORD grant(const wchar_t *path, PSID sid, int inherited) {
  PACL previous = NULL, next = NULL; PSECURITY_DESCRIPTOR security = NULL;
  DWORD error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &previous, NULL, &security);
  if (error != ERROR_SUCCESS) return error;
  EXPLICIT_ACCESSW entry = {0};
  entry.grfAccessPermissions = GENERIC_ALL;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = inherited ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID; entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN; entry.Trustee.ptstrName = (LPWSTR)sid;
  error = SetEntriesInAclW(1, &entry, previous, &next);
  if (error == ERROR_SUCCESS) error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, next, NULL);
  if (next) LocalFree(next); if (security) LocalFree(security);
  return error;
}
static int checked_sid(const wchar_t *name, const wchar_t *expected, PSID *sid) {
  LPWSTR actual = NULL;
  if (!valid_name(name) || FAILED(DeriveAppContainerSidFromAppContainerName(name, sid))) return 0;
  if (!ConvertSidToStringSidW(*sid, &actual)) { FreeSid(*sid); *sid = NULL; return 0; }
  int equal = wcscmp(actual, expected) == 0;
  LocalFree(actual); if (!equal) { FreeSid(*sid); *sid = NULL; }
  return equal;
}
static int setup(const wchar_t *source, const wchar_t *home, const wchar_t *name) {
  if (!directory(home) || !valid_name(name)) return failure("arguments", ERROR_INVALID_PARAMETER);
  PSID sid = NULL; LPWSTR text = NULL; wchar_t target[32768], config[32768], fuigo[32768];
  HRESULT created = CreateAppContainerProfile(name, L"Murage Fuigo compatibility probe", L"Temporary offline updater probe", NULL, 0, &sid);
  if (FAILED(created)) return failure("create-profile", (DWORD)created); /* Never adopt an existing profile. */
  _snwprintf_s(target, 32768, _TRUNCATE, L"%s\\probe-fuigo.exe", home);
  _snwprintf_s(fuigo, 32768, _TRUNCATE, L"%s\\fuigo", home);
  _snwprintf_s(config, 32768, _TRUNCATE, L"%s\\fuigo\\config.toml", home);
  DWORD error = grant(home, sid, 1);
  if (error == ERROR_SUCCESS) error = grant(fuigo, sid, 1);
  if (error == ERROR_SUCCESS) error = grant(config, sid, 0);
  if (error == ERROR_SUCCESS && !CopyFileW(source, target, TRUE)) error = GetLastError();
  if (error == ERROR_SUCCESS) error = grant(target, sid, 0);
  if (error == ERROR_SUCCESS && !ConvertSidToStringSidW(sid, &text)) error = GetLastError();
  if (error != ERROR_SUCCESS) {
    HRESULT removed = DeleteAppContainerProfile(name);
    if (FAILED(removed)) fprintf(stderr, "FUIGO_PROBE_CLEANUP profile %ls 0x%lx\n", name, (unsigned long)removed);
    FreeSid(sid); return failure("prepare-profile", error);
  }
  wprintf(L"%s\n", text); LocalFree(text); FreeSid(sid); return 0;
}
static int cleanup(const wchar_t *name, const wchar_t *expected) {
  PSID sid = NULL;
  if (!checked_sid(name, expected, &sid)) return failure("cleanup-identity", ERROR_INVALID_SID);
  FreeSid(sid);
  HRESULT removed = DeleteAppContainerProfile(name);
  if (FAILED(removed)) { fprintf(stderr, "FUIGO_PROBE_CLEANUP profile %ls 0x%lx\n", name, (unsigned long)removed); return 73; }
  return 0;
}
/* Windows argv quoting, including backslashes before quotes or the closing quote. */
static int quote(wchar_t *buffer, size_t capacity, size_t *used, const wchar_t *value) {
  if (*used + 3 >= capacity) return 0; buffer[(*used)++] = L'"';
  for (;;) {
    size_t slashes = 0; while (*value == L'\\') { slashes++; value++; }
    size_t count = (*value == L'"' || !*value) ? slashes * 2 : slashes;
    if (*used + count + 4 >= capacity) return 0;
    while (count--) buffer[(*used)++] = L'\\';
    if (!*value) break;
    if (*value == L'"') buffer[(*used)++] = L'\\';
    buffer[(*used)++] = *value++;
  }
  buffer[(*used)++] = L'"'; buffer[(*used)++] = L' '; buffer[*used] = 0; return 1;
}
static int run(int argc, wchar_t **argv) {
  PSID sid = NULL;
  if (argc < 6 || !directory(argv[4]) || !checked_sid(argv[2], argv[3], &sid)) return failure("run-identity", ERROR_INVALID_PARAMETER);
  wchar_t executable[32768], command[32768] = {0}; size_t used = 0;
  _snwprintf_s(executable, 32768, _TRUNCATE, L"%s\\probe-fuigo.exe", argv[4]);
  if (!quote(command, 32768, &used, executable)) { FreeSid(sid); return failure("command", ERROR_BUFFER_OVERFLOW); }
  for (int i = 5; i < argc; i++) if (!quote(command, 32768, &used, argv[i])) { FreeSid(sid); return failure("command", ERROR_BUFFER_OVERFLOW); }
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  SECURITY_CAPABILITIES capabilities = {0}; capabilities.AppContainerSid = sid;
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE handles[3] = {0}, source[3] = { GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE) };
  HANDLE job = NULL; PROCESS_INFORMATION process = {0}; DWORD error = ERROR_SUCCESS, code = 72;
  const char *operation = "initialize-attributes";
  if (!attributes || !InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) { error = GetLastError(); goto done; }
  startup.lpAttributeList = attributes;
  for (int i = 0; i < 3; i++) {
    operation = i == 0 ? "duplicate-stdin" : i == 1 ? "duplicate-stdout" : "duplicate-stderr";
    if (!DuplicateHandle(GetCurrentProcess(), source[i], GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) { error = GetLastError(); goto done; }
  }
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  operation = "security-capabilities";
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL)) { error = GetLastError(); goto done; }
  operation = "handle-list";
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), NULL, NULL)) { error = GetLastError(); goto done; }
  operation = "create-job";
  job = CreateJobObjectW(NULL, NULL);
  if (!job) { error = GetLastError(); goto done; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  operation = "job-limits";
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { error = GetLastError(); goto done; }
  operation = "create-process";
  if (!CreateProcessW(executable, command, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, argv[4], &startup.StartupInfo, &process)) { error = GetLastError(); goto done; }
  operation = "assign-job";
  if (!AssignProcessToJobObject(job, process.hProcess)) { error = GetLastError(); TerminateProcess(process.hProcess, 72); goto done; }
  operation = "resume-thread";
  if (ResumeThread(process.hThread) == (DWORD)-1) { error = GetLastError(); goto done; }
  operation = "wait-process";
  if (WaitForSingleObject(process.hProcess, 45000) != WAIT_OBJECT_0) { error = ERROR_TIMEOUT; goto done; }
  operation = "exit-code";
  if (!GetExitCodeProcess(process.hProcess, &code)) error = GetLastError();
done:
  if (job) CloseHandle(job); /* Kernel kills every contained child, including on launcher termination. */
  if (process.hThread) CloseHandle(process.hThread); if (process.hProcess) CloseHandle(process.hProcess);
  for (int i = 0; i < 3; i++) if (handles[i]) CloseHandle(handles[i]);
  if (attributes) { if (startup.lpAttributeList) DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); }
  FreeSid(sid); return error == ERROR_SUCCESS ? (int)code : failure(operation, error);
}
int wmain(int argc, wchar_t **argv) {
  if (argc == 5 && !wcscmp(argv[1], L"setup")) return setup(argv[2], argv[3], argv[4]);
  if (argc == 4 && !wcscmp(argv[1], L"cleanup")) return cleanup(argv[2], argv[3]);
  if (argc >= 6 && !wcscmp(argv[1], L"run")) return run(argc, argv);
  return failure("usage", ERROR_INVALID_PARAMETER);
}
#else
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int failure(const char *operation) { fprintf(stderr, "FUIGO_ISOLATION_UNAVAILABLE %s errno=%d\n", operation, errno); return 72; }
static int allow_path(int ruleset, const char *path, __u64 rights, int required) {
  int descriptor = open(path, O_PATH | O_CLOEXEC);
  if (descriptor < 0) return !required && errno == ENOENT ? 0 : -1;
  struct stat status; if (fstat(descriptor, &status)) { close(descriptor); return -1; }
  if (!S_ISDIR(status.st_mode)) rights &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = descriptor };
  int result = (int)syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0); close(descriptor); return result;
}
static int filesystem(const char *cli, const char *home) {
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) { errno = ENOTSUP; return -1; }
  __u64 read = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  __u64 all = read | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr attributes = { .handled_access_fs = all };
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attributes, sizeof(attributes), 0); if (ruleset < 0) return -1;
  int result = allow_path(ruleset, cli, read, 1) || allow_path(ruleset, home, all, 1);
  const char *runtime[] = { "/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/ld.so.cache", "/etc/localtime", "/usr/share/zoneinfo" };
  for (size_t i = 0; !result && i < sizeof(runtime) / sizeof(runtime[0]); i++) result = allow_path(ruleset, runtime[i], read, 0);
  const char *devices[] = { "/dev/null", "/dev/urandom", "/dev/random" };
  for (size_t i = 0; !result && i < sizeof(devices) / sizeof(devices[0]); i++) result = allow_path(ruleset, devices[i], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 1);
  if (!result) result = (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  close(ruleset); return result;
}
#define DENY(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static int syscalls(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY(SYS_socket), DENY(SYS_socketpair), DENY(SYS_connect), DENY(SYS_bind), DENY(SYS_listen), DENY(SYS_accept), DENY(SYS_accept4),
    DENY(SYS_io_uring_setup), DENY(SYS_io_uring_enter), DENY(SYS_io_uring_register),
    DENY(SYS_ptrace), DENY(SYS_process_vm_readv), DENY(SYS_process_vm_writev), DENY(SYS_pidfd_getfd),
    DENY(SYS_mount), DENY(SYS_umount2), DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_bpf),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[1], "run") || argv[2][0] != '/' || argv[3][0] != '/') { errno = EINVAL; return failure("arguments"); }
  char *cli = realpath(argv[2], NULL), *home = realpath(argv[3], NULL);
  if (!cli || !home) return failure("realpath");
  struct stat status; if (lstat(home, &status) || !S_ISDIR(status.st_mode) || status.st_uid != getuid()) { errno = EINVAL; return failure("scratch-owner"); }
  if (chdir(home) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) return failure("process-policy");
  if (syscall(SYS_close_range, 3U, ~0U, 0)) return failure("descriptor-cleanup");
  if (filesystem(cli, home)) return failure("landlock");
  if (syscalls()) return failure("seccomp");
  char **arguments = calloc((size_t)argc - 2, sizeof(char *)); if (!arguments) return failure("argv");
  arguments[0] = cli; for (int i = 4; i < argc; i++) arguments[i - 3] = argv[i];
  execv(cli, arguments); return failure("exec");
}
#endif
