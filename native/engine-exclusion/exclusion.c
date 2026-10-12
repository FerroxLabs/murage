// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The few operating-system calls Node cannot make, which Murage needs before it changes a coding engine's own file:
//   lock(fd)                       macOS, Linux: take the same whole-file lock the engine takes (flock), waiting up to 1 s
//   processes()                    all: every process as { pid, ppid, uid, mine, start, comm, exe, argv } (macOS proc_listpids,
//                                  proc_pidpath and KERN_PROCARGS2; Linux /proc; Windows Toolhelp32, QueryFullProcessImageNameW and the
//                                  process's own command line, split as CommandLineToArgvW splits it). Murage uses it to know whether an
//                                  engine is running before it touches the engine's files (server/engine-closed.ts). A process that
//                                  cannot be read is listed with null, never left out. A list that could not be completed (a buffer that
//                                  stayed too small, a directory read that failed part way, Process32Next failing for any reason but the
//                                  end of the list) is an error, never a shorter list.
//   renameNoReplace(from, to)      all: one atomic rename that never replaces (renameat2 RENAME_NOREPLACE, renamex_np RENAME_EXCL,
//                                  MoveFileEx without REPLACE_EXISTING). 0 done, 1 the name exists, 2 not supported here.
//   writers(paths)                 macOS, Linux: which other processes have any of the files at `paths` open FOR WRITING, found by
//                                  device and inode in every process's open files (macOS proc_pidinfo PROC_PIDLISTFDS + PROC_PIDFDVNODEINFO;
//                                  Linux /proc/<pid>/fd and fdinfo): { writers: [{ pid, index }], unreadable: [{ pid, uid }] }. A process whose
//                                  open files cannot be read is listed in `unreadable`, never left out. Linux also gives the kernel's
//                                  own answer, `openForWrite` (a read lease taken and let go at once): false when no process at all has
//                                  one of the files open for writing, true when one does, null when it cannot be told. Murage asks this of a file it
//                                  has renamed to a private name (nobody can open it by name any more) just before it removes it, so
//                                  a writer that opened it before the rename is seen and nothing it writes can land in a removed file.
//   fullSync(fd)                   macOS, Linux: makes what was written to the file (or the names in a folder) durable, through the
//                                  drive's own cache on macOS (F_FULLFSYNC; plain fsync where the file system refuses it).
//   openFile / handle*             Windows: a file opened share-none (or shared, for the engine's lock) as a HANDLE that this addon
//                                  owns. Every read, write, flush, lock, delete mark and close runs here on that HANDLE. JavaScript
//                                  holds only an opaque external value and hands it back; no C runtime descriptor is ever passed
//                                  between this module and Node (they would be different runtimes).
// Nothing here reads or writes a file on POSIX: Node does that through its own descriptor (writers() on Linux opens a file read only,
// only to ask for a lease, and reads nothing). Only a process that is confirmed gone
// (ESRCH/ENOENT on that process) is left out of processes(). Built per platform by scripts/build-engine-exclusion.mjs (N-API 9).
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
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#ifndef SZOMB
#define SZOMB 5
#endif
#endif
#ifdef __linux__
#include <signal.h>
#include <sys/syscall.h>
#endif
#endif

