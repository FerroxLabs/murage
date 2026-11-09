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
//   anchorClose(handle), anchorEnd(session)           -> undefined (idempotent)
//
// Every failure throws Error("Could not read Claude Code files.") with one of a fixed set of `code`s; the message never carries a path,
// a name, a Win32 error or an NTSTATUS, and nothing is written to stderr or any log. Nothing here touches JS memory off the JS thread.
#define NAPI_VERSION 9
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "anchored-win.h"

#define PLAIN "Could not read Claude Code files."
#define MAX_BUDGET_MS 10000
#define ADMISSION_WAIT_MS 2000
#define END_WAIT_MS 500
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
};

struct Entry {
  Session *s;
  HANDLE h;
  int closed;               // set under the session lock at POST time (R17)
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
static volatile LONG g_fail = 0;
enum { F_NONE = 0, F_ATTRIBUTES, F_REMOTE, F_VOLUME, F_DEVICE, F_DRIVETYPE, F_FILESYSTEM, F_THREAD };
#define FORCED(which) (InterlockedCompareExchange(&g_fail, F_NONE, (which)) == (which))
static volatile LONG g_why = 0;   // test build only: which internal check last refused (a diagnosis aid, never in the shipped addon)
#define WHY(n) InterlockedExchange(&g_why, (n))
#else
#define FORCED(which) 0
#define WHY(n) ((void)0)
#endif

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
  if (s->thread) CloseHandle(s->thread);
  if (s->wake) CloseHandle(s->wake);
  if (s->closed_all) CloseHandle(s->closed_all);
  free(s->reg);
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
  if (r->done) CloseHandle(r->done);
  free(r);
}
static Request *req_new(int op, LONG refs) {
  Request *r = calloc(1, sizeof *r);
  if (!r) return NULL;
  r->op = op;
  r->refs = refs;
  r->state = REQ_PENDING;
  if (refs > 1) {
    r->done = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!r->done) { free(r); return NULL; }
  }
  return r;
}

// ---------------------------------------------------------------- the worker (the session's own I/O thread)

static void reg_add(Session *s, HANDLE h) {
  if (s->reg_count == s->reg_cap) {
    size_t cap = s->reg_cap ? s->reg_cap * 2 : 64;
    HANDLE *grown = realloc(s->reg, cap * sizeof(HANDLE));
    if (!grown) return;  // the handle is then closed with the others only if tracked; refuse instead
    s->reg = grown;
    s->reg_cap = cap;
  }
  s->reg[s->reg_count++] = h;
}
static void reg_close(Session *s, HANDLE h) {
  for (size_t i = 0; i < s->reg_count; i++) {
    if (s->reg[i] == h) { s->reg[i] = s->reg[--s->reg_count]; break; }
  }
  CloseHandle(h);
}
static void reg_close_all(Session *s) {
  while (s->reg_count > 0) CloseHandle(s->reg[--s->reg_count]);
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
  reg_add(s, h);
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
  UNICODE_STRING text;
  text.Buffer = r->name;
  text.Length = (USHORT)(r->name_len * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES object;
  InitializeObjectAttributes(&object, &text, OBJ_CASE_INSENSITIVE, r->parent, NULL);
  ULONG share = r->want_dir ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : FILE_SHARE_READ;  // never FILE_SHARE_DELETE
  ULONG options = NT_OPEN_REPARSE_POINT | NT_SYNC_NONALERT | NT_COMPLETE_IF_OPLOCKED | NT_OPEN_NO_RECALL | (r->want_dir ? NT_DIRECTORY_FILE : NT_NON_DIRECTORY_FILE);
  IO_STATUS_BLOCK io;
  memset(&io, 0, sizeof io);
  HANDLE h = NULL;
  LONG status = g_create(&h, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &object, &io, NULL, 0, share, NT_OPEN, options, NULL, 0);
  if (status < 0) { WHY(status); return map_status(status); }
  if (status == ST_OPLOCK_BREAK) { CloseHandle(h); return E_EBUSY; }
  code = judge(s, h, r->want_dir, r, 0);
  if (code == E_OK) {
    // R22b: the kernel's own answer for where the opened object is: parent FileNameInfo + "\" + name.
    size_t pn = 0, cn = 0;
    wchar_t *parent = name_of(r->parent, &pn), *child = name_of(h, &cn);
    int same = 0;
    if (parent && child) {
      size_t trim = pn;
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
    free(parent);
    free(child);
    if (!same) code = E_ELOOP;
  }
  if (code != E_OK) { CloseHandle(h); return code; }
  reg_add(s, h);
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
    if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) == REQ_PENDING) { r->err = code; if (r->done) SetEvent(r->done); }
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
    LeaveCriticalSection(&s->lock);
    if (s->poisoned && !list) exiting = 1;
    while (list) {
      Request *r = list;
      list = r->next;
      r->next = NULL;
      if (exiting) {
        if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) == REQ_PENDING) { r->err = s->poisoned ? E_ETIMEDOUT : E_EBADF; if (r->done) SetEvent(r->done); }
        req_release(r);
        continue;
      }
