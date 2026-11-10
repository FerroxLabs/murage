// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows anchored opens for the Claude Code copy import (CONTRACTS-B 1.3, amendments R1-R22). Every folder and file is opened
// RELATIVE to the handle of its parent (NtCreateFile with RootDirectory, FILE_OPEN_REPARSE_POINT, never FILE_SHARE_DELETE), judged on
// the open handle, and held until the request ends, so no path is resolved twice and no held folder can be renamed, deleted or
// replaced by a junction. Every call that touches the file system runs on the session's own I/O thread; the JS thread waits under
// the request deadline and, on timeout, abandons the call, poisons the session and returns at once.
//
//   anchorBegin(home, budgetMs)                       -> Session
//   anchorOpen(parent, name, "dir" | "file")          -> { handle, kind, volume, fileId, nlink, size }
//   anchorList(dir)                                   -> { names, truncated }
//   anchorRead(file, position, length)                -> Buffer (length <= 1 MiB)
//   anchorStat(handle)                                -> { kind, volume, fileId, nlink, size, attributes }
//   anchorClose(handle)                               -> undefined (idempotent)
//   anchorEnd(session)                                -> boolean: true once the worker has closed everything (idempotent; it never waits)
//
// Every failure throws Error("Could not read Claude Code files.") with one of a fixed set of `code`s; the message never carries a path,
// a name, a Win32 error or an NTSTATUS, and nothing is written to stderr or any log. Nothing here touches JS memory off the JS thread.
#define NAPI_VERSION 9
#define _WIN32_WINNT 0x0A00
#ifdef ANCHOR_TEST_HOOKS
#define _CRTDBG_MAP_ALLOC  // R25: the debug CRT records file and line of every allocation in this file
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef ANCHOR_TEST_HOOKS
#include <crtdbg.h>
#endif
#include "anchored-win.h"

#define PLAIN "Could not read Claude Code files."
#define MAX_BUDGET_MS 10000
#define ADMISSION_WAIT_MS 2000
#define MAX_ENTRIES 4096
#define MAX_READ (1024 * 1024)
#define MAX_LIST_NAMES 1024
#define LIST_BYTES (64 * 1024)
#define MAX_NAME_UNITS 255

#define NT_OPEN 0x00000001
#define NT_DIRECTORY_FILE 0x00000001
#define NT_SYNC_NONALERT 0x00000020
#define NT_NON_DIRECTORY_FILE 0x00000040
#define NT_COMPLETE_IF_OPLOCKED 0x00000100
#define NT_OPEN_REPARSE_POINT 0x00200000
#define NT_OPEN_NO_RECALL 0x00400000
#define ST_OPLOCK_BREAK ((LONG)0x00000108)
#define ST_ACCESS_DENIED ((LONG)0xC0000022)
#define ST_NAME_NOT_FOUND ((LONG)0xC0000034)
#define ST_PATH_NOT_FOUND ((LONG)0xC000003A)
#define ST_SHARING_VIOLATION ((LONG)0xC0000043)
#define ST_DELETE_PENDING ((LONG)0xC0000056)
#define ST_FILE_IS_A_DIRECTORY ((LONG)0xC00000BA)
#define ST_NOT_A_DIRECTORY ((LONG)0xC0000103)
#define ST_LOCK_CONFLICT ((LONG)0xC0000054)
#define ST_NAME_INVALID ((LONG)0xC0000033)
#define ST_REPARSE_NOT_HANDLED ((LONG)0xC0000279)
#define ST_REPARSE_NOT_RESOLVED ((LONG)0xC0000280)
#define OFFLINE_ATTRS (FILE_ATTRIBUTE_OFFLINE | 0x00040000 /* RECALL_ON_OPEN */ | 0x00400000 /* RECALL_ON_DATA_ACCESS */)
#define FS_DEVICE_INFORMATION 4
#define DEV_DISK 7
#define DEV_REMOTE 0x10

