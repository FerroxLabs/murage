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
//                                  drive's own cache on macOS (F_FULLFSYNC), and says which barrier it was: "full" (F_FULLFSYNC done;
//                                  Linux fsync, which flushes the drive's cache itself) or "fallback" (macOS: the file system refuses
//                                  F_FULLFSYNC with ENOTSUP, EINVAL or ENOTTY, as Apple documents for file systems without it, and
//                                  plain fsync was done instead). Any other failure throws. Version 7.
//   openFile / handle*             Windows: a file opened share-none (or shared, for the engine's lock) as a HANDLE that this addon
//                                  owns. Every read, write, flush, lock, delete mark and close runs here on that HANDLE. JavaScript
//                                  holds only an opaque external value and hands it back; no C runtime descriptor is ever passed
//                                  between this module and Node (they would be different runtimes).
//   removeTree(path, beforeFolder?) Windows: removes `path` and everything under it by handle, never by path: only the top is opened
//                                  by name, as itself; each folder is listed through its own handle, each entry opened relative to
//                                  it with FILE_OPEN_REPARSE_POINT, judged on that handle, and deleted through it (POSIX semantics,
//                                  read-only ignored). A symlink or junction (any name-surrogate reparse point) is deleted as a link,
//                                  never followed, so a folder swapped for a junction mid-walk cannot send the walk anywhere. true
//                                  removed, false nothing there; a failure throws with a Node errno name as `code`. beforeFolder(rel)
//                                  (tests) runs after each folder is opened and before it is listed.
//   authenticode(path)             Windows: a Promise of { status, publisher, code } for the file's Authenticode signature, from
//                                  WinVerifyTrust (WINTRUST_ACTION_GENERIC_VERIFY_V2, no revocation check, as Get-AuthenticodeSignature
//                                  does), on a worker thread. `status` uses Get-AuthenticodeSignature's names (Valid, NotSigned,
//                                  HashMismatch, NotTrusted, UnknownError); `publisher` is the signer certificate's simple name when
//                                  Valid, else ""; `code` is WinVerifyTrust's own result. Murage checks its own signed files with it,
//                                  so opening Murage starts no PowerShell (murage-releases #1).
//   jobCreate / jobAssign / jobClose / jobStop, processStart, driveInfo, fileOwnerSid, accountSid, machineSid, speechVoices,
//   speechToWave                   Windows (version 8): the calls that replaced every PowerShell Murage used to start itself: the
//                                  memory-maintenance job object, a process's exact creation time, a folder's drive type and format,
//                                  a file's owner SID and account-name lookups, and SAPI speech. Each is described where it is defined.
//   domainSids                     Windows (version 9): this computer's account, joined and forest-root domain SIDs (LSA policy), for
//                                  the SDDL domain aliases. Version 9 also ends a process jobAssign cannot open.
//   cwdOf(pid)                     Windows (DELETION-WHILE-OPEN-107): another process's working folder, read from its PEB
//                                  (ProcessParameters->CurrentDirectory.DosPath); null when it cannot be read. Optional: an older
//                                  build without it only means the open-home pass does not run there (it fails closed).
//   dropShutdownPrivileges         Windows (version 10): removes both shutdown privileges from this process's primary token and
//                                  verifies they are absent. Returns { ok: true } or { ok: false, step, error }.
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

#define ADDON_VERSION 10
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
#else
static napi_value make_text(napi_env env, const char *text) {
  napi_value value;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  return value;
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
  // the wait is measured on the clock, not counted in steps: a loaded machine can let each 10 ms sleep run far longer
  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) return fail_code(env, errname(errno), "the clock could not be read");
  // a signal (EINTR, from the lock call or the sleep) is retried, but only within the same deadline: nothing waits longer than
  // LOCK_WAIT_MS of wall clock, and no attempt is made once the deadline has passed (a sleep that ran long is not followed by one)
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) return make_bool(env, 1);
    if (errno != EINTR && errno != EWOULDBLOCK) return make_bool(env, 0);
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return make_bool(env, 0);
    long long waited = (long long)(now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
    if (waited >= LOCK_WAIT_MS) return make_bool(env, 0);
    long long left = LOCK_WAIT_MS - waited;
    long long nap = left < LOCK_STEP_MS ? left : LOCK_STEP_MS;
    struct timespec step = {0, (long)(nap * 1000000L)};
    nanosleep(&step, NULL);  // an interrupted sleep is simply shorter; the clock above decides
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return make_bool(env, 0);
    waited = (long long)(now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
    if (waited > LOCK_WAIT_MS) return make_bool(env, 0);
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
      int ended = 0;
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
          // An ended process stays in the list while any handle to it is open (its parent's, until the parent's loop closes it): its
          // memory is gone, so its command line can never be read. It runs nothing and writes nothing: reported as a process with no
          // program, as a zombie is on macOS and Linux, never as one whose arguments could not be read.
          DWORD code = 0;
          ended = (exited.dwLowDateTime != 0 || exited.dwHighDateTime != 0) && GetExitCodeProcess(process, &code) && code != STILL_ACTIVE;
        }
        // The command line is in the process's own memory (its PEB). A 32-bit process on 64-bit Windows keeps it elsewhere: not read.
        BOOL wow = FALSE;
        if (!ended && full_access && query && exe && IsWow64Process(process, &wow) && !wow) {
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
      if (ended) emit_process(env, list, index++, (double)pid, (double)entry.th32ParentProcessID, mine, -1, started, comm, "", NULL, 0, 1);
      else emit_process(env, list, index++, (double)pid, (double)entry.th32ParentProcessID, mine, -1, started, comm, exe, command, command_length, command != NULL);
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

// ── environment(pid, names): all platforms ──────────────────────────────
//
// The values of a few named variables in another process's environment, only the ones it has, as { name: value }; null when the
// environment cannot be read (the process is gone, another user's or protected; on Windows a 32-bit process on 64-bit Windows).
// Murage asks it only of a process that is an engine, and only for the variables that decide the engine's home (engine-closed.ts
// homeScope): nothing else of the process's environment is copied out. macOS: KERN_PROCARGS2 (the environment follows the
// arguments); Linux: /proc/<pid>/environ; Windows: the block ProcessParameters->Environment points to in the process's PEB, read
// page by page up to its double NUL, with names matched in any case.
#define ENVIRONMENT_NAMES_MAX 32
#define ENVIRONMENT_BLOCK_MAX (1024 * 1024)

/** The names asked for, as UTF-8 strings the caller frees with free_names; -1 when the argument is not an array of strings. */
static int read_names(napi_env env, napi_value value, char **names) {
  bool is_array = false;
  uint32_t count = 0;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array || napi_get_array_length(env, value, &count) != napi_ok || count > ENVIRONMENT_NAMES_MAX) return -1;
  for (uint32_t i = 0; i < count; i++) {
    napi_value item;
    napi_valuetype type;
    names[i] = NULL;
    if (napi_get_element(env, value, i, &item) != napi_ok || napi_typeof(env, item, &type) != napi_ok || type != napi_string) { for (uint32_t j = 0; j < i; j++) free(names[j]); return -1; }
    size_t length = 0, copied = 0;
    napi_get_value_string_utf8(env, item, NULL, 0, &length);
    names[i] = malloc(length + 1);
    if (!names[i] || napi_get_value_string_utf8(env, item, names[i], length + 1, &copied) != napi_ok) { for (uint32_t j = 0; j <= i; j++) free(names[j]); return -1; }
    names[i][copied] = '\0';
  }
  return (int)count;
}

static void free_names(char **names, int count) { for (int i = 0; i < count; i++) free(names[i]); }

#ifndef _WIN32
/** Picks the asked-for names out of NUL-ended "NAME=value" entries (exact names), into `out`. */
static void pick_entries(napi_env env, const char *block, size_t length, char **names, int count, napi_value out) {
  size_t at = 0;
  while (at < length) {
    const char *entry = block + at;
    size_t left = length - at, n = 0;
    while (n < left && entry[n] != '\0') n++;
    if (n == 0) break;  // an empty string ends the environment (macOS: the system's own strings follow it)
    const char *equals = memchr(entry, '=', n);
    if (equals && equals != entry) {
      size_t key = (size_t)(equals - entry);
      for (int i = 0; i < count; i++) {
        if (strlen(names[i]) == key && memcmp(names[i], entry, key) == 0) {
          napi_value text;
          if (napi_create_string_utf8(env, equals + 1, n - key - 1, &text) == napi_ok) napi_set_named_property(env, out, names[i], text);
          break;
        }
      }
    }
    at += n + 1;
  }
}
#endif

static napi_value environment_of(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  uint32_t pid = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) return fail(env, "environment needs a pid and names");
  char *names[ENVIRONMENT_NAMES_MAX];
  int count = read_names(env, argv[1], names);
  if (count < 0) return fail(env, "environment needs an array of at most 32 names");
  napi_value out;
  napi_create_object(env, &out);
  int ok = 0;
#if defined(__linux__)
  char path[64];
  snprintf(path, sizeof path, "/proc/%lu/environ", (unsigned long)pid);
  char *block = NULL;
  size_t length = 0;
  if (read_proc_file(path, &block, &length) == 0) { pick_entries(env, block, length, names, count, out); ok = 1; }
  free(block);
#elif defined(__APPLE__)
  int mib_max[2] = {CTL_KERN, KERN_ARGMAX};
  int arg_max = 0;
  size_t arg_max_size = sizeof arg_max;
  if (sysctl(mib_max, 2, &arg_max, &arg_max_size, NULL, 0) != 0 || arg_max <= 0) arg_max = 1024 * 1024;
  char *buffer = malloc((size_t)arg_max);
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, (int)pid};
  size_t size = (size_t)arg_max;
  if (buffer && sysctl(mib, 3, buffer, &size, NULL, 0) == 0 && size > sizeof(int)) {
    // an int argc, the executable's path, padding NULs, argc NUL-ended arguments, then the environment
    int args = 0;
    memcpy(&args, buffer, sizeof args);
    char *at = buffer + sizeof args, *limit = buffer + size;
    while (at < limit && *at != '\0') at++;
    while (at < limit && *at == '\0') at++;
    int seen = 0;
    while (at < limit && seen < args) { if (*at == '\0') seen++; at++; }
    if (seen == args) { pick_entries(env, at, (size_t)(limit - at), names, count, out); ok = 1; }
  }
  free(buffer);