#ifdef ANCHOR_TEST_HOOKS
      {
        HANDLE stall = (HANDLE)InterlockedExchangePointer((PVOID volatile *)&g_stall, NULL);
        if (stall) { WaitForSingleObject(stall, INFINITE); CloseHandle(stall); }
      }
#endif
      int code = E_OK;
      if (s->poisoned && r->op != OP_CLOSEALL && r->op != OP_CLOSE) code = E_ETIMEDOUT;
      else switch (r->op) {
        case OP_BEGIN: code = do_begin(s, r); if (code != E_OK) { s->failed_begin = 1; exiting = 1; } break;
        case OP_OPEN: code = do_open(s, r); break;
        case OP_LIST: code = do_list(s, r); break;
        case OP_READ: code = do_read(r); break;
        case OP_STAT: code = judge(s, r->target, -1, r, 0); break;
        case OP_CLOSE: reg_close(s, r->target); break;
        case OP_CLOSEALL: exiting = 1; break;
      }
      r->err = code;
      if (r->op != OP_CLOSE && r->op != OP_CLOSEALL) {
        if (InterlockedCompareExchange(&r->state, REQ_DELIVERED, REQ_PENDING) != REQ_PENDING) {
          // abandoned: nothing is published, so whatever this call opened is closed here and now
          if (r->out) { reg_close(s, r->out); r->out = NULL; }
          exiting = 1;
        } else if (r->done) SetEvent(r->done);
      }
      if (s->poisoned) exiting = 1;
      req_release(r);
    }
  }
  reg_close_all(s);
  EnterCriticalSection(&s->lock);
  s->worker_gone = 1;
  drain(s, s->poisoned ? E_ETIMEDOUT : E_EBADF);
  LeaveCriticalSection(&s->lock);
  SetEvent(s->closed_all);
  session_release(s);
  slot_release();
  return 0;
}

// ---------------------------------------------------------------- JS side

static void post_locked(Session *s, Request *r) {
  if (s->tail) s->tail->next = r; else s->head = r;
  s->tail = r;
}

/** Posts a close (or close-all) that nobody waits for. The lock is held by the caller. */
static void post_nowait_locked(Session *s, int op, HANDLE target) {
  if (s->worker_gone) return;
  Request *r = req_new(op, 1);
  if (!r) return;
  r->target = target;
  post_locked(s, r);
  SetEvent(s->wake);
}

/** Posts `r` (refs 2), waits under the session deadline, and settles the CAS. E_OK keeps the JS reference for the caller; any
 * other code has already released it. */
static int run(Session *s, Request *r) {
  EnterCriticalSection(&s->lock);
  int refuse = s->worker_gone ? (s->poisoned ? E_ETIMEDOUT : E_EBADF) : (s->poisoned ? E_ETIMEDOUT : E_OK);
  if (refuse == E_OK) { post_locked(s, r); SetEvent(s->wake); }
  LeaveCriticalSection(&s->lock);
  if (refuse != E_OK) { req_release(r); req_release(r); return refuse; }
  ULONGLONG now = GetTickCount64();
  DWORD wait = 0;
  if (now < s->deadline) { ULONGLONG left = s->deadline - now; wait = (DWORD)(left > MAX_BUDGET_MS ? MAX_BUDGET_MS : left); }
  DWORD got = wait ? WaitForSingleObject(r->done, wait) : WAIT_TIMEOUT;
  if (got != WAIT_OBJECT_0 && InterlockedCompareExchange(&r->state, REQ_ABANDONED, REQ_PENDING) == REQ_PENDING) {
    // R22a: the CAS first; only the winner of ABANDONED poisons and cancels, and it never waits for the call.
    EnterCriticalSection(&s->lock);
    s->poisoned = 1;
    LeaveCriticalSection(&s->lock);
    CancelSynchronousIo(s->thread);
    req_release(r);
    return E_ETIMEDOUT;
  }
  int err = r->err;
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
  EnterCriticalSection(&s->lock);
  if (!s->end_posted) {
    s->end_posted = 1;
    for (Entry *e = s->entries; e; e = e->next) e->closed = 1;
    post_nowait_locked(s, OP_CLOSEALL, NULL);
  }
  LeaveCriticalSection(&s->lock);
  session_release(s);
}