typedef LONG (NTAPI *NtCreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef LONG (NTAPI *NtQueryVolumeInformationFileFn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int);
typedef struct { ULONG DeviceType; ULONG Characteristics; } FsDeviceInfo;

enum { E_OK = 0, E_EINVAL, E_ENOENT, E_ENOTDIR, E_EISDIR, E_ELOOP, E_EBUSY, E_EMLINK, E_EREMOTE, E_EACCES, E_ETIMEDOUT, E_EBADF, E_ENOTSUP, E_EIO, E_EMFILE };
static const char *const CODE[] = { "", "EINVAL", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EBUSY", "EMLINK", "EREMOTE", "EACCES", "ETIMEDOUT", "EBADF", "ENOTSUP", "EIO", "EMFILE" };

enum { OP_BEGIN, OP_OPEN, OP_LIST, OP_READ, OP_STAT, OP_CLOSE, OP_CLOSEALL };
enum { REQ_PENDING = 0, REQ_DELIVERED = 1, REQ_ABANDONED = 2 };

typedef struct Request Request;
typedef struct Entry Entry;
typedef struct Session Session;

struct Request {
  volatile LONG refs;       // one for the JS caller (when it waits) and one for the worker
  volatile LONG state;      // REQ_*: the CAS is the sole arbiter of publication (R20, R22a)
  HANDLE done;
  int op;
  Request *next;
  // inputs
  HANDLE parent, target;
  wchar_t name[MAX_NAME_UNITS + 1];
  int name_len, want_dir;
  ULONGLONG position;
  DWORD length;
  wchar_t *home;
  // results
  int err;
  HANDLE out;
  int is_dir;
  ULONGLONG volume;
  BYTE file_id[16];
  DWORD nlink, attributes;
  ULONGLONG size;
  BYTE *buf;
  DWORD got;
  wchar_t *names;           // NUL-separated
  DWORD name_count;
  int truncated;
  // R22b: the parent's cached FileNameInfo (copied in by the JS thread, so the request owns it), and the opened child's, handed to its Entry
  wchar_t *pname, *cname;
  size_t pname_len, cname_len;
#ifdef ANCHOR_TEST_HOOKS
  ULONG sched;              // test build: the arm generation this request claimed, 0 when it claimed none (R25')
  volatile LONG sched_w, sched_c;   // test build: the worker's and the caller's final gate access were made (each at most once)
#endif
};

struct Entry {
  Session *s;
  HANDLE h;
  int closed;               // set under the session lock at POST time (R17)
  wchar_t *name;            // R22b: this folder's FileNameInfo, read from its own handle when it was opened (children are compared with it)
  size_t name_len;
  Entry *next;
};

typedef struct { HANDLE h; } Held;

struct Session {
  volatile LONG refs;       // worker, Session external, and every Entry external (released only in finalizers, R19)
  CRITICAL_SECTION lock;
  HANDLE thread, wake, closed_all;
  Request *head, *tail;
  volatile LONG poisoned;
  int worker_gone, end_posted, failed_begin;
  ULONGLONG deadline;
  HANDLE home;              // owned by the worker
  wchar_t *home_name;       // R22b: the home's FileNameInfo, cached at begin (written by the worker before it publishes the begin)
  size_t home_name_len;
  ULONGLONG volume;
  Entry *entries;
  int open_count;
  // worker-only
  HANDLE *reg;
  size_t reg_count, reg_cap;
};

typedef struct { Session *s; } SessionBox;

static volatile LONG g_slot = 0;
static HANDLE g_slot_event = NULL;
static NtCreateFileFn g_create = NULL;
static NtQueryVolumeInformationFileFn g_query_volume = NULL;
static const napi_type_tag SESSION_TAG = { 0x6d75726167650a01ULL, 0x616e63686f723a01ULL };
static const napi_type_tag ENTRY_TAG = { 0x6d75726167650a02ULL, 0x616e63686f723a02ULL };

#ifdef ANCHOR_TEST_HOOKS
static volatile HANDLE g_stall = NULL;
static volatile HANDLE g_open_stall = NULL;          // R22b: release event the next do_open waits on, after its parent re-query
static volatile HANDLE g_open_stall_arrived = NULL;  // R22b: set by do_open when it reaches that point
static volatile LONG g_open_stalled = 0;             // how many times a do_open reached that point (anchorTestStats().openStalled: a test proves the worker got there)
static volatile LONG g_fail = 0;
static volatile LONG g_stall_ms = 0;                 // test build: the next dequeued request sleeps this long (a stall that ends on its own, for the race test)
static volatile HANDLE g_exit_stall = NULL;          // test build: release event the worker waits on just before its final close-all
// test build: exact counters (R25). Lifetime counters are only incremented at allocation and decremented at free, never read from a struct.
static volatile LONG g_sessions_live = 0, g_entries_live = 0, g_requests_live = 0;
static volatile LONG g_file_handles = 0, g_active_workers = 0, g_late_consumed = 0, g_abandoned_closed = 0, g_session_finalized = 0;
static volatile LONG g_deadline_at_post = -1;
#define CNT_INC(v) InterlockedIncrement(&(v))
#define CNT_DEC(v) InterlockedDecrement(&(v))
enum { F_NONE = 0, F_ATTRIBUTES, F_REMOTE, F_VOLUME, F_DEVICE, F_DRIVETYPE, F_FILESYSTEM, F_THREAD, F_CLOSEALLOC, F_TAG, F_CREATE, F_BEGINALLOC };
#define FORCED(which) (InterlockedCompareExchange(&g_fail, F_NONE, (which)) == (which))
static volatile LONG g_why = 0;   // test build only: which internal check last refused (a diagnosis aid, never in the shipped addon)
#define WHY(n) InterlockedExchange(&g_why, (n))
#else
#define FORCED(which) 0
#define WHY(n) ((void)0)
#define CNT_INC(v) ((void)0)
#define CNT_DEC(v) ((void)0)
#endif


#ifdef ANCHOR_TEST_HOOKS
// ---------------------------------------------------------------- test build: the turn gate (CONTRACTS-B 1.5 R25') and the CRT debug heap (R25)
// Steps: W1 the operation, W2 the err write through the publication CAS (and the lost-CAS close), W3 everything after the CAS through
// SetEvent(done); J1 the caller's deadline wait, J2 the caller's CAS and its poison or late consume. Gate state is process-global and is never
// stored in a Request. The gate lock is never held across a production step body, and no gate wait is entered while holding a Session lock.
enum { S_NONE = 0, S_W1, S_W2, S_W3, S_J1, S_J2 };
#define SCHED_MAX 8
#define SCHED_WAIT_MS 5000
static struct {
  CRITICAL_SECTION cs;
  CONDITION_VARIABLE cv;
  int armed, claimed, n, cursor, owners;   // owners: participants (worker, caller) of the CLAIMED request that have not yet made their final gate access
  ULONG gen;
  const void *session;
  int order[SCHED_MAX];
  LONG broken, steps;
} g_sched;

static void sched_break_locked(void) {
  g_sched.broken = 1;
  g_sched.armed = 0;
  WakeAllConditionVariable(&g_sched.cv);
}
/** Waits until `id` is next in the order (one absolute 5 s allowance, never restarted by a spurious wake). Returns the arm generation when
 * the step is scheduled, 0 when the gate is not armed or broke (the run then continues unscheduled). */
static ULONG sched_enter(int id, ULONG want) {
  ULONG gen = 0;
  if (!want) return 0;
  EnterCriticalSection(&g_sched.cs);
  ULONGLONG until = GetTickCount64() + SCHED_WAIT_MS;
  while (g_sched.armed && g_sched.gen == want && g_sched.order[g_sched.cursor] != id) {
    ULONGLONG now = GetTickCount64();
    if (now >= until) { sched_break_locked(); break; }
    if (!SleepConditionVariableCS(&g_sched.cv, &g_sched.cs, (DWORD)(until - now)) && GetLastError() != ERROR_TIMEOUT) { sched_break_locked(); break; }
  }
  if (g_sched.armed && g_sched.gen == want) gen = want;   // an access is bound to the generation its request claimed
  LeaveCriticalSection(&g_sched.cs);
  return gen;
}
static void sched_leave(ULONG gen) {
  if (!gen) return;
  EnterCriticalSection(&g_sched.cs);
  if (g_sched.armed && g_sched.gen == gen) {
    g_sched.cursor++;
    g_sched.steps++;
    if (g_sched.cursor >= g_sched.n) g_sched.armed = 0;
    WakeAllConditionVariable(&g_sched.cv);
  }
  LeaveCriticalSection(&g_sched.cs);
}
/** The first request posted on `s` after an arm takes the arm and returns its generation (0 when it takes nothing). From the claim until BOTH
 * participants (the worker and the caller) have made their final gate access, whether waiting, between steps or finished, the gate is owned:
 * anchorTestSchedule refuses a re-arm (EBUSY). An unclaimed arm is still replaced freely. */
static ULONG sched_claim(const void *s) {
  ULONG gen = 0;
  EnterCriticalSection(&g_sched.cs);
  if (g_sched.armed && !g_sched.claimed && g_sched.session == s) { g_sched.claimed = 1; g_sched.owners = 2; gen = g_sched.gen; }
  LeaveCriticalSection(&g_sched.cs);
  return gen;
}
/** One participant's final gate access for the request that claimed generation `gen`; the gate is released when both have made theirs. */
static void sched_finish(ULONG gen) {
  if (!gen) return;
  EnterCriticalSection(&g_sched.cs);
  if (g_sched.gen == gen && g_sched.owners > 0) g_sched.owners--;
  LeaveCriticalSection(&g_sched.cs);
}
static void sched_worker_done(Request *r) {
  if (r->sched && InterlockedExchange(&r->sched_w, 1) == 0) sched_finish(r->sched);
}
static void sched_caller_done(Request *r) {
  if (r->sched && InterlockedExchange(&r->sched_c, 1) == 0) sched_finish(r->sched);
}
static void sched_forget(const void *s) {
  EnterCriticalSection(&g_sched.cs);
  if (g_sched.session == s) { g_sched.session = NULL; if (!g_sched.claimed) g_sched.armed = 0; }
  LeaveCriticalSection(&g_sched.cs);
}

static _CrtMemState g_mark;
static volatile LONG g_capture = 0, g_leaks = 0;
static void heap_die(const char *what) {
  static const char tag[] = "ANCHOR-CRT-HEAP: ";
  DWORD wrote = 0;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err && err != INVALID_HANDLE_VALUE) {
    WriteFile(err, tag, (DWORD)(sizeof tag - 1), &wrote, NULL);
    WriteFile(err, what, (DWORD)strlen(what), &wrote, NULL);
    WriteFile(err, "\n", 1, &wrote, NULL);
  }
  TerminateProcess(GetCurrentProcess(), 86);
}
static int heap_message(int type, const char *text) {
  if (type == _CRT_ERROR || type == _CRT_ASSERT) heap_die(text ? text : "heap error");
  if (type == _CRT_WARN && text) {
    if (strstr(text, "memory check error") || strstr(text, "DAMAGE") || strstr(text, "HEAP CORRUPTION")) heap_die(text);
    if (g_capture) {
      if (strstr(text, "anchored-win.c(") && strstr(text, "block")) InterlockedIncrement(&g_leaks);
      return TRUE;
    }
  }
  return FALSE;
}
static int __cdecl heap_hook(int type, char *message, int *ret) { (void)ret; return heap_message(type, message); }
static int __cdecl heap_hook_w(int type, wchar_t *message, int *ret) {
  char narrow[512];
  (void)ret;
  narrow[0] = 0;
  if (message) WideCharToMultiByte(CP_ACP, 0, message, -1, narrow, (int)sizeof narrow - 1, NULL, NULL);
  narrow[sizeof narrow - 1] = 0;
  return heap_message(type, narrow);
}
static BOOL CALLBACK test_init_body(PINIT_ONCE once, PVOID param, PVOID *ctx) {
  (void)once; (void)param; (void)ctx;
  InitializeCriticalSection(&g_sched.cs);
  InitializeConditionVariable(&g_sched.cv);
  _CrtSetDbgFlag(_CRTDBG_ALLOC_MEM_DF | _CRTDBG_DELAY_FREE_MEM_DF | _CRTDBG_CHECK_EVERY_16_DF | _CRTDBG_LEAK_CHECK_DF);
  int types[3] = { _CRT_WARN, _CRT_ERROR, _CRT_ASSERT };
  for (int i = 0; i < 3; i++) {
    _CrtSetReportMode(types[i], _CRTDBG_MODE_FILE);
    _CrtSetReportFile(types[i], _CRTDBG_FILE_STDERR);
  }
  _CrtSetReportHook2(_CRT_RPTHOOK_INSTALL, heap_hook);
  _CrtSetReportHookW2(_CRT_RPTHOOK_INSTALL, heap_hook_w);
  return TRUE;
}
/** Completion-aware: every registrar (a second Node environment, a worker thread) blocks here until the gate and the CRT hooks are initialized. */
static void test_init_once(void) {
  static INIT_ONCE once = INIT_ONCE_STATIC_INIT;
  InitOnceExecuteOnce(&once, test_init_body, NULL, NULL);
}
#endif

static void close_file(HANDLE h) {
  CNT_DEC(g_file_handles);
  CloseHandle(h);
}

static napi_value throw_code(napi_env env, int code) {
  napi_throw_error(env, CODE[code], PLAIN);
  return NULL;
}

static int map_win32(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: case ERROR_INVALID_NAME: return E_ENOENT;
    case ERROR_ACCESS_DENIED: return E_EACCES;
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: return E_EBUSY;
    case ERROR_DIRECTORY: return E_ENOTDIR;
    default: return E_EIO;
  }
}

static int map_status(LONG status) {
  if (status == ST_NAME_NOT_FOUND || status == ST_PATH_NOT_FOUND || status == ST_DELETE_PENDING || status == ST_NAME_INVALID) return E_ENOENT;
  if (status == ST_NOT_A_DIRECTORY) return E_ENOTDIR;
  if (status == ST_FILE_IS_A_DIRECTORY) return E_EISDIR;
  if (status == ST_ACCESS_DENIED) return E_EACCES;
  if (status == ST_SHARING_VIOLATION || status == ST_LOCK_CONFLICT || status == ST_OPLOCK_BREAK) return E_EBUSY;
  if (status == ST_REPARSE_NOT_HANDLED || status == ST_REPARSE_NOT_RESOLVED) return E_ELOOP;
  return E_EIO;
}

// ---------------------------------------------------------------- reference counting

static void session_free(Session *s) {
  CNT_DEC(g_sessions_live);
#ifdef ANCHOR_TEST_HOOKS
  sched_forget(s);
#endif
  if (s->thread) CloseHandle(s->thread);
  if (s->wake) CloseHandle(s->wake);
  if (s->closed_all) CloseHandle(s->closed_all);
  free(s->reg);
  free(s->home_name);
  DeleteCriticalSection(&s->lock);
  free(s);
}
static void session_release(Session *s) {
  if (InterlockedDecrement(&s->refs) == 0) session_free(s);
}
static void req_release(Request *r) {
  if (InterlockedDecrement(&r->refs) != 0) return;
  free(r->buf);
  free(r->names);
  free(r->home);
  free(r->pname);
  free(r->cname);
  if (r->done) CloseHandle(r->done);
  CNT_DEC(g_requests_live);
  free(r);
}
static Request *req_new(int op, LONG refs) {
  if (refs == 1 && FORCED(F_CLOSEALLOC)) return NULL;  // test build: a close request that cannot be allocated
  Request *r = calloc(1, sizeof *r);
  if (!r) return NULL;
  CNT_INC(g_requests_live);
  r->op = op;
  r->refs = refs;
  r->state = REQ_PENDING;
  if (refs > 1) {
    r->done = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!r->done) { CNT_DEC(g_requests_live); free(r); return NULL; }
  }
  return r;
}

// ---------------------------------------------------------------- the worker (the session's own I/O thread)

/** Tracks h so close-all can find it. Returns 0 when it could not be tracked: the CALLER then closes h and refuses (an untracked
 * handle would pin its folder for good). */
