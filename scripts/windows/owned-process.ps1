# Windows Job Object: the gate and all descendants die with this handle,
# including if Task Scheduler terminates the wrapper on its deadline. Start
# suspended so no descendant can escape before assignment. No breakaway flag.
function Initialize-OwnedProcess {
  if ('MurageGateProcess' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
public static class MurageGateProcess {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr process,thread; public uint pid,tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags;
    public UIntPtr minWorking,maxWorking; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT limits,uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint size,out uint returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  public class Proof { public bool ownerClosed; public bool empty; public uint flags; public int[] remaining; }
  public static readonly System.Collections.Generic.List<Proof> Proofs=new System.Collections.Generic.List<Proof>();
  public static bool InNamedJob(string name) {
    var j=OpenJobObject(4,false,name); Check(j!=IntPtr.Zero);
    try { bool inside; Check(IsProcessInJob(GetCurrentProcess(),j,out inside)); return inside; } finally {CloseHandle(j);}
  }
  public static void JoinNamedJob(string name) {
    var j=OpenJobObject(1,false,name); Check(j!=IntPtr.Zero);
    try {Check(AssignProcessToJobObject(j,GetCurrentProcess()));} finally {CloseHandle(j);}
  }
  static void AssertEmpty(IntPtr audit,int timeoutMilliseconds=15000) {
    // Audit is a distinct parent job: keeping its handle does not retain the
    // kill-on-close child job. Query the parent AFTER closing the owner handle.
    var buffer=Marshal.AllocHGlobal(65536);
    try {
      var deadline=DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
      do {
        uint returned; Check(QueryInformationJobObject(audit,3,buffer,65536,out returned));
        if(Marshal.ReadInt32(buffer)==0 && Marshal.ReadInt32(buffer,4)==0) return;
        System.Threading.Thread.Sleep(50);
      } while(DateTime.UtcNow<deadline);
      throw new InvalidOperationException("Job descendants survived owner close");
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  // The operator retains this handle across Scheduler /Run and wrapper startup.
  // Global namespace bridges the SSH operator and interactive desktop sessions.
  public sealed class WrapperJob : IDisposable {
    IntPtr handle;
    internal WrapperJob(string name) {
      handle=CreateJobObject(IntPtr.Zero,name); Check(handle!=IntPtr.Zero);
      if(Marshal.GetLastWin32Error()==183) {CloseHandle(handle);handle=IntPtr.Zero;throw new InvalidOperationException("Wrapper job already exists");}
      try {
        EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
        Check(SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(limits)));
      } catch {Dispose();throw;}
    }
    public bool TerminateAndProveEmpty(int timeoutMilliseconds=8000) {
      Check(TerminateJobObject(handle,1)); AssertEmpty(handle,timeoutMilliseconds); return true;
    }
    public void Dispose() {if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
  }
  public static WrapperJob CreateWrapperJob(string name) {return new WrapperJob(name);}
  public static int RunNative(string exe,string args,string cwd,int timeoutSeconds,string input,string output,string error,int proofTimeoutMilliseconds=15000) {
    using(var stdin=new FileStream(input,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Inheritable))
    using(var stdout=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.Read|FileShare.Inheritable))
    using(var stderr=new FileStream(error,FileMode.CreateNew,FileAccess.Write,FileShare.Read|FileShare.Inheritable)) {
      return RunCore(exe,args,cwd,timeoutSeconds,false,new IntPtr[]{stdin.SafeFileHandle.DangerousGetHandle(),stdout.SafeFileHandle.DangerousGetHandle(),stderr.SafeFileHandle.DangerousGetHandle()},proofTimeoutMilliseconds);
    }
  }
  static readonly object jobsGuard=new object();
  static readonly System.Collections.Generic.List<IntPtr> jobs=new System.Collections.Generic.List<IntPtr>();
  public static void CancelAll() { lock(jobsGuard) { foreach(var job in jobs) Check(TerminateJobObject(job,1)); } }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static System.Threading.Tasks.Task<int> RunInBackground(string exe,string args,string cwd,int timeoutSeconds,bool visible) {
    return System.Threading.Tasks.Task.Factory.StartNew(() => RunCore(exe,args,cwd,timeoutSeconds,visible));
  }
  public static int Run(string exe,string args,string cwd,int timeoutSeconds) { return RunCore(exe,args,cwd,timeoutSeconds,false); }
  static int RunCore(string exe,string args,string cwd,int timeoutSeconds,bool visible,IntPtr[] stdHandles=null,int proofTimeoutMilliseconds=15000) {
    IntPtr audit=CreateJobObject(IntPtr.Zero,null);
    Check(audit!=IntPtr.Zero);
    // Only the outer scenario launcher names its job. Nested helper jobs stay anonymous.
    string name=stdHandles==null ? Environment.GetEnvironmentVariable("MURAGE_GATE_CREATE_JOB") : null;
    IntPtr job=CreateJobObject(IntPtr.Zero,name);
    if(job==IntPtr.Zero) {CloseHandle(audit);Check(false);}
    if(name!=null && Marshal.GetLastWin32Error()==183) {CloseHandle(job);CloseHandle(audit);throw new InvalidOperationException("Run job already exists");}
    lock(jobsGuard) { jobs.Add(job); }
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    IntPtr attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero;
    bool attributesReady=false;
    try {
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      IntPtr size=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,stdHandles==null?1:2,0,ref size);
      attributes=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes,stdHandles==null?1:2,0,ref size)); attributesReady=true;
      jobList=Marshal.AllocHGlobal(IntPtr.Size*2);
      Marshal.WriteIntPtr(jobList,0,audit); Marshal.WriteIntPtr(jobList,IntPtr.Size,job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: atomic assignment, including on failure.
      // There is never an unassigned process to terminate if creation fails.
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobList,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero));
      STARTUPINFOEX si=new STARTUPINFOEX(); si.startup.cb=Marshal.SizeOf(si); si.attributes=attributes;
      if(stdHandles!=null) {
        si.startup.flags=0x100; si.startup.input=stdHandles[0];si.startup.output=stdHandles[1];si.startup.error=stdHandles[2];
        handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
        for(int i=0;i<3;i++) Marshal.WriteIntPtr(handleList,i*IntPtr.Size,stdHandles[i]);
        // Inherit only these three handles, never the job owner or audit handle.
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      }
      // CREATE_SUSPENDED + EXTENDED_STARTUPINFO_PRESENT, with hidden native IO.
      Check(CreateProcess(exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,stdHandles!=null,(visible?0x00000014u:0x08000004u)|0x00080000u,IntPtr.Zero,cwd,ref si,out pi));
      Check(ResumeThread(pi.thread)!=0xffffffff);
      uint waited=WaitForSingleObject(pi.process,checked((uint)timeoutSeconds*1000));
      if(waited==258) { Check(TerminateJobObject(job,1)); throw new TimeoutException("Owned command exceeded its deadline"); }
      Check(waited==0);
      uint code; Check(GetExitCodeProcess(pi.process,out code));
      return unchecked((int)code);
    } finally {
      if(attributesReady) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      lock(jobsGuard) { jobs.Remove(job); Check(CloseHandle(job)); }
      try { AssertEmpty(audit,proofTimeoutMilliseconds); lock(jobsGuard) { Proofs.Add(new Proof {ownerClosed=true,empty=true,flags=0x2000,remaining=new int[0]}); } }
      finally {
        CloseHandle(audit);
        if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
        if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      }
    }
  }
}
'@
}

