// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The few operating-system calls Node cannot make, which Murage needs before it changes a coding engine's own file:
//   lock(fd)                       macOS, Linux: take the same whole-file lock the engine takes (flock), waiting up to 1 s
//   openers(devs, inos)            macOS, Linux: which of these files OR DIRECTORIES does ANOTHER process of this user hold (open
//                                  file, open directory, working directory or root directory)? An incomplete scan says "held".
//   renameNoReplace(from, to)      all: one atomic rename that never replaces (renameat2 RENAME_NOREPLACE, renamex_np RENAME_EXCL,
//                                  MoveFileEx without REPLACE_EXISTING). 0 done, 1 the name exists, 2 not supported here.
//   openFile / handle*             Windows: a file opened share-none (or shared, for the engine's lock) as a HANDLE that this addon
//                                  owns. Every read, write, flush, lock, delete mark and close runs here on that HANDLE. JavaScript
//                                  holds only an opaque external value and hands it back; no C runtime descriptor is ever passed
//                                  between this module and Node (they would be different runtimes).
// Nothing here reads or writes a file on POSIX: Node does that through its own descriptor. A scan that cannot be completed reports
// every file as held, never as free: only a process that is confirmed gone (ESRCH/ENOENT on that process) is left out, and only
// a process confirmed to belong to another user is not inspected. Built per platform by scripts/build-engine-exclusion.mjs (N-API 9).
#define NAPI_VERSION 9
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#endif
#ifdef __linux__
#include <sys/syscall.h>
#endif
#endif

#define ADDON_VERSION 2
#define LOCK_WAIT_MS 1000
#define LOCK_STEP_MS 10

static napi_value make_bool(napi_env env, int value) {
  napi_value out;
  napi_get_boolean(env, value != 0, &out);
  return out;
}
static napi_value make_int(napi_env env, int32_t value) {
  napi_value out;
  napi_create_int32(env, value, &out);
  return out;
}
#ifdef _WIN32
static napi_value make_null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}
#endif
static napi_value fail(napi_env env, const char *what) {
  napi_throw_error(env, "ENGINE_EXCLUSION", what);
  return NULL;
}
static napi_value fail_code(napi_env env, const char *code, const char *what) {
  napi_throw_error(env, code, what);
  return NULL;
}

/** A UTF-8 string argument, copied into memory the caller frees. NULL (with an exception pending) when it is not a string. */
static char *get_utf8(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) { fail(env, "a path must be a string"); return NULL; }
  char *text = malloc(length + 1);
  if (!text) { fail(env, "out of memory"); return NULL; }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &copied) != napi_ok) { free(text); fail(env, "a path must be a string"); return NULL; }
  text[copied] = '\0';
  return text;
}

#ifndef _WIN32
static const char *errname(int e) {
  switch (e) {
    case ENOENT: return "ENOENT";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EEXIST: return "EEXIST";
    case EXDEV: return "EXDEV";
    case EBUSY: return "EBUSY";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EINVAL: return "EINVAL";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EROFS: return "EROFS";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOTSUP: return "ENOTSUP";
    case ENOSYS: return "ENOSYS";
    default: return "EIO";
  }
}
#endif

// ── lock(fd): macOS, Linux ──────────────────────────────────────────────

#ifndef _WIN32
static napi_value lock_file(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd = -1;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return fail(env, "lock needs a file descriptor");
  for (int waited = 0;; waited += LOCK_STEP_MS) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) return make_bool(env, 1);
    if (errno == EINTR) continue;
    if (errno != EWOULDBLOCK || waited >= LOCK_WAIT_MS) return make_bool(env, 0);
    struct timespec step = {0, LOCK_STEP_MS * 1000000L};
    nanosleep(&step, NULL);
  }
}
#else
static napi_value lock_file(napi_env env, napi_callback_info info) {
  (void)info;
  return fail(env, "lock(fd) is not used on Windows; use handleLock");
}
#endif

// ── openers(devs, inos): macOS, Linux ───────────────────────────────────

#ifndef _WIN32
typedef struct {
  uint64_t *devs, *inos;
  uint32_t count;
  char *held;
  int failed;  // the scan could not be completed: every answer is "held"
} Wanted;