#else
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  NtQueryInformationProcessFn query = (NtQueryInformationProcessFn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  BOOL wow = TRUE;
  if (process && query && IsWow64Process(process, &wow) && !wow) {
    PROCESS_BASIC_INFORMATION basic;
    ULONG returned = 0;
    PEB peb;
    // <winternl.h> declares RTL_USER_PROCESS_PARAMETERS only up to CommandLine; Environment is the pointer right after it
    struct { RTL_USER_PROCESS_PARAMETERS head; PVOID environment; } parameters;
    SIZE_T read = 0;
    if (query(process, 0, &basic, sizeof basic, &returned) == 0 && basic.PebBaseAddress &&
        ReadProcessMemory(process, basic.PebBaseAddress, &peb, sizeof peb, &read) && read == sizeof peb && peb.ProcessParameters &&
        ReadProcessMemory(process, peb.ProcessParameters, &parameters, sizeof parameters, &read) && read == sizeof parameters && parameters.environment) {
      wchar_t *block = malloc(ENVIRONMENT_BLOCK_MAX + 2 * sizeof(wchar_t));
      size_t got = 0, units = 0, end = (size_t)-1;
      uintptr_t address = (uintptr_t)parameters.environment;
      // one page at a time: a read that crosses into a page the process does not have fails as a whole
      while (block && end == (size_t)-1 && got < ENVIRONMENT_BLOCK_MAX) {
        size_t step = 4096 - (size_t)(address % 4096);
        if (step > ENVIRONMENT_BLOCK_MAX - got) step = ENVIRONMENT_BLOCK_MAX - got;
        if (!ReadProcessMemory(process, (LPCVOID)address, (char *)block + got, step, &read) || read != step) break;
        got += step;
        address += step;
        size_t now = got / sizeof(wchar_t);
        for (size_t i = units > 0 ? units - 1 : 0; i + 1 < now; i++) if (block[i] == L'\0' && block[i + 1] == L'\0') { end = i; break; }
        units = now;
      }
      if (block && end != (size_t)-1) {
        ok = 1;
        wchar_t *wide[ENVIRONMENT_NAMES_MAX];
        for (int i = 0; i < count; i++) {
          int need = MultiByteToWideChar(CP_UTF8, 0, names[i], -1, NULL, 0);
          wide[i] = need > 0 ? malloc((size_t)need * sizeof(wchar_t)) : NULL;
          if (wide[i] && MultiByteToWideChar(CP_UTF8, 0, names[i], -1, wide[i], need) != need) { free(wide[i]); wide[i] = NULL; }
        }
        size_t at = 0;
        while (at < end + 1 && block[at] != L'\0') {
          const wchar_t *entry = block + at;
          size_t n = wcslen(entry);
          // "=C:=C:\..." entries start with "=": the name is never empty
          const wchar_t *equals = n > 1 ? wcschr(entry + 1, L'=') : NULL;
          if (equals) {
            int key = (int)(equals - entry);
            for (int i = 0; i < count; i++) {
              if (wide[i] && CompareStringOrdinal(entry, key, wide[i], -1, TRUE) == CSTR_EQUAL) {
                char *value = wide_to_utf8(equals + 1, (int)(n - (size_t)key - 1));
                napi_value text;
                if (value && napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text) == napi_ok) napi_set_named_property(env, out, names[i], text);
                free(value);
                break;
              }
            }
          }
          at += n + 1;
        }
        for (int i = 0; i < count; i++) free(wide[i]);
      }
      free(block);
    }
  }
  if (process) CloseHandle(process);
#endif
  free_names(names, count);
  if (!ok) napi_get_null(env, &out);
  return out;
}

#ifdef _WIN32
// ── cwdOf(pid): Windows ─────────────────────────────────────────────────
//
// DELETION-WHILE-OPEN-107: the working folder of another process, as Windows keeps it in the process's own memory:
// RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath. <winternl.h> declares that block only as Reserved2[10] before ImagePathName:
// ConsoleHandle, ConsoleFlags, StandardInput, StandardOutput, StandardError, then CurrentDirectory (a UNICODE_STRING, the size of two
// pointers on both 32- and 64-bit Windows), so DosPath is Reserved2[5]. null when it cannot be read: the process is gone, another
// user's or protected, a 32-bit process on 64-bit Windows, or any read that fails. Murage asks it only of the processes on an engine
// home whose conversation is being deleted (engine-closed.ts holdersClearOf); a null keeps that home for the closed-engine pass.
static napi_value cwd_of(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t pid = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) return fail(env, "cwdOf needs a pid");
  napi_value out;
  napi_get_null(env, &out);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  NtQueryInformationProcessFn query = (NtQueryInformationProcessFn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  BOOL wow = TRUE;
  if (process && query && IsWow64Process(process, &wow) && !wow) {
    PROCESS_BASIC_INFORMATION basic;
    ULONG returned = 0;
    PEB peb;
    RTL_USER_PROCESS_PARAMETERS parameters;
    SIZE_T read = 0;
    if (query(process, 0, &basic, sizeof basic, &returned) == 0 && basic.PebBaseAddress &&
        ReadProcessMemory(process, basic.PebBaseAddress, &peb, sizeof peb, &read) && read == sizeof peb && peb.ProcessParameters &&
        ReadProcessMemory(process, peb.ProcessParameters, &parameters, sizeof parameters, &read) && read == sizeof parameters) {
      UNICODE_STRING dos;
      memcpy(&dos, &parameters.Reserved2[5], sizeof dos);
      if (dos.Buffer && dos.Length > 0 && dos.Length % sizeof(wchar_t) == 0 && dos.Length <= dos.MaximumLength) {
        wchar_t *path = malloc((size_t)dos.Length + sizeof(wchar_t));
        if (path && ReadProcessMemory(process, dos.Buffer, path, dos.Length, &read) && read == dos.Length) {
          char *text = wide_to_utf8(path, (int)(dos.Length / sizeof(wchar_t)));
          if (text && text[0]) napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out);
          free(text);
        }
        free(path);
      }
    }
  }
  if (process) CloseHandle(process);
  return out;
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
 * without leases cannot be told. One file found open for writing is the answer for the whole set (1), whatever the others answer;
 * otherwise any file that cannot be told makes the set -1. */