function ConvertTo-WindowsArgument([string]$Value) {
  if ($Value -match '[\x00\r\n]') { throw 'Invalid command argument' }
  # CommandLineToArgvW quoting, including backslashes before quotes or the end.
  '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-OwnedNative([string]$File,[string]$Arguments,[int]$TimeoutSeconds,[int]$ProofTimeoutMilliseconds=15000) {
  Initialize-OwnedProcess
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('native-'+[Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($directory)
  $inputFile=Join-Path $directory 'stdin'
  $outputFile=Join-Path $directory 'stdout'
  $errorFile=Join-Path $directory 'stderr'
  try {
    # Empty regular file gives immediate stdin EOF; no prompts or pipe deadlocks.
    [IO.File]::WriteAllText($inputFile,'')
    $code=[MurageGateProcess]::RunNative($File,$Arguments,[Environment]::CurrentDirectory,$TimeoutSeconds,$inputFile,$outputFile,$errorFile,$ProofTimeoutMilliseconds)
    @{ExitCode=$code;Stdout=[IO.File]::ReadAllText($outputFile,[Console]::OutputEncoding);Stderr=[IO.File]::ReadAllText($errorFile,[Console]::OutputEncoding)}
  } finally {Remove-Item -LiteralPath $directory -Recurse -Force}
}
# Dynamic test doubles are confined to Linux; this is not a Windows launch API.
function Invoke-LinuxFixtureCallback([scriptblock]$Callback,[object[]]$Arguments=@()) {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Unix){throw 'Linux fixture callbacks only'}
  & $Callback @Arguments
}
function Invoke-LinuxLegacyLauncherCleanup {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Unix){throw 'Linux legacy fixture only'}
  $outer=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run-interactive.ps1') -Raw
  $core=$outer.Substring($outer.IndexOf('  Complete-RunLedger -Ledger'))
  $core=$core.Substring(0,$core.IndexOf('  } catch {'))
  & ([scriptblock]::Create($core))
}