static void note(Wanted *wanted, uint64_t dev, uint64_t ino) {
  for (uint32_t i = 0; i < wanted->count; i++) {
#ifdef __APPLE__
    // vst_dev is 32 bits; Node's dev_t may be sign-extended
    if ((uint32_t)wanted->devs[i] == (uint32_t)dev && wanted->inos[i] == ino) wanted->held[i] = 1;
#else
    if (wanted->devs[i] == dev && wanted->inos[i] == ino) wanted->held[i] = 1;
#endif
  }
}

#ifdef __APPLE__
static void note_vinfo(Wanted *wanted, const struct vinfo_stat *stat) {
  if (stat->vst_ino == 0) return;
  note(wanted, (uint64_t)stat->vst_dev, (uint64_t)stat->vst_ino);
}

// libproc: for every process of this user, its working directory, root directory, and every file descriptor that is a vnode
// (a file or a directory). Any call that fails for a reason other than "that process is gone" makes the whole scan "unknown".
static void scan(Wanted *wanted) {
  pid_t *pids = NULL;
  int bytes = 0;
  size_t capacity = 0;
  for (int attempt = 0; attempt < 8; attempt++) {
    int need = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (need <= 0) { free(pids); wanted->failed = 1; return; }
    capacity = (size_t)need * 2 + 64 * sizeof(pid_t) * (size_t)(attempt + 1);
    free(pids);
    pids = malloc(capacity);
    if (!pids) { wanted->failed = 1; return; }
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)capacity);
    if (bytes <= 0) { free(pids); wanted->failed = 1; return; }
    if ((size_t)bytes < capacity) break;  // a full buffer may have been cut short: ask again with a larger one
    bytes = -1;
  }
  if (bytes < 0) { free(pids); wanted->failed = 1; return; }
  uid_t euid = geteuid(), ruid = getuid();
  for (int p = 0; p < bytes / (int)sizeof(pid_t) && !wanted->failed; p++) {
    pid_t pid = pids[p];
    if (pid <= 0 || pid == getpid()) continue;
    struct proc_bsdinfo bsd;
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof bsd);
    if (got != (int)sizeof bsd) {
      if (errno == ESRCH || errno == 0) continue;  // gone (proc_pidinfo says 0 with no error for a process that just exited)
      wanted->failed = 1;
      break;
    }
    if (bsd.pbi_status == 5 /* SZOMB: a zombie holds nothing */) continue;
    if (bsd.pbi_uid != euid && bsd.pbi_ruid != ruid) continue;  // confirmed to belong to another user: an engine of this user does not
    struct proc_vnodepathinfo paths;
    errno = 0;
    got = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof paths);
    if (got == (int)sizeof paths) {
      note_vinfo(wanted, &paths.pvi_cdir.vip_vi.vi_stat);
      note_vinfo(wanted, &paths.pvi_rdir.vip_vi.vi_stat);
    } else if (errno != ESRCH) { wanted->failed = 1; break; }
    else continue;
    struct proc_fdinfo *fds = NULL;
    int size = 0;
    size_t fds_capacity = 0;
    int listed = 0;
    for (int attempt = 0; attempt < 8; attempt++) {
      errno = 0;
      int need = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
      if (need < 0 || (need == 0 && errno != 0)) { size = -1; break; }
      if (need == 0) { size = 0; listed = 1; break; }
      fds_capacity = (size_t)need * 2 + 16 * sizeof(struct proc_fdinfo) * (size_t)(attempt + 1);
      free(fds);
      fds = malloc(fds_capacity);
      if (!fds) { size = -2; break; }
      errno = 0;
      size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)fds_capacity);
      if (size < 0 || (size == 0 && errno != 0)) { size = -1; break; }
      if ((size_t)size < fds_capacity) { listed = 1; break; }  // a full buffer may have been cut short: ask again
    }
    if (size == -2) { free(fds); wanted->failed = 1; break; }
    if (size < 0) {
      int gone = errno == ESRCH;
      free(fds);
      if (gone) continue;
      wanted->failed = 1;
      break;
    }
    if (!listed) { free(fds); wanted->failed = 1; break; }  // never got a complete list
    for (int i = 0; i < size / (int)sizeof(struct proc_fdinfo); i++) {
      if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfowithpath vnode;
      errno = 0;
      if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &vnode, sizeof vnode) != (int)sizeof vnode) {
        if (errno == ESRCH || errno == EBADF || errno == ENOENT || errno == 0) continue;  // the process or the descriptor went away
        wanted->failed = 1;
        break;
      }
      note_vinfo(wanted, &vnode.pvip.vip_vi.vi_stat);
    }
    free(fds);
  }
  free(pids);
}
#else
// Linux: /proc/<pid>/status says whose process it is; for this user's processes /proc/<pid>/cwd, /proc/<pid>/root and every
// /proc/<pid>/fd/<n> are stat()ed (stat follows the link to the open file or directory). A step that fails for a reason other than
// "that process or descriptor is gone" makes the whole scan unknown.
static int gone_error(int e) { return e == ENOENT || e == ESRCH; }