#define ADDON_VERSION 6
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
static napi_value make_null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}
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
  // the wait is measured on the clock, not counted in steps: a loaded machine can let each 10 ms sleep run far longer
  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) return fail_code(env, errname(errno), "the clock could not be read");
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) return make_bool(env, 1);
    if (errno == EINTR) continue;
    if (errno != EWOULDBLOCK) return make_bool(env, 0);
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return make_bool(env, 0);
    long long waited = (long long)(now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
    if (waited >= LOCK_WAIT_MS) return make_bool(env, 0);
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

// ── processes(): all platforms ──────────────────────────────────────────

// One process as the object the caller reads: { pid, ppid, uid, mine, start, comm, exe, argv }.
//   uid    the user it runs as (macOS, Linux); null: Windows, or could not be told
//   comm   the name the system gives it (macOS pbi_comm, Linux /proc/<pid>/comm, Windows the executable's file name); null: could not be read
//   mine   true: this user's; false: another user's; null: could not be told
//   start  when it began, in seconds since a fixed point (the same pid with another start is another process)
//   exe    the program's full path; "" for a process with none (a zombie, a kernel thread); null: could not be read
//   argv   its arguments, in order; null: could not be read (Windows: the whole command line as the one element)
// A process that is confirmed gone is left out. A process that could not be inspected is listed with null where it could not be
// read, never left out: the caller reads a null as "cannot tell", not as "not there".
static void emit_process(napi_env env, napi_value list, uint32_t index, double pid, double ppid, int mine, double uid, double start,
                         const char *comm, const char *exe, const char *args, size_t args_len, int args_ok) {
  napi_value item, value;
  if (napi_create_object(env, &item) != napi_ok) return;
  napi_create_double(env, pid, &value); napi_set_named_property(env, item, "pid", value);
  napi_create_double(env, ppid, &value); napi_set_named_property(env, item, "ppid", value);
  if (mine < 0) napi_get_null(env, &value); else napi_get_boolean(env, mine != 0, &value);
  napi_set_named_property(env, item, "mine", value);
  if (uid < 0) napi_get_null(env, &value); else napi_create_double(env, uid, &value);
  napi_set_named_property(env, item, "uid", value);
  napi_create_double(env, start, &value); napi_set_named_property(env, item, "start", value);
  if (comm) napi_create_string_utf8(env, comm, NAPI_AUTO_LENGTH, &value); else napi_get_null(env, &value);
  napi_set_named_property(env, item, "comm", value);
  if (exe) napi_create_string_utf8(env, exe, NAPI_AUTO_LENGTH, &value); else napi_get_null(env, &value);
  napi_set_named_property(env, item, "exe", value);
  if (args_ok) {
    napi_create_array(env, &value);
    uint32_t count = 0;
    size_t at = 0;
    while (at < args_len) {
      size_t end = at;
      while (end < args_len && args[end] != '\0') end++;
      napi_value text;
      if (napi_create_string_utf8(env, args + at, end - at, &text) == napi_ok) napi_set_element(env, value, count++, text);
      at = end + 1;
    }
  } else napi_get_null(env, &value);
  napi_set_named_property(env, item, "argv", value);
  napi_set_element(env, list, index, item);
}

#if defined(__linux__)
/** A whole small file (a /proc entry) into memory the caller frees; 0 read, else the errno. */
static int read_proc_file(const char *path, char **out, size_t *length) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno;
  size_t capacity = 4096, used = 0;
  char *text = malloc(capacity);
  if (!text) { close(fd); return ENOMEM; }
  for (;;) {
    if (used == capacity) {
      if (capacity >= 64u * 1024u * 1024u) break;
      char *bigger = realloc(text, capacity * 2);
      if (!bigger) { free(text); close(fd); return ENOMEM; }
      text = bigger;
      capacity *= 2;
    }
    ssize_t got = read(fd, text + used, capacity - used);
    if (got < 0) { if (errno == EINTR) continue; int e = errno; free(text); close(fd); return e; }
    if (got == 0) break;
    used += (size_t)got;
  }
  close(fd);
  *out = text;
  *length = used;
  return 0;
}

static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  DIR *proc = opendir("/proc");
  if (!proc) return fail_code(env, "EIO", "/proc could not be read");
  napi_value list;
  napi_create_array(env, &list);
  uint32_t index = 0;
  uid_t me = getuid();
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(proc);
    if (entry == NULL) {
      // end of the directory, or a read that failed part way: only the first is a complete list
      if (errno != 0) { closedir(proc); return fail_code(env, "EIO", "the process list could not be read to its end"); }
      break;
    }
    char *end = NULL;
    long pid = strtol(entry->d_name, &end, 10);
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9' || !end || *end != '\0' || pid <= 0) continue;
    char path[64];
    struct stat st;
    snprintf(path, sizeof path, "/proc/%ld", pid);
    if (stat(path, &st) != 0) { if (errno == ENOENT || errno == ESRCH) continue; emit_process(env, list, index++, (double)pid, 0, -1, -1, 0, NULL, NULL, NULL, 0, 0); continue; }
    int mine = st.st_uid == me;
    double uid_out = (double)st.st_uid;
    snprintf(path, sizeof path, "/proc/%ld/stat", pid);
    char *stat_text = NULL;
    size_t stat_length = 0;
    int rc = read_proc_file(path, &stat_text, &stat_length);
    if (rc == ENOENT || rc == ESRCH) continue;
    long ppid = 0;
    unsigned long long started = 0;
    char state = '?';
    int parsed = 0;
    if (rc == 0) {
      char *text = realloc(stat_text, stat_length + 1);
      if (text) {
        stat_text = text;
        stat_text[stat_length] = '\0';
        char *close_paren = strrchr(stat_text, ')');
        if (close_paren && sscanf(close_paren + 1, " %c %ld %*d %*d %*d %*d %*u %*u %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %llu", &state, &ppid, &started) == 3) parsed = 1;
      }
      free(stat_text);
    }
    // the name the system gives the process (at most 15 characters), also when its program cannot be read
    char comm[64];
    const char *comm_out = NULL;
    snprintf(path, sizeof path, "/proc/%ld/comm", pid);
    {
      char *comm_text = NULL;
      size_t comm_length = 0;
      int comm_rc = read_proc_file(path, &comm_text, &comm_length);
      if (comm_rc == ENOENT || comm_rc == ESRCH) { free(comm_text); continue; }
      if (comm_rc == 0) {
        size_t n = comm_length < sizeof comm - 1 ? comm_length : sizeof comm - 1;
        memcpy(comm, comm_text, n);
        while (n > 0 && (comm[n - 1] == '\n' || comm[n - 1] == '\0')) n--;
        comm[n] = '\0';
        comm_out = comm;
        free(comm_text);
      }
    }
    if (!parsed) { emit_process(env, list, index++, (double)pid, 0, mine, uid_out, 0, comm_out, NULL, NULL, 0, 0); continue; }
    char exe[4096];
    const char *exe_out = NULL;
    snprintf(path, sizeof path, "/proc/%ld/exe", pid);
    ssize_t linked = readlink(path, exe, sizeof exe - 1);
    if (linked > 0) {
      exe[linked] = '\0';
      static const char suffix[] = " (deleted)";
      size_t suffix_length = sizeof suffix - 1;
      if ((size_t)linked > suffix_length && strcmp(exe + linked - suffix_length, suffix) == 0) exe[linked - (ssize_t)suffix_length] = '\0';
      exe_out = exe;
    } else if (state == 'Z' || (linked < 0 && errno == ENOENT)) exe_out = "";
    char *args = NULL;
    size_t args_length = 0;
    snprintf(path, sizeof path, "/proc/%ld/cmdline", pid);
    int args_rc = read_proc_file(path, &args, &args_length);
    if (args_rc == ENOENT || args_rc == ESRCH) { free(args); continue; }
    double started_seconds = (double)started / (double)(sysconf(_SC_CLK_TCK) > 0 ? sysconf(_SC_CLK_TCK) : 100);
    emit_process(env, list, index++, (double)pid, (double)ppid, mine, uid_out, started_seconds, comm_out, exe_out, args_rc == 0 ? args : NULL, args_length, args_rc == 0);
    if (args_rc == 0) free(args);
  }
  closedir(proc);
  return list;
}

