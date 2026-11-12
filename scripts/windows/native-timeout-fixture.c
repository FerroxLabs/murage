// Linux test double for the Win32 boundary, never a Windows acceptance test.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
static uintptr_t next_job=100, audit, owner;
static int terminated, closed, jobs_attached, handles_attached;
static void event(const char *name) {FILE *f=fopen(getenv("WINSCEN_NATIVE_TRACE"),"a");if(!f)abort();fprintf(f,"%s\n",name);fclose(f);}
void *CreateJobObject(void *attributes,void *name) {
  uintptr_t h=++next_job; if(h%2){audit=h;event("create-audit");}else{owner=h;event("create-owner");}
  errno=0; return (void*)h;
}
int SetInformationJobObject(void *job,int kind,void *limits,uint32_t size) {
  uint32_t flags=*(uint32_t*)((char*)limits+16);
  if((uintptr_t)job!=owner||kind!=9||flags!=0x2000)abort();event("no-breakaway-kill-on-close");return 1;
}
int InitializeProcThreadAttributeList(void *list,int count,uint32_t flags,uintptr_t *size) {*size=64;return list!=NULL;}
int UpdateProcThreadAttribute(void *list,uint32_t flags,uintptr_t attr,uintptr_t *value,uintptr_t size,void *old,void *returned) {
  if(attr==0x2000D){if(size!=2*sizeof(void*)||value[0]!=audit||value[1]!=owner)abort();jobs_attached=1;event("assign-audit-and-owner-at-creation");}
  else if(attr==0x20002){if(size!=3*sizeof(void*))abort();handles_attached=1;event("inherit-only-stdio");}
  else abort(); return 1;
}
void DeleteProcThreadAttributeList(void *list) {}
typedef struct {void *process,*thread;uint32_t pid,tid;} PI;
int CreateProcess(void *exe,void *args,void *pa,void *ta,int inherit,uint32_t flags,void *env,void *cwd,void *si,PI *pi) {
  if(!jobs_attached||!handles_attached||!inherit||flags!=0x08080004)abort();
  // Fake PID 900 is owned; PID 999 represents an unrelated process untouched.
  pi->process=(void*)900;pi->thread=(void*)901;pi->pid=900;pi->tid=901;
  event(getenv("WINSCEN_NATIVE_WAIT_MS") ? "create-suspended-snapshot" : "create-suspended-schtasks");return 1;
}
uint32_t ResumeThread(void *thread) {if(thread!=(void*)901)abort();event("resume-owned-thread");return 1;}
uint32_t WaitForSingleObject(void *process,uint32_t ms) {
  uint32_t expected=getenv("WINSCEN_NATIVE_WAIT_MS") ? atoi(getenv("WINSCEN_NATIVE_WAIT_MS")) : 30000;
  if(process!=(void*)900||ms!=expected)abort();event(expected==300000 ? "snapshot-still-running-after-300000ms" : "schtasks-still-running-after-30000ms");return 258;
}
int TerminateJobObject(void *job,uint32_t code) {if((uintptr_t)job!=owner)abort();terminated=1;event("terminate-owned-job-only");return 1;}
int CloseHandle(void *handle) {if((uintptr_t)handle==owner){closed=1;event("close-owner");}return 1;}
int QueryInformationJobObject(void *job,int kind,void *buffer,uint32_t size,uint32_t *returned) {
  if((uintptr_t)job!=audit||!terminated||!closed||kind!=3)abort();
  memset(buffer,0,size);*returned=8;event("prove-empty-after-termination-and-close");return 1;
}