function Initialize-ConsoleObserver {
if ('MurageConsoleObserver' -as [type]) { return }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class MurageConsoleObserver {
  delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, uint length, out uint needed);
  static string Name(IntPtr handle) {
    var text=new StringBuilder(512); uint needed;
    if(handle==IntPtr.Zero || !GetUserObjectInformation(handle,2,text,1024,out needed)) throw new Exception("Desktop identity unavailable: "+Marshal.GetLastWin32Error());
    return text.ToString();
  }
  public static Dictionary<string,object> Desktop() {
    IntPtr input=OpenInputDesktop(0,false,1);
    try { return new Dictionary<string,object> {
      {"session",Process.GetCurrentProcess().SessionId},{"activeSession",WTSGetActiveConsoleSessionId()},
      {"inputDesktop",Name(input)},{"threadDesktop",Name(GetThreadDesktop(GetCurrentThreadId()))},{"windowStation",Name(GetProcessWindowStation())}
    }; } finally {if(input!=IntPtr.Zero)CloseDesktop(input);}
  }
  static void RequireDesktop() {
    var d=Desktop();
    if(Convert.ToUInt32(d["session"])!=Convert.ToUInt32(d["activeSession"]) || Convert.ToUInt32(d["session"])==0 || (string)d["inputDesktop"]!="Default" || (string)d["threadDesktop"]!="Default" || (string)d["windowStation"]!="WinSta0") throw new Exception("Interactive desktop changed");
  }
  static readonly object guard = new object();
  static Timer timer;
  static Stopwatch watch = new Stopwatch();
  static long last;
  public static long Samples, MaxGapMs, FinalGapMs, StartedAt, StoppedAt;
  static long controlHwnd;
  static Dictionary<long,long> seen = new Dictionary<long,long>();
  public static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
  // A handle is accepted only after the independent EnumWindows sampler saw it.
  public static bool AcceptControl(long hwnd,long afterSample) {
    lock(guard) {
      long sample;
      if(!seen.TryGetValue(hwnd,out sample) || sample<=afterSample) return false;
      controlHwnd=hwnd;
      Visible.RemoveAll(s => s.EndsWith(" hwnd="+hwnd) && long.Parse(s.Split(' ')[0])>afterSample);
      return true;
    }
  }
  public static void EndControl() {
    long hwnd; lock(guard) { hwnd=controlHwnd; }
    if(hwnd==0) throw new Exception("Positive control was not observed");
    for(int i=0;i<100 && IsWindowVisible(new IntPtr(hwnd));i++) Thread.Sleep(50);
    if(IsWindowVisible(new IntPtr(hwnd))) throw new Exception("Positive control window did not close");
    lock(guard) { controlHwnd=0; }
  }
  public static List<string> Visible = new List<string>();
  public static List<int> Errors = new List<int>();
  public static void Start() {
    RequireDesktop();
    ShowWindow(GetConsoleWindow(), 0);
    StartedAt=Now(); watch.Restart(); last=0;
    timer = new Timer(_ => {
      lock(guard) {
        long now = watch.ElapsedMilliseconds;
        MaxGapMs = Math.Max(MaxGapMs, now-last); last=now; Samples++;
        try { RequireDesktop(); } catch { Errors.Add(-1); return; }
        bool ok = EnumWindows((hwnd, data) => {
          var name = new StringBuilder(256);
          GetClassName(hwnd, name, name.Capacity);
          if (IsWindowVisible(hwnd) && name.ToString() == "ConsoleWindowClass") {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            seen[hwnd.ToInt64()]=Samples;
            if(hwnd.ToInt64()!=controlHwnd) Visible.Add(Samples+" "+DateTime.UtcNow.ToString("O") + " pid=" + pid + " hwnd=" + hwnd.ToInt64());
          }
          return true;
        }, IntPtr.Zero);
        if (!ok) Errors.Add(Marshal.GetLastWin32Error());
      }
    }, null, 0, 250);
  }
  public static void Stop() {
    if(timer==null) return;
    using (var done = new ManualResetEvent(false)) { timer.Dispose(done); done.WaitOne(); }
    lock(guard) { FinalGapMs=watch.ElapsedMilliseconds-last; MaxGapMs=Math.Max(MaxGapMs,FinalGapMs); StoppedAt=Now(); watch.Stop(); }
  }
}
'@

}