#elif defined(__APPLE__)
static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) return fail_code(env, "EIO", "the process list could not be read");
  // The list can grow between asking for its size and reading it: read into a buffer, and when the answer fills the buffer, double
  // it and read again (at most six times). A buffer that stays full is an error, never a shorter list. (TEST_FORCE_SLOTS=1 starts
  // with four slots so a test exercises the growth.)
  size_t slots = getenv("TEST_FORCE_SLOTS") ? 4 : (size_t)bytes / sizeof(pid_t) + 64;
  pid_t *pids = NULL;
  int tries = 0;
  for (;;) {
    free(pids);
    pids = calloc(slots, sizeof(pid_t));
    if (!pids) return fail(env, "out of memory");
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)(slots * sizeof(pid_t)));
    if (bytes <= 0) { free(pids); return fail_code(env, "EIO", "the process list could not be read"); }
    if ((size_t)bytes < slots * sizeof(pid_t)) break;
    if (++tries > 6) { free(pids); return fail_code(env, "EIO", "the process list kept growing while it was read"); }
    slots *= 2;
  }
  size_t count = (size_t)bytes / sizeof(pid_t);
  int mib_max[2] = {CTL_KERN, KERN_ARGMAX};
  int arg_max = 0;
  size_t arg_max_size = sizeof arg_max;
  if (sysctl(mib_max, 2, &arg_max, &arg_max_size, NULL, 0) != 0 || arg_max <= 0) arg_max = 1024 * 1024;
  char *buffer = malloc((size_t)arg_max);
  if (!buffer) { free(pids); return fail(env, "out of memory"); }
  napi_value list;
  napi_create_array(env, &list);
  uint32_t index = 0;
  uid_t me = getuid();
  for (size_t i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 0) continue;
    struct proc_bsdinfo bsd;
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, PROC_PIDTBSDINFO_SIZE);
    // PROC_PIDTBSDINFO answers only for this user's processes (and root's caller); for every other user's process (launchd, the
    // system's daemons) it fails with EPERM. The kernel's process table (sysctl KERN_PROC_PID, what ps reads) gives the same fields
    // for every process to every user, so that is asked next. Only an answer that says the process is gone leaves it out.
    char comm_buffer[MAXCOMLEN + 1];
    comm_buffer[0] = '\0';
    uid_t owner = 0;
    double parent = 0, started = 0;
    int zombie = 0;
    if (got == (int)PROC_PIDTBSDINFO_SIZE) {
      owner = bsd.pbi_uid;
      parent = (double)bsd.pbi_ppid;
      memcpy(comm_buffer, bsd.pbi_comm, sizeof comm_buffer - 1);
      started = (double)bsd.pbi_start_tvsec + (double)bsd.pbi_start_tvusec / 1e6;
      zombie = bsd.pbi_status == SZOMB;
    } else {
      // PROC_PIDTBSDINFO also says ESRCH for a process that `ps` still lists (a zombie, one being created): only the kernel's process
      // table, asked next, can say a process is gone (an empty answer). So a failure here never leaves a process out on its own.
      struct kinfo_proc kinfo;
      size_t kinfo_size = sizeof kinfo;
      int kmib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
      memset(&kinfo, 0, sizeof kinfo);
      if (sysctl(kmib, 4, &kinfo, &kinfo_size, NULL, 0) != 0) { emit_process(env, list, index++, (double)pid, 0, -1, -1, 0, NULL, NULL, NULL, 0, 0); continue; }
      if (kinfo_size == 0) continue;  // the table has no such process: it is gone
      owner = kinfo.kp_eproc.e_ucred.cr_uid;
      parent = (double)kinfo.kp_eproc.e_ppid;
      memcpy(comm_buffer, kinfo.kp_proc.p_comm, sizeof comm_buffer - 1);
      started = (double)kinfo.kp_proc.p_starttime.tv_sec + (double)kinfo.kp_proc.p_starttime.tv_usec / 1e6;
      zombie = kinfo.kp_proc.p_stat == SZOMB;
    }
    comm_buffer[sizeof comm_buffer - 1] = '\0';
    int mine = owner == me;
    double uid_out = (double)owner;
    const char *comm_out = comm_buffer[0] ? comm_buffer : NULL;
    if (zombie) { emit_process(env, list, index++, (double)pid, parent, mine, uid_out, started, comm_out, "", NULL, 0, 1); continue; }
    char exe[PROC_PIDPATHINFO_MAXSIZE];
    const char *exe_out = proc_pidpath(pid, exe, sizeof exe) > 0 ? exe : NULL;
    // KERN_PROCARGS2: an int argc, the executable's path, padding NULs, then argc NUL-ended arguments (the environment follows)
    int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = (size_t)arg_max;
    const char *args = NULL;
    size_t args_length = 0;
    int args_ok = 0;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) == 0 && size > sizeof(int)) {
      int argc = 0;
      memcpy(&argc, buffer, sizeof argc);
      char *at = buffer + sizeof argc, *limit = buffer + size;
      while (at < limit && *at != '\0') at++;     // the executable's path
      while (at < limit && *at == '\0') at++;     // the padding
      char *first = at;
      int seen = 0;
      while (at < limit && seen < argc) { if (*at == '\0') seen++; at++; }
      if (seen == argc) { args = first; args_length = (size_t)(at - first); args_ok = 1; }
    }
    emit_process(env, list, index++, (double)pid, parent, mine, uid_out, started, comm_out, exe_out, args, args_length, args_ok);
  }
  free(buffer);
  free(pids);
  return list;
}