static int kernel_write_open(napi_env env, napi_value array, const Target *targets, uint32_t count) {
  int answer = 0;
  for (uint32_t i = 0; i < count; i++) {
    if (!targets[i].present) continue;
    napi_value item;
    if (napi_get_element(env, array, i, &item) != napi_ok) { if (answer == 0) answer = -1; continue; }
    char *path = get_utf8(env, item);
    if (!path) { napi_value ignored; napi_get_and_clear_last_exception(env, &ignored); if (answer == 0) answer = -1; continue; }
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
    free(path);
    if (fd < 0) { if (errno != ENOENT && answer == 0) answer = -1; continue; }
    struct stat st;
    int same = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_dev == targets[i].dev && st.st_ino == targets[i].ino;
    int leased = same && fcntl(fd, F_SETSIG, SIGURG) == 0 ? fcntl(fd, F_SETLEASE, F_RDLCK) : -1;
    int e = errno;
    if (leased == 0) fcntl(fd, F_SETLEASE, F_UNLCK);
    close(fd);
    if (leased == 0) continue;
    if (same && (e == EAGAIN || e == EWOULDBLOCK)) return 1;
    answer = -1;
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
      // every file it had was closed between the two calls (an answer of no bytes and no error): a process with no open file writes nothing
      if (got == 0 && e == 0) continue;
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
  const char *barrier = "full";
#if defined(__APPLE__)
  for (;;) {
    if (fcntl(fd, F_FULLFSYNC) == 0) return make_text(env, "full");
    if (errno != EINTR) break;
  }
  if (errno != ENOTSUP && errno != EINVAL && errno != ENOTTY) return fail_code(env, errname(errno), "fullSync failed");
  barrier = "fallback";
#endif
  for (;;) {
    if (fsync(fd) == 0) return make_text(env, barrier);
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
  // the wait is measured on the clock (as on POSIX), not counted in sleeps: a loaded machine can let each sleep run far longer
  ULONGLONG start = GetTickCount64();
  for (;;) {
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof overlapped);
    if (LockFileEx(held->handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &overlapped)) return make_bool(env, 1);
    DWORD error = GetLastError();
    ULONGLONG waited = GetTickCount64() - start;
    if (error != ERROR_LOCK_VIOLATION || waited >= LOCK_WAIT_MS) return make_bool(env, 0);
    ULONGLONG left = LOCK_WAIT_MS - waited;
    Sleep((DWORD)(left < LOCK_STEP_MS ? left : LOCK_STEP_MS));
    if (GetTickCount64() - start > LOCK_WAIT_MS) return make_bool(env, 0);
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

// ── Windows: remove a tree by handle, never by path ─────────────────────
//
// Only the top is ever opened by name, as itself (FILE_FLAG_OPEN_REPARSE_POINT). Every folder is listed through its own handle;
// every entry in it is opened relative to that handle (NtCreateFile with RootDirectory and FILE_OPEN_REPARSE_POINT), what it is
// (a link, a folder, a file) is read from the opened handle, and it is deleted through that same handle. A name surrogate (a
// symlink, a junction, any reparse point that stands for another name) is deleted as the entry it is and never opened through.
// A folder renamed, or replaced by a junction, while the walk runs is still the folder the walk holds open: the walk keeps
// removing what it opened, wherever it now is, and a junction put in its place is a new entry, removed as a link.
#define TREE_FILE_OPEN 0x00000001
#define TREE_SYNCHRONOUS_IO_NONALERT 0x00000020
#define TREE_OPEN_FOR_BACKUP_INTENT 0x00004000
#define TREE_OPEN_REPARSE_POINT 0x00200000
#define TREE_STATUS_ACCESS_DENIED ((LONG)0xC0000022)
#define TREE_STATUS_OBJECT_NAME_NOT_FOUND ((LONG)0xC0000034)
#define TREE_STATUS_OBJECT_PATH_NOT_FOUND ((LONG)0xC000003A)
#define TREE_STATUS_DELETE_PENDING ((LONG)0xC0000056)
#define TREE_DISPOSITION_INFO_EX ((FILE_INFO_BY_HANDLE_CLASS)21)  /* FileDispositionInfoEx, Windows 10 1607 and later */
#define TREE_DISPOSE_DELETE 0x00000001
#define TREE_DISPOSE_POSIX 0x00000002
#define TREE_DISPOSE_IGNORE_READONLY 0x00000010
#define TREE_SETTABLE (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)
#define TREE_MAX_DEPTH 1024
#define TREE_LIST_BYTES (64 * 1024)
#define TREE_ACCESS_FULL (DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | FILE_LIST_DIRECTORY)
#define TREE_ACCESS_LEAST (DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES)
typedef LONG (NTAPI *NtCreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG (NTAPI *RtlNtStatusToDosErrorFn)(LONG);

typedef struct {
  napi_env env;
  napi_value hook;                    /* beforeFolder, or NULL */
  NtCreateFileFn create;
  RtlNtStatusToDosErrorFn to_dos;
  DWORD error;                        /* the Windows error that stopped the walk */
  const char *step;                   /* what it was doing then */
  int thrown;                         /* beforeFolder threw: its exception is pending */
  wchar_t *where;                     /* the entry's path relative to the top, for beforeFolder and the error text only: never opened */
  size_t where_length, where_size;
} TreeWalk;

static int tree_fail(TreeWalk *walk, DWORD error, const char *step) {
  walk->error = error;
  walk->step = step;
  return -1;
}

static int tree_push(TreeWalk *walk, const WCHAR *name, size_t chars, size_t *saved) {
  *saved = walk->where_length;
  size_t need = walk->where_length + 1 + chars + 1;
  if (need > walk->where_size) {
    size_t size = need * 2;
    wchar_t *grown = realloc(walk->where, size * sizeof(wchar_t));
    if (!grown) return tree_fail(walk, ERROR_NOT_ENOUGH_MEMORY, "remember the path");
    walk->where = grown;
    walk->where_size = size;
  }
  if (walk->where_length) walk->where[walk->where_length++] = L'\\';
  memcpy(walk->where + walk->where_length, name, chars * sizeof(wchar_t));
  walk->where_length += chars;
  walk->where[walk->where_length] = L'\0';
  return 0;
}

static void tree_pop(TreeWalk *walk, size_t saved) {
  walk->where_length = saved;
  walk->where[saved] = L'\0';
}

/** Deletes the entry `handle` is open on: POSIX semantics (the name goes at once) ignoring the read-only attribute; where the file
 * system has no POSIX delete (FAT, Windows before 10 1607), the classic one after clearing the read-only attribute on the handle. */
static int tree_delete(TreeWalk *walk, HANDLE handle, DWORD attributes) {
  struct { DWORD Flags; } posix = { TREE_DISPOSE_DELETE | TREE_DISPOSE_POSIX | TREE_DISPOSE_IGNORE_READONLY };
  if (SetFileInformationByHandle(handle, TREE_DISPOSITION_INFO_EX, &posix, sizeof posix)) return 0;
  DWORD error = GetLastError();
  if (error != ERROR_INVALID_PARAMETER && error != ERROR_NOT_SUPPORTED && error != ERROR_INVALID_FUNCTION) return tree_fail(walk, error, "delete");
  if (attributes & FILE_ATTRIBUTE_READONLY) {
    FILE_BASIC_INFO basic;
    memset(&basic, 0, sizeof basic);
    DWORD kept = attributes & TREE_SETTABLE & ~(DWORD)FILE_ATTRIBUTE_READONLY;
    basic.FileAttributes = kept ? kept : FILE_ATTRIBUTE_NORMAL;
    if (!SetFileInformationByHandle(handle, FileBasicInfo, &basic, sizeof basic)) return tree_fail(walk, GetLastError(), "clear read-only");
  }
  FILE_DISPOSITION_INFO classic = {TRUE};
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &classic, sizeof classic)) return tree_fail(walk, GetLastError(), "delete");
  return 0;
}

/** Opens `name` in the folder `folder` is open on, as itself (a link is opened, never followed). 1 opened, 0 not there, -1 error. */
static int tree_open(TreeWalk *walk, HANDLE folder, const WCHAR *name, ULONG bytes, HANDLE *out) {
  UNICODE_STRING text;
  text.Buffer = (PWSTR)name;
  text.Length = (USHORT)bytes;
  text.MaximumLength = (USHORT)bytes;
  OBJECT_ATTRIBUTES object;
  InitializeObjectAttributes(&object, &text, OBJ_CASE_INSENSITIVE, folder, NULL);
  const ACCESS_MASK tries[2] = { TREE_ACCESS_FULL, TREE_ACCESS_LEAST };
  for (int i = 0; i < 2; i++) {
    IO_STATUS_BLOCK io;
    memset(&io, 0, sizeof io);
    LONG status = walk->create(out, tries[i], &object, &io, NULL, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, TREE_FILE_OPEN,
                               TREE_OPEN_REPARSE_POINT | TREE_SYNCHRONOUS_IO_NONALERT | TREE_OPEN_FOR_BACKUP_INTENT, NULL, 0);
    if (status >= 0) return 1;
    if (status == TREE_STATUS_OBJECT_NAME_NOT_FOUND || status == TREE_STATUS_OBJECT_PATH_NOT_FOUND || status == TREE_STATUS_DELETE_PENDING) return 0;
    // without the right to list or to change attributes (a file the owner may delete but not read): delete is all it needs
    if (status == TREE_STATUS_ACCESS_DENIED && i == 0) continue;
    return tree_fail(walk, walk->to_dos(status), "open");
  }
  return tree_fail(walk, ERROR_ACCESS_DENIED, "open");
}

static int tree_remove(TreeWalk *walk, HANDLE handle, int depth);

/** Removes every entry of the folder `folder` is open on, listed through that handle. */
static int tree_empty(TreeWalk *walk, HANDLE folder, int depth) {
  char *list = malloc(TREE_LIST_BYTES);
  if (!list) return tree_fail(walk, ERROR_NOT_ENOUGH_MEMORY, "list");
  FILE_INFO_BY_HANDLE_CLASS kind = FileFullDirectoryRestartInfo;
  int result = 0;
  while (!result) {
    if (!GetFileInformationByHandleEx(folder, kind, list, TREE_LIST_BYTES)) {
      DWORD error = GetLastError();
      if (error != ERROR_NO_MORE_FILES) result = tree_fail(walk, error, "list");
      break;
    }
    kind = FileFullDirectoryInfo;
    for (FILE_FULL_DIR_INFO *entry = (FILE_FULL_DIR_INFO *)list; ; entry = (FILE_FULL_DIR_INFO *)((char *)entry + entry->NextEntryOffset)) {
      size_t chars = entry->FileNameLength / sizeof(WCHAR);
      int dots = (chars == 1 && entry->FileName[0] == L'.') || (chars == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
      if (!dots) {
        size_t saved;
        if (tree_push(walk, entry->FileName, chars, &saved)) { result = -1; break; }
        HANDLE child = INVALID_HANDLE_VALUE;
        int opened = tree_open(walk, folder, entry->FileName, entry->FileNameLength, &child);
        int done = opened == 1 ? tree_remove(walk, child, depth + 1) : opened;
        if (opened == 1) CloseHandle(child);
        if (done < 0) { result = -1; break; }  /* `where` stays on the entry that failed */
        tree_pop(walk, saved);
      }
      if (!entry->NextEntryOffset) break;
    }
  }
  free(list);
  return result;
}

/** Removes the entry `handle` is open on (opened as itself): a link or a file is deleted, a folder is emptied through its handle
 * and then deleted. */
static int tree_remove(TreeWalk *walk, HANDLE handle, int depth) {
  FILE_ATTRIBUTE_TAG_INFO info;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof info)) return tree_fail(walk, GetLastError(), "read what it is");
  int link = (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && IsReparseTagNameSurrogate(info.ReparseTag);
  if (link || !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return tree_delete(walk, handle, info.FileAttributes);
  if (depth > TREE_MAX_DEPTH) return tree_fail(walk, ERROR_FILENAME_EXCED_RANGE, "go deeper");
  if (walk->hook) {
    napi_value global, text, ignored;
    if (napi_get_global(walk->env, &global) != napi_ok || napi_create_string_utf16(walk->env, (const char16_t *)walk->where, walk->where_length, &text) != napi_ok ||
        napi_call_function(walk->env, global, walk->hook, 1, &text, &ignored) != napi_ok) {
      walk->thrown = 1;
      return -1;
    }
  }
  for (int pass = 0; ; pass++) {
    if (tree_empty(walk, handle, depth)) return -1;
    if (tree_delete(walk, handle, info.FileAttributes) == 0) return 0;
    // an entry made in a place the listing had already passed: list once more
    if (walk->error != ERROR_DIR_NOT_EMPTY || pass >= 2) return -1;
  }
}

static const char *tree_code(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ACCESS_DENIED: case ERROR_PRIVILEGE_NOT_HELD: return "EPERM";
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: return "EBUSY";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    case ERROR_TOO_MANY_OPEN_FILES: return "EMFILE";
    case ERROR_WRITE_PROTECT: return "EROFS";
    case ERROR_NOT_ENOUGH_MEMORY: case ERROR_OUTOFMEMORY: return "ENOMEM";
    case ERROR_FILENAME_EXCED_RANGE: return "ENAMETOOLONG";
    default: return "EIO";
  }
}

/** The full form of `given` with the \\?\ prefix (\\?\UNC\ for a share), so MAX_PATH does not apply; NULL when it cannot be made. */
static wchar_t *tree_long_path(const wchar_t *given) {
  DWORD need = GetFullPathNameW(given, 0, NULL, NULL);
  if (!need) return NULL;
  wchar_t *full = malloc(((size_t)need + 1) * sizeof(wchar_t));
  if (!full) return NULL;
  DWORD got = GetFullPathNameW(given, need + 1, full, NULL);
  if (!got || got > need) { free(full); return NULL; }
  if (wcsncmp(full, L"\\\\?\\", 4) == 0 || wcsncmp(full, L"\\\\.\\", 4) == 0) return full;
  int share = wcsncmp(full, L"\\\\", 2) == 0;
  const wchar_t *prefix = share ? L"\\\\?\\UNC\\" : L"\\\\?\\";
  const wchar_t *rest = share ? full + 2 : full;
  size_t length = wcslen(prefix) + wcslen(rest) + 1;
  wchar_t *out = malloc(length * sizeof(wchar_t));
  if (out) { wcscpy_s(out, length, prefix); wcscat_s(out, length, rest); }
  free(full);
  return out;
}

/** True when GetFullPathNameW leaves `given` exactly as it is, so the folder opened is the one the caller named and checked. */
static int tree_path_is_full(const wchar_t *given) {
  DWORD need = GetFullPathNameW(given, 0, NULL, NULL);
  if (!need) return 0;
  wchar_t *full = malloc(((size_t)need + 1) * sizeof(wchar_t));
  if (!full) return 0;
  DWORD got = GetFullPathNameW(given, need + 1, full, NULL);
  int same = got && got <= need && wcscmp(full, given) == 0;
  free(full);
  return same;
}

static napi_value remove_tree(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype hook_type = napi_undefined;
  if (argc >= 2) napi_typeof(env, argv[1], &hook_type);
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 ||
      (hook_type != napi_undefined && hook_type != napi_null && hook_type != napi_function))
    return fail(env, "removeTree needs a path");
  TreeWalk walk;
  memset(&walk, 0, sizeof walk);
  walk.env = env;
  walk.hook = hook_type == napi_function ? argv[1] : NULL;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  walk.create = ntdll ? (NtCreateFileFn)(void *)GetProcAddress(ntdll, "NtCreateFile") : NULL;
  walk.to_dos = ntdll ? (RtlNtStatusToDosErrorFn)(void *)GetProcAddress(ntdll, "RtlNtStatusToDosError") : NULL;
  if (!walk.create || !walk.to_dos) return fail(env, "removeTree: ntdll.dll has no NtCreateFile");
  char16_t *given = malloc((length + 1) * sizeof(char16_t));
  if (!given) return fail(env, "out of memory");
  napi_get_value_string_utf16(env, argv[0], given, length + 1, &length);
  // a NUL inside the string would end the path early (the folder before it would be removed): refused, never shortened
  if (wcslen((const wchar_t *)given) != length) { free(given); return fail_code(env, "ERR_INVALID_ARG_VALUE", "removeTree: the path holds a NUL"); }
  // Windows reads some paths as another (a trailing dot or space dropped, `..` applied): the caller's checks compared the path as
  // written, so one Windows would rewrite is refused, never shortened. The JS wrapper hands its resolved form, which is already full.
  if (!tree_path_is_full((const wchar_t *)given)) { free(given); return fail_code(env, "EINVAL", "removeTree: Windows would read this path as a different one"); }
  wchar_t *name = tree_long_path((const wchar_t *)given);
  free(given);
  if (!name) return fail_code(env, "EINVAL", "removeTree: not a usable path");
  HANDLE top = INVALID_HANDLE_VALUE;
  DWORD error = 0;
  const DWORD tries[2] = { TREE_ACCESS_FULL, TREE_ACCESS_LEAST };
  for (int i = 0; i < 2; i++) {
    top = CreateFileW(name, tries[i], FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (top != INVALID_HANDLE_VALUE) break;
    error = GetLastError();
    if (error != ERROR_ACCESS_DENIED) break;
  }
  free(name);
  if (top == INVALID_HANDLE_VALUE) {
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return make_bool(env, 0);
    char text[96];
    snprintf(text, sizeof text, "removeTree: could not open (%lu)", (unsigned long)error);
    return fail_code(env, tree_code(error), text);
  }
  walk.where_size = 64;
  walk.where = malloc(walk.where_size * sizeof(wchar_t));
  if (!walk.where) { CloseHandle(top); return fail(env, "out of memory"); }
  walk.where[0] = L'\0';
  int result = tree_remove(&walk, top, 0);
  CloseHandle(top);
  if (result == 0) { free(walk.where); return make_bool(env, 1); }
  if (walk.thrown) { free(walk.where); return NULL; }  /* beforeFolder's own exception */
  char *where = wide_to_utf8(walk.where, (int)walk.where_length);
  free(walk.where);
  size_t size = 128 + (where ? strlen(where) : 0);
  char *text = malloc(size);
  if (!text) { free(where); return fail_code(env, tree_code(walk.error), "removeTree failed"); }
  snprintf(text, size, "removeTree: could not %s (%lu) at '%s'", walk.step ? walk.step : "remove", (unsigned long)walk.error, where ? where : "?");
  napi_value thrown = fail_code(env, tree_code(walk.error), text);
  free(text);
  free(where);
  return thrown;
}
#endif

/** macOS: this boot's own id (kern.bootsessionuuid), a new one at every start of the system; null where it cannot be read. Elsewhere
 * null (Linux reads /proc/sys/kernel/random/boot_id itself; Windows has none). The journals of a fallback barrier wait for a new one. */
static napi_value boot_id(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __APPLE__
  char id[128];
  size_t size = sizeof id;
  if (sysctlbyname("kern.bootsessionuuid", id, &size, NULL, 0) == 0 && size > 1 && size <= sizeof id) {
    id[size - 1] = '\0';
    napi_value value;
    if (napi_create_string_utf8(env, id, NAPI_AUTO_LENGTH, &value) == napi_ok) return value;
  }
#endif
  napi_value none;
  napi_get_null(env, &none);
  return none;
}

static napi_value version(napi_env env, napi_callback_info info) {
  (void)info;
  return make_int(env, ADDON_VERSION);
}

#ifdef _WIN32
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  wchar_t *path;
  LONG result;
  wchar_t publisher[512];
  wchar_t subject[2048];
} AuthenticodeWork;

static const char *authenticode_status(LONG result) {
  switch (result) {
    case ERROR_SUCCESS: return "Valid";
    case TRUST_E_NOSIGNATURE: return "NotSigned";
    case TRUST_E_BAD_DIGEST: case CRYPT_E_HASH_VALUE: return "HashMismatch";
    case CERT_E_UNTRUSTEDROOT: case CERT_E_CHAINING: case CERT_E_UNTRUSTEDTESTROOT: case TRUST_E_EXPLICIT_DISTRUST:
    case TRUST_E_SUBJECT_NOT_TRUSTED: case CERT_E_REVOKED: case CERT_E_EXPIRED: return "NotTrusted";
    default: return "UnknownError";
  }
}

static void authenticode_execute(napi_env env, void *data) {
  (void)env;
  AuthenticodeWork *job = data;
  job->publisher[0] = L'\0';
  job->subject[0] = L'\0';
  WINTRUST_FILE_INFO file;
  memset(&file, 0, sizeof file);
  file.cbStruct = sizeof file;
  file.pcwszFilePath = job->path;
  WINTRUST_DATA trust;
  memset(&trust, 0, sizeof trust);
  trust.cbStruct = sizeof trust;
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  job->result = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &trust);
  if (job->result == ERROR_SUCCESS) {
    CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
    CRYPT_PROVIDER_SGNR *signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : NULL;
    CRYPT_PROVIDER_CERT *leaf = signer ? WTHelperGetProvCertFromChain(signer, 0) : NULL;
    if (leaf && leaf->pCert) {
      CertGetNameStringW(leaf->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, NULL, job->publisher, 512);
      // Version 9: the signer's whole subject, as .NET's X500DistinguishedName.Name writes it ("CN=..., O=..., C=..."), for the
      // updater's publisher check (electron/windows-update-signature.mjs).
      if (!CertNameToStrW(X509_ASN_ENCODING, &leaf->pCert->pCertInfo->Subject, CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG, job->subject, 2048))
        job->subject[0] = L'\0';
    }
    // A Valid answer whose signer cannot be named is not a Valid signature from anyone in particular.
    if (job->publisher[0] == L'\0') job->result = TRUST_E_NO_SIGNER_CERT;
  }
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &trust);
}