// 0: this user's process (*mine = 1) or another user's (*mine = 0); 1: gone; -1: could not tell
static int whose(long pid, int *mine) {
  char path[64];
  snprintf(path, sizeof path, "/proc/%ld/status", pid);
  FILE *status = fopen(path, "r");
  if (!status) return gone_error(errno) ? 1 : -1;
  char line[256];
  unsigned long real = 0, effective = 0;
  int found = 0;
  while (fgets(line, sizeof line, status)) {
    if (strncmp(line, "Uid:", 4) == 0) { found = sscanf(line + 4, "%lu %lu", &real, &effective) == 2; break; }
  }
  int read_error = ferror(status) ? errno : 0;
  fclose(status);
  if (!found) return (read_error && gone_error(read_error)) ? 1 : -1;
  *mine = real == (unsigned long)getuid() || effective == (unsigned long)geteuid();
  return 0;
}

static void note_path(Wanted *wanted, const char *path) {
  struct stat st;
  if (stat(path, &st) == 0) { note(wanted, (uint64_t)st.st_dev, (uint64_t)st.st_ino); return; }
  if (!gone_error(errno)) wanted->failed = 1;
}

static void scan(Wanted *wanted) {
  DIR *proc = opendir("/proc");
  if (!proc) { wanted->failed = 1; return; }
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(proc);
    if (!entry) { if (errno != 0) wanted->failed = 1; break; }
    char *end;
    long pid = strtol(entry->d_name, &end, 10);
    if (*end != '\0' || pid <= 0 || pid == (long)getpid()) continue;
    int mine = 0;
    int who = whose(pid, &mine);
    if (who < 0) { wanted->failed = 1; break; }
    if (who > 0 || !mine) continue;  // gone, or confirmed to belong to another user
    char path[96];
    snprintf(path, sizeof path, "/proc/%ld/cwd", pid);
    note_path(wanted, path);
    snprintf(path, sizeof path, "/proc/%ld/root", pid);
    note_path(wanted, path);
    char dir[64];
    snprintf(dir, sizeof dir, "/proc/%ld/fd", pid);
    DIR *fds = opendir(dir);
    if (!fds) { if (!gone_error(errno)) wanted->failed = 1; if (wanted->failed) break; continue; }
    for (;;) {
      errno = 0;
      struct dirent *fd = readdir(fds);
      if (!fd) { if (errno != 0 && !gone_error(errno)) wanted->failed = 1; break; }
      if (fd->d_name[0] == '.') continue;
      char link[512];
      snprintf(link, sizeof link, "%s/%s", dir, fd->d_name);
      note_path(wanted, link);
      if (wanted->failed) break;
    }
    closedir(fds);
    if (wanted->failed) break;
  }
  closedir(proc);
}
#endif

/** A device or inode number from a BigInt, lossless (an unsigned one, or a signed one that fits). */
static int get_id(napi_env env, napi_value value, uint64_t *out) {
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless) return 1;
  int64_t signed_value = 0;
  lossless = false;
  if (napi_get_value_bigint_int64(env, value, &signed_value, &lossless) == napi_ok && lossless) { *out = (uint64_t)signed_value; return 1; }
  return 0;
}

