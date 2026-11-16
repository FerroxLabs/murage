/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Producer and snapshot consumer owner: scperf-p2. Kernel-held leases and
 * private, anchored receipt handles. No lock stealing or process lookup.
 * Existing native accounting callbacks owner: scperf-p1. */
#ifdef _WIN32
#include <aclapi.h>
#include <sddl.h>
#else
#include <limits.h>
#ifdef __APPLE__
#include <mach/mach_time.h>
#endif
#endif

typedef struct sio_handle {
#ifdef _WIN32
  HANDLE h;
  wchar_t *path;
#else
  int fd;
#endif
  int directory;
} sio_handle;

static void sio_release(sio_handle *h) {
  if (!h) return;
#ifdef _WIN32
  if (h->h != INVALID_HANDLE_VALUE) { CloseHandle(h->h); h->h = INVALID_HANDLE_VALUE; }
  free(h->path); h->path = NULL;
#else
  if (h->fd >= 0) { close(h->fd); h->fd = -1; }
#endif
}
static void sio_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; sio_release(data); free(data);
}
static sio_handle *sio_get(napi_env env, napi_value value) {
  sio_handle *h = NULL;
  if (napi_get_value_external(env, value, (void **)&h) != napi_ok || !h) return NULL;
#ifdef _WIN32
  return h->h == INVALID_HANDLE_VALUE ? NULL : h;
#else
  return h->fd < 0 ? NULL : h;
#endif
}
#ifdef _WIN32
/* Query security on the opened handle, never by path or through icacls.
 * A null/unknown ACL or any ACE granting another principal access is refused. */
static int sio_private(HANDLE h, int directory) {
  BY_HANDLE_FILE_INFORMATION st;
  PSECURITY_DESCRIPTOR sd = NULL; PSID owner = NULL; PACL acl = NULL;
  HANDLE token = NULL; TOKEN_USER *user = NULL; DWORD size = 0;
  BYTE system[SECURITY_MAX_SID_SIZE], admins[SECURITY_MAX_SID_SIZE];
  DWORD ns = sizeof system, na = sizeof admins; int ok = 0;
  if (!GetFileInformationByHandle(h, &st) || (st.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
      || !!(st.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory
      || (!directory && st.nNumberOfLinks != 1)) return 0;
  if (GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &acl, NULL, &sd) != ERROR_SUCCESS || !owner || !acl) goto done;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  user = malloc(size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)
      || !EqualSid(owner, user->User.Sid)
      || !CreateWellKnownSid(WinLocalSystemSid, NULL, system, &ns)
      || !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admins, &na)) goto done;
  for (DWORD i = 0; i < acl->AceCount; i++) {
    void *ace = NULL;
    if (!GetAce(acl, i, &ace)) goto done;
    ACE_HEADER *header = ace;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) goto done;
    ACCESS_ALLOWED_ACE *allow = ace; PSID sid = &allow->SidStart;
    if (!EqualSid(sid, user->User.Sid) && !EqualSid(sid, system) && !EqualSid(sid, admins)) goto done;
  }
  ok = 1;
 done:
  if (token) CloseHandle(token);
  free(user); if (sd) LocalFree(sd);
  return ok;
}
static wchar_t *sio_wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
  if (!n) return NULL;
  wchar_t *w = malloc((size_t)n * sizeof(wchar_t));
  if (w && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n)) { free(w); return NULL; }
  return w;
}
static wchar_t *sio_child_path(sio_handle *root, const char *name) {
  wchar_t *leaf = sio_wide(name); if (!leaf) return NULL;
  size_t n = wcslen(root->path), m = wcslen(leaf);
  wchar_t *path = malloc((n + m + 2) * sizeof(wchar_t));
  if (path) { memcpy(path, root->path, n * sizeof(wchar_t)); path[n] = L'\\'; memcpy(path + n + 1, leaf, (m + 1) * sizeof(wchar_t)); }
  free(leaf); return path;
}
#else
static int sio_private(int fd, int directory) {
  struct stat st;
  return fstat(fd, &st) == 0 && st.st_uid == geteuid() && (st.st_mode & 0077) == 0
    && (directory ? S_ISDIR(st.st_mode) : (S_ISREG(st.st_mode) && st.st_nlink == 1));
}
#endif
static int sio_name(const char *s) {
  return s && *s && strlen(s) < 64 && !strchr(s, '/') && !strchr(s, '\\') && !strstr(s, "..");
}
static napi_value sio_external(napi_env env, sio_handle *h) {
  napi_value out;
  if (napi_create_external(env, h, sio_finalize, NULL, &out) != napi_ok) { sio_release(h); free(h); return fail(env, "receipt handle"); }
  return out;
}
/* Provision a new private directory. This never changes an existing ACL. */
static napi_value sio_create_root(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value a[1]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  if (n != 1) return fail(env, "receipt create arguments");
  char *path = get_utf8(env, a[0]); if (!path) return NULL;
  int ok = 0;
#ifdef _WIN32
  HANDLE token = NULL; DWORD size = 0; TOKEN_USER *user = NULL;
  LPWSTR sid = NULL; PSECURITY_DESCRIPTOR sd = NULL; wchar_t *wide = sio_wide(path);
  if (!wide || !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &size); user = malloc(size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)
      || !ConvertSidToStringSidW(user->User.Sid, &sid)) goto done;
  size_t length = wcslen(sid) + 100; wchar_t *sddl = malloc(length * sizeof(wchar_t));
  if (!sddl) goto done;
  _snwprintf_s(sddl, length, _TRUNCATE, L"D:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", sid);
  if (ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, NULL)) {
    SECURITY_ATTRIBUTES attrs = { sizeof attrs, sd, FALSE };
    ok = CreateDirectoryW(wide, &attrs) != 0;
  }
  free(sddl);
 done:
  free(wide); free(user); if (sid) LocalFree(sid); if (sd) LocalFree(sd); if (token) CloseHandle(token);