static int reg_add(Session *s, HANDLE h) {
  if (s->reg_count == s->reg_cap) {
    size_t cap = s->reg_cap ? s->reg_cap * 2 : 64;
    HANDLE *grown = realloc(s->reg, cap * sizeof(HANDLE));
    if (!grown) return 0;
    s->reg = grown;
    s->reg_cap = cap;
  }
  s->reg[s->reg_count++] = h;
  return 1;
}
static void reg_close(Session *s, HANDLE h) {
  for (size_t i = 0; i < s->reg_count; i++) {
    if (s->reg[i] == h) { s->reg[i] = s->reg[--s->reg_count]; break; }
  }
  close_file(h);
}
static void reg_close_all(Session *s) {
  while (s->reg_count > 0) close_file(s->reg[--s->reg_count]);
}

/** FileNameInfo of a handle, malloc'd (volume-relative, UTF-16, not NUL-ended); NULL on failure. */
static wchar_t *name_of(HANDLE h, size_t *chars) {
  DWORD size = (DWORD)(sizeof(DWORD) + 33000 * sizeof(wchar_t));
  FILE_NAME_INFO *info = malloc(size);
  if (!info) return NULL;
  wchar_t *out = NULL;
  if (GetFileInformationByHandleEx(h, FileNameInfo, info, size) && info->FileNameLength > 0 && info->FileNameLength < 66000) {
    size_t n = info->FileNameLength / sizeof(wchar_t);
    out = malloc((n + 1) * sizeof(wchar_t));
    if (out) { memcpy(out, info->FileName, n * sizeof(wchar_t)); out[n] = 0; *chars = n; }
  }
  free(info);
  return out;
}

/** Judge an open handle (R4, R6, 1.3): attributes, kind, links, ids. Returns an E_ code. */
static int judge(Session *s, HANDLE h, int want_dir, Request *r, int is_home) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (FORCED(F_ATTRIBUTES) || !GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof tag)) { WHY(40); return E_EIO; }
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return E_ELOOP;
  if (tag.FileAttributes & OFFLINE_ATTRS) return E_EREMOTE;
  FILE_STANDARD_INFO std;
  if (!GetFileInformationByHandleEx(h, FileStandardInfo, &std, sizeof std)) { WHY(41); return E_EIO; }
  if (std.DeletePending) return E_ENOENT;
  if (want_dir == 1 && !std.Directory) return E_ENOTDIR;
  if (want_dir == 0 && std.Directory) return E_EISDIR;
  if (want_dir == 0 && std.NumberOfLinks != 1) return E_EMLINK;  // want_dir -1 (a stat) reports the links instead of refusing
  FILE_ID_INFO id;
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof id)) { WHY(42); return E_EIO; }
  if (!is_home &&id.VolumeSerialNumber != s->volume) return E_ELOOP;
  if (std.EndOfFile.QuadPart < 0 || (ULONGLONG)std.EndOfFile.QuadPart > 9007199254740991ULL) return E_EIO;
  if (r) {
    r->is_dir = std.Directory ? 1 : 0;
    r->volume = id.VolumeSerialNumber;
    memcpy(r->file_id, &id.FileId, 16);
    r->nlink = std.NumberOfLinks;
    r->size = (ULONGLONG)std.EndOfFile.QuadPart;
    r->attributes = tag.FileAttributes;
  }
  return E_OK;
}

static int do_begin(Session *s, Request *r) {
  const wchar_t *home = r->home;
  size_t n = wcslen(home);
  wchar_t *path = malloc((n + 5) * sizeof(wchar_t));
  if (!path) return E_EIO;
  wcscpy(path, L"\\\\?\\");
  wcscpy(path + 4, home);
  HANDLE h = CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  DWORD open_error = GetLastError();
  if (h == INVALID_HANDLE_VALUE) { free(path); return map_win32(open_error); }
  CNT_INC(g_file_handles);
  if (!reg_add(s, h)) { close_file(h); free(path); return E_EIO; }
  s->home = h;
  int code = judge(s, h, 1, NULL, 1);
  if (code != E_OK) { free(path); return code; }
  // R4: affirmative local storage. The remote-protocol query must fail with exactly ERROR_INVALID_PARAMETER.
  FILE_REMOTE_PROTOCOL_INFO remote;
  if (FORCED(F_REMOTE)) { free(path); return E_EIO; }
  if (GetFileInformationByHandleEx(h, FileRemoteProtocolInfo, &remote, sizeof remote)) { free(path); return E_EREMOTE; }
  if (GetLastError() != ERROR_INVALID_PARAMETER) { free(path); return E_EIO; }
  FsDeviceInfo device;
  IO_STATUS_BLOCK io;
  memset(&io, 0, sizeof io);
  if (FORCED(F_DEVICE) || !g_query_volume || g_query_volume(h, &io, &device, sizeof device, FS_DEVICE_INFORMATION) < 0) { free(path); return E_EIO; }
  if (device.DeviceType != DEV_DISK || (device.Characteristics & DEV_REMOTE)) { free(path); return E_EREMOTE; }
  wchar_t fsname[MAX_PATH + 1];
  if (FORCED(F_FILESYSTEM) || !GetVolumeInformationByHandleW(h, NULL, 0, NULL, NULL, NULL, fsname, MAX_PATH)) { free(path); return E_EIO; }
  if (wcscmp(fsname, L"NTFS") != 0 && wcscmp(fsname, L"ReFS") != 0) { WHY(3); free(path); return E_ENOTSUP; }
  wchar_t root[MAX_PATH + 2];
  if (FORCED(F_VOLUME) || !GetVolumePathNameW(home, root, MAX_PATH)) { free(path); return E_EIO; }
  UINT drive = GetDriveTypeW(root);
  free(path);
  if (FORCED(F_DRIVETYPE)) return E_EIO;
  if (drive == DRIVE_REMOTE) return E_EREMOTE;
  if (drive != DRIVE_FIXED && drive != DRIVE_REMOVABLE) return E_EREMOTE;
  FILE_ID_INFO id;
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof id)) return E_EIO;
  s->volume = id.VolumeSerialNumber;
  s->home_name = name_of(h, &s->home_name_len);  // R22b: the kernel's own name for the home, kept for every child's comparison
  if (!s->home_name) return E_EIO;
  return E_OK;
}

static int parent_ok(HANDLE parent) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(parent, FileAttributeTagInfo, &tag, sizeof tag)) return E_EIO;
  return (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? E_ELOOP : E_OK;  // R6: no in-place mutation of a held folder
}

static int do_open(Session *s, Request *r) {
  int code = parent_ok(r->parent);
  if (code != E_OK) return code;
#ifdef ANCHOR_TEST_HOOKS
  {
    // R22b: park between the parent re-query and the open so a test can convert the held, emptied parent into a mount point here.
    HANDLE release = (HANDLE)InterlockedExchangePointer((PVOID volatile *)&g_open_stall, NULL);
    if (release) {
      HANDLE arrived = (HANDLE)InterlockedExchangePointer((PVOID volatile *)&g_open_stall_arrived, NULL);
      // The arrived handle stays open until the fixture has released us: it may not have opened the named event yet, and the event dies
      // with its last handle. It is closed right after, so handle-count measurements stay meaningful.
      InterlockedIncrement(&g_open_stalled);
      if (arrived) SetEvent(arrived);
      WaitForSingleObject(release, 20000);
      CloseHandle(release);
      if (arrived) CloseHandle(arrived);
    }
  }
#endif
  UNICODE_STRING text;
  text.Buffer = r->name;
  text.Length = (USHORT)(r->name_len * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES object;
  InitializeObjectAttributes(&object, &text, OBJ_CASE_INSENSITIVE, r->parent, NULL);
  ULONG share = r->want_dir ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : FILE_SHARE_READ;  // never FILE_SHARE_DELETE
  // FILE_COMPLETE_IF_OPLOCKED and FILE_OPEN_NO_RECALL are for files: a directory open with either is STATUS_INVALID_PARAMETER (found on a
  // real runner). Directories have no oplock, and the attribute check on the opened handle still refuses an offline or recall-on-access one.
  ULONG options = NT_OPEN_REPARSE_POINT | NT_SYNC_NONALERT | (r->want_dir ? NT_DIRECTORY_FILE : (NT_NON_DIRECTORY_FILE | NT_COMPLETE_IF_OPLOCKED | NT_OPEN_NO_RECALL));
  IO_STATUS_BLOCK io;
  memset(&io, 0, sizeof io);
  HANDLE h = NULL;
  LONG status = g_create(&h, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &object, &io, NULL, 0, share, NT_OPEN, options, NULL, 0);
  if (status < 0) { WHY(status); return map_status(status); }
  CNT_INC(g_file_handles);
  if (status == ST_OPLOCK_BREAK) { close_file(h); return E_EBUSY; }
  code = judge(s, h, r->want_dir, r, 0);
  if (code == E_OK) {
    // R22b: the kernel's own answer for where the opened object is (read from the child's handle) must equal the parent's CACHED
    // FileNameInfo + "\" + name. The parent's name was read when the parent was opened, not now. The child's name is then cached in its Entry.
    size_t cn = 0;
    wchar_t *parent = r->pname, *child = name_of(h, &cn);
    int same = 0;
    if (parent && child) {
      size_t trim = r->pname_len;
      while (trim > 0 && parent[trim - 1] == L'\\') trim--;
      size_t want = trim + 1 + (size_t)r->name_len;
      if (want == cn && want <= 33000) {
        wchar_t *expected = malloc((want + 1) * sizeof(wchar_t));
        if (expected) {
          memcpy(expected, parent, trim * sizeof(wchar_t));
          expected[trim] = L'\\';
          memcpy(expected + trim + 1, r->name, (size_t)r->name_len * sizeof(wchar_t));
          same = CompareStringOrdinal(expected, (int)want, child, (int)cn, TRUE) == CSTR_EQUAL;
          free(expected);
        }
      }
    }
    if (same) { r->cname = child; r->cname_len = cn; } else { free(child); code = E_ELOOP; }
  }
  if (code != E_OK) { close_file(h); return code; }
  if (!reg_add(s, h)) { close_file(h); return E_EIO; }
  r->out = h;
  return E_OK;
}

static int do_list(Session *s, Request *r) {
  (void)s;
  int code = parent_ok(r->target);
  if (code != E_OK) return code;
  BYTE *buffer = malloc(LIST_BYTES);
  if (!buffer) return E_EIO;
  size_t cap = 4096, used = 0;
  wchar_t *names = malloc(cap * sizeof(wchar_t));
  if (!names) { free(buffer); return E_EIO; }
  DWORD count = 0;
  int first = 1, done = 0;
  while (!done) {
    if (!GetFileInformationByHandleEx(r->target, first ? FileFullDirectoryRestartInfo : FileFullDirectoryInfo, buffer, LIST_BYTES)) {
      DWORD e = GetLastError();
      if (e == ERROR_NO_MORE_FILES) break;
      free(buffer); free(names);
      return map_win32(e);
    }
    first = 0;
    BYTE *cursor = buffer;
    for (;;) {
      FILE_FULL_DIR_INFO *entry = (FILE_FULL_DIR_INFO *)cursor;
      size_t n = entry->FileNameLength / sizeof(wchar_t);
      int dot = (n == 1 && entry->FileName[0] == L'.') || (n == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
      if (!dot) {
        if (count >= MAX_LIST_NAMES) { r->truncated = 1; done = 1; break; }
        if (used + n + 1 > cap) {
          size_t grown = (used + n + 1) * 2;
          wchar_t *bigger = realloc(names, grown * sizeof(wchar_t));
          if (!bigger) { free(buffer); free(names); return E_EIO; }
          names = bigger; cap = grown;
        }
        memcpy(names + used, entry->FileName, n * sizeof(wchar_t));
        used += n;
        names[used++] = 0;
        count++;
      }
      if (entry->NextEntryOffset == 0) break;
      cursor += entry->NextEntryOffset;
    }
  }
  free(buffer);
  r->names = names;
  r->name_count = count;
  return E_OK;
}

static int do_read(Request *r) {
  r->buf = malloc(r->length ? r->length : 1);
  if (!r->buf) return E_EIO;
  OVERLAPPED ov;
  memset(&ov, 0, sizeof ov);
  ov.Offset = (DWORD)(r->position & 0xffffffffULL);
  ov.OffsetHigh = (DWORD)(r->position >> 32);
  DWORD got = 0;
  if (!ReadFile(r->target, r->buf, r->length, &got, &ov)) {
    DWORD e = GetLastError();
    if (e != ERROR_HANDLE_EOF) return e == ERROR_LOCK_VIOLATION ? E_EBUSY : E_EIO;
    got = 0;
  }
  r->got = got;
  return E_OK;
}

static void drain(Session *s, int code) {
  // called with the lock held, after worker_gone is set: waiters get an answer, nobody is left pending
  Request *r = s->head;
  s->head = s->tail = NULL;
  while (r) {
    Request *next = r->next;
    r->err = code;  // R20: the result is written BEFORE the CAS publishes it (an abandoned caller never reads it)
    if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) == REQ_PENDING && r->done) SetEvent(r->done);
#ifdef ANCHOR_TEST_HOOKS
    sched_worker_done(r);
#endif
    req_release(r);
    r = next;
  }
}

