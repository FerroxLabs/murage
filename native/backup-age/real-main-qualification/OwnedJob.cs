// Task-owned process containment, following native/fuigo-probe/launcher.c.
// No breakaway permission: relaunch must remain in this job or qualification fails.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class BackupQualificationJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public uint cb; public string lpReserved, lpDesktop, lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT value,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr value,uint length,out uint returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,System.Text.StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
  IntPtr job;
  readonly List<IntPtr> handles = new List<IntPtr>();
  readonly Dictionary<uint,IntPtr> pinned = new Dictionary<uint,IntPtr>();
  public BackupQualificationJob() {
    job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
    var limits=new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE only
    if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) { Dispose(); throw new Win32Exception(); }
  }
  public uint Start(string executable,string arguments,string directory,string environment) {
    var startup=new STARTUPINFO(); startup.cb=(uint)Marshal.SizeOf(startup);
    PROCESS_INFORMATION child; IntPtr env=Marshal.StringToHGlobalUni(environment);
    try {
      if(!CreateProcess(executable,new System.Text.StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x404,env,directory,ref startup,out child)) throw new Win32Exception();
    } finally { Marshal.FreeHGlobal(env); }
    try {
      if(!AssignProcessToJobObject(job,child.hProcess)) { TerminateProcess(child.hProcess,74); WaitForSingleObject(child.hProcess,10000); throw new Win32Exception(); }
      handles.Add(child.hProcess);
      pinned[child.dwProcessId]=child.hProcess;
      if(ResumeThread(child.hThread)==0xffffffff) { TerminateProcess(child.hProcess,75); throw new Win32Exception(); }
      return child.dwProcessId;
    } finally { CloseHandle(child.hThread); if(!handles.Contains(child.hProcess)) CloseHandle(child.hProcess); }
  }
  public Accounting Counts() {
    int size=Marshal.SizeOf(typeof(Accounting)); IntPtr memory=Marshal.AllocHGlobal(size);
    try { uint returned; if(!QueryInformationJobObject(job,1,memory,(uint)size,out returned)) throw new Win32Exception(); return (Accounting)Marshal.PtrToStructure(memory,typeof(Accounting)); }
    finally { Marshal.FreeHGlobal(memory); }
  }
  public uint[] ProcessIds() {
    const int bytes=65536; IntPtr memory=Marshal.AllocHGlobal(bytes);
    try {
      uint returned; if(!QueryInformationJobObject(job,3,memory,bytes,out returned)) throw new Win32Exception();
      int assigned=Marshal.ReadInt32(memory), count=Marshal.ReadInt32(memory,4);
      if(count<0 || assigned!=count || count>(bytes-8)/IntPtr.Size) throw new Exception("Incomplete owned job process inventory");
      var ids=new uint[count]; for(int i=0;i<count;i++) ids[i]=checked((uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64()); return ids;
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public void Pin(uint pid) {
    IntPtr handle=OpenProcess(0x100000|0x1000,false,pid); if(handle==IntPtr.Zero) throw new Win32Exception();
    bool owned; if(!IsProcessInJob(handle,job,out owned)||!owned) { CloseHandle(handle); throw new Exception("Replacement is not in owned job"); }
    handles.Add(handle);
    pinned[pid]=handle;
  }
  public bool Exited(uint pid) { return pinned.ContainsKey(pid) && WaitForSingleObject(pinned[pid],0)==0; }
  public uint ExitCode(uint pid) {
    if(!Exited(pid)) throw new Exception("Pinned process has not exited");
    uint code; if(!GetExitCodeProcess(pinned[pid],out code)) throw new Win32Exception();
    return code;
  }
  public bool HandlesClosed() { foreach(var handle in handles) if(WaitForSingleObject(handle,0)!=0) return false; return true; }
  public void StopOwned() { if(!TerminateJobObject(job,76)) throw new Win32Exception(); }
  public void Dispose() {
    if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
    foreach(var handle in handles) CloseHandle(handle); handles.Clear();
  }
}