#else  /* _WIN32 */
#include <tlhelp32.h>
#include <winternl.h>
#include <shellapi.h>
typedef LONG (NTAPI *NtQueryInformationProcessFn)(HANDLE, int, PVOID, ULONG, PULONG);

/** UTF-16 to UTF-8 in memory the caller frees; NULL when it cannot be converted. */
static char *wide_to_utf8(const wchar_t *text, int length) {
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, length, NULL, 0, NULL, NULL);
  if (bytes <= 0) return length == 0 ? _strdup("") : NULL;
  char *out = malloc((size_t)bytes + 1);
  if (!out) return NULL;
  if (WideCharToMultiByte(CP_UTF8, 0, text, length, out, bytes, NULL, NULL) != bytes) { free(out); return NULL; }
  out[bytes] = '\0';
  return out;
}

static PTOKEN_USER user_of_token(HANDLE token) {
  DWORD need = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &need);
  if (need == 0) return NULL;
  PTOKEN_USER user = malloc(need);
  if (!user) return NULL;
  if (!GetTokenInformation(token, TokenUser, user, need, &need)) { free(user); return NULL; }
  return user;
}

/** A command line split into its arguments the way CommandLineToArgvW splits it (quotes, backslashes before quotes, a path with
 * spaces), as UTF-8 arguments each ended by a NUL, in memory the caller frees. NULL when it cannot be split. `line` must be NUL-ended. */
static char *split_command_line(const wchar_t *line, size_t *out_length) {
  int argc = 0;
  LPWSTR *parts = CommandLineToArgvW(line, &argc);
  if (!parts) return NULL;
  char **converted = calloc((size_t)(argc > 0 ? argc : 1), sizeof(char *));
  if (!converted) { LocalFree(parts); return NULL; }
  size_t total = 0;
  int ok = 1;
  for (int i = 0; i < argc && ok; i++) {
    converted[i] = wide_to_utf8(parts[i], (int)wcslen(parts[i]));
    if (!converted[i]) ok = 0; else total += strlen(converted[i]) + 1;
  }
  char *out = ok ? malloc(total + 1) : NULL;
  if (out) {
    size_t at = 0;
    for (int i = 0; i < argc; i++) { size_t n = strlen(converted[i]) + 1; memcpy(out + at, converted[i], n); at += n; }
    out[at] = '\0';
    *out_length = total;
  }
  for (int i = 0; i < argc; i++) free(converted[i]);
  free(converted);
  LocalFree(parts);
  return out;
}