static void slot_release(void) {
  InterlockedExchange(&g_slot, 0);
  if (g_slot_event) SetEvent(g_slot_event);
}

static DWORD WINAPI worker_main(LPVOID arg) {
  Session *s = (Session *)arg;
  int exiting = 0;
  while (!exiting) {
    WaitForSingleObject(s->wake, INFINITE);
    EnterCriticalSection(&s->lock);
    Request *list = s->head;
    s->head = s->tail = NULL;
    int end = s->end_posted;   // R2/R13: the close-all is a FLAG, so it needs no allocation and cannot be lost
    LeaveCriticalSection(&s->lock);
    if ((s->poisoned || end) && !list) exiting = 1;
    while (list) {
      Request *r = list;
      list = r->next;
      r->next = NULL;
      if (exiting) {
        r->err = s->poisoned ? E_ETIMEDOUT : E_EBADF;
        if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) == REQ_PENDING && r->done) SetEvent(r->done);
#ifdef ANCHOR_TEST_HOOKS
        sched_worker_done(r);   // this request never reaches a gate step: the worker's participation ends here
#endif
        req_release(r);
        continue;
      }
#ifdef ANCHOR_TEST_HOOKS
      {
        HANDLE stall = (HANDLE)InterlockedExchangePointer((PVOID volatile *)&g_stall, NULL);
        if (stall) { WaitForSingleObject(stall, INFINITE); CloseHandle(stall); }
        LONG ms = InterlockedExchange(&g_stall_ms, 0);
        if (ms > 0) Sleep((DWORD)ms);
      }
#endif
      int code = E_OK;
#ifdef ANCHOR_TEST_HOOKS
      ULONG sc = r->op != OP_CLOSE ? r->sched : 0;   // read while this worker still holds its request reference
      ULONG gw1 = sched_enter(S_W1, sc);
#endif
      if (s->poisoned && r->op != OP_CLOSE) code = E_ETIMEDOUT;
      else switch (r->op) {
        case OP_BEGIN:
          code = do_begin(s, r);
          if (code != E_OK) {
            // R2/R12: a begin that fails for any non-timeout reason closes what it opened BEFORE its error is published, so the caller
            // that sees the throw never finds a folder still held. (A stall here is still bounded by the deadline: the caller abandons.)
            reg_close_all(s);
            s->home = NULL;
            s->failed_begin = 1;
            exiting = 1;
          }
          break;
        case OP_OPEN: code = do_open(s, r); break;
        case OP_LIST: code = do_list(s, r); break;
        case OP_READ: code = do_read(r); break;
        case OP_STAT: code = judge(s, r->target, -1, r, 0); break;
        case OP_CLOSE: reg_close(s, r->target); break;
      }
#ifdef ANCHOR_TEST_HOOKS
      sched_leave(gw1);
#endif
      if (r->op != OP_CLOSE) {
#ifdef ANCHOR_TEST_HOOKS
        ULONG gw2 = sched_enter(S_W2, sc);
#endif
        r->err = code;  // R20: written before the CAS publishes it
        if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) != REQ_PENDING) {
          // abandoned: nothing is published, so whatever this call opened is closed here and now
          if (r->out) { reg_close(s, r->out); r->out = NULL; CNT_INC(g_abandoned_closed); }
          exiting = 1;
#ifdef ANCHOR_TEST_HOOKS
          sched_leave(gw2);
          sched_worker_done(r);
#endif
        } else {
#ifdef ANCHOR_TEST_HOOKS
          sched_leave(gw2);
          ULONG gw3 = sched_enter(S_W3, sc);
#endif
          if (r->done) SetEvent(r->done);
#ifdef ANCHOR_TEST_HOOKS
          sched_leave(gw3);
          sched_worker_done(r);
#endif
        }
      }
      if (s->poisoned) exiting = 1;
      req_release(r);
    }
    if (end) exiting = 1;   // the requests posted before the end have run; everything still open is closed below
  }
#ifdef ANCHOR_TEST_HOOKS
  {
    HANDLE hold = (HANDLE)InterlockedExchangePointer((PVOID volatile *)&g_exit_stall, NULL);
    if (hold) { WaitForSingleObject(hold, 20000); CloseHandle(hold); }
  }
#endif
  // R23' exit order: closed_all means every handle is closed, the queue is drained and the admission slot is free
  reg_close_all(s);
  EnterCriticalSection(&s->lock);
  s->worker_gone = 1;
  drain(s, s->poisoned ? E_ETIMEDOUT : E_EBADF);
  LeaveCriticalSection(&s->lock);
  CNT_DEC(g_active_workers);
  slot_release();
  SetEvent(s->closed_all);
  session_release(s);
  return 0;
}

// ---------------------------------------------------------------- JS side

static void post_locked(Session *s, Request *r) {
  if (s->tail) s->tail->next = r; else s->head = r;
  s->tail = r;
}

/** Posts the close of ONE handle that nobody waits for. The lock is held by the caller. If the request cannot be allocated the handle
 * simply stays registered, and the session's end closes it (it is never lost: the end needs no allocation, see end_locked). */
static void post_nowait_locked(Session *s, int op, HANDLE target) {
  if (s->worker_gone) return;
  Request *r = req_new(op, 1);
  if (!r) return;
  r->target = target;
  post_locked(s, r);
  SetEvent(s->wake);
}

/** Ends the session (R2, R13, R22c): invalidates every Entry and wakes the worker, which closes everything it holds and exits. This is a
 * flag plus an event, so it allocates nothing and cannot fail or be lost. The lock is held by the caller. */
static void end_locked(Session *s) {
  if (s->end_posted) return;
  s->end_posted = 1;
  for (Entry *e = s->entries; e; e = e->next) e->closed = 1;
  if (!s->worker_gone) SetEvent(s->wake);
}

/** Posts `r` (refs 2), waits under the session deadline, and settles the CAS. E_OK keeps the JS reference for the caller; any
 * other code has already released it. */