static napi_value find_openers(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  uint32_t count = 0, count_inos = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || napi_get_array_length(env, argv[0], &count) != napi_ok || napi_get_array_length(env, argv[1], &count_inos) != napi_ok || count != count_inos)
    return fail(env, "openers needs two arrays of the same length");
  Wanted wanted = {calloc(count + 1, sizeof(uint64_t)), calloc(count + 1, sizeof(uint64_t)), count, calloc(count + 1, 1), 0};
  if (!wanted.devs || !wanted.inos || !wanted.held) { free(wanted.devs); free(wanted.inos); free(wanted.held); return fail(env, "out of memory"); }
  for (uint32_t i = 0; i < count; i++) {
    napi_value dev, ino;
    if (napi_get_element(env, argv[0], i, &dev) != napi_ok || napi_get_element(env, argv[1], i, &ino) != napi_ok ||
        !get_id(env, dev, &wanted.devs[i]) || !get_id(env, ino, &wanted.inos[i])) {
      free(wanted.devs); free(wanted.inos); free(wanted.held);
      return fail(env, "openers needs lossless BigInt device and inode numbers");
    }
  }
  if (count > 0) scan(&wanted);
  napi_value out;
  napi_create_array_with_length(env, count, &out);
  for (uint32_t i = 0; i < count; i++) napi_set_element(env, out, i, make_bool(env, wanted.failed || wanted.held[i]));
  free(wanted.devs); free(wanted.inos); free(wanted.held);
  return out;
}
#else
static napi_value find_openers(napi_env env, napi_callback_info info) {
  (void)info;
  return fail(env, "openers is not used on Windows");
}
#endif

// ── renameNoReplace(from, to): all platforms ────────────────────────────

static napi_value rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) return fail(env, "renameNoReplace needs two paths");
#ifdef _WIN32
  size_t from_length = 0, to_length = 0;
  if (napi_get_value_string_utf16(env, argv[0], NULL, 0, &from_length) != napi_ok || napi_get_value_string_utf16(env, argv[1], NULL, 0, &to_length) != napi_ok)
    return fail(env, "a path must be a string");
  char16_t *from = malloc((from_length + 1) * sizeof(char16_t));
  char16_t *to = malloc((to_length + 1) * sizeof(char16_t));
  if (!from || !to) { free(from); free(to); return fail(env, "out of memory"); }
  napi_get_value_string_utf16(env, argv[0], from, from_length + 1, &from_length);
  napi_get_value_string_utf16(env, argv[1], to, to_length + 1, &to_length);
  // Without MOVEFILE_REPLACE_EXISTING the move fails when the name is taken: it never replaces.
  BOOL moved = MoveFileExW((LPCWSTR)from, (LPCWSTR)to, 0);
  DWORD error = GetLastError();
  free(from); free(to);
  if (moved) return make_int(env, 0);
  if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) return make_int(env, 1);
  if (error == ERROR_NOT_SAME_DEVICE || error == ERROR_CALL_NOT_IMPLEMENTED) return make_int(env, 2);
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return fail_code(env, "ENOENT", "renameNoReplace: not found");
  if (error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION) return fail_code(env, "EBUSY", "renameNoReplace: in use");
  if (error == ERROR_ACCESS_DENIED) return fail_code(env, "EACCES", "renameNoReplace: access denied");
  return fail_code(env, "EIO", "renameNoReplace failed");
#else
  char *from = get_utf8(env, argv[0]);
  if (!from) return NULL;
  char *to = get_utf8(env, argv[1]);
  if (!to) { free(from); return NULL; }
  int result = -1, error = 0;
#if defined(__linux__) && defined(SYS_renameat2)
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif
  result = (int)syscall(SYS_renameat2, AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
  error = errno;
#elif defined(__APPLE__) && defined(RENAME_EXCL)
  result = renamex_np(from, to, RENAME_EXCL);
  error = errno;
#else
  result = -1;
  error = ENOSYS;
#endif
  free(from); free(to);
  if (result == 0) return make_int(env, 0);
  if (error == EEXIST) return make_int(env, 1);
  // EINVAL: the file system does not know the no-replace flag (renameat2); ENOTSUP/ENOSYS: not available here
  if (error == EINVAL || error == ENOTSUP || error == ENOSYS) return make_int(env, 2);
  return fail_code(env, errname(error), "renameNoReplace failed");
#endif
}

// ── Windows handles ─────────────────────────────────────────────────────