function New-ConsoleControl([string]$Fixture) {
  $file=Assert-GatePath (Join-Path $Fixture 'visible-control.exe')
  Add-Type -OutputAssembly $file -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
public class MurageVisibleControl {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public static void Main(string[] args) {
    File.WriteAllText(args[0],GetConsoleWindow().ToInt64().ToString());
    var end=DateTime.UtcNow.AddSeconds(10);
    while(!File.Exists(args[1]) && DateTime.UtcNow<end) Thread.Sleep(50);
  }
}
'@
  return $file
}
# Compile a GUI-subsystem scheduler bridge. It joins the existing named job
# before launching the unchanged packaged Sentinel trampoline, then waits.
function New-GateTaskHelper([string]$Directory) {
  $file=Assert-GatePath (Join-Path $Directory 'task-bridge.exe')
  $source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'owned-process.ps1') -Raw
  $body=[regex]::Match($source,"(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  $body+=@'
public class GateTaskBridge {
  public static int Main(string[] args) {
    try {
      if(args.Length<3 || !System.Text.RegularExpressions.Regex.IsMatch(args[0],@"^Local\\MurageCI-[a-f0-9]{32}-$")) return 91;
      MurageGateProcess.JoinNamedJob(args[0]);
      if(!MurageGateProcess.InNamedJob(args[0])) return 92;
      var command=new System.Text.StringBuilder();
      for(int i=2;i<args.Length;i++) {
        command.Append('"');
        int slashes=0;
        foreach(char c in args[i]) {
          if(c=='\\') {slashes++;continue;}
          if(c=='"') {command.Append('\\',slashes*2+1);command.Append(c);slashes=0;continue;}
          command.Append('\\',slashes);slashes=0;command.Append(c);
        }
        command.Append('\\',slashes*2);command.Append("\" ");
      }
      return MurageGateProcess.Run(args[1],command.ToString(),System.IO.Path.GetDirectoryName(args[1]),55);
    } catch {return 93;}
  }
}
'@
  Add-Type -OutputAssembly $file -OutputType WindowsApplication -TypeDefinition $body
  return $file
}

function Initialize-GateAutologonSecret {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GateAutologonSecret {
 [StructLayout(LayoutKind.Sequential)] struct S {public ushort Length,MaximumLength;public IntPtr Buffer;}
 [StructLayout(LayoutKind.Sequential)] struct A {public uint Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService;}
 [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr name,ref A attributes,uint access,out IntPtr handle);
 [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle,ref S key,ref S value);
 [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
 [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
 static void Check(uint status){if(status!=0)throw new Win32Exception((int)LsaNtStatusToWinError(status));}
 public static void Store(string value){
  IntPtr handle=IntPtr.Zero;A a=new A();a.Length=(uint)Marshal.SizeOf(a);
  S k=new S(),v=new S();
  try {
   Check(LsaOpenPolicy(IntPtr.Zero,ref a,0x20,out handle));
   k.Buffer=Marshal.StringToHGlobalUni("DefaultPassword");k.Length=30;k.MaximumLength=32;
   v.Buffer=Marshal.StringToHGlobalUni(value);v.Length=checked((ushort)(value.Length*2));v.MaximumLength=checked((ushort)(v.Length+2));
   Check(LsaStorePrivateData(handle,ref k,ref v));
  } finally {
   if(v.Buffer!=IntPtr.Zero){for(int i=0;i<v.MaximumLength;i++)Marshal.WriteByte(v.Buffer,i,0);Marshal.FreeHGlobal(v.Buffer);}
   if(k.Buffer!=IntPtr.Zero)Marshal.FreeHGlobal(k.Buffer);if(handle!=IntPtr.Zero)LsaClose(handle);
  }
 }
}
'@

}
function Initialize-LinuxAdmissionFixture {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Unix){throw 'Linux admission fixture only'}
  Add-Type -TypeDefinition 'public static class MurageGateProcess { public static bool Inside=true; public static bool InNamedJob(string name) {return Inside;} }'
}
function Test-OwnedNativeCompilation {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Unix){throw 'Linux compilation fixture only'}
  Initialize-OwnedProcess
  Initialize-ConsoleObserver
  $controlBody=[regex]::Match(${function:New-ConsoleControl}.ToString(),"(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  Add-Type -TypeDefinition $controlBody
  $bridgeBody=[regex]::Match(${function:New-GateTaskHelper}.ToString(),"(?s)@'\r?\n(.*?)\r?\n'@").Groups[1].Value
  $ownedBody=[regex]::Match(${function:Initialize-OwnedProcess}.ToString(),"(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  Add-Type -TypeDefinition (($ownedBody+$bridgeBody).Replace('MurageGateProcess','MurageBridgeCompileCheck'))
}

function Invoke-WindowsNative([string]$File, [string[]]$ArgumentList) {
  $arguments=($ArgumentList | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
  Invoke-OwnedNative -File $File -Arguments $arguments -TimeoutSeconds 30
}