static int run(Session *s, Request *r) {
#ifdef ANCHOR_TEST_HOOKS
  ULONG sc = 0, gj1 = 0, gj2 = 0;
#endif
  EnterCriticalSection(&s->lock);
  int refuse = s->worker_gone ? (s->poisoned ? E_ETIMEDOUT : E_EBADF) : (s->poisoned ? E_ETIMEDOUT : E_OK);
  if (refuse == E_OK) {
#ifdef ANCHOR_TEST_HOOKS
    LONG at_post = InterlockedExchange(&g_deadline_at_post, -1);
    if (at_post >= 0) s->deadline = GetTickCount64() + (ULONGLONG)at_post;
    sc = sched_claim(s);
    r->sched = sc;
#endif
    post_locked(s, r);
    SetEvent(s->wake);
  }
  LeaveCriticalSection(&s->lock);
  if (refuse != E_OK) { req_release(r); req_release(r); return refuse; }
  ULONGLONG now = GetTickCount64();
  DWORD wait = 0;
  if (now < s->deadline) { ULONGLONG left = s->deadline - now; wait = (DWORD)(left > MAX_BUDGET_MS ? MAX_BUDGET_MS : left); }
  DWORD got;
#ifdef ANCHOR_TEST_HOOKS
  if (sc) {
    gj1 = sched_enter(S_J1, sc);
    got = WaitForSingleObject(r->done, 0);   // armed: J1 times out exactly when the worker has not delivered before it
    sched_leave(gj1);
  } else
#endif
  got = wait ? WaitForSingleObject(r->done, wait) : WAIT_TIMEOUT;
  if (got != WAIT_OBJECT_0) {
#ifdef ANCHOR_TEST_HOOKS
    gj2 = sched_enter(S_J2, sc);
#endif
    if (InterlockedCompareExchange(&r->state, REQ_ABANDONED, REQ_PENDING) == REQ_PENDING) {
      // R22a: the CAS first; only the winner of ABANDONED poisons and cancels, and it never waits for the call.
      EnterCriticalSection(&s->lock);
      s->poisoned = 1;
      LeaveCriticalSection(&s->lock);
      CancelSynchronousIo(s->thread);
#ifdef ANCHOR_TEST_HOOKS
      sched_leave(gj2);
      sched_caller_done(r);
#endif
      req_release(r);
      return E_ETIMEDOUT;
    }
    CNT_INC(g_late_consumed);   // the wait timed out but the CAS found DELIVERED: consume the result (R20)
  }
  int err = r->err;
#ifdef ANCHOR_TEST_HOOKS
  sched_leave(gj2);
  sched_caller_done(r);
#endif
  if (err != E_OK) { req_release(r); return err; }
  return E_OK;
}

static napi_value make_plain_bigint(napi_env env, ULONGLONG value) {
  napi_value out;
  napi_create_bigint_uint64(env, value, &out);
  return out;
}
static napi_value make_u32(napi_env env, DWORD value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}
static napi_value make_double(napi_env env, ULONGLONG value) {
  napi_value out;
  napi_create_double(env, (double)value, &out);
  return out;
}
static napi_value make_text(napi_env env, const char *text) {
  napi_value out;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out);
  return out;
}
static void set(napi_env env, napi_value object, const char *key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

static napi_value file_id_value(napi_env env, const BYTE id[16]) {
  uint64_t words[2];
  memcpy(words, id, 16);
  napi_value out = NULL;
  napi_create_bigint_words(env, 0, 2, words, &out);
  return out;
}

static void session_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Session *s = (Session *)data;
  CNT_INC(g_session_finalized);
  EnterCriticalSection(&s->lock);
  end_locked(s);
  LeaveCriticalSection(&s->lock);
  session_release(s);
}

static void entry_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Entry *e = (Entry *)data;
  CNT_DEC(g_entries_live);
  Session *s = e->s;
  EnterCriticalSection(&s->lock);
  for (Entry **link = &s->entries; *link; link = &(*link)->next) {
    if (*link == e) { *link = e->next; break; }
  }
  if (!e->closed) { e->closed = 1; post_nowait_locked(s, OP_CLOSE, e->h); }
  s->open_count--;
  LeaveCriticalSection(&s->lock);
  free(e->name);
  free(e);
  session_release(s);  // R19: the Entry's reference is released here and only here
}

typedef struct { Session *s; Entry *e; HANDLE h; } Target;

/** Resolves a JS value to a live Session or Entry. Returns an E_ code. */
static int resolve(napi_env env, napi_value value, int allow_session, Target *out) {
  bool is_session = false, is_entry = false;
  memset(out, 0, sizeof *out);
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, &ENTRY_TAG, &is_entry) != napi_ok) return E_EBADF;
  if (is_entry) {
    if (napi_get_value_external(env, value, &data) != napi_ok || !data) return E_EBADF;
    Entry *e = (Entry *)data;
    Session *s = e->s;
    EnterCriticalSection(&s->lock);
    int closed = e->closed;
    int gone = s->worker_gone, poisoned = s->poisoned;
    LeaveCriticalSection(&s->lock);
    if (closed) return E_EBADF;
    if (gone || poisoned) return poisoned ? E_ETIMEDOUT : E_EBADF;
    out->s = s; out->e = e; out->h = e->h;
    return E_OK;
  }
  if (!allow_session) return E_EBADF;
  if (napi_check_object_type_tag(env, value, &SESSION_TAG, &is_session) != napi_ok || !is_session) return E_EBADF;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) return E_EBADF;
  Session *s = (Session *)data;
  EnterCriticalSection(&s->lock);
  int ended = s->end_posted, gone = s->worker_gone, poisoned = s->poisoned;
  LeaveCriticalSection(&s->lock);
  if (ended) return E_EBADF;
  if (gone || poisoned) return poisoned ? E_ETIMEDOUT : E_EBADF;
  out->s = s; out->h = s->home;
  return E_OK;
}

static int load_ntdll(void) {
  if (g_create && g_query_volume) return 1;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return 0;
  g_create = (NtCreateFileFn)(void *)GetProcAddress(ntdll, "NtCreateFile");
  g_query_volume = (NtQueryVolumeInformationFileFn)(void *)GetProcAddress(ntdll, "NtQueryVolumeInformationFile");
  return g_create && g_query_volume;
}

/** SeBackupPrivilege or SeRestorePrivilege ENABLED would let an open bypass an ACL: refuse (1.3). */
static int privileges_ok(void) {
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { WHY(21); return 0; }
  DWORD need = 0;
  GetTokenInformation(token, TokenPrivileges, NULL, 0, &need);
  TOKEN_PRIVILEGES *list = need ? malloc(need) : NULL;
  int ok = 0;
  if (!list) WHY(22);
  if (list && GetTokenInformation(token, TokenPrivileges, list, need, &need)) {
    LUID backup, restore;
    if (LookupPrivilegeValueW(NULL, L"SeBackupPrivilege", &backup) && LookupPrivilegeValueW(NULL, L"SeRestorePrivilege", &restore)) {
      ok = 1;
      for (DWORD i = 0; i < list->PrivilegeCount; i++) {
        LUID_AND_ATTRIBUTES *a = &list->Privileges[i];
        int is_it = (a->Luid.LowPart == backup.LowPart && a->Luid.HighPart == backup.HighPart) || (a->Luid.LowPart == restore.LowPart && a->Luid.HighPart == restore.HighPart);
        if (is_it && (a->Attributes & SE_PRIVILEGE_ENABLED)) { ok = 0; WHY(100 + (int)a->Attributes); }
      }
    } else WHY(23);
  } else if (list) WHY(24);
  free(list);
  CloseHandle(token);
  return ok;
}

static int home_is_valid(const wchar_t *home, size_t units, size_t length) {
  if (units == 0 || units != length || units > 32000) return 0;                       // an embedded NUL
  if (units < 3 || !(((home[0] >= L'A' && home[0] <= L'Z') || (home[0] >= L'a' && home[0] <= L'z')) && home[1] == L':' && home[2] == L'\\')) return 0;
  DWORD need = GetFullPathNameW(home, 0, NULL, NULL);                                // Windows must read it as the same path
  if (!need) return 0;
  wchar_t *full = malloc(((size_t)need + 1) * sizeof(wchar_t));
  if (!full) return 0;
  DWORD got = GetFullPathNameW(home, need + 1, full, NULL);
  int same = got && got <= need && wcscmp(full, home) == 0;
  free(full);
  return same;
}