static void entry_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Entry *e = (Entry *)data;
  Session *s = e->s;
  EnterCriticalSection(&s->lock);
  for (Entry **link = &s->entries; *link; link = &(*link)->next) {
    if (*link == e) { *link = e->next; break; }
  }
  if (!e->closed) { e->closed = 1; post_nowait_locked(s, OP_CLOSE, e->h); }
  s->open_count--;
  LeaveCriticalSection(&s->lock);
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
  InitializeCriticalSection(&s->lock);
  s->refs = 2;  // the worker's, and this call's (which becomes the Session external's)
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
  Request *r = req_new(OP_BEGIN, 2);
  if (!r) {
    // the suspended worker is released with a close-all so it runs, closes nothing, and gives the slot back
    s->end_posted = 1;
    Request *c = req_new(OP_CLOSEALL, 1);
    if (c) post_locked(s, c);
    ResumeThread(s->thread);
    SetEvent(s->wake);
    session_release(s);
    free(home);
    return throw_code(env, E_EIO);
  }
  r->home = home;
  ResumeThread(s->thread);
  int code = run(s, r);
  if (code != E_OK) {
    // timeout: poisoned by run(), the worker cleans up on its own. A failed begin ends the worker by itself.
    session_release(s);
    return throw_code(env, code);
  }
  req_release(r);
  napi_value external = NULL;
  if (napi_create_external(env, s, session_finalize, NULL, &external) != napi_ok || napi_type_tag_object(env, external, &SESSION_TAG) != napi_ok) {
    EnterCriticalSection(&s->lock);
    s->end_posted = 1;
    post_nowait_locked(s, OP_CLOSEALL, NULL);
    LeaveCriticalSection(&s->lock);
    session_release(s);
    return throw_code(env, E_EIO);
  }
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
  e->s = s;
  e->h = r->out;
  EnterCriticalSection(&s->lock);
  e->next = s->entries;
  s->entries = e;
  s->open_count++;
  InterlockedIncrement(&s->refs);
  LeaveCriticalSection(&s->lock);
  if (napi_create_external(env, e, entry_finalize, NULL, &external) != napi_ok || napi_type_tag_object(env, external, &ENTRY_TAG) != napi_ok) {
    entry_finalize(env, e, NULL);
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
  int wait = 0;
  EnterCriticalSection(&s->lock);
  if (!s->end_posted) {
    s->end_posted = 1;
    for (Entry *e = s->entries; e; e = e->next) e->closed = 1;
    post_nowait_locked(s, OP_CLOSEALL, NULL);
  }
  wait = !s->worker_gone && !s->poisoned;
  LeaveCriticalSection(&s->lock);
  // The close itself runs on the I/O thread. When that thread is healthy this returns once it is done (bounded), so a caller that
  // renames a formerly held folder right after anchorEnd sees it released; a stalled worker is never waited for.
  if (wait) WaitForSingleObject(s->closed_all, END_WAIT_MS);
  return NULL;
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
  add(env, exports, "anchorBegin", anchor_begin);
  add(env, exports, "anchorOpen", anchor_open);
  add(env, exports, "anchorList", anchor_list);
  add(env, exports, "anchorRead", anchor_read);
  add(env, exports, "anchorStat", anchor_stat);
  add(env, exports, "anchorClose", anchor_close);
  add(env, exports, "anchorEnd", anchor_end);
#ifdef ANCHOR_TEST_HOOKS
  add(env, exports, "anchorTestStall", test_stall);
  add(env, exports, "anchorTestRelease", test_release);
  add(env, exports, "anchorTestFail", test_fail);
  add(env, exports, "anchorTestWhy", test_why);
  add(env, exports, "anchorTestDropPrivileges", test_drop_privileges);
#endif
}