static void authenticode_complete(napi_env env, napi_status status, void *data) {
  AuthenticodeWork *job = data;
  napi_value result = NULL, value;
  if (status == napi_ok && napi_create_object(env, &result) == napi_ok) {
    napi_create_string_utf8(env, authenticode_status(job->result), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "status", value);
    char *publisher = wide_to_utf8(job->publisher, (int)wcslen(job->publisher));
    napi_create_string_utf8(env, publisher ? publisher : "", NAPI_AUTO_LENGTH, &value);
    free(publisher);
    napi_set_named_property(env, result, "publisher", value);
    char *subject = wide_to_utf8(job->subject, (int)wcslen(job->subject));
    napi_create_string_utf8(env, subject ? subject : "", NAPI_AUTO_LENGTH, &value);
    free(subject);
    napi_set_named_property(env, result, "subject", value);
    napi_create_int64(env, (int64_t)(uint32_t)job->result, &value);
    napi_set_named_property(env, result, "code", value);
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    napi_value message, error;
    napi_create_string_utf8(env, "authenticode check did not finish", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, job->deferred, error);
  }
  napi_delete_async_work(env, job->work);
  free(job->path);
  free(job);
}

static napi_value authenticode(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argv[1], promise, name;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 || length > 32767)
    return fail(env, "authenticode needs a path");
  AuthenticodeWork *job = calloc(1, sizeof(AuthenticodeWork));
  if (!job) return fail(env, "out of memory");
  job->path = malloc((length + 1) * sizeof(wchar_t));
  if (!job->path) { free(job); return fail(env, "out of memory"); }
  napi_get_value_string_utf16(env, argv[0], (char16_t *)job->path, length + 1, &length);
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok
      || napi_create_string_utf8(env, "authenticode", NAPI_AUTO_LENGTH, &name) != napi_ok
      || napi_create_async_work(env, NULL, name, authenticode_execute, authenticode_complete, job, &job->work) != napi_ok
      || napi_queue_async_work(env, job->work) != napi_ok) {
    free(job->path); free(job);
    return fail(env, "could not start the authenticode check");
  }
  return promise;
}
#endif