static napi_value anchor_begin(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype t0 = napi_undefined, t1 = napi_undefined;
  if (argc >= 2) { napi_typeof(env, argv[0], &t0); napi_typeof(env, argv[1], &t1); }
  double budget = 0;
  if (argc < 2 || t0 != napi_string || t1 != napi_number || napi_get_value_double(env, argv[1], &budget) != napi_ok || !(budget >= 0)) return throw_code(env, E_EINVAL);
  size_t units = 0;
  napi_get_value_string_utf16(env, argv[0], NULL, 0, &units);
  if (units == 0 || units > 32000) return throw_code(env, E_EINVAL);
  wchar_t *home = malloc((units + 1) * sizeof(wchar_t));
  if (!home) return throw_code(env, E_EIO);
  size_t copied = 0;
  napi_get_value_string_utf16(env, argv[0], (char16_t *)home, units + 1, &copied);
  home[copied] = 0;
  if (!home_is_valid(home, copied, wcslen(home))) { free(home); return throw_code(env, E_EINVAL); }
  if (!load_ntdll()) { WHY(1); free(home); return throw_code(env, E_ENOTSUP); }
  if (!privileges_ok()) { free(home); return throw_code(env, E_ENOTSUP); }
  ULONGLONG limit = budget > MAX_BUDGET_MS ? MAX_BUDGET_MS : (ULONGLONG)budget;
  if (limit < 1) limit = 1;
  ULONGLONG started = GetTickCount64();
  // R21/R22d: one process-wide admission slot, taken before the worker exists; waited for up to min(budget, 2 s)
  if (!g_slot_event) {
    HANDLE made = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (made && InterlockedCompareExchangePointer((PVOID volatile *)&g_slot_event, made, NULL) != NULL) CloseHandle(made);
  }
  ULONGLONG admit_until = started + (limit > ADMISSION_WAIT_MS ? ADMISSION_WAIT_MS : limit);
  while (InterlockedCompareExchange(&g_slot, 1, 0) != 0) {
    ULONGLONG now = GetTickCount64();
    if (now >= admit_until || !g_slot_event) { free(home); return throw_code(env, E_EBUSY); }
    WaitForSingleObject(g_slot_event, (DWORD)(admit_until - now));
  }
  Session *s = calloc(1, sizeof *s);
  if (!s) { slot_release(); free(home); return throw_code(env, E_EIO); }
  CNT_INC(g_sessions_live);
  InitializeCriticalSection(&s->lock);
  s->refs = 2;  // the worker's, and this call's (which becomes the Session external's at step 3)
  s->deadline = started + limit;
  s->wake = CreateEventW(NULL, FALSE, FALSE, NULL);
  s->closed_all = CreateEventW(NULL, TRUE, FALSE, NULL);
  s->thread = (s->wake && s->closed_all && !FORCED(F_THREAD)) ? CreateThread(NULL, 0, worker_main, s, CREATE_SUSPENDED, NULL) : NULL;
  if (!s->thread) {
    session_free(s);   // no worker owns it yet: nothing else holds a reference
    slot_release();    // R21: the failed begin itself gives the slot back
    free(home);
    return throw_code(env, E_EIO);
  }
  CNT_INC(g_active_workers);
  // R24 step 3: the Session external exists BEFORE the worker is resumed and before any request is posted, so nothing after the worker
  // has opened the home can fail (B1), and a begin that throws has no handle open (B2).
  napi_value external = NULL;
  int made = !FORCED(F_CREATE) && napi_create_external(env, s, session_finalize, NULL, &external) == napi_ok;
  if (!made) {
    // no external, so no finalizer is registered: this call still owns its reference. The suspended worker is released with the end flag
    // (no allocation), opens nothing, exits and gives the slot back.
    EnterCriticalSection(&s->lock);
    end_locked(s);
    LeaveCriticalSection(&s->lock);
    ResumeThread(s->thread);
    session_release(s);
    free(home);
    return throw_code(env, E_EIO);
  }
  if (napi_type_tag_object(env, external, &SESSION_TAG) != napi_ok || FORCED(F_TAG)) {
    // the external exists and its finalizer is registered, so that finalizer owns this reference (R19): end the session, release nothing
    EnterCriticalSection(&s->lock);
    end_locked(s);
    LeaveCriticalSection(&s->lock);
    ResumeThread(s->thread);
    free(home);
    return throw_code(env, E_EIO);
  }
  Request *r = FORCED(F_BEGINALLOC) ? NULL : req_new(OP_BEGIN, 2);
  if (!r) {
    EnterCriticalSection(&s->lock);
    end_locked(s);
    LeaveCriticalSection(&s->lock);
    ResumeThread(s->thread);
    free(home);
    return throw_code(env, E_EIO);
  }
  r->home = home;   // ownership of `home` moves to the request
  ResumeThread(s->thread);
  int code = run(s, r);
  if (code != E_OK) {
    // timeout: poisoned by run(), the worker cleans up on its own. Any other failure: the worker closed everything before it published.
    // The finalizer owns the caller's reference; releasing it here would be a double release.
    EnterCriticalSection(&s->lock);
    end_locked(s);
    LeaveCriticalSection(&s->lock);
    return throw_code(env, code);
  }
  req_release(r);
  return external;
}

static int valid_name(const wchar_t *name, size_t units, size_t length) {
  if (units < 1 || units > MAX_NAME_UNITS || units != length) return 0;
  if ((units == 1 && name[0] == L'.') || (units == 2 && name[0] == L'.' && name[1] == L'.')) return 0;
  for (size_t i = 0; i < units; i++) {
    wchar_t c = name[i];
    if (c < 0x20 || c == L'\\' || c == L'/' || c == L':' || c == L'*' || c == L'?' || c == L'"' || c == L'<' || c == L'>' || c == L'|') return 0;
  }
  return 1;
}

static napi_value anchor_open(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype t1 = napi_undefined, t2 = napi_undefined;
  if (argc >= 3) { napi_typeof(env, argv[1], &t1); napi_typeof(env, argv[2], &t2); }
  if (argc < 3 || t1 != napi_string || t2 != napi_string) return throw_code(env, E_EINVAL);
  size_t units = 0, copied = 0;
  napi_get_value_string_utf16(env, argv[1], NULL, 0, &units);
  char kind[8] = {0};
  size_t kind_len = 0;
  napi_get_value_string_utf8(env, argv[2], kind, sizeof kind, &kind_len);
  int want_dir = strcmp(kind, "dir") == 0;
  if (!want_dir && strcmp(kind, "file") != 0) return throw_code(env, E_EINVAL);
  if (units < 1 || units > MAX_NAME_UNITS) return throw_code(env, E_EINVAL);
  wchar_t name[MAX_NAME_UNITS + 2];
  napi_get_value_string_utf16(env, argv[1], (char16_t *)name, MAX_NAME_UNITS + 2, &copied);
  name[copied] = 0;
  if (!valid_name(name, copied, wcslen(name))) return throw_code(env, E_EINVAL);
  Target parent;
  int code = resolve(env, argv[0], 1, &parent);
  if (code != E_OK) return throw_code(env, code);
  Session *s = parent.s;
  if (GetTickCount64() >= s->deadline) return throw_code(env, E_ETIMEDOUT);
  EnterCriticalSection(&s->lock);
  int full = s->open_count >= MAX_ENTRIES;
  LeaveCriticalSection(&s->lock);
  if (full) return throw_code(env, E_EMFILE);
  Request *r = req_new(OP_OPEN, 2);
  if (!r) return throw_code(env, E_EIO);
  r->parent = parent.h;
  memcpy(r->name, name, copied * sizeof(wchar_t));
  r->name_len = (int)copied;
  r->want_dir = want_dir;
  // R22b: the parent's cached FileNameInfo travels IN the request (copied under the lock), so a parent collected while an abandoned open
  // is still running cannot leave the worker reading freed memory
  EnterCriticalSection(&s->lock);
  const wchar_t *cached = parent.e ? parent.e->name : s->home_name;
  size_t cached_len = parent.e ? parent.e->name_len : s->home_name_len;
  if (cached && cached_len) {
    r->pname = malloc(cached_len * sizeof(wchar_t));
    if (r->pname) { memcpy(r->pname, cached, cached_len * sizeof(wchar_t)); r->pname_len = cached_len; }
  }
  LeaveCriticalSection(&s->lock);
  if (!r->pname) { req_release(r); req_release(r); return throw_code(env, E_EIO); }
  code = run(s, r);
  if (code != E_OK) return throw_code(env, code);
  // publish: the Entry takes its own session reference, released only by its finalizer (R19)
  Entry *e = calloc(1, sizeof *e);
  napi_value external = NULL, entry_obj = NULL;
  if (!e) {
    EnterCriticalSection(&s->lock);
    post_nowait_locked(s, OP_CLOSE, r->out);
    LeaveCriticalSection(&s->lock);
    req_release(r);
    return throw_code(env, E_EIO);
  }
  CNT_INC(g_entries_live);
  e->s = s;
  e->h = r->out;
  e->name = r->cname;   // R22b: this Entry's own cached FileNameInfo
  e->name_len = r->cname_len;
  r->cname = NULL;
  EnterCriticalSection(&s->lock);
  e->next = s->entries;
  s->entries = e;
  s->open_count++;
  InterlockedIncrement(&s->refs);
  LeaveCriticalSection(&s->lock);
  if (napi_create_external(env, e, entry_finalize, NULL, &external) != napi_ok) {
    // no external, so no finalizer is registered: undo by hand (unlink, post the close, free, release the Entry's reference)
    entry_finalize(env, e, NULL);
    req_release(r);
    return throw_code(env, E_EIO);
  }
  if (napi_type_tag_object(env, external, &ENTRY_TAG) != napi_ok || FORCED(F_TAG)) {
    // the external exists and its finalizer will run: that finalizer owns the Entry and the reference (R19). Only invalidate and close
    // the handle now; never free or release here.
    EnterCriticalSection(&s->lock);
    if (!e->closed) { e->closed = 1; post_nowait_locked(s, OP_CLOSE, e->h); }
    LeaveCriticalSection(&s->lock);
    req_release(r);
    return throw_code(env, E_EIO);
  }
  napi_create_object(env, &entry_obj);
  set(env, entry_obj, "handle", external);
  set(env, entry_obj, "kind", make_text(env, r->is_dir ? "dir" : "file"));
  set(env, entry_obj, "volume", make_plain_bigint(env, r->volume));
  set(env, entry_obj, "fileId", file_id_value(env, r->file_id));
  set(env, entry_obj, "nlink", make_u32(env, r->nlink));
  set(env, entry_obj, "size", make_double(env, r->size));
  req_release(r);
  return entry_obj;
}

static napi_value anchor_list(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_code(env, E_EINVAL);
  Target dir;
  int code = resolve(env, argv[0], 1, &dir);
  if (code != E_OK) return throw_code(env, code);
  Session *s = dir.s;
  if (GetTickCount64() >= s->deadline) return throw_code(env, E_ETIMEDOUT);
  Request *r = req_new(OP_LIST, 2);
  if (!r) return throw_code(env, E_EIO);
  r->target = dir.h;
  code = run(s, r);
  if (code != E_OK) return throw_code(env, code);
  napi_value result = NULL, names = NULL;
  napi_create_object(env, &result);
  napi_create_array_with_length(env, r->name_count, &names);
  const wchar_t *cursor = r->names;
  for (DWORD i = 0; i < r->name_count; i++) {
    size_t n = wcslen(cursor);
    napi_value text;
    napi_create_string_utf16(env, (const char16_t *)cursor, n, &text);
    napi_set_element(env, names, i, text);
    cursor += n + 1;
  }
  napi_value truncated;
  napi_get_boolean(env, r->truncated != 0, &truncated);
  set(env, result, "names", names);
  set(env, result, "truncated", truncated);
  req_release(r);
  return result;
}

static napi_value anchor_read(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  double position = 0, length = 0;
  if (argc < 3 || napi_get_value_double(env, argv[1], &position) != napi_ok || napi_get_value_double(env, argv[2], &length) != napi_ok) return throw_code(env, E_EINVAL);
  if (!(position >= 0) || position > 9007199254740991.0 || !(length >= 0) || length > MAX_READ || position != (double)(ULONGLONG)position || length != (double)(DWORD)length) return throw_code(env, E_EINVAL);
  Target file;
  int code = resolve(env, argv[0], 0, &file);
  if (code != E_OK) return throw_code(env, code);
  Session *s = file.s;
  if (GetTickCount64() >= s->deadline) return throw_code(env, E_ETIMEDOUT);
  Request *r = req_new(OP_READ, 2);
  if (!r) return throw_code(env, E_EIO);
  r->target = file.h;
  r->position = (ULONGLONG)position;
  r->length = (DWORD)length;
  code = run(s, r);
  if (code != E_OK) return throw_code(env, code);
  napi_value out = NULL;
  void *copy = NULL;
  napi_status made = napi_create_buffer_copy(env, r->got, r->buf, &copy, &out);
  req_release(r);
  if (made != napi_ok) return throw_code(env, E_EIO);
  return out;
}

