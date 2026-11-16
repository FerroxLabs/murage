// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-IOMETER: count bytes at SQLite's actual write boundary, including journals,
// checkpoints, temp spills and backup destinations. No secondary shm descriptor.
#include <node_api.h>
#include <stdint.h>
#include <string.h>
#include <limits.h>
#include <stdlib.h>
#ifndef _WIN32
#include <unistd.h>
#include <time.h>
#endif
#include "sqlite/sqlite3ext.h"
SQLITE_EXTENSION_INIT1
#ifdef _WIN32
#include <windows.h>
static volatile LONG meter_lock;
static void lock_meter(void) { while (InterlockedCompareExchange(&meter_lock,1,0)) SwitchToThread(); }
static void unlock_meter(void) { InterlockedExchange(&meter_lock,0); }
#define METER_EXPORT __declspec(dllexport)
#define METER_TLS __declspec(thread)
#else
static int meter_lock;
static void lock_meter(void) { while (__atomic_test_and_set(&meter_lock,__ATOMIC_ACQUIRE)) {} }
static void unlock_meter(void) { __atomic_clear(&meter_lock,__ATOMIC_RELEASE); }
#define METER_EXPORT __attribute__((visibility("default")))
#define METER_TLS _Thread_local
#endif
#define METER_BUCKETS 256
#define METER_KEY 512
// One mutex protects insertion AND snapshots; each xWrite holds it only for two
// integer additions. Slots never move while an open SQLite file references one.
static struct { char key[METER_KEY]; uint64_t bytes; int bg; } buckets[METER_BUCKETS+1];
static unsigned bucket_count;
static uint64_t meter_total;
static int meter_unknown;
// Producer owner: scperf-p1 (io-meter.ts). Consumer owner: scperf-p1 (VFS).
static uint64_t os_page_size = 4096, refused_writes, ceiling_miss, read_bytes, charged_bytes;
static int all_bg;
static METER_TLS uint64_t thread_raw,thread_read;
typedef struct MeterGrant { int live,foreground; uint64_t cap,used,raw,expires,generation; } MeterGrant;
static METER_TLS MeterGrant grant,saved_grant;
static METER_TLS int foreground_open;
static uint64_t wall_ms(void) {
#ifdef _WIN32
  FILETIME ft; ULARGE_INTEGER t; GetSystemTimeAsFileTime(&ft); t.LowPart=ft.dwLowDateTime; t.HighPart=ft.dwHighDateTime;
  return (t.QuadPart-116444736000000000ULL)/10000;
#else
  struct timespec t; clock_gettime(CLOCK_REALTIME,&t); return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;
#endif
}
// Producer owner: recall-fix-f. Consumer owner: scperf-p1 (existing grant expiry).
static int grant_expired(void *unused) {
  (void)unused;
  return grant.live && !grant.foreground && wall_ms()>=grant.expires;
}
static void set_grant_deadline(sqlite3_context *ctx,int argc,sqlite3_value **argv) {
  (void)argc;
  sqlite3_progress_handler(sqlite3_context_db_handle(ctx),sqlite3_value_int(argv[0])?1000:0,grant_expired,0);
  sqlite3_result_int(ctx,1);
}
static int install_grant_deadline(sqlite3 *db,char **error,const sqlite3_api_routines *api) {
  (void)error;(void)api;
  return sqlite3_create_function_v2(db,"murage_grant_deadline",1,SQLITE_UTF8|SQLITE_DIRECTONLY,0,set_grant_deadline,0,0,0);
}
static uint64_t page_span(uint64_t off,uint64_t len) {
  return ((off+len+os_page_size-1)/os_page_size-off/os_page_size)*os_page_size;
}
static int grant_charge(int bucket,uint64_t bytes) {
  const uint64_t now=wall_ms(); int refused=0;
  lock_meter();
  if(grant.live || all_bg || buckets[bucket].bg) {
    if(!grant.live || (!grant.foreground && (now>=grant.expires || bytes>grant.cap-grant.used))) {
      refused_writes++; if(grant.live && now<grant.expires)ceiling_miss++; refused=1;
    } else { grant.used+=bytes; if(!grant.foreground)charged_bytes+=bytes; }
  }
  unlock_meter(); return !refused;
}
static int bucket_for(const char *key) {
  unsigned i;
  if (!key || strlen(key)>=METER_KEY) return METER_BUCKETS;
  lock_meter();
  for (i=0;i<bucket_count;i++) if (!strcmp(key,buckets[i].key)) { unlock_meter(); return (int)i; }
  if (bucket_count==METER_BUCKETS) { unlock_meter(); return METER_BUCKETS; }
  i=bucket_count++; strcpy(buckets[i].key,key); unlock_meter(); return (int)i;
}
static void meter_bytes(int bucket,uint64_t bytes) {
  lock_meter();
  if (UINT64_MAX-meter_total<bytes || UINT64_MAX-buckets[bucket].bytes<bytes) meter_unknown=1;
  else { meter_total+=bytes; buckets[bucket].bytes+=bytes; }
  unlock_meter();
}
static void meter_failed(void) { lock_meter(); meter_unknown=1; unlock_meter(); }
typedef struct MeterFile { sqlite3_file base; sqlite3_file *real; int bucket, wal; uint64_t sqlite_page, first_frame, grant_generation; sqlite3_io_methods methods; } MeterFile;
#define MF(p) ((MeterFile *)(p))
#define REAL(p) (MF(p)->real)
#define CALL(p,method) (REAL(p)->pMethods->method)
static int m_close(sqlite3_file *p) { int rc=CALL(p,xClose)(REAL(p));p->pMethods=0;return rc; }
static int m_read(sqlite3_file *p,void *b,int n,sqlite3_int64 o) {
  int rc=CALL(p,xRead)(REAL(p),b,n,o);
  if(rc==SQLITE_OK || rc==SQLITE_IOERR_SHORT_READ){lock_meter();read_bytes+=(uint64_t)n;thread_read+=(uint64_t)n;unlock_meter();}
  return rc;
}
static uint32_t be32(const unsigned char *b) { return ((uint32_t)b[0]<<24)|((uint32_t)b[1]<<16)|((uint32_t)b[2]<<8)|b[3]; }
static uint64_t wal_region(uint64_t frame) { return frame<=4062?0:1+(frame-4063)/4096; }
static int m_write(sqlite3_file *p,const void *b,int n,sqlite3_int64 o) {
  MeterFile *f=MF(p);
  if(f->wal && o==0 && n>=12)f->sqlite_page=be32((const unsigned char *)b+8);
  if(f->wal && grant.live && o>=32 && n>=24 && f->sqlite_page && ((uint64_t)o-32)%(f->sqlite_page+24)==0) {
    uint64_t frame=((uint64_t)o-32)/(f->sqlite_page+24)+1;
    if(f->grant_generation!=grant.generation){f->first_frame=frame;f->grant_generation=grant.generation;}
    if(!f->first_frame)f->first_frame=frame;
    if(be32((const unsigned char *)b+4)!=0) {
      uint64_t regions=wal_region(frame)-wal_region(f->first_frame)+1;
      if(!grant_charge(f->bucket,(8*regions+1)*4096))return SQLITE_IOERR_WRITE;
      f->first_frame=0;
    }
  }
  if(!grant_charge(f->bucket,page_span((uint64_t)o,(uint64_t)n)))return SQLITE_IOERR_WRITE;
  int rc=CALL(p,xWrite)(REAL(p),b,n,o);
  if (rc==SQLITE_OK) { thread_raw+=(uint64_t)n;if(grant.live)grant.raw+=(uint64_t)n;meter_bytes(f->bucket,(uint64_t)n); } else meter_failed();
  return rc;
}
static int m_truncate(sqlite3_file *p,sqlite3_int64 n) { return CALL(p,xTruncate)(REAL(p),n); }
static int m_sync(sqlite3_file *p,int f) { return CALL(p,xSync)(REAL(p),f); }
static int m_size(sqlite3_file *p,sqlite3_int64 *n) { return CALL(p,xFileSize)(REAL(p),n); }
static int m_lock(sqlite3_file *p,int n) { return CALL(p,xLock)(REAL(p),n); }
static int m_unlock(sqlite3_file *p,int n) { return CALL(p,xUnlock)(REAL(p),n); }
static int m_reserved(sqlite3_file *p,int *n) { return CALL(p,xCheckReservedLock)(REAL(p),n); }
static int m_control(sqlite3_file *p,int op,void *arg) {
  if(op==SQLITE_FCNTL_PRAGMA && arg) {
    char **a=(char **)arg;
    if(a[1] && !sqlite3_stricmp(a[1],"murage_bg")) {
      lock_meter(); if(MF(p)->bucket!=METER_BUCKETS && a[2] && !strcmp(a[2],"1"))buckets[MF(p)->bucket].bg=1;
      int bg=buckets[MF(p)->bucket].bg; unlock_meter();
      a[0]=sqlite3_mprintf("%d",bg); return SQLITE_OK;
    }
  }
  return CALL(p,xFileControl)(REAL(p),op,arg);
}
static int m_sector(sqlite3_file *p) { return CALL(p,xSectorSize)(REAL(p)); }
static int m_device(sqlite3_file *p) { return CALL(p,xDeviceCharacteristics)(REAL(p)); }
static int m_shmmap(sqlite3_file *p,int page,int size,int extend,void volatile **out) { return CALL(p,xShmMap)(REAL(p),page,size,extend,out); }
static int m_shmlock(sqlite3_file *p,int o,int n,int f) {
  // WAL_CKPT_LOCK=1: pay its mmap page before a whole checkpoint can copy anything.
  if(o==1 && (f&SQLITE_SHM_LOCK) && (f&SQLITE_SHM_EXCLUSIVE) && !grant_charge(MF(p)->bucket,4096))return SQLITE_IOERR_WRITE;
  return CALL(p,xShmLock)(REAL(p),o,n,f);
}
static void m_barrier(sqlite3_file *p) { CALL(p,xShmBarrier)(REAL(p)); }
static int m_unmap(sqlite3_file *p,int del) { return CALL(p,xShmUnmap)(REAL(p),del); }
static int m_fetch(sqlite3_file *p,sqlite3_int64 o,int n,void **out) { return CALL(p,xFetch)(REAL(p),o,n,out); }
static int m_unfetch(sqlite3_file *p,sqlite3_int64 o,void *ptr) { return CALL(p,xUnfetch)(REAL(p),o,ptr); }
static sqlite3_vfs meter_vfs;
static sqlite3_vfs *underlying;
static int m_open(sqlite3_vfs *v,const char *path,sqlite3_file *p,int flags,int *out) {
  MeterFile *f=MF(p);char key[METER_KEY];size_t len;
  (void)v;memset(f,0,sizeof(*f));f->real=(sqlite3_file *)((char *)p+sizeof(*f));
  int rc=underlying->xOpen(underlying,path,f->real,flags,out);
  if (rc!=SQLITE_OK) return rc;
  f->wal=(flags&SQLITE_OPEN_WAL)!=0;
  if(f->wal){unsigned char h[12];f->sqlite_page=4096;if(f->real->pMethods->xRead(f->real,h,12,0)==SQLITE_OK)f->sqlite_page=be32(h+8);}
  if (path && (flags&(SQLITE_OPEN_MAIN_DB|SQLITE_OPEN_WAL|SQLITE_OPEN_MAIN_JOURNAL))) {
    len=strlen(path);
    if (flags&SQLITE_OPEN_WAL) { if(len>=4&&!strcmp(path+len-4,"-wal"))len-=4; }
    if (flags&SQLITE_OPEN_MAIN_JOURNAL) { if(len>=8&&!strcmp(path+len-8,"-journal"))len-=8; }
    if (len+10<sizeof(key)) { memcpy(key,"database:",9);memcpy(key+9,path,len);key[len+9]=0;f->bucket=bucket_for(key); }
    else f->bucket=METER_BUCKETS;
  } else f->bucket=bucket_for("sqlite-temp");
  f->methods.iVersion=f->real->pMethods->iVersion;
  f->methods.xClose=m_close;f->methods.xRead=m_read;f->methods.xWrite=m_write;f->methods.xTruncate=m_truncate;
  f->methods.xSync=m_sync;f->methods.xFileSize=m_size;f->methods.xLock=m_lock;f->methods.xUnlock=m_unlock;
  f->methods.xCheckReservedLock=m_reserved;f->methods.xFileControl=m_control;f->methods.xSectorSize=m_sector;f->methods.xDeviceCharacteristics=m_device;
  if(f->methods.iVersion>=2){f->methods.xShmMap=m_shmmap;f->methods.xShmLock=m_shmlock;f->methods.xShmBarrier=m_barrier;f->methods.xShmUnmap=m_unmap;}
  if(f->methods.iVersion>=3){f->methods.xFetch=f->real->pMethods->xFetch?m_fetch:0;f->methods.xUnfetch=f->real->pMethods->xUnfetch?m_unfetch:0;}
  p->pMethods=&f->methods;return SQLITE_OK;
}
// VFS methods receive their ORIGINAL VFS, including its pAppData. Copying the
// pointers alone would pass our wrapper to vendor implementations that cast it.
static int v_delete(sqlite3_vfs*v,const char*p,int s){(void)v;return underlying->xDelete(underlying,p,s);}
static int v_access(sqlite3_vfs*v,const char*p,int f,int*r){(void)v;return underlying->xAccess(underlying,p,f,r);}
static int v_full(sqlite3_vfs*v,const char*p,int n,char*r){(void)v;return underlying->xFullPathname(underlying,p,n,r);}
static void *v_dlopen(sqlite3_vfs*v,const char*p){(void)v;return underlying->xDlOpen(underlying,p);}
static void v_dlerror(sqlite3_vfs*v,int n,char*p){(void)v;underlying->xDlError(underlying,n,p);}
static void (*v_dlsym(sqlite3_vfs*v,void*h,const char*p))(void){(void)v;return underlying->xDlSym(underlying,h,p);}
static void v_dlclose(sqlite3_vfs*v,void*h){(void)v;underlying->xDlClose(underlying,h);}
static int v_random(sqlite3_vfs*v,int n,char*p){(void)v;return underlying->xRandomness(underlying,n,p);}
static int v_sleep(sqlite3_vfs*v,int n){(void)v;return underlying->xSleep(underlying,n);}
static int v_time(sqlite3_vfs*v,double*p){(void)v;return underlying->xCurrentTime(underlying,p);}
static int v_error(sqlite3_vfs*v,int n,char*p){(void)v;return underlying->xGetLastError(underlying,n,p);}
static int v_time64(sqlite3_vfs*v,sqlite3_int64*p){(void)v;return underlying->xCurrentTimeInt64(underlying,p);}
static int v_setcall(sqlite3_vfs*v,const char*n,sqlite3_syscall_ptr p){(void)v;return underlying->xSetSystemCall(underlying,n,p);}
static sqlite3_syscall_ptr v_getcall(sqlite3_vfs*v,const char*n){(void)v;return underlying->xGetSystemCall(underlying,n);}
static const char *v_nextcall(sqlite3_vfs*v,const char*n){(void)v;return underlying->xNextSystemCall(underlying,n);}
METER_EXPORT int sqlite3_muragemeter_init(sqlite3 *db,char **error,const sqlite3_api_routines *api) {
  int rc=SQLITE_OK;
  lock_meter();
  SQLITE_EXTENSION_INIT2(api);
  rc=install_grant_deadline(db,error,api);
  if(rc!=SQLITE_OK){unlock_meter();return rc;}
  if (!underlying) {
#ifdef _WIN32
    SYSTEM_INFO si; GetSystemInfo(&si); os_page_size=si.dwPageSize;
#else
    long ps=sysconf(_SC_PAGESIZE); if(ps>0)os_page_size=(uint64_t)ps;
#endif
    underlying=sqlite3_vfs_find(0);
    if(!underlying){unlock_meter();return SQLITE_ERROR;}
    memset(&meter_vfs,0,sizeof(meter_vfs));meter_vfs.iVersion=underlying->iVersion;meter_vfs.szOsFile=(int)sizeof(MeterFile)+underlying->szOsFile;
    meter_vfs.mxPathname=underlying->mxPathname;meter_vfs.zName="murage-write-meter";
    meter_vfs.xOpen=m_open;meter_vfs.xDelete=v_delete;meter_vfs.xAccess=v_access;meter_vfs.xFullPathname=v_full;
    meter_vfs.xDlOpen=v_dlopen;meter_vfs.xDlError=v_dlerror;meter_vfs.xDlSym=v_dlsym;meter_vfs.xDlClose=v_dlclose;
    meter_vfs.xRandomness=v_random;meter_vfs.xSleep=v_sleep;meter_vfs.xCurrentTime=v_time;meter_vfs.xGetLastError=v_error;
    if(meter_vfs.iVersion>=2)meter_vfs.xCurrentTimeInt64=v_time64;
    if(meter_vfs.iVersion>=3){meter_vfs.xSetSystemCall=v_setcall;meter_vfs.xGetSystemCall=v_getcall;meter_vfs.xNextSystemCall=v_nextcall;}
    rc=sqlite3_vfs_register(&meter_vfs,1);
    if(rc==SQLITE_OK){
      rc=sqlite3_auto_extension((void(*)(void))install_grant_deadline);
      if(rc!=SQLITE_OK)sqlite3_vfs_unregister(&meter_vfs);
    }
    if(rc!=SQLITE_OK)underlying=0;
  }
  unlock_meter();
  // SQLite permanently retains the extension, so callbacks cannot outlive its code.
  return rc==SQLITE_OK?SQLITE_OK_LOAD_PERMANENTLY:rc;
}
napi_value io_add(napi_env env,napi_callback_info info) {
  napi_value args[2],out;size_t argc=2,n=0;char key[METER_KEY];double bytes;
  napi_get_cb_info(env,info,&argc,args,0,0);
  if(argc!=2||napi_get_value_string_utf8(env,args[0],key,sizeof(key),&n)!=napi_ok||n>=sizeof(key)-1||napi_get_value_double(env,args[1],&bytes)!=napi_ok||bytes!=bytes||bytes<0||bytes>9007199254740991.0||bytes!=(double)(uint64_t)bytes){meter_failed();}
  else { if(grant.live)grant.raw+=(uint64_t)bytes;thread_raw+=(uint64_t)bytes;meter_bytes(bucket_for(key),(uint64_t)bytes); }
  napi_get_undefined(env,&out);return out;
}
napi_value io_snapshot(napi_env env,napi_callback_info info) {
  napi_value out,total,known,list,row,key,value;unsigned i,count;uint64_t sum,values[METER_BUCKETS+1];int valid;
  (void)info;lock_meter();sum=meter_total;valid=!meter_unknown&&sum<=9007199254740991ULL;count=bucket_count;
  for(i=0;i<=METER_BUCKETS;i++)values[i]=buckets[i].bytes;
  unlock_meter();
  napi_create_object(env,&out);napi_create_double(env,(double)sum,&total);napi_get_boolean(env,valid,&known);
  napi_set_named_property(env,out,"total",total);napi_set_named_property(env,out,"known",known);napi_create_array_with_length(env,count+1,&list);
  for(i=0;i<=count;i++){
    napi_create_array_with_length(env,2,&row);napi_create_string_utf8(env,i==count?"other-files":buckets[i].key,NAPI_AUTO_LENGTH,&key);
    napi_create_double(env,(double)values[i==count?METER_BUCKETS:i],&value);napi_set_element(env,row,0,key);napi_set_element(env,row,1,value);napi_set_element(env,list,i,row);
  }
  napi_set_named_property(env,out,"buckets",list);return out;
}
napi_value io_total(napi_env env,napi_callback_info info) {
  napi_value out;uint64_t sum;int valid;(void)info;
  lock_meter();sum=meter_total;valid=!meter_unknown&&sum<=9007199254740991ULL;unlock_meter();
  if(valid)napi_create_double(env,(double)sum,&out);else napi_get_null(env,&out);return out;
}
napi_value io_bytes(napi_env env,napi_callback_info info) {
  napi_value arg,out;size_t argc=1,n=0;char key[METER_KEY];unsigned i;uint64_t sum=0;
  napi_get_cb_info(env,info,&argc,&arg,0,0);
  if(argc==1&&napi_get_value_string_utf8(env,arg,key,sizeof(key),&n)==napi_ok&&n<sizeof(key)-1){
    lock_meter();for(i=0;i<bucket_count;i++)if(!strcmp(key,buckets[i].key)){sum=buckets[i].bytes;break;}unlock_meter();
  }
  napi_create_double(env,(double)sum,&out);return out;
}
void io_meter_mark_unknown(void) { meter_failed(); }
void io_meter_note_native_bytes(uint64_t bytes) { meter_bytes(bucket_for("native-files"),bytes); }
napi_value io_unknown(napi_env env,napi_callback_info info) { napi_value out;(void)info;meter_failed();napi_get_undefined(env,&out);return out; }