#ifdef _WIN32
// ---- The calls that replaced Murage's own PowerShell starts (murage-releases #1). Version 8. ----
#include <sddl.h>
#include <aclapi.h>
#include "exclusion-lsa.h"
#define COBJMACROS
#include <sapi.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "advapi32.lib")

static napi_value shutdown_privileges_result(napi_env env, const char *step, DWORD error) {
  napi_value out, value;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "ok", make_bool(env, step == NULL));
  if (step) {
    napi_create_string_utf8(env, step, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, out, "step", value);
    napi_create_uint32(env, error, &value);
    napi_set_named_property(env, out, "error", value);
  }
  return out;
}

// Removal is permanent for this primary token and inherited by normal child spawns.
// ERROR_NOT_ALL_ASSIGNED is expected when either privilege was already absent;
// success still requires reading the token back and finding neither LUID.
static napi_value drop_shutdown_privileges(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE token = NULL;
  struct { DWORD PrivilegeCount; LUID_AND_ATTRIBUTES Privileges[2]; } remove;
  TOKEN_PRIVILEGES *current = NULL;
  DWORD length = 0, error = ERROR_SUCCESS;
  const char *step = "open";
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token))
    return shutdown_privileges_result(env, step, GetLastError());
  memset(&remove, 0, sizeof remove);
  remove.PrivilegeCount = 2;
  step = "lookup";
  if (!LookupPrivilegeValueW(NULL, L"SeShutdownPrivilege", &remove.Privileges[0].Luid)
      || !LookupPrivilegeValueW(NULL, L"SeRemoteShutdownPrivilege", &remove.Privileges[1].Luid)) {
    error = GetLastError(); goto done;
  }
  remove.Privileges[0].Attributes = SE_PRIVILEGE_REMOVED;
  remove.Privileges[1].Attributes = SE_PRIVILEGE_REMOVED;
  step = "adjust";
  SetLastError(ERROR_SUCCESS);
  if (!AdjustTokenPrivileges(token, FALSE, (TOKEN_PRIVILEGES *)&remove, 0, NULL, NULL)) {
    error = GetLastError(); goto done;
  }
  error = GetLastError();
  if (error != ERROR_SUCCESS && error != ERROR_NOT_ALL_ASSIGNED) goto done;
  step = "verify";
  if (GetTokenInformation(token, TokenPrivileges, NULL, 0, &length)) {
    error = ERROR_INVALID_DATA; goto done;
  }
  error = GetLastError();
  if (error != ERROR_INSUFFICIENT_BUFFER) goto done;
  current = malloc(length);
  if (!current) { error = ERROR_NOT_ENOUGH_MEMORY; goto done; }
  if (!GetTokenInformation(token, TokenPrivileges, current, length, &length)) {
    error = GetLastError(); goto done;
  }
  for (DWORD i = 0; i < current->PrivilegeCount; i++) {
    for (DWORD j = 0; j < 2; j++) {
      if (current->Privileges[i].Luid.LowPart == remove.Privileges[j].Luid.LowPart
          && current->Privileges[i].Luid.HighPart == remove.Privileges[j].Luid.HighPart) {
        error = ERROR_ACCESS_DENIED; goto done; // A remaining LUID fails even when disabled.
      }
    }
  }
  step = NULL;
  error = ERROR_SUCCESS;
done:
  free(current);
  CloseHandle(token);
  return shutdown_privileges_result(env, step, error);
}

/** A UTF-16 string argument of 1..max code units, NUL-ended, in memory the caller frees; NULL when it is not one (no exception). */
static wchar_t *get_wide(napi_env env, napi_value value, size_t max) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > max) return NULL;
  wchar_t *out = malloc((length + 1) * sizeof(wchar_t));
  if (!out) return NULL;
  if (napi_get_value_string_utf16(env, value, (char16_t *)out, length + 1, &length) != napi_ok) { free(out); return NULL; }
  out[length] = L'\0';
  return out;
}
static napi_value make_wide(napi_env env, const wchar_t *text) {
  napi_value out;
  if (!text) return make_null(env);
  napi_create_string_utf16(env, (const char16_t *)text, wcslen(text), &out);
  return out;
}
static napi_value make_sid(napi_env env, PSID sid) {
  wchar_t *text = NULL;
  if (!sid || !IsValidSid(sid) || !ConvertSidToStringSidW(sid, &text)) return make_null(env);
  napi_value out = make_wide(env, text);
  LocalFree(text);
  return out;
}