#else
  ok = mkdir(path, 0700) == 0;
  if (ok) {
    char *slash = strrchr(path, '/');
    if (!slash || slash == path) ok = 0;
    else {
      *slash = '\0'; int parent = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      ok = parent >= 0 && fsync(parent) == 0;
      if (parent >= 0) close(parent);
    }
  }
#endif
  free(path); return make_bool(env, ok);
}
static napi_value sio_open_root(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value a[1]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  if (n != 1) return fail(env, "receipt root arguments");
  char *path = get_utf8(env, a[0]); if (!path) return NULL;
  sio_handle *h = calloc(1, sizeof *h); if (!h) { free(path); return fail(env, "receipt memory"); }
  h->directory = 1;
#ifdef _WIN32
  h->path = sio_wide(path);
  h->h = h->path ? CreateFileW(h->path, FILE_LIST_DIRECTORY | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL) : INVALID_HANDLE_VALUE;
  free(path);
  if (h->h == INVALID_HANDLE_VALUE || !sio_private(h->h, 1)) {
#else
  h->fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); free(path);
  if (h->fd < 0 || !sio_private(h->fd, 1)) {
#endif
    sio_release(h); free(h); return fail(env, "receipt root refused");
  }
  return sio_external(env, h);
}
static napi_value sio_open(napi_env env, napi_callback_info info) {
  size_t n = 3; napi_value a[3]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  int32_t kind = -1; sio_handle *root = n == 3 ? sio_get(env, a[0]) : NULL;
  if (!root || !root->directory || napi_get_value_int32(env, a[2], &kind) != napi_ok || kind < 0 || kind > 2) return fail(env, "receipt open arguments");
  char *name = get_utf8(env, a[1]); if (!name) return NULL;
  if (!sio_name(name)) { free(name); return fail(env, "receipt child name"); }
  sio_handle *h = calloc(1, sizeof *h); if (!h) { free(name); return fail(env, "receipt memory"); }
#ifdef _WIN32
  h->path = sio_child_path(root, name); free(name);
  h->h = h->path ? CreateFileW(h->path, GENERIC_READ | (kind ? GENERIC_WRITE : 0) | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, kind == 2 ? CREATE_NEW : OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL) : INVALID_HANDLE_VALUE;
  if (h->h == INVALID_HANDLE_VALUE || !sio_private(h->h, 0)) {
#else
  h->fd = openat(root->fd, name, (kind ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC | (kind == 2 ? O_CREAT | O_EXCL : 0), 0600); free(name);
  if (h->fd < 0 || !sio_private(h->fd, 0)) {
#endif
    sio_release(h); free(h); return fail(env, "receipt file refused");
  }
  return sio_external(env, h);
}
static napi_value sio_close(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value a[1]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  sio_handle *h = n == 1 ? sio_get(env, a[0]) : NULL;
  if (h) sio_release(h);
  return make_bool(env, 1);
}
static napi_value sio_lock(napi_env env, napi_callback_info info) {
  size_t n = 2; napi_value a[2]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  sio_handle *h = n == 2 ? sio_get(env, a[0]) : NULL; int32_t mode = -1;
  if (!h || h->directory || napi_get_value_int32(env, a[1], &mode) != napi_ok || mode < 0 || mode > 2) return fail(env, "receipt lock arguments");
#ifdef _WIN32
  OVERLAPPED o; memset(&o, 0, sizeof o);
  if (mode == 0) return make_bool(env, UnlockFileEx(h->h, 0, 1, 0, &o));
  return make_bool(env, LockFileEx(h->h, LOCKFILE_FAIL_IMMEDIATELY | (mode == 2 ? LOCKFILE_EXCLUSIVE_LOCK : 0), 0, 1, 0, &o));
#else
  return make_bool(env, flock(h->fd, mode == 0 ? LOCK_UN : (mode == 2 ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0);
#endif
}
static napi_value sio_read(napi_env env, napi_callback_info info) {
  size_t n = 2; napi_value a[2]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  sio_handle *h = n == 2 ? sio_get(env, a[0]) : NULL; uint32_t limit = 0;
  if (!h || h->directory || napi_get_value_uint32(env, a[1], &limit) != napi_ok || limit > 8192) return fail(env, "receipt read arguments");
  uint64_t size;
#ifdef _WIN32
  LARGE_INTEGER length, zero; zero.QuadPart = 0;
  if (!sio_private(h->h, 0) || !GetFileSizeEx(h->h, &length) || !SetFilePointerEx(h->h, zero, NULL, FILE_BEGIN)) return fail(env, "receipt read security");
  size = length.QuadPart;
#else
  struct stat st;
  if (!sio_private(h->fd, 0) || fstat(h->fd, &st)) return fail(env, "receipt read security");
  size = (uint64_t)st.st_size;
#endif
  if (size > limit) return fail(env, "receipt read limit");
  napi_value out; void *buffer = NULL;
  if (napi_create_buffer(env, (size_t)size, &buffer, &out) != napi_ok) return fail(env, "receipt read memory");
  size_t at = 0;
  while (at < size) {
#ifdef _WIN32
    DWORD got = 0;
    if (!ReadFile(h->h, (char *)buffer + at, (DWORD)(size - at), &got, NULL) || !got) return fail(env, "receipt short read");
#else
    ssize_t got = pread(h->fd, (char *)buffer + at, (size_t)size - at, (off_t)at);
    if (got <= 0) return fail(env, "receipt short read");
#endif
    at += (size_t)got;
  }
  return out;
}
static int sio_sync_handle(sio_handle *h) {
#ifdef _WIN32
  return FlushFileBuffers(h->h) != 0;
#else
#ifdef __APPLE__
  if (!h->directory) {
    if (fcntl(h->fd, F_FULLFSYNC) == 0) return 1;
    if (errno != ENOTSUP && errno != EINVAL && errno != ENOTTY) return 0;
  }
#endif
  return fsync(h->fd) == 0;
#endif
}
static napi_value sio_write(napi_env env, napi_callback_info info) {
  size_t n = 2, length = 0; napi_value a[2]; void *buffer = NULL;
  napi_get_cb_info(env, info, &n, a, NULL, NULL);
  sio_handle *h = n == 2 ? sio_get(env, a[0]) : NULL;
  if (!h || h->directory || napi_get_buffer_info(env, a[1], &buffer, &length) != napi_ok || length > 8192) return fail(env, "receipt write arguments");
#ifdef _WIN32
  LARGE_INTEGER zero; zero.QuadPart = 0;
  if (!sio_private(h->h, 0) || !SetFilePointerEx(h->h, zero, NULL, FILE_BEGIN) || !SetEndOfFile(h->h)) return fail(env, "receipt write security");
#else
  if (!sio_private(h->fd, 0) || ftruncate(h->fd, 0)) return fail(env, "receipt write security");
#endif
  size_t at = 0;
  while (at < length) {
#ifdef _WIN32
    DWORD got = 0;
    if (!WriteFile(h->h, (char *)buffer + at, (DWORD)(length - at), &got, NULL) || !got) { io_meter_mark_unknown(); return fail(env, "receipt short write"); }
#else
    ssize_t got = pwrite(h->fd, (char *)buffer + at, length - at, (off_t)at);
    if (got <= 0) { io_meter_mark_unknown(); return fail(env, "receipt short write"); }
#endif
    io_meter_note_native_bytes((uint64_t)got); at += (size_t)got;
  }
  if (!sio_sync_handle(h)) { io_meter_mark_unknown(); return fail(env, "receipt flush"); }
  return make_bool(env, 1);
}
static napi_value sio_replace(napi_env env, napi_callback_info info) {
  size_t n = 3; napi_value a[3]; napi_get_cb_info(env, info, &n, a, NULL, NULL);
  sio_handle *root = n == 3 ? sio_get(env, a[0]) : NULL;
  if (!root || !root->directory) return fail(env, "receipt replace root");
  char *from = get_utf8(env, a[1]); if (!from) return NULL;
  char *to = get_utf8(env, a[2]); if (!to) { free(from); return NULL; }
  if (!sio_name(from) || !sio_name(to)) { free(from); free(to); return fail(env, "receipt replace name"); }
  int ok;
  /* Refuse an existing unsafe destination, even though rename itself would
   * replace rather than follow a link. Never certify an aliased namespace. */
#ifdef _WIN32
  wchar_t *target = sio_child_path(root, to);
  HANDLE existing = target ? CreateFileW(target, GENERIC_READ | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL) : INVALID_HANDLE_VALUE;
  int safe = existing != INVALID_HANDLE_VALUE ? sio_private(existing, 0) : GetLastError() == ERROR_FILE_NOT_FOUND;
  if (existing != INVALID_HANDLE_VALUE) CloseHandle(existing);
  free(target);
  if (!safe) { free(from); free(to); return fail(env, "receipt replace destination"); }
  wchar_t *f = sio_child_path(root, from), *t = sio_child_path(root, to);
  ok = f && t && MoveFileExW(f, t, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  free(f); free(t);
#else
  struct stat destination;
  int found = fstatat(root->fd, to, &destination, AT_SYMLINK_NOFOLLOW);
  if ((found == 0 && (!S_ISREG(destination.st_mode) || destination.st_nlink != 1
      || destination.st_uid != geteuid() || (destination.st_mode & 0077))) || (found != 0 && errno != ENOENT)) {
    free(from); free(to); return fail(env, "receipt replace destination");
  }
  ok = renameat(root->fd, from, root->fd, to) == 0 && sio_sync_handle(root);
#endif
  free(from); free(to);
  if (!ok) { io_meter_mark_unknown(); return fail(env, "receipt durable replace"); }
  return make_bool(env, 1);
}
/* Awake time excludes suspend; Windows QPC/hrtime alone does not. */
static napi_value sio_awake(napi_env env, napi_callback_info info) {
  (void)info; double ms;
#ifdef _WIN32
  ULONGLONG ticks;
  if (!QueryUnbiasedInterruptTime(&ticks)) return fail(env, "receipt awake clock");
  ms = (double)ticks / 10000.0;
#elif defined(__APPLE__)
  mach_timebase_info_data_t base;
  if (mach_timebase_info(&base) != KERN_SUCCESS || !base.denom) return fail(env, "receipt awake clock");
  ms = (double)mach_absolute_time() * base.numer / base.denom / 1000000.0;
#else
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) return fail(env, "receipt awake clock");
  ms = (double)t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
#endif
  napi_value out; napi_create_double(env, ms, &out); return out;
}
static void sentinel_io_register(napi_env env, napi_value exports) {
  add(env, exports, "sentinelIoAwakeMs", sio_awake);
  add(env, exports, "sentinelIoCreateRoot", sio_create_root);
  add(env, exports, "sentinelIoRoot", sio_open_root);
  add(env, exports, "sentinelIoOpen", sio_open);
  add(env, exports, "sentinelIoClose", sio_close);
  add(env, exports, "sentinelIoLock", sio_lock);
  add(env, exports, "sentinelIoRead", sio_read);
  add(env, exports, "sentinelIoWrite", sio_write);
  add(env, exports, "sentinelIoReplace", sio_replace);
}