static void number_property(napi_env env,napi_value out,const char *key,uint64_t n) {
  napi_value value; napi_create_double(env,(double)n,&value);napi_set_named_property(env,out,key,value);
}
napi_value io_grant_snapshot(napi_env env,napi_callback_info info) {
  napi_value out,live;uint64_t refused,miss,reads,charged;(void)info;
  lock_meter();refused=refused_writes;miss=ceiling_miss;reads=read_bytes;charged=charged_bytes;unlock_meter();
  napi_create_object(env,&out);napi_get_boolean(env,grant.live,&live);napi_set_named_property(env,out,"live",live);
  napi_get_boolean(env,1,&live);napi_set_named_property(env,out,"sqlDeadline",live);
  number_property(env,out,"wallTime",wall_ms());number_property(env,out,"rawBytes",grant.raw);number_property(env,out,"threadRawBytes",thread_raw);number_property(env,out,"usedBytes",grant.used);number_property(env,out,"capBytes",grant.cap);
  number_property(env,out,"refusedWrites",refused);number_property(env,out,"ceilingMiss",miss);
  number_property(env,out,"backgroundProcess",(uint64_t)all_bg);number_property(env,out,"pageSize",os_page_size);number_property(env,out,"readBytes",reads);number_property(env,out,"threadReadBytes",thread_read);number_property(env,out,"chargedBytes",charged);
  return out;
}
napi_value io_grant_begin(napi_env env,napi_callback_info info) {
  napi_value args[2],out;size_t argc=2;double cap=0,expires=0;
  napi_get_cb_info(env,info,&argc,args,0,0);
  if(grant.live || argc!=2 || napi_get_value_double(env,args[0],&cap)!=napi_ok || napi_get_value_double(env,args[1],&expires)!=napi_ok || cap!=cap || expires!=expires || cap<0 || cap>9007199254740991.0 || cap!=(double)(uint64_t)cap || expires<0 || expires>9007199254740991.0 || expires!=(double)(uint64_t)expires) {
    napi_throw_error(env,0,"BG_GRANT_INVALID");return 0;
  }
  grant.generation++;grant.live=1;grant.cap=(uint64_t)cap;grant.used=0;grant.raw=0;grant.expires=(uint64_t)expires;
  napi_get_undefined(env,&out);return out;
}
napi_value io_grant_end(napi_env env,napi_callback_info info) { grant.live=0;return io_grant_snapshot(env,info); }
napi_value io_grant_charge(napi_env env,napi_callback_info info) {
  napi_value arg,out;size_t argc=1;double bytes=0;napi_get_cb_info(env,info,&argc,&arg,0,0);
  if(argc!=1 || napi_get_value_double(env,arg,&bytes)!=napi_ok || bytes!=bytes || bytes<0 || bytes>9007199254740991.0 || bytes!=(double)(uint64_t)bytes || !grant_charge(METER_BUCKETS,(uint64_t)bytes)) {
    napi_throw_error(env,0,"BG_GRANT_REFUSED");return 0;
  }
  napi_get_undefined(env,&out);return out;
}
napi_value io_all_bg(napi_env env,napi_callback_info info) { napi_value out;(void)info;lock_meter();all_bg=1;unlock_meter();napi_get_undefined(env,&out);return out; }

napi_value io_fg_begin(napi_env env,napi_callback_info info) {
  napi_value out;(void)info;
  if(foreground_open){napi_throw_error(env,0,"FGCOPY_NESTED");return 0;}
  saved_grant=grant;memset(&grant,0,sizeof(grant));grant.live=1;grant.foreground=1;grant.generation=saved_grant.generation+1;foreground_open=1;
  napi_get_undefined(env,&out);return out;
}
napi_value io_fg_end(napi_env env,napi_callback_info info) {
  napi_value out=io_grant_snapshot(env,info);grant=saved_grant;foreground_open=0;return out;
}