// jobCreate(name) / jobAssign(job, pid, refusalCode) / jobClose(job) / jobStop(name, waitMs): the memory-maintenance (PIP) job.
// The job is named Local\murage-pip-<id>, KILL_ON_JOB_CLOSE, and its only handle is this process's (not inheritable): when the
// server ends, however it ends, Windows ends every process in the job. jobAssign puts a process in it; when that fails the process
// is ended at once with `refusalCode`, so a CLI never runs outside its job. jobStop opens the job by name, terminates it and waits
// up to waitMs for its members to be gone, on a worker thread.
typedef struct { HANDLE job; int closed; } JobHeld;
static void job_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  JobHeld *held = data;
  if (!held) return;
  if (!held->closed && held->job) CloseHandle(held->job);
  free(held);
}
static int job_name_ok(const wchar_t *name) {
  static const wchar_t prefix[] = L"Local\\murage-pip-";
  size_t length = wcslen(prefix);
  if (wcsncmp(name, prefix, length) != 0 || name[length] == L'\0') return 0;
  for (const wchar_t *c = name + length; *c; c++)
    if (!((*c >= L'a' && *c <= L'z') || (*c >= L'A' && *c <= L'Z') || (*c >= L'0' && *c <= L'9') || *c == L'-')) return 0;
  return 1;
}
// jobCreate(name): KILL_ON_JOB_CLOSE and no breakaway of any kind (U24 design R1): a process a member starts is in the job before
// its first instruction. This job never grants a breakaway: a CreateProcess that asks for CREATE_BREAKAWAY_FROM_JOB may still
// succeed when an outer job in the hierarchy permits it (libuv's own job does), but the child stays a member of this job and ends
// with it (gate box, 2026-10-25). Engine and PIP jobs are the same job.
static napi_value job_create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], out;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *name = argc >= 1 ? get_wide(env, argv[0], 200) : NULL;
  if (!name || !job_name_ok(name)) { free(name); return fail(env, "jobCreate needs a Local\\murage-pip- name"); }
  SetLastError(ERROR_SUCCESS);
  HANDLE job = CreateJobObjectW(NULL, name);
  DWORD error = GetLastError();
  free(name);
  if (!job) return fail_code(env, "EJOB", "the job could not be created");
  if (error == ERROR_ALREADY_EXISTS) { CloseHandle(job); return fail_code(env, "EEXIST", "a job with this name exists"); }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) { CloseHandle(job); return fail_code(env, "EJOB", "the job could not be limited"); }
  JobHeld *held = calloc(1, sizeof(JobHeld));
  if (!held) { CloseHandle(job); return fail(env, "out of memory"); }
  held->job = job;
  if (napi_create_external(env, held, job_finalize, NULL, &out) != napi_ok) { CloseHandle(job); free(held); return fail(env, "the job could not be handed back"); }
  return out;
}
static JobHeld *job_of(napi_env env, napi_value value) {
  napi_valuetype type;
  void *data = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external || napi_get_value_external(env, value, &data) != napi_ok || !data) {
    fail(env, "not a job of this addon");
    return NULL;
  }
  return data;
}
static napi_value job_assign(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  uint32_t pid = 0, code = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || napi_get_value_uint32(env, argv[1], &pid) != napi_ok || napi_get_value_uint32(env, argv[2], &code) != napi_ok || pid == 0)
    return fail(env, "jobAssign needs a job, a pid and a refusal code");
  JobHeld *held = job_of(env, argv[0]);
  if (!held) return NULL;
  if (held->closed) return fail_code(env, "EBADF", "the job is closed");
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    // Version 9: a process that cannot be opened for assignment is still ended (terminate-only access), so no CLI runs outside its
    // job; the caller ends it again through its own handle and refuses the run.
    HANDLE end = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (end) { TerminateProcess(end, code); CloseHandle(end); }
    return make_bool(env, 0);
  }
  BOOL ok = AssignProcessToJobObject(held->job, process);
  if (!ok) TerminateProcess(process, code);
  CloseHandle(process);
  return make_bool(env, ok);
}
static napi_value job_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return fail(env, "jobClose needs a job");
  JobHeld *held = job_of(env, argv[0]);
  if (!held) return NULL;
  if (!held->closed) { CloseHandle(held->job); held->closed = 1; held->job = NULL; }
  return NULL;
}
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  wchar_t *name;
  DWORD wait_ms;
  int absent, failed;
  DWORD active;
} JobStopWork;
static void job_stop_execute(napi_env env, void *data) {
  (void)env;
  JobStopWork *w = data;
  HANDLE job = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, FALSE, w->name);
  if (!job) { if (GetLastError() == ERROR_FILE_NOT_FOUND) w->absent = 1; else w->failed = 1; return; }
  if (!TerminateJobObject(job, 1)) { w->failed = 1; CloseHandle(job); return; }
  ULONGLONG started = GetTickCount64();
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) { w->failed = 1; break; }
    if (accounting.ActiveProcesses == 0 || GetTickCount64() - started >= w->wait_ms) { w->active = accounting.ActiveProcesses; break; }
    Sleep(25);
  }
  CloseHandle(job);
}
static void job_stop_complete(napi_env env, napi_status status, void *data) {
  JobStopWork *w = data;
  napi_value result, value;
  if (status == napi_ok && !w->failed && napi_create_object(env, &result) == napi_ok) {
    napi_create_string_utf8(env, w->absent ? "absent" : "present", NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "state", value);
    if (!w->absent) { napi_create_uint32(env, w->active, &value); napi_set_named_property(env, result, "activeProcesses", value); }
    napi_resolve_deferred(env, w->deferred, result);
  } else {
    napi_value message, error;
    napi_create_string_utf8(env, "the job could not be stopped", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, w->deferred, error);
  }
  napi_delete_async_work(env, w->work);
  free(w->name);
  free(w);
}
static napi_value job_stop(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], promise, name;
  uint32_t wait_ms = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || napi_get_value_uint32(env, argv[1], &wait_ms) != napi_ok) return fail(env, "jobStop needs a name and a wait");
  wchar_t *job_name = get_wide(env, argv[0], 200);
  if (!job_name || !job_name_ok(job_name)) { free(job_name); return fail(env, "jobStop needs a Local\\murage-pip- name"); }
  JobStopWork *w = calloc(1, sizeof(JobStopWork));
  if (!w) { free(job_name); return fail(env, "out of memory"); }
  w->name = job_name;
  w->wait_ms = wait_ms;
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok
      || napi_create_string_utf8(env, "jobStop", NAPI_AUTO_LENGTH, &name) != napi_ok
      || napi_create_async_work(env, NULL, name, job_stop_execute, job_stop_complete, w, &w->work) != napi_ok
      || napi_queue_async_work(env, w->work) != napi_ok) {
    free(w->name); free(w);
    return fail(env, "could not start the job stop");
  }
  return promise;
}

// processStart(pid): the process's kernel creation time as a FILETIME in decimal (what .NET's StartTime.ToFileTimeUtc() gives), or
// null when it cannot be read. data-dir-lease.mjs compares it with a version 1 lease record.
static napi_value process_start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t pid = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) return fail(env, "processStart needs a pid");
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return make_null(env);
  FILETIME created, exited, kernel, user;
  BOOL ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
  CloseHandle(process);
  if (!ok) return make_null(env);
  char text[32];
  snprintf(text, sizeof text, "%llu", ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime);
  napi_value out;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out);
  return out;
}

// driveInfo(path): { type, format } of the volume that holds `path` (GetVolumePathNameW, GetDriveTypeW, GetVolumeInformationW),
// with .NET DriveInfo's type names; null when it cannot be told.
static napi_value drive_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], out, value;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *path = argc >= 1 ? get_wide(env, argv[0], 32767) : NULL;
  if (!path) return fail(env, "driveInfo needs a path");
  wchar_t root[MAX_PATH + 1], format[MAX_PATH + 1];
  BOOL ok = GetVolumePathNameW(path, root, MAX_PATH + 1);
  free(path);
  if (!ok) return make_null(env);
  format[0] = L'\0';
  const char *type;
  switch (GetDriveTypeW(root)) {
    case DRIVE_NO_ROOT_DIR: type = "NoRootDirectory"; break;
    case DRIVE_REMOVABLE: type = "Removable"; break;
    case DRIVE_FIXED: type = "Fixed"; break;
    case DRIVE_REMOTE: type = "Network"; break;
    case DRIVE_CDROM: type = "CDRom"; break;
    case DRIVE_RAMDISK: type = "Ram"; break;
    default: type = "Unknown"; break;
  }
  if (!GetVolumeInformationW(root, NULL, 0, NULL, NULL, NULL, format, MAX_PATH + 1)) return make_null(env);
  napi_create_object(env, &out);
  napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, out, "type", value);
  napi_set_named_property(env, out, "format", make_wide(env, format));
  return out;
}