static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return fail_code(env, "EIO", "the process list could not be read");
  NtQueryInformationProcessFn query = (NtQueryInformationProcessFn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  PTOKEN_USER own = NULL;
  HANDLE own_token = NULL;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &own_token)) { own = user_of_token(own_token); CloseHandle(own_token); }
  napi_value list;
  napi_create_array(env, &list);
  uint32_t index = 0;
  PROCESSENTRY32W entry;
  entry.dwSize = sizeof entry;
  BOOL more = Process32FirstW(snapshot, &entry);
  if (!more) { CloseHandle(snapshot); free(own); return fail_code(env, "EIO", "the process list could not be read"); }
  while (more) {
    DWORD pid = entry.th32ProcessID;
    if (pid != 0) {
      int mine = -1;
      double started = 0;
      char *exe = NULL;
      char *command = NULL;
      size_t command_length = 0;
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
      int full_access = process != NULL;
      if (!process) process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (process) {
        wchar_t path[32768];
        DWORD size = (DWORD)(sizeof path / sizeof path[0]);
        if (QueryFullProcessImageNameW(process, 0, path, &size)) exe = wide_to_utf8(path, (int)size);
        HANDLE token = NULL;
        if (own && OpenProcessToken(process, TOKEN_QUERY, &token)) {
          PTOKEN_USER user = user_of_token(token);
          if (user) { mine = EqualSid(user->User.Sid, own->User.Sid) ? 1 : 0; free(user); }
          CloseHandle(token);
        }
        FILETIME created, exited, kernel, user_time;
        if (GetProcessTimes(process, &created, &exited, &kernel, &user_time)) {
          ULARGE_INTEGER ticks;
          ticks.LowPart = created.dwLowDateTime;
          ticks.HighPart = created.dwHighDateTime;
          started = (double)ticks.QuadPart / 1e7;
        }
        // The command line is in the process's own memory (its PEB). A 32-bit process on 64-bit Windows keeps it elsewhere: not read.
        BOOL wow = FALSE;
        if (full_access && query && exe && IsWow64Process(process, &wow) && !wow) {
          PROCESS_BASIC_INFORMATION basic;
          ULONG returned = 0;
          if (query(process, 0, &basic, sizeof basic, &returned) == 0 && basic.PebBaseAddress) {
            PEB peb;
            RTL_USER_PROCESS_PARAMETERS parameters;
            SIZE_T read = 0;
            if (ReadProcessMemory(process, basic.PebBaseAddress, &peb, sizeof peb, &read) && read == sizeof peb && peb.ProcessParameters &&
                ReadProcessMemory(process, peb.ProcessParameters, &parameters, sizeof parameters, &read) && read == sizeof parameters &&
                parameters.CommandLine.Length > 0 && parameters.CommandLine.Buffer) {
              USHORT bytes = parameters.CommandLine.Length;
              wchar_t *line = malloc((size_t)bytes + sizeof(wchar_t));
              if (line) {
                if (ReadProcessMemory(process, parameters.CommandLine.Buffer, line, bytes, &read) && read == bytes) {
                  line[bytes / sizeof(wchar_t)] = L'\0';
                  command = split_command_line(line, &command_length);
                }
                free(line);
              }
            }
          }
        }
        CloseHandle(process);
      }
      char *comm = wide_to_utf8(entry.szExeFile, (int)wcslen(entry.szExeFile));
      emit_process(env, list, index++, (double)pid, (double)entry.th32ParentProcessID, mine, -1, started, comm, exe, command, command_length, command != NULL);
      free(comm);
      free(exe);
      free(command);
    }
    more = Process32NextW(snapshot, &entry);
    // the end of the list is ERROR_NO_MORE_FILES; any other reason it stopped means the list is not complete
    if (!more && GetLastError() != ERROR_NO_MORE_FILES) { CloseHandle(snapshot); free(own); return fail_code(env, "EIO", "the process list could not be read to its end"); }
  }
  CloseHandle(snapshot);
  free(own);
  return list;
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

// ── writers(path), fullSync(fd): macOS, Linux ──────────────────────────

#ifndef _WIN32
static napi_value writers_result(napi_env env, napi_value writers, napi_value unreadable) {
  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "writers", writers);
  napi_set_named_property(env, out, "unreadable", unreadable);
  return out;
}

static void push_unreadable(napi_env env, napi_value list, uint32_t *count, double pid, double uid) {
  napi_value item, value;
  if (napi_create_object(env, &item) != napi_ok) return;
  napi_create_double(env, pid, &value); napi_set_named_property(env, item, "pid", value);
  if (uid < 0) napi_get_null(env, &value); else napi_create_double(env, uid, &value);
  napi_set_named_property(env, item, "uid", value);
  napi_set_element(env, list, (*count)++, item);
}

/** One writer: the process and the index (in the paths asked about) of the file it has open for writing. */
static void push_writer(napi_env env, napi_value list, uint32_t *count, double pid, uint32_t index) {
  napi_value item, value;
  if (napi_create_object(env, &item) != napi_ok) return;
  napi_create_double(env, pid, &value); napi_set_named_property(env, item, "pid", value);
  napi_create_uint32(env, index, &value); napi_set_named_property(env, item, "index", value);
  napi_set_element(env, list, (*count)++, item);
}