static napi_value anchor_stat(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_code(env, E_EINVAL);
  Target t;
  int code = resolve(env, argv[0], 1, &t);
  if (code != E_OK) return throw_code(env, code);
  Session *s = t.s;
  if (GetTickCount64() >= s->deadline) return throw_code(env, E_ETIMEDOUT);
  Request *r = req_new(OP_STAT, 2);
  if (!r) return throw_code(env, E_EIO);
  r->target = t.h;
  code = run(s, r);
  if (code != E_OK) return throw_code(env, code);
  napi_value out = NULL;
  napi_create_object(env, &out);
  set(env, out, "kind", make_text(env, r->is_dir ? "dir" : "file"));
  set(env, out, "volume", make_plain_bigint(env, r->volume));
  set(env, out, "fileId", file_id_value(env, r->file_id));
  set(env, out, "nlink", make_u32(env, r->nlink));
  set(env, out, "size", make_double(env, r->size));
  set(env, out, "attributes", make_u32(env, r->attributes));
  req_release(r);
  return out;
}

static napi_value anchor_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_code(env, E_EINVAL);
  bool is_entry = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, argv[0], &ENTRY_TAG, &is_entry) != napi_ok || !is_entry || napi_get_value_external(env, argv[0], &data) != napi_ok || !data) return throw_code(env, E_EBADF);
  Entry *e = (Entry *)data;
  Session *s = e->s;
  // R2/R17: exempt from the deadline and from poisoning; only invalidates and posts, never waits, never throws for a closed handle
  EnterCriticalSection(&s->lock);
  if (!e->closed) { e->closed = 1; post_nowait_locked(s, OP_CLOSE, e->h); }
  LeaveCriticalSection(&s->lock);
  return NULL;
}

static napi_value anchor_end(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_code(env, E_EINVAL);
  bool is_session = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, argv[0], &SESSION_TAG, &is_session) != napi_ok || !is_session || napi_get_value_external(env, argv[0], &data) != napi_ok || !data) return throw_code(env, E_EBADF);
  Session *s = (Session *)data;
  EnterCriticalSection(&s->lock);
  end_locked(s);
  LeaveCriticalSection(&s->lock);
  // R23': posts the end and reports; never waits. True means the worker has closed every handle, drained the queue and freed the slot.
  napi_value out = NULL;
  napi_get_boolean(env, WaitForSingleObject(s->closed_all, 0) == WAIT_OBJECT_0, &out);
  return out;
}

#ifdef ANCHOR_TEST_HOOKS
static napi_value test_stall(napi_env env, napi_callback_info info) {
  size_t argc = 1, units = 0;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t name[200];
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], (char16_t *)name, 200, &units) != napi_ok) return throw_code(env, E_EINVAL);
  name[units] = 0;
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, name);
  if (!event) return throw_code(env, E_EIO);
  InterlockedExchangePointer((PVOID volatile *)&g_stall, event);
  return NULL;
}
/** anchorTestStallOpen(releaseEvent, arrivedEvent): the next anchorOpen's I/O-thread call creates both named events, then parks after
 * its parent re-query until releaseEvent is set (20 s at most), setting arrivedEvent when it gets there. */
static napi_value test_stall_open(napi_env env, napi_callback_info info) {
  size_t argc = 2, units = 0;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t release_name[200], arrived_name[200];
  if (argc < 2 || napi_get_value_string_utf16(env, argv[0], (char16_t *)release_name, 200, &units) != napi_ok) return throw_code(env, E_EINVAL);
  release_name[units] = 0;
  if (napi_get_value_string_utf16(env, argv[1], (char16_t *)arrived_name, 200, &units) != napi_ok) return throw_code(env, E_EINVAL);
  arrived_name[units] = 0;
  HANDLE release = CreateEventW(NULL, TRUE, FALSE, release_name);
  HANDLE arrived = CreateEventW(NULL, TRUE, FALSE, arrived_name);
  if (!release || !arrived) return throw_code(env, E_EIO);
  InterlockedExchangePointer((PVOID volatile *)&g_open_stall_arrived, arrived);
  InterlockedExchangePointer((PVOID volatile *)&g_open_stall, release);
  return NULL;
}
static napi_value test_release(napi_env env, napi_callback_info info) {
  size_t argc = 1, units = 0;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t name[200];
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], (char16_t *)name, 200, &units) != napi_ok) return throw_code(env, E_EINVAL);
  name[units] = 0;
  HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, name);
  if (!event) return throw_code(env, E_EIO);
  SetEvent(event);
  CloseHandle(event);
  return NULL;
}
/** Test build only: removes SeBackupPrivilege and SeRestorePrivilege from this process's token. A hosted-runner administrator's Node
 * process holds both ENABLED, which the helper correctly refuses; the tests drop them first so they exercise the helper itself. */
static napi_value test_drop_privileges(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) return throw_code(env, E_EIO);
  struct { DWORD count; LUID_AND_ATTRIBUTES p[2]; } remove;
  memset(&remove, 0, sizeof remove);
  remove.count = 2;
  if (!LookupPrivilegeValueW(NULL, L"SeBackupPrivilege", &remove.p[0].Luid) || !LookupPrivilegeValueW(NULL, L"SeRestorePrivilege", &remove.p[1].Luid)) {
    CloseHandle(token);
    return throw_code(env, E_EIO);
  }
  remove.p[0].Attributes = SE_PRIVILEGE_REMOVED;
  remove.p[1].Attributes = SE_PRIVILEGE_REMOVED;
  SetLastError(0);
  AdjustTokenPrivileges(token, FALSE, (TOKEN_PRIVILEGES *)&remove, 0, NULL, NULL);
  DWORD error = GetLastError();
  CloseHandle(token);
  if (error != ERROR_SUCCESS && error != ERROR_NOT_ALL_ASSIGNED) return throw_code(env, E_EIO);
  return NULL;
}
/** anchorTestStallMs(ms): the next request the I/O thread dequeues sleeps ms first (a stall that ends by itself, for the 1,000-run race). */
static napi_value test_stall_ms(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t ms = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &ms) != napi_ok || ms < 0 || ms > 60000) return throw_code(env, E_EINVAL);
  InterlockedExchange(&g_stall_ms, ms);
  return NULL;
}
/** anchorTestStallExit(event): the next worker to exit waits (20 s at most) on the named event just before its final close-all. */
static napi_value test_stall_exit(napi_env env, napi_callback_info info) {
  size_t argc = 1, units = 0;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  wchar_t name[200];
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], (char16_t *)name, 200, &units) != napi_ok) return throw_code(env, E_EINVAL);
  name[units] = 0;
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, name);
  if (!event) return throw_code(env, E_EIO);
  InterlockedExchangePointer((PVOID volatile *)&g_exit_stall, event);
  return NULL;
}
/** anchorTestStats(): the process handle count and the exact counters (R25, R25'). */
static napi_value test_stats(napi_env env, napi_callback_info info) {
  (void)info;
  DWORD handles = 0;
  GetProcessHandleCount(GetCurrentProcess(), &handles);
  napi_value out = NULL;
  napi_create_object(env, &out);
  set(env, out, "handles", make_u32(env, handles));
  set(env, out, "sessions", make_u32(env, (DWORD)g_sessions_live));
  set(env, out, "entries", make_u32(env, (DWORD)g_entries_live));
  set(env, out, "requests", make_u32(env, (DWORD)g_requests_live));
  set(env, out, "fileHandles", make_u32(env, (DWORD)g_file_handles));
  set(env, out, "activeWorkers", make_u32(env, (DWORD)g_active_workers));
  set(env, out, "slot", make_u32(env, (DWORD)g_slot));
  set(env, out, "lateConsumed", make_u32(env, (DWORD)g_late_consumed));
  set(env, out, "abandonedClosed", make_u32(env, (DWORD)g_abandoned_closed));
  set(env, out, "sessionExternalsFinalized", make_u32(env, (DWORD)g_session_finalized));
  set(env, out, "openStalled", make_u32(env, (DWORD)g_open_stalled));
  set(env, out, "schedSteps", make_u32(env, (DWORD)g_sched.steps));
  set(env, out, "schedBroken", make_u32(env, (DWORD)g_sched.broken));
  return out;
}
/** anchorTestDeadlineAtPost(ms): the next run() sets the session deadline to now + ms immediately before posting (after the call-start check). */
static napi_value test_deadline_at_post(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t ms = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &ms) != napi_ok || ms < 0 || ms > 60000) return throw_code(env, E_EINVAL);
  InterlockedExchange(&g_deadline_at_post, ms);
  return NULL;
}
static Session *test_session_arg(napi_env env, napi_value value) {
  bool is_session = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, &SESSION_TAG, &is_session) != napi_ok || !is_session || napi_get_value_external(env, value, &data) != napi_ok || !data) return NULL;
  return (Session *)data;
}
/** anchorTestWaitSettled(session, ms) -> boolean: blocks the JS thread until closed_all (a test may block; production never calls this). */
/** anchorTestGateReset(): test isolation after a failed case. Drops the whole process-global gate state and voids every participant of the old
 * generation (a waiting one wakes and continues unscheduled; its later accesses bind to a generation that no longer exists), so one red case
 * cannot leave an armed gate, a stuck worker step or a held ownership behind for the cases after it. */