#ifdef _WIN32
typedef struct {
  HANDLE handle;
  int closed;
} Held;

static void held_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Held *held = (Held *)data;
  if (!held) return;
  if (!held->closed && held->handle != INVALID_HANDLE_VALUE) CloseHandle(held->handle);
  free(held);
}

/** The Held behind an opaque external value, or NULL (with an exception pending) when it is not one or is already closed. */
static Held *held_of(napi_env env, napi_value value, int allow_closed) {
  napi_valuetype type;
  void *data = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external || napi_get_value_external(env, value, &data) != napi_ok || !data) {
    fail(env, "not a handle of this addon");
    return NULL;
  }
  Held *held = (Held *)data;
  if (held->closed && !allow_closed) { fail_code(env, "EBADF", "the handle is closed"); return NULL; }
  return held;
}

static napi_value open_file(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value argv[2];
  int32_t kind = -1;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok || napi_get_value_int32(env, argv[1], &kind) != napi_ok || kind < 0 || kind > 2)
    return fail(env, "openFile needs a path and a kind");
  char16_t *path = malloc((length + 1) * sizeof(char16_t));
  if (!path) return fail(env, "out of memory");
  napi_get_value_string_utf16(env, argv[0], path, length + 1, &length);
  DWORD share = kind == 2 ? (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) : 0;
  DWORD access = GENERIC_READ | GENERIC_WRITE | (kind == 1 ? DELETE : 0);
  HANDLE handle = CreateFileW((LPCWSTR)path, access, share, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  DWORD error = GetLastError();
  free(path);
  if (handle == INVALID_HANDLE_VALUE) {
    if (error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION) return make_null(env);  // in use
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return fail_code(env, "ENOENT", "openFile: not found");
    if (error == ERROR_ACCESS_DENIED) return fail_code(env, "EACCES", "openFile: access denied");
    char text[64];
    snprintf(text, sizeof text, "could not open (%lu)", (unsigned long)error);
    return fail_code(env, "EIO", text);
  }
  Held *held = malloc(sizeof(Held));
  if (!held) { CloseHandle(handle); return fail(env, "out of memory"); }
  held->handle = handle;
  held->closed = 0;
  napi_value external;
  if (napi_create_external(env, held, held_finalize, NULL, &external) != napi_ok) { CloseHandle(handle); free(held); return fail(env, "could not wrap the handle"); }
  return external;
}

static napi_value handle_read(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  uint32_t length = 0;
  double position = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || napi_get_value_uint32(env, argv[1], &length) != napi_ok || napi_get_value_double(env, argv[2], &position) != napi_ok || position < 0 || length > 64u * 1024u * 1024u)
    return fail(env, "handleRead needs a handle, a length and a position");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  void *data = NULL;
  napi_value buffer;
  if (napi_create_buffer(env, length, &data, &buffer) != napi_ok) return fail(env, "out of memory");
  uint32_t total = 0;
  while (total < length) {
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof overlapped);
    unsigned long long at = (unsigned long long)position + total;
    overlapped.Offset = (DWORD)(at & 0xffffffffULL);
    overlapped.OffsetHigh = (DWORD)(at >> 32);
    DWORD got = 0;
    if (!ReadFile(held->handle, (char *)data + total, length - total, &got, &overlapped)) {
      DWORD error = GetLastError();
      if (error == ERROR_HANDLE_EOF) break;
      return fail_code(env, "EIO", "read failed");
    }
    if (got == 0) break;
    total += got;
  }
  if (total < length) {
    napi_value shorter;
    void *copy = NULL;
    if (napi_create_buffer_copy(env, total, data, &copy, &shorter) != napi_ok) return fail(env, "out of memory");
    return shorter;
  }
  return buffer;
}

static napi_value handle_write(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  double position = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t length = 0;
  if (argc < 3 || napi_get_buffer_info(env, argv[1], &data, &length) != napi_ok || napi_get_value_double(env, argv[2], &position) != napi_ok || position < 0)
    return fail(env, "handleWrite needs a handle, a buffer and a position");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  size_t total = 0;
  while (total < length) {
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof overlapped);
    unsigned long long at = (unsigned long long)position + total;
    overlapped.Offset = (DWORD)(at & 0xffffffffULL);
    overlapped.OffsetHigh = (DWORD)(at >> 32);
    DWORD put = 0;
    DWORD want = (DWORD)((length - total) > 0x10000000u ? 0x10000000u : (length - total));
    if (!WriteFile(held->handle, (const char *)data + total, want, &put, &overlapped) || put == 0) return fail_code(env, "EIO", "write failed");
    total += put;
  }
  return make_null(env);
}