typedef struct { dev_t dev; ino_t ino; int present; } Target;

/** The device and inode of every path in the array argument; a path that is not there is left out (present 0). NULL (with an
 * exception pending) when the argument is not an array of strings or a path cannot be looked at for another reason. */
static Target *targets_of(napi_env env, napi_value array, uint32_t *count) {
  bool is_array = false;
  if (napi_is_array(env, array, &is_array) != napi_ok || !is_array) { fail(env, "writers needs an array of paths"); return NULL; }
  napi_get_array_length(env, array, count);
  Target *targets = calloc(*count ? *count : 1, sizeof(Target));
  if (!targets) { fail(env, "out of memory"); return NULL; }
  for (uint32_t i = 0; i < *count; i++) {
    napi_value item;
    napi_get_element(env, array, i, &item);
    char *path = get_utf8(env, item);
    if (!path) { free(targets); return NULL; }
    struct stat st;
    int rc = stat(path, &st);
    int e = errno;
    free(path);
    if (rc != 0) {
      if (e == ENOENT || e == ENOTDIR) continue;
      free(targets);
      fail_code(env, errname(e), "writers: a file could not be looked at");
      return NULL;
    }
    targets[i].dev = st.st_dev;
    targets[i].ino = st.st_ino;
    targets[i].present = 1;
  }
  return targets;
}

/** The index of the target with this device and inode, or -1. */
static long target_index(const Target *targets, uint32_t count, dev_t dev, ino_t ino) {
  for (uint32_t i = 0; i < count; i++) if (targets[i].present && targets[i].dev == dev && targets[i].ino == ino) return (long)i;
  return -1;
}

#if defined(__linux__)
/** The kernel's own answer, whatever /proc lets this user read: 0 when no open file description anywhere has any of the files at
 * `paths` open for writing, 1 when one does, -1 when it cannot be told. A read lease (F_SETLEASE F_RDLCK) is granted only while the
 * file is open for writing nowhere (inode_is_open_for_write), so it sees a writer in a process whose open files cannot be listed (one
 * made undumpable: (sd-pam), ssh-agent, gpg-agent, a keyring). The lease is released at once. Its break signal is SIGURG, which is
 * ignored by default, never SIGIO (which would end this process); and these files are under Murage's private names, which no one
 * opens. A file that is not the one looked at (`targets`), a file of another owner (no lease without CAP_LEASE), or a file system
 * without leases answers -1. */
static int kernel_write_open(napi_env env, napi_value array, const Target *targets, uint32_t count) {
  int answer = 0;
  for (uint32_t i = 0; i < count; i++) {
    if (!targets[i].present) continue;
    napi_value item;
    if (napi_get_element(env, array, i, &item) != napi_ok) return -1;
    char *path = get_utf8(env, item);
    if (!path) { napi_value ignored; napi_get_and_clear_last_exception(env, &ignored); return -1; }
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
    free(path);
    if (fd < 0) { if (errno == ENOENT) continue; return -1; }
    struct stat st;
    int same = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_dev == targets[i].dev && st.st_ino == targets[i].ino;
    int leased = same && fcntl(fd, F_SETSIG, SIGURG) == 0 ? fcntl(fd, F_SETLEASE, F_RDLCK) : -1;
    int e = errno;
    if (leased == 0) fcntl(fd, F_SETLEASE, F_UNLCK);
    close(fd);
    if (leased == 0) continue;
    if (same && (e == EAGAIN || e == EWOULDBLOCK)) answer = 1;
    else return -1;
  }
  return answer;
}