static napi_value test_gate_reset(napi_env env, napi_callback_info info) {
  (void)env; (void)info;
  EnterCriticalSection(&g_sched.cs);
  g_sched.gen++;
  if (!g_sched.gen) g_sched.gen++;
  g_sched.armed = 0;
  g_sched.claimed = 0;
  g_sched.owners = 0;
  g_sched.n = 0;
  g_sched.cursor = 0;
  g_sched.broken = 0;
  g_sched.steps = 0;
  g_sched.session = NULL;
  WakeAllConditionVariable(&g_sched.cv);
  LeaveCriticalSection(&g_sched.cs);
  return NULL;
}
static napi_value test_wait_settled(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  double ms = 0;
  Session *s = argc >= 2 ? test_session_arg(env, argv[0]) : NULL;
  if (!s || napi_get_value_double(env, argv[1], &ms) != napi_ok || !(ms >= 0) || ms > 600000) return throw_code(env, E_EINVAL);
  napi_value out = NULL;
  napi_get_boolean(env, WaitForSingleObject(s->closed_all, (DWORD)ms) == WAIT_OBJECT_0, &out);
  return out;
}
/** anchorTestSchedule(session, "W1,J1,..."): arms the NEXT request posted on that session with a total order of gate steps (R25'). */
static napi_value test_schedule(napi_env env, napi_callback_info info) {
  size_t argc = 2, units = 0;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Session *s = argc >= 2 ? test_session_arg(env, argv[0]) : NULL;
  char text[64] = {0};
  if (!s || napi_get_value_string_utf8(env, argv[1], text, sizeof text, &units) != napi_ok || units == 0 || units >= sizeof text - 1) return throw_code(env, E_EINVAL);
  int order[SCHED_MAX], n = 0;
  for (size_t i = 0; i < units; i += 3) {
    int id = 0;
    if (text[i] == 'W' && text[i + 1] >= '1' && text[i + 1] <= '3') id = S_W1 + (text[i + 1] - '1');
    else if (text[i] == 'J' && text[i + 1] >= '1' && text[i + 1] <= '2') id = S_J1 + (text[i + 1] - '1');
    if (!id || n >= SCHED_MAX || (i + 2 < units && text[i + 2] != ',') || (i + 2 >= units && i + 2 != units)) return throw_code(env, E_EINVAL);
    order[n++] = id;
  }
  if (n == 0) return throw_code(env, E_EINVAL);
  EnterCriticalSection(&g_sched.cs);
  if (g_sched.owners > 0) { LeaveCriticalSection(&g_sched.cs); return throw_code(env, E_EBUSY); }
  g_sched.gen++;
  if (!g_sched.gen) g_sched.gen++;
  g_sched.armed = 1;
  g_sched.claimed = 0;
  g_sched.session = s;
  g_sched.n = n;
  g_sched.cursor = 0;
  g_sched.broken = 0;
  g_sched.steps = 0;
  memcpy(g_sched.order, order, sizeof(int) * (size_t)n);
  LeaveCriticalSection(&g_sched.cs);
  return NULL;
}
static napi_value test_heap_mark(napi_env env, napi_callback_info info) {
  (void)env; (void)info;
  _CrtMemCheckpoint(&g_mark);
  return NULL;
}
/** anchorTestHeapCheck() -> { valid, blocks, bytes }: a full heap check and the NORMAL blocks still live since the mark. */
static napi_value test_heap_check(napi_env env, napi_callback_info info) {
  (void)info;
  _CrtMemState now, diff;
  int valid = _CrtCheckMemory() != 0;
  _CrtMemCheckpoint(&now);
  _CrtMemDifference(&diff, &g_mark, &now);
  napi_value out = NULL, flag = NULL;
  napi_create_object(env, &out);
  napi_get_boolean(env, valid != 0, &flag);
  set(env, out, "valid", flag);
  set(env, out, "blocks", make_u32(env, (DWORD)(diff.lCounts[_NORMAL_BLOCK] > 0 ? diff.lCounts[_NORMAL_BLOCK] : 0)));
  set(env, out, "bytes", make_u32(env, (DWORD)(diff.lSizes[_NORMAL_BLOCK] > 0 ? diff.lSizes[_NORMAL_BLOCK] : 0)));
  if (diff.lCounts[_NORMAL_BLOCK] > 0) _CrtMemDumpAllObjectsSince(&g_mark);
  return out;
}
/** anchorTestHeapLeaks() -> number of live blocks the CRT attributes to anchored-win.c. */
static napi_value test_heap_leaks(napi_env env, napi_callback_info info) {
  (void)info;
  InterlockedExchange(&g_leaks, 0);
  InterlockedExchange(&g_capture, 1);
  _CrtDumpMemoryLeaks();
  InterlockedExchange(&g_capture, 0);
  return make_u32(env, (DWORD)g_leaks);
}
/** anchorTestHeapCanary("double-free" | "write-after-free"): commits that bug on purpose. Positive control, run in a child process only. */
static napi_value test_heap_canary(napi_env env, napi_callback_info info) {
  size_t argc = 1, units = 0;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char kind[24] = {0};
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], kind, sizeof kind, &units) != napi_ok) return throw_code(env, E_EINVAL);
  char *block = malloc(32);
  if (!block) return throw_code(env, E_EIO);
  if (strcmp(kind, "double-free") == 0) {
    free(block);
    free(block);
  } else if (strcmp(kind, "write-after-free") == 0) {
    free(block);
    block[4] = 0x41;
    if (!_CrtCheckMemory()) heap_die("memory check error: write after free");
  } else { free(block); return throw_code(env, E_EINVAL); }
  return NULL;
}
/** anchorTestCorruptName(sessionOrEntry): damages the cached FileNameInfo of that Session or Entry, so a test can prove an open is
 * compared against the CACHED name (R22b) and not against a fresh query. */
static napi_value test_corrupt_name(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_code(env, E_EINVAL);
  bool is_entry = false, is_session = false;
  void *data = NULL;
  wchar_t **name = NULL;
  size_t *len = NULL;
  CRITICAL_SECTION *lock = NULL;
  if (napi_check_object_type_tag(env, argv[0], &ENTRY_TAG, &is_entry) == napi_ok && is_entry && napi_get_value_external(env, argv[0], &data) == napi_ok && data) {
    Entry *e = (Entry *)data;
    name = &e->name; len = &e->name_len; lock = &e->s->lock;
  } else if (napi_check_object_type_tag(env, argv[0], &SESSION_TAG, &is_session) == napi_ok && is_session && napi_get_value_external(env, argv[0], &data) == napi_ok && data) {
    Session *s = (Session *)data;
    name = &s->home_name; len = &s->home_name_len; lock = &s->lock;
  } else return throw_code(env, E_EBADF);
  EnterCriticalSection(lock);
  if (*name && *len > 0) (*name)[*len - 1] ^= 0x0001;  // the last character now differs
  LeaveCriticalSection(lock);
  return NULL;
}
static napi_value test_why(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value value = NULL;
  napi_create_int32(env, (int32_t)g_why, &value);
  return value;
}
static napi_value test_fail(napi_env env, napi_callback_info info) {
  size_t argc = 1, units = 0;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char query[24] = {0};
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], query, sizeof query, &units) != napi_ok) return throw_code(env, E_EINVAL);
  LONG which = F_NONE;
  if (strcmp(query, "attributes") == 0) which = F_ATTRIBUTES;
  else if (strcmp(query, "remote") == 0) which = F_REMOTE;
  else if (strcmp(query, "volume") == 0) which = F_VOLUME;
  else if (strcmp(query, "device") == 0) which = F_DEVICE;
  else if (strcmp(query, "drivetype") == 0) which = F_DRIVETYPE;
  else if (strcmp(query, "filesystem") == 0) which = F_FILESYSTEM;
  else if (strcmp(query, "thread") == 0) which = F_THREAD;
  else if (strcmp(query, "closealloc") == 0) which = F_CLOSEALLOC;
  else if (strcmp(query, "tag") == 0) which = F_TAG;
  else if (strcmp(query, "create") == 0) which = F_CREATE;
  else if (strcmp(query, "beginalloc") == 0) which = F_BEGINALLOC;
  else if (strcmp(query, "none") == 0) which = F_NONE;
  else return throw_code(env, E_EINVAL);
  InterlockedExchange(&g_fail, which);
  return NULL;
}
#endif

static void add(napi_env env, napi_value exports, const char *name, napi_callback fn) {
  napi_value value;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &value) == napi_ok) napi_set_named_property(env, exports, name, value);
}

void anchored_win_register(napi_env env, napi_value exports) {
#ifdef ANCHOR_TEST_HOOKS
  test_init_once();
#endif
  add(env, exports, "anchorBegin", anchor_begin);
  add(env, exports, "anchorOpen", anchor_open);
  add(env, exports, "anchorList", anchor_list);
  add(env, exports, "anchorRead", anchor_read);
  add(env, exports, "anchorStat", anchor_stat);
  add(env, exports, "anchorClose", anchor_close);
  add(env, exports, "anchorEnd", anchor_end);
#ifdef ANCHOR_TEST_HOOKS
  add(env, exports, "anchorTestStall", test_stall);
  add(env, exports, "anchorTestStallOpen", test_stall_open);
  add(env, exports, "anchorTestRelease", test_release);
  add(env, exports, "anchorTestFail", test_fail);
  add(env, exports, "anchorTestWhy", test_why);
  add(env, exports, "anchorTestStallMs", test_stall_ms);
  add(env, exports, "anchorTestStallExit", test_stall_exit);
  add(env, exports, "anchorTestStats", test_stats);
  add(env, exports, "anchorTestCorruptName", test_corrupt_name);
  add(env, exports, "anchorTestDropPrivileges", test_drop_privileges);
  add(env, exports, "anchorTestDeadlineAtPost", test_deadline_at_post);
  add(env, exports, "anchorTestWaitSettled", test_wait_settled);
  add(env, exports, "anchorTestGateReset", test_gate_reset);
  add(env, exports, "anchorTestSchedule", test_schedule);
  add(env, exports, "anchorTestHeapMark", test_heap_mark);
  add(env, exports, "anchorTestHeapCheck", test_heap_check);
  add(env, exports, "anchorTestHeapLeaks", test_heap_leaks);
  add(env, exports, "anchorTestHeapCanary", test_heap_canary);
#endif
}