// fileOwnerSid(path): the owner of the file or folder itself (a link is not followed) as an S-1-… string, or null.
static napi_value file_owner_sid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *path = argc >= 1 ? get_wide(env, argv[0], 32767) : NULL;
  if (!path) return fail(env, "fileOwnerSid needs a path");
  HANDLE file = CreateFileW(path, READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (file == INVALID_HANDLE_VALUE) return make_null(env);
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, NULL, NULL, NULL, &descriptor);
  CloseHandle(file);
  napi_value out = error == ERROR_SUCCESS ? make_sid(env, owner) : make_null(env);
  if (descriptor) LocalFree(descriptor);
  return out;
}

// accountSid(name): LookupAccountNameW's SID for an account name in any display language ("NT-AUTORITÄT\SYSTEM"), or null when the
// name maps to no account. machineSid(): this computer's own account-domain SID (the prefix of its local accounts), or null.
static napi_value lookup_sid(napi_env env, const wchar_t *name, int want_domain) {
  BYTE sid[SECURITY_MAX_SID_SIZE];
  DWORD sid_size = sizeof sid, domain_size = 256;
  wchar_t domain[256];
  SID_NAME_USE use;
  if (!LookupAccountNameW(NULL, name, sid, &sid_size, domain, &domain_size, &use)) return make_null(env);
  if (want_domain && use != SidTypeDomain) return make_null(env);
  return make_sid(env, (PSID)sid);
}
static napi_value account_sid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t *name = argc >= 1 ? get_wide(env, argv[0], 512) : NULL;
  if (!name) return fail(env, "accountSid needs a name");
  napi_value out = lookup_sid(env, name, 0);
  free(name);
  return out;
}
static napi_value machine_sid(napi_env env, napi_callback_info info) {
  (void)info;
  wchar_t name[MAX_COMPUTERNAME_LENGTH + 2];
  DWORD size = MAX_COMPUTERNAME_LENGTH + 1;
  if (!GetComputerNameW(name, &size)) return make_null(env);
  return lookup_sid(env, name, 1);
}

// domainSids(): { account, primary, forestRoot } (version 9), each an S-1-5-21-a-b-c domain SID or null, read from this computer's
// LSA policy (LsaQueryInformationPolicy), never derived from a user or machine SID. `account`: this computer's own account domain
// (its local accounts: SDDL LA, LG). `primary`: the Active Directory domain it is joined to (SDDL DA, DU, DG, ...), null in a workgroup.
// `forestRoot`: that domain's forest root (SDDL EA, SA, RO, EK): the primary domain when the forest's DNS name is the domain's own,
// else the SID Windows' account lookup gives for the forest's DNS name (SidTypeDomain only), null when it cannot be told.
static napi_value sid_or_null(napi_env env, PSID sid) { return sid && IsValidSid(sid) ? make_sid(env, sid) : make_null(env); }
static napi_value domain_sids(napi_env env, napi_callback_info info) {
  (void)info;
  MurLsaDomainSids lsa;
  if (mur_lsa_domain_sids(&lsa) != 0) return fail(env, "the computer's domain could not be read");
  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "account", sid_or_null(env, lsa.has_account ? (PSID)lsa.account_sid : NULL));
  PSID primary = lsa.has_primary ? (PSID)lsa.primary_sid : NULL;
  napi_set_named_property(env, out, "primary", sid_or_null(env, primary));
  napi_value root = make_null(env);
  if (primary && lsa.forest_present) {
    if (lsa.forest_is_domain) root = make_sid(env, primary);
    else if (!lsa.forest_too_long) root = lookup_sid(env, lsa.forest_name, 1);
  }
  napi_set_named_property(env, out, "forestRoot", root);
  return out;
}

// speechVoices() / speechToWave(text, voice, path): the installed SAPI voices (the same list .NET's System.Speech gives: the
// HKLM\SOFTWARE\Microsoft\Speech\Voices category, each token's Name attribute as the id, its Language as a culture name and its
// description), and one utterance written to a 22,050 Hz 16-bit mono WAV file. The text is spoken as plain text, never as SAPI XML.
// `voice` "" or a name no installed voice has keeps the machine's default voice. Both run on a worker thread; speaking is bounded
// at 30 s and stopped (purged) when it runs past that.
static const GUID MUR_CLSID_SpVoice = {0x96749377, 0x3391, 0x11d2, {0x9e, 0xe3, 0x00, 0xc0, 0x4f, 0x79, 0x73, 0x96}};
static const GUID MUR_IID_ISpVoice = {0x6c44df74, 0x72b9, 0x4992, {0xa1, 0xec, 0xef, 0x99, 0x6e, 0x04, 0x22, 0xd4}};
static const GUID MUR_CLSID_SpStream = {0x715d9c59, 0x4442, 0x11d2, {0x96, 0x05, 0x00, 0xc0, 0x4f, 0x8e, 0xe6, 0x28}};
static const GUID MUR_IID_ISpStream = {0x12e3cca9, 0x7518, 0x44c5, {0xa5, 0xe7, 0xba, 0x5a, 0x79, 0xcb, 0x92, 0x9e}};
static const GUID MUR_CLSID_SpObjectTokenCategory = {0xa910187f, 0x0c7a, 0x45ac, {0x92, 0xcc, 0x59, 0xed, 0xaf, 0xb7, 0x7b, 0x53}};
static const GUID MUR_IID_ISpObjectTokenCategory = {0x2d3d3845, 0x39af, 0x4850, {0xbb, 0xf9, 0x40, 0xb4, 0x97, 0x80, 0x01, 0x1d}};
static const GUID MUR_SPDFID_WaveFormatEx = {0xc31adbae, 0x527f, 0x4ff5, {0xa2, 0x30, 0xf6, 0x2b, 0xb6, 0x1f, 0xf7, 0x0c}};
#define MUR_SPCAT_VOICES L"HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices"
#define SPEAK_BOUND_MS 30000

static HRESULT voice_tokens(IEnumSpObjectTokens **out) {
  ISpObjectTokenCategory *category = NULL;
  HRESULT hr = CoCreateInstance(&MUR_CLSID_SpObjectTokenCategory, NULL, CLSCTX_ALL, &MUR_IID_ISpObjectTokenCategory, (void **)&category);
  if (FAILED(hr)) return hr;
  hr = ISpObjectTokenCategory_SetId(category, MUR_SPCAT_VOICES, FALSE);
  if (SUCCEEDED(hr)) hr = ISpObjectTokenCategory_EnumTokens(category, NULL, NULL, out);
  ISpObjectTokenCategory_Release(category);
  return hr;
}
/** A token's Attributes\<name> value (CoTaskMemFree it), or NULL. */
static wchar_t *voice_attribute(ISpObjectToken *token, const wchar_t *name) {
  ISpDataKey *key = NULL;
  wchar_t *value = NULL;
  if (SUCCEEDED(ISpObjectToken_OpenKey(token, L"Attributes", &key)) && key) {
    if (FAILED(ISpDataKey_GetStringValue(key, name, &value))) value = NULL;
    ISpDataKey_Release(key);
  }
  return value;
}