static napi_value list_writers(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "writers needs an array of paths");
  uint32_t target_count = 0;
  Target *targets = targets_of(env, argv[0], &target_count);
  if (!targets) return NULL;
  DIR *proc = opendir("/proc");
  if (!proc) { free(targets); return fail_code(env, "EIO", "/proc could not be read"); }
  napi_value writers, unreadable;
  napi_create_array(env, &writers);
  napi_create_array(env, &unreadable);
  uint32_t writer_count = 0, unreadable_count = 0;
  pid_t self = getpid();
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(proc);
    if (entry == NULL) {
      if (errno != 0) { closedir(proc); free(targets); return fail_code(env, "EIO", "the process list could not be read to its end"); }
      break;
    }
    char *end = NULL;
    long pid = strtol(entry->d_name, &end, 10);
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9' || !end || *end != '\0' || pid <= 0 || pid == (long)self) continue;
    char path[96];
    struct stat owner;
    snprintf(path, sizeof path, "/proc/%ld", pid);
    if (stat(path, &owner) != 0) { if (errno == ENOENT || errno == ESRCH) continue; push_unreadable(env, unreadable, &unreadable_count, (double)pid, -1); continue; }
    // a zombie (or a process that is exiting) holds no file any more: its state in /proc/<pid>/stat says so
    snprintf(path, sizeof path, "/proc/%ld/stat", pid);
    {
      char *stat_text = NULL;
      size_t stat_length = 0;
      int rc = read_proc_file(path, &stat_text, &stat_length);
      if (rc == ENOENT || rc == ESRCH) { free(stat_text); continue; }
      int dead = 0;
      if (rc == 0) {
        char *grown = realloc(stat_text, stat_length + 1);
        if (grown) {
          stat_text = grown;
          stat_text[stat_length] = '\0';
          char *close_paren = strrchr(stat_text, ')');
          char state = '?';
          if (close_paren && sscanf(close_paren + 1, " %c", &state) == 1) dead = state == 'Z' || state == 'X' || state == 'x';
        }
        free(stat_text);
      }
      if (dead) continue;
    }
    snprintf(path, sizeof path, "/proc/%ld/fd", pid);
    DIR *fds = opendir(path);
    if (!fds) {
      if (errno == ENOENT || errno == ESRCH) continue;
      push_unreadable(env, unreadable, &unreadable_count, (double)pid, (double)owner.st_uid);
      continue;
    }
    int failed = 0;
    struct dirent *fd_entry;
    for (;;) {
      errno = 0;
      fd_entry = readdir(fds);
      // a list that ends with ENOENT/ESRCH: the process exited while it was read (it holds nothing now)
      if (fd_entry == NULL) { if (errno != 0 && errno != ENOENT && errno != ESRCH) failed = 1; break; }
      if (fd_entry->d_name[0] < '0' || fd_entry->d_name[0] > '9') continue;
      char link[320];
      struct stat st;
      snprintf(link, sizeof link, "/proc/%ld/fd/%s", pid, fd_entry->d_name);
      if (stat(link, &st) != 0) { if (errno == ENOENT || errno == ESRCH) continue; failed = 1; continue; }
      long index = target_index(targets, target_count, st.st_dev, st.st_ino);
      if (index < 0) continue;
      // the file is open in this process: for writing unless its flags say read only (an unreadable flags line counts as writing)
      char info_path[320];
      snprintf(info_path, sizeof info_path, "/proc/%ld/fdinfo/%s", pid, fd_entry->d_name);
      char *text = NULL;
      size_t length = 0;
      int rc = read_proc_file(info_path, &text, &length);
      if (rc == ENOENT || rc == ESRCH) { free(text); continue; }
      int writes = 1;
      if (rc == 0) {
        char *grown = realloc(text, length + 1);
        if (grown) {
          text = grown;
          text[length] = '\0';
          char *flags = strstr(text, "flags:");
          unsigned long value = 0;
          if (flags && sscanf(flags + 6, " %lo", &value) == 1) writes = (value & O_ACCMODE) != O_RDONLY;
        }
        free(text);
      }
      if (writes) push_writer(env, writers, &writer_count, (double)pid, (uint32_t)index);
    }
    closedir(fds);
    if (failed) push_unreadable(env, unreadable, &unreadable_count, (double)pid, (double)owner.st_uid);
  }
  closedir(proc);
  int kernel = kernel_write_open(env, argv[0], targets, target_count);
  free(targets);
  napi_value out = writers_result(env, writers, unreadable);
  napi_value open_for_write;
  if (kernel < 0) napi_get_null(env, &open_for_write); else napi_get_boolean(env, kernel == 1, &open_for_write);
  napi_set_named_property(env, out, "openForWrite", open_for_write);
  return out;
}
#elif defined(__APPLE__)
#ifndef FWRITE
#define FWRITE 0x0002
#endif
/** The user a process runs as, from the kernel's process table (readable for every process); -1 when it cannot be read. */
static double uid_of_pid(pid_t pid) {
  struct kinfo_proc kinfo;
  size_t kinfo_size = sizeof kinfo;
  int kmib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  memset(&kinfo, 0, sizeof kinfo);
  if (sysctl(kmib, 4, &kinfo, &kinfo_size, NULL, 0) != 0 || kinfo_size == 0) return -1;
  return (double)kinfo.kp_eproc.e_ucred.cr_uid;
}