static napi_value handle_sync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleSync needs a handle");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  if (!FlushFileBuffers(held->handle)) return fail_code(env, "EIO", "flush failed");
  return make_null(env);
}

static napi_value handle_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleLock needs a handle");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  for (int waited = 0;; waited += LOCK_STEP_MS) {
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof overlapped);
    if (LockFileEx(held->handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &overlapped)) return make_bool(env, 1);
    DWORD error = GetLastError();
    if (error != ERROR_LOCK_VIOLATION || waited >= LOCK_WAIT_MS) return make_bool(env, 0);
    Sleep(LOCK_STEP_MS);
  }
}

static napi_value handle_mark_delete(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleMarkDelete needs a handle");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  FILE_DISPOSITION_INFO disposition = {TRUE};
  return make_bool(env, SetFileInformationByHandle(held->handle, FileDispositionInfo, &disposition, sizeof disposition));
}

static napi_value handle_id(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleId needs a handle");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  BY_HANDLE_FILE_INFORMATION data;
  if (!GetFileInformationByHandle(held->handle, &data)) return fail_code(env, "EIO", "could not identify the file");
  uint64_t index = ((uint64_t)data.nFileIndexHigh << 32) | data.nFileIndexLow;
  napi_value pair, dev, ino;
  napi_create_array_with_length(env, 2, &pair);
  napi_create_bigint_uint64(env, (uint64_t)data.dwVolumeSerialNumber, &dev);
  napi_create_bigint_uint64(env, index, &ino);
  napi_set_element(env, pair, 0, dev);
  napi_set_element(env, pair, 1, ino);
  return pair;
}

static napi_value handle_size(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleSize needs a handle");
  Held *held = held_of(env, argv[0], 0);
  if (!held) return NULL;
  LARGE_INTEGER size;
  if (!GetFileSizeEx(held->handle, &size)) return fail_code(env, "EIO", "could not size the file");
  napi_value out;
  napi_create_double(env, (double)size.QuadPart, &out);
  return out;
}

static napi_value handle_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "handleClose needs a handle");
  Held *held = held_of(env, argv[0], 1);
  if (!held) return NULL;
  if (!held->closed) {
    held->closed = 1;
    if (!CloseHandle(held->handle)) return fail_code(env, "EIO", "close failed");
  }
  return make_null(env);
}
#endif

static napi_value version(napi_env env, napi_callback_info info) {
  (void)info;
  return make_int(env, ADDON_VERSION);
}

static void add(napi_env env, napi_value exports, const char *name, napi_callback fn) {
  napi_value value;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &value) == napi_ok) napi_set_named_property(env, exports, name, value);
}

NAPI_MODULE_INIT() {
  add(env, exports, "lock", lock_file);
  add(env, exports, "openers", find_openers);
  add(env, exports, "renameNoReplace", rename_no_replace);
#ifdef _WIN32
  add(env, exports, "openFile", open_file);
  add(env, exports, "handleRead", handle_read);
  add(env, exports, "handleWrite", handle_write);
  add(env, exports, "handleSync", handle_sync);
  add(env, exports, "handleLock", handle_lock);
  add(env, exports, "handleMarkDelete", handle_mark_delete);
  add(env, exports, "handleId", handle_id);
  add(env, exports, "handleSize", handle_size);
  add(env, exports, "handleClose", handle_close);
#endif
  add(env, exports, "version", version);
  return exports;
}

#ifdef _WIN32
// The addon is loaded by whatever executable hosts Node (node.exe, the app, Electron): its napi_* imports resolve to that host.
#include <delayimp.h>
static FARPROC WINAPI host_hook(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0) return (FARPROC)GetModuleHandle(NULL);
  return NULL;
}
const PfnDliHook __pfnDliNotifyHook2 = host_hook;
#endif