typedef struct { char *name, *culture, *description; } VoiceRow;
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  VoiceRow *rows;
  size_t count, capacity;
  HRESULT hr;
} VoicesWork;
static char *co_to_utf8(wchar_t *text) {
  char *out = text ? wide_to_utf8(text, (int)wcslen(text)) : _strdup("");
  if (text) CoTaskMemFree(text);
  return out ? out : _strdup("");
}
static void voices_execute(napi_env env, void *data) {
  (void)env;
  VoicesWork *w = data;
  HRESULT init = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  IEnumSpObjectTokens *tokens = NULL;
  w->hr = voice_tokens(&tokens);
  if (SUCCEEDED(w->hr) && tokens) {
    ISpObjectToken *token = NULL;
    wchar_t ui[16];
    swprintf(ui, 16, L"%x", (unsigned)GetUserDefaultUILanguage());
    while (IEnumSpObjectTokens_Next(tokens, 1, &token, NULL) == S_OK && token) {
      wchar_t *name = voice_attribute(token, L"Name");
      if (name && name[0]) {
        if (w->count == w->capacity) {
          size_t capacity = w->capacity ? w->capacity * 2 : 16;
          VoiceRow *rows = realloc(w->rows, capacity * sizeof(VoiceRow));
          if (!rows) { CoTaskMemFree(name); ISpObjectToken_Release(token); w->hr = E_OUTOFMEMORY; break; }
          w->rows = rows; w->capacity = capacity;
        }
        VoiceRow *row = &w->rows[w->count++];
        row->name = co_to_utf8(name);
        name = NULL;
        // Culture: the first LCID of the Language attribute ("409;9"), as a culture name ("en-US").
        wchar_t *language = voice_attribute(token, L"Language");
        wchar_t culture[LOCALE_NAME_MAX_LENGTH];
        culture[0] = L'\0';
        if (language) {
          unsigned long lcid = wcstoul(language, NULL, 16);
          if (lcid == 0 || LCIDToLocaleName((LCID)lcid, culture, LOCALE_NAME_MAX_LENGTH, 0) == 0) culture[0] = L'\0';
          CoTaskMemFree(language);
        }
        row->culture = wide_to_utf8(culture, (int)wcslen(culture));
        if (!row->culture) row->culture = _strdup("");
        // Description: the value named for the display language, else the token's default value (as System.Speech reads it).
        wchar_t *description = NULL;
        if (FAILED(ISpObjectToken_GetStringValue(token, ui, &description))) description = NULL;
        if (!description && FAILED(ISpObjectToken_GetStringValue(token, NULL, &description))) description = NULL;
        row->description = co_to_utf8(description);
      }
      if (name) CoTaskMemFree(name);
      ISpObjectToken_Release(token);
      token = NULL;
    }
    IEnumSpObjectTokens_Release(tokens);
  }
  if (SUCCEEDED(init)) CoUninitialize();
}
static void voices_complete(napi_env env, napi_status status, void *data) {
  VoicesWork *w = data;
  napi_value list, item, value;
  if (status == napi_ok && SUCCEEDED(w->hr) && napi_create_array_with_length(env, w->count, &list) == napi_ok) {
    for (size_t i = 0; i < w->count; i++) {
      napi_create_object(env, &item);
      napi_create_string_utf8(env, w->rows[i].name, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, item, "name", value);
      napi_create_string_utf8(env, w->rows[i].culture, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, item, "culture", value);
      napi_create_string_utf8(env, w->rows[i].description, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, item, "description", value);
      napi_set_element(env, list, (uint32_t)i, item);
    }
    napi_resolve_deferred(env, w->deferred, list);
  } else {
    char text[64];
    snprintf(text, sizeof text, "the voices could not be listed (0x%08lx)", (unsigned long)w->hr);
    napi_value message, error;
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, w->deferred, error);
  }
  for (size_t i = 0; i < w->count; i++) { free(w->rows[i].name); free(w->rows[i].culture); free(w->rows[i].description); }
  free(w->rows);
  napi_delete_async_work(env, w->work);
  free(w);
}
static napi_value speech_voices(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value promise, name;
  VoicesWork *w = calloc(1, sizeof(VoicesWork));
  if (!w) return fail(env, "out of memory");
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok
      || napi_create_string_utf8(env, "speechVoices", NAPI_AUTO_LENGTH, &name) != napi_ok
      || napi_create_async_work(env, NULL, name, voices_execute, voices_complete, w, &w->work) != napi_ok
      || napi_queue_async_work(env, w->work) != napi_ok) {
    free(w);
    return fail(env, "could not start the voice list");
  }
  return promise;
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  wchar_t *text, *voice, *path;
  HRESULT hr;
  int selected, timed_out;
} SpeakWork;
static void speak_execute(napi_env env, void *data) {
  (void)env;
  SpeakWork *w = data;
  HRESULT init = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  ISpVoice *voice = NULL;
  ISpStream *stream = NULL;
  w->hr = CoCreateInstance(&MUR_CLSID_SpVoice, NULL, CLSCTX_ALL, &MUR_IID_ISpVoice, (void **)&voice);
  if (SUCCEEDED(w->hr) && w->voice && w->voice[0]) {
    // The exact name first, as System.Speech's SelectVoice; then the same name in another case. None: the default voice.
    for (int pass = 0; pass < 2 && !w->selected; pass++) {
      IEnumSpObjectTokens *tokens = NULL;
      if (FAILED(voice_tokens(&tokens)) || !tokens) break;
      ISpObjectToken *token = NULL;
      while (!w->selected && IEnumSpObjectTokens_Next(tokens, 1, &token, NULL) == S_OK && token) {
        wchar_t *name = voice_attribute(token, L"Name");
        if (name && (pass == 0 ? wcscmp(name, w->voice) == 0 : _wcsicmp(name, w->voice) == 0) && SUCCEEDED(ISpVoice_SetVoice(voice, token))) w->selected = 1;
        if (name) CoTaskMemFree(name);
        ISpObjectToken_Release(token);
        token = NULL;
      }
      IEnumSpObjectTokens_Release(tokens);
    }
  }
  if (SUCCEEDED(w->hr)) w->hr = CoCreateInstance(&MUR_CLSID_SpStream, NULL, CLSCTX_ALL, &MUR_IID_ISpStream, (void **)&stream);
  if (SUCCEEDED(w->hr)) {
    WAVEFORMATEX format;
    memset(&format, 0, sizeof format);
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 1;
    format.nSamplesPerSec = 22050;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 2;
    format.nAvgBytesPerSec = 44100;
    w->hr = ISpStream_BindToFile(stream, w->path, SPFM_CREATE_ALWAYS, &MUR_SPDFID_WaveFormatEx, &format, 0);
  }
  if (SUCCEEDED(w->hr)) w->hr = ISpVoice_SetOutput(voice, (IUnknown *)stream, TRUE);
  if (SUCCEEDED(w->hr)) w->hr = ISpVoice_Speak(voice, w->text, SPF_ASYNC | SPF_IS_NOT_XML, NULL);
  if (SUCCEEDED(w->hr)) {
    HRESULT done = ISpVoice_WaitUntilDone(voice, SPEAK_BOUND_MS);
    if (done == S_FALSE) { w->timed_out = 1; ISpVoice_Speak(voice, NULL, SPF_PURGEBEFORESPEAK, NULL); w->hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT); }
    else if (FAILED(done)) w->hr = done;
  }
  if (voice) { ISpVoice_SetOutput(voice, NULL, TRUE); ISpVoice_Release(voice); }
  if (stream) { ISpStream_Close(stream); ISpStream_Release(stream); }
  if (SUCCEEDED(init)) CoUninitialize();
}
static void speak_complete(napi_env env, napi_status status, void *data) {
  SpeakWork *w = data;
  napi_value result;
  if (status == napi_ok && SUCCEEDED(w->hr)) {
    napi_get_boolean(env, w->selected != 0, &result);
    napi_resolve_deferred(env, w->deferred, result);
  } else {
    char text[64];
    snprintf(text, sizeof text, w->timed_out ? "speaking ran past its bound" : "the voice could not speak (0x%08lx)", (unsigned long)w->hr);
    napi_value message, error;
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, w->deferred, error);
  }
  napi_delete_async_work(env, w->work);
  free(w->text); free(w->voice); free(w->path);
  free(w);
}
static napi_value speech_to_wave(napi_env env, napi_callback_info info) {
  size_t argc = 3, voice_length = 0;
  napi_value argv[3], promise, name;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3) return fail(env, "speechToWave needs text, a voice and a path");
  SpeakWork *w = calloc(1, sizeof(SpeakWork));
  if (!w) return fail(env, "out of memory");
  w->text = get_wide(env, argv[0], 1000000);
  w->path = get_wide(env, argv[2], 32767);
  if (napi_get_value_string_utf16(env, argv[1], NULL, 0, &voice_length) == napi_ok && voice_length > 0) w->voice = get_wide(env, argv[1], 512);
  if (!w->text || !w->path || (voice_length > 0 && !w->voice)) { free(w->text); free(w->path); free(w->voice); free(w); return fail(env, "speechToWave needs text, a voice and a path"); }
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok
      || napi_create_string_utf8(env, "speechToWave", NAPI_AUTO_LENGTH, &name) != napi_ok
      || napi_create_async_work(env, NULL, name, speak_execute, speak_complete, w, &w->work) != napi_ok
      || napi_queue_async_work(env, w->work) != napi_ok) {
    free(w->text); free(w->path); free(w->voice); free(w);
    return fail(env, "could not start speaking");
  }
  return promise;
}
#endif

static void add(napi_env env, napi_value exports, const char *name, napi_callback fn) {
  napi_value value;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &value) == napi_ok) napi_set_named_property(env, exports, name, value);
}

NAPI_MODULE_INIT() {
  add(env, exports, "lock", lock_file);
  add(env, exports, "processes", list_processes);
  add(env, exports, "renameNoReplace", rename_no_replace);
  add(env, exports, "environment", environment_of);
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
  add(env, exports, "authenticode", authenticode);
  add(env, exports, "removeTree", remove_tree);
  add(env, exports, "jobCreate", job_create);
  add(env, exports, "jobAssign", job_assign);
  add(env, exports, "jobClose", job_close);
  add(env, exports, "jobStop", job_stop);
  add(env, exports, "processStart", process_start);
  add(env, exports, "driveInfo", drive_info);
  add(env, exports, "fileOwnerSid", file_owner_sid);
  add(env, exports, "accountSid", account_sid);
  add(env, exports, "machineSid", machine_sid);
  add(env, exports, "domainSids", domain_sids);
  add(env, exports, "dropShutdownPrivileges", drop_shutdown_privileges);
  add(env, exports, "speechVoices", speech_voices);
  add(env, exports, "speechToWave", speech_to_wave);
  add(env, exports, "cwdOf", cwd_of);
#endif
  add(env, exports, "bootId", boot_id);
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