static napi_value list_writers(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "writers needs an array of paths");
  uint32_t target_count = 0;
  Target *targets = targets_of(env, argv[0], &target_count);
  if (!targets) return NULL;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) { free(targets); return fail_code(env, "EIO", "the process list could not be read"); }
  size_t slots = (size_t)bytes / sizeof(pid_t) + 64;
  pid_t *pids = NULL;
  int tries = 0;
  for (;;) {
    free(pids);
    pids = calloc(slots, sizeof(pid_t));
    if (!pids) { free(targets); return fail(env, "out of memory"); }
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)(slots * sizeof(pid_t)));
    if (bytes <= 0) { free(pids); free(targets); return fail_code(env, "EIO", "the process list could not be read"); }
    if ((size_t)bytes < slots * sizeof(pid_t)) break;
    if (++tries > 6) { free(pids); free(targets); return fail_code(env, "EIO", "the process list kept growing while it was read"); }
    slots *= 2;
  }
  size_t count = (size_t)bytes / sizeof(pid_t);
  napi_value writers, unreadable;
  napi_create_array(env, &writers);
  napi_create_array(env, &unreadable);
  uint32_t writer_count = 0, unreadable_count = 0;
  pid_t self = getpid();
  for (size_t i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 0 || pid == self) continue;
    errno = 0;
    int need = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (need <= 0) {
      int e = errno;
      // no open files at all; or gone; or a zombie or a process being made (no file table): none of them can write to the file
      if (need == 0 && e == 0) continue;
      if (e == ESRCH || e == ENOENT) continue;
      push_unreadable(env, unreadable, &unreadable_count, (double)pid, uid_of_pid(pid));
      continue;
    }
    // the table can grow between the two calls: room for twice as many, and a full answer is read again (at most four times)
    size_t room = (size_t)need * 2 + sizeof(struct proc_fdinfo) * 16;
    struct proc_fdinfo *fds = NULL;
    int got = 0, ok = 0;
    for (int attempt = 0; attempt < 4; attempt++) {
      free(fds);
      fds = malloc(room);
      if (!fds) break;
      errno = 0;
      got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)room);
      if (got <= 0) break;
      if ((size_t)got < room) { ok = 1; break; }
      room *= 2;
    }
    if (!ok) {
      int e = errno;
      free(fds);
      if (got <= 0 && (e == ESRCH || e == ENOENT)) continue;
      push_unreadable(env, unreadable, &unreadable_count, (double)pid, uid_of_pid(pid));
      continue;
    }
    int failed = 0;
    size_t listed = (size_t)got / sizeof(struct proc_fdinfo);
    for (size_t at = 0; at < listed; at++) {
      if (fds[at].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfo vnode;
      memset(&vnode, 0, sizeof vnode);
      errno = 0;
      int size = proc_pidfdinfo(pid, fds[at].proc_fd, PROC_PIDFDVNODEINFO, &vnode, sizeof vnode);
      if (size != (int)sizeof vnode) {
        if (errno == EBADF || errno == ESRCH || errno == ENOENT) continue;  // closed meanwhile, or the process is gone
        failed = 1;
        continue;
      }
      long index = target_index(targets, target_count, (dev_t)vnode.pvi.vi_stat.vst_dev, (ino_t)vnode.pvi.vi_stat.vst_ino);
      if (index >= 0 && (vnode.pfi.fi_openflags & FWRITE)) push_writer(env, writers, &writer_count, (double)pid, (uint32_t)index);
    }
    free(fds);
    if (failed) push_unreadable(env, unreadable, &unreadable_count, (double)pid, uid_of_pid(pid));
  }
  free(pids);
  free(targets);
  return writers_result(env, writers, unreadable);
}
#endif

static napi_value full_sync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd = -1;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return fail(env, "fullSync needs a file descriptor");
#if defined(__APPLE__)
  if (fcntl(fd, F_FULLFSYNC) == 0) return make_null(env);
  if (errno != ENOTSUP && errno != EINVAL && errno != ENOTTY) return fail_code(env, errname(errno), "fullSync failed");
#endif
  for (;;) {
    if (fsync(fd) == 0) return make_null(env);
    if (errno != EINTR) return fail_code(env, errname(errno), "fullSync failed");
  }
}
#endif

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
  if (argc < 2 || napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok || napi_get_value_int32(env, argv[1], &kind) != napi_ok || kind < 0 || kind > 3)
    return fail(env, "openFile needs a path and a kind");
  char16_t *path = malloc((length + 1) * sizeof(char16_t));
  if (!path) return fail(env, "out of memory");
  napi_get_value_string_utf16(env, argv[0], path, length + 1, &length);
  // kind 0 share-none, 1 share-none with the right to delete, 2 shared (for the engine's lock), 3 shared and read only (to look at
  // the engine's lock without asking to write: a file the owner made read only can still be looked at)
  DWORD share = kind >= 2 ? (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) : 0;
  DWORD access = kind == 3 ? GENERIC_READ : (GENERIC_READ | GENERIC_WRITE | (kind == 1 ? DELETE : 0));
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
  // ONE write: it returns how many bytes it put, and the caller asks its guard again before it writes the rest
  if (length == 0) return make_int(env, 0);
  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  unsigned long long at = (unsigned long long)position;
  overlapped.Offset = (DWORD)(at & 0xffffffffULL);
  overlapped.OffsetHigh = (DWORD)(at >> 32);
  DWORD put = 0;
  DWORD want = (DWORD)(length > 0x10000000u ? 0x10000000u : length);
  if (!WriteFile(held->handle, (const char *)data, want, &put, &overlapped) || put == 0) return fail_code(env, "EIO", "write failed");
  return make_int(env, (int32_t)put);
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
  add(env, exports, "processes", list_processes);
  add(env, exports, "renameNoReplace", rename_no_replace);
#ifndef _WIN32
  add(env, exports, "writers", list_writers);
  add(env, exports, "fullSync", full_sync);
#endif
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
